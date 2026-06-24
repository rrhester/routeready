// Creates a Google Doc / Sheet / Slide for the caller's DSP, files it into the
// RouteReady Vault (a drive_documents row, is_google_file=true), and links it to
// the operational record in context (e.g. a driver). JWT-gated; browser-called
// via supabase.functions.invoke → needs CORS.
//
// Reuses the Calendar Google connection + token store (one connection per DSP),
// which must carry the drive.file scope (added to google-oauth-start). If the
// DSP hasn't connected, or hasn't re-consented for Drive, we return a soft
// {error} with HTTP 200 so the dashboard can prompt cleanly.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import {
  getAccessToken, hasDriveScope, driveCreate, driveCopy, GOOGLE_MIME, type GCalAccount,
} from "../_shared/google_drive.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SUBS = ["Coaching", "Attendance", "Warnings", "Employment", "DOT", "Licenses", "Documents"];
const soft = (error: string, extra: Record<string, unknown> = {}) =>
  jsonResponse({ error, ...extra }, { headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });
  const dspId = appUser.dsp_id;

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty ok */ }

  const kind = String(body.kind || "document");
  if (!GOOGLE_MIME[kind]) return soft("bad_kind");
  const name = String(body.name || "Untitled").slice(0, 240);

  const { data: acct } = await supa.from("google_calendar_accounts")
    .select("dsp_id, google_email, calendar_id, scope, refresh_token_enc, refresh_token_iv, access_token_enc, access_token_iv, access_token_expires_at")
    .eq("dsp_id", dspId).maybeSingle();
  if (!acct) return soft("not_connected");
  if (!hasDriveScope(acct.scope)) return soft("no_drive_scope");

  try {
    const token = await getAccessToken(supa, acct as GCalAccount);

    // Optional template copy. Templates are app-owned Google Docs mapped per DSP
    // in a future google_templates table; until that exists we create a blank
    // Doc with the supplied (already RouteReady-named) title.
    let tplId: string | null = null;
    if (body.template) {
      try {
        const { data: tpl } = await supa.from("google_templates")
          .select("google_file_id").eq("dsp_id", dspId).eq("template_key", String(body.template)).maybeSingle();
        tplId = tpl?.google_file_id || null;
      } catch (_) { tplId = null; }
    }
    const file = tplId ? await driveCopy(token, tplId, name) : await driveCreate(token, name, GOOGLE_MIME[kind]);

    const driverId = body.driver_id || null;
    const folderId = body.folder_id || null;
    const subRaw = String(body.subfolder || "");
    const subfolder = driverId ? (SUBS.includes(subRaw) ? subRaw : "Documents") : null;
    const nowIso = new Date().toISOString();

    const row = {
      dsp_id: dspId,
      folder_id: folderId,
      driver_id: driverId,
      name: file.name || name,
      doc_type: body.document_type || (driverId ? subfolder : null),
      category: folderId ? "custom" : (driverId ? "drivers" : null),
      subfolder,
      source: "google",
      is_google_file: true,
      google_file_id: file.id,
      google_drive_url: file.webViewLink,
      google_mime_type: file.mimeType,
      related_entity_type: driverId ? "driver" : null,
      related_entity_id: driverId,
      permissions_status: "ok",
      modified_at: file.modifiedTime || nowIso,
      last_synced_at: nowIso,
      created_by: user.id,
      metadata: { drive_title: file.name || name, drive_created_by: acct.google_email || "" },
    };

    const { data: ins, error } = await supa.from("drive_documents").insert(row).select("id").single();
    if (error) {
      // The Google file exists in Drive, but couldn't be filed into the Vault.
      const m = String(error.message || "");
      if (/is_google_file|google_file_id|does not exist|schema cache|42703|42P01/i.test(m))
        return soft("needs_migration", { detail: m });
      return soft("filing_failed", { detail: m });
    }

    return jsonResponse({
      ok: true, id: ins.id, name: file.name || name,
      google_file_id: file.id, google_drive_url: file.webViewLink, google_mime_type: file.mimeType,
    }, { headers: CORS });
  } catch (e) {
    // deno-lint-ignore no-explicit-any
    const status = (e as any)?.status;
    const msg = String((e as Error)?.message || e);
    if (status === 401 || status === 403 || /insufficient|scope|forbidden/i.test(msg)) return soft("needs_reauth", { detail: msg });
    return soft("create_failed", { detail: msg });
  }
});
