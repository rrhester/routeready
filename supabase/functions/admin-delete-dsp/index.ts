// admin-delete-dsp · Platform-admin-only · scrubs a DSP completely
// from the database, auth.users, AND Supabase Storage.
//
// Why an edge function (not just a SQL RPC like 0127's
// admin_delete_dsp): truly "scrubbed clean" needs three things the
// SQL RPC can't reach:
//
//   1. The DB cascade — handled by the existing FK ON DELETE CASCADE
//      chain across 30+ tenant-scoped tables.
//   2. auth.users records — the cascade removes app_users rows for
//      that DSP, but the underlying auth.users entries persist.
//      Cleaning them needs auth.admin.deleteUser, which only works
//      with the service-role key.
//   3. Supabase Storage objects — driver photos, applicant videos,
//      message attachments, coaching docs, driver documents, and
//      driver-chat attachments live in 6 storage buckets that don't
//      cascade with FK deletion.  storage.from(bucket).remove(...)
//      also requires service-role.
//
// All three need to happen atomically from the operator's POV.
//
// POST { p_dsp_id: uuid } with the inviter's JWT in Authorization.
// Response: { ok: true, db_deleted: name, auth_users_deleted: N,
//             storage_objects_deleted: M, errors: [...] }
//
// Safeguards (mirror admin_delete_dsp from migration 0127 + 0128):
//   - Caller MUST be platform_admin
//   - Cannot delete the caller's own DSP (would lock the admin out)
//   - Cannot delete a DSP that has another platform_admin as a
//     member (would orphan that admin)

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { createClient } from "@supabase/supabase-js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

// ── Storage path helpers ──────────────────────────────────────────────
// Supabase storage URLs for public buckets look like:
//   https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<path>
// For signed URLs:
//   https://<proj>.supabase.co/storage/v1/object/sign/<bucket>/<path>?token=...
// We need just <path> to call .remove([path]).
function extractStoragePath(url: string | null | undefined, bucket: string): string | null {
  if (!url) return null;
  const re = new RegExp(`/storage/v1/object/(?:public|sign|signed)/${bucket}/([^?]+)`);
  const m = url.match(re);
  return m ? decodeURIComponent(m[1]) : null;
}

// Recursive list under a prefix.  Supabase Storage lists 1000 entries
// per call, so we loop.  Returns a flat array of full object paths.
async function listAllUnder(admin: ReturnType<typeof serviceClient>, bucket: string, prefix: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [prefix];
  while (stack.length) {
    const here = stack.pop()!;
    let offset = 0;
    while (true) {
      const { data, error } = await admin.storage.from(bucket).list(here, {
        limit: 1000, offset, sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        // Most common: prefix doesn't exist yet (empty bucket / no objects).
        // That's fine — just stop scanning.
        break;
      }
      const entries = data ?? [];
      if (entries.length === 0) break;
      for (const e of entries) {
        if (!e?.name) continue;
        // A "folder" in Storage is just a prefix; the entry has no
        // metadata.size and no `id`.  Recurse into it.
        const isFolder = e.id == null && (e.metadata == null || Object.keys(e.metadata).length === 0);
        const full = here ? `${here}/${e.name}` : e.name;
        if (isFolder) stack.push(full);
        else          out.push(full);
      }
      if (entries.length < 1000) break;
      offset += entries.length;
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return badRequest("method_not_allowed", 405);

  let body: { p_dsp_id?: string };
  try { body = await req.json(); }
  catch { return badRequest("invalid_json"); }

  const dspId = (body.p_dsp_id || "").trim();
  if (!dspId) return badRequest("missing_dsp_id");

  const url  = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return badRequest("server_misconfigured", 500);

  // 1. Resolve caller via JWT.
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return badRequest("not_authenticated", 401);

  const admin = serviceClient();
  const { data: callerProfile } = await admin
    .from("app_users")
    .select("id, dsp_id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!callerProfile)              return badRequest("no_profile", 403);
  if (!callerProfile.active)       return badRequest("inactive_caller", 403);
  if (callerProfile.role !== "platform_admin") return badRequest("forbidden", 403);

  // 2. Safeguards.
  if (callerProfile.dsp_id === dspId) {
    return badRequest("cannot_delete_own_dsp", 403);
  }

  const { count: adminCount } = await admin
    .from("app_users")
    .select("id", { count: "exact", head: true })
    .eq("dsp_id", dspId)
    .eq("role", "platform_admin");
  if ((adminCount ?? 0) > 0) {
    return badRequest("platform_admin_in_target_dsp", 403);
  }

  const { data: targetDsp } = await admin
    .from("dsps")
    .select("id, name")
    .eq("id", dspId)
    .maybeSingle();
  if (!targetDsp) return badRequest("dsp_not_found", 404);

  // 3. Gather all storage object paths BEFORE the cascade kills the
  // rows that referenced them.
  const errors: string[] = [];

  // 3a. driver-photos · drivers.photo_path stores the bucket-relative
  //     key directly (e.g. "<driver_id>/avatar.jpg").
  const { data: drvPhotos } = await admin
    .from("drivers")
    .select("photo_path")
    .eq("dsp_id", dspId)
    .not("photo_path", "is", null);
  const driverPhotoPaths = (drvPhotos ?? [])
    .map((r) => r.photo_path as string)
    .filter(Boolean);

  // 3b. applicant-videos · applicants.video_url stores the FULL URL.
  //     Extract just the bucket-relative path.
  const { data: appVideos } = await admin
    .from("applicants")
    .select("video_url")
    .eq("dsp_id", dspId)
    .not("video_url", "is", null);
  const applicantVideoPaths = (appVideos ?? [])
    .map((r) => extractStoragePath(r.video_url as string, "applicant-videos"))
    .filter((p): p is string => !!p);

  // 3c. driver-chat-attachments · driver_messages.attachment_path
  //     stores the key directly under the bucket.
  const { data: chatAtt } = await admin
    .from("driver_messages")
    .select("attachment_path")
    .eq("dsp_id", dspId)
    .not("attachment_path", "is", null);
  const driverChatPaths = (chatAtt ?? [])
    .map((r) => r.attachment_path as string)
    .filter(Boolean);

  // 3d. driver-documents · driver_documents.file_path
  const { data: drvDocs } = await admin
    .from("driver_documents")
    .select("file_path")
    .eq("dsp_id", dspId)
    .not("file_path", "is", null);
  const driverDocPaths = (drvDocs ?? [])
    .map((r) => r.file_path as string)
    .filter(Boolean);

  // 3e. coaching-attachments · coaching_attachments.storage_path.
  //     The schema has the table named coaching_attachments with a
  //     storage_path column (per migration 0038).  We try / fall
  //     through; older schemas may not have it.
  let coachingPaths: string[] = [];
  try {
    const { data: coach } = await admin
      .from("coaching_attachments")
      .select("storage_path")
      .eq("dsp_id", dspId)
      .not("storage_path", "is", null);
    coachingPaths = (coach ?? [])
      .map((r) => r.storage_path as string)
      .filter(Boolean);
  } catch {
    // Table may not exist on older deploys; skip silently.
  }

  // 3f. message-attachments · keyed by `<dsp_id>/<template_id>/<file>`.
  //     Stored on message_templates.attachments / sms_messages.attachments
  //     / email_messages.attachments as JSONB arrays, but easier to
  //     just list under the dsp_id prefix.
  const messageAttPaths = await listAllUnder(admin, "message-attachments", dspId);

  // 4. Gather auth.users IDs to delete.
  const { data: appUsers } = await admin
    .from("app_users")
    .select("id, email")
    .eq("dsp_id", dspId);
  const authUserIds = (appUsers ?? []).map((u) => u.id as string);

  // 5. DB cascade · DELETE the dsp row.  Every dsp_id-referencing
  // table has ON DELETE CASCADE, so this nukes 30+ tenant-scoped
  // tables in one shot.
  const { error: dspDelErr } = await admin.from("dsps").delete().eq("id", dspId);
  if (dspDelErr) {
    return jsonResponse({
      ok: false,
      stage: "db_delete",
      error: dspDelErr.message,
    }, { status: 500, headers: CORS });
  }

  // 6. Storage cleanup · per bucket, batches of 100 (Supabase
  // storage's remove() takes an array; no documented hard limit but
  // 100 is safe).
  const buckets: { bucket: string; paths: string[] }[] = [
    { bucket: "driver-photos",            paths: driverPhotoPaths },
    { bucket: "applicant-videos",         paths: applicantVideoPaths },
    { bucket: "driver-chat-attachments",  paths: driverChatPaths },
    { bucket: "driver-documents",         paths: driverDocPaths },
    { bucket: "coaching-attachments",     paths: coachingPaths },
    { bucket: "message-attachments",      paths: messageAttPaths },
  ];
  let storageDeleted = 0;
  for (const { bucket, paths } of buckets) {
    if (!paths.length) continue;
    for (let i = 0; i < paths.length; i += 100) {
      const batch = paths.slice(i, i + 100);
      const { error } = await admin.storage.from(bucket).remove(batch);
      if (error) errors.push(`storage:${bucket}: ${error.message}`);
      else       storageDeleted += batch.length;
    }
  }

  // 7. Auth user cleanup · delete each auth.users entry whose
  // app_users row was just cascade-removed.  Best-effort; partial
  // failures don't roll back (DB delete already happened, can't
  // un-cascade).
  let authDeleted = 0;
  for (const userId of authUserIds) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) errors.push(`auth:${userId}: ${error.message}`);
    else       authDeleted++;
  }

  return jsonResponse({
    ok: true,
    db_deleted:               (targetDsp as { name?: string }).name ?? null,
    auth_users_deleted:       authDeleted,
    storage_objects_deleted:  storageDeleted,
    errors,
  }, { headers: CORS });
});
