// export-tenant-files · Owner-only manifest of download links for a tenant's
// document FILES (the bytes the metadata export in export_my_dsp_data can't
// return). Completes the data-portability / DSR story: the JSON export gives
// records, this gives fresh signed URLs to every driver-document file.
//
// v1 returns a link manifest (robust at any tenant size — no server-side
// zipping / memory limit). A streaming ZIP bundle is a reasonable v2.
//
// Auth: owner only. Validates the caller's JWT, requires an ACTIVE app_users
// row with role='owner', and scopes strictly to that owner's dsp_id — it can
// never reach another tenant's files. Gateway verify_jwt off (config.toml); the
// check happens in-code so the browser CORS preflight succeeds.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, GET, OPTIONS",
};
const BUCKET = "driver-documents";
const TTL = 60 * 60;          // 1 hour — enough to pull the files.
const MAX_FILES = 5000;       // hard cap; report if a tenant exceeds it.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });
  }

  // ── Owner-only auth ──────────────────────────────────────────────────────
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });

  const svc = serviceClient();
  let dspId: string;
  try {
    const anon = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!);
    const { data: u, error } = await anon.auth.getUser(token);
    if (error || !u?.user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
    const { data: au } = await svc
      .from("app_users")
      .select("dsp_id, role, active")
      .eq("id", u.user.id)
      .maybeSingle();
    if (!au || au.active !== true || au.role !== "owner" || !au.dsp_id) {
      return jsonResponse({ error: "forbidden", message: "Owner only." }, { status: 403, headers: CORS });
    }
    dspId = au.dsp_id as string;
  } catch {
    return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
  }

  // ── Gather this tenant's document files ──────────────────────────────────
  const { data: docs, error: docErr } = await svc
    .from("driver_documents")
    .select("id, driver_id, kind, label, file_path, mime_type")
    .eq("dsp_id", dspId)
    .not("file_path", "is", null)
    .limit(MAX_FILES + 1);
  if (docErr) return jsonResponse({ error: "query_failed", message: docErr.message }, { status: 500, headers: CORS });

  const rows = (docs ?? []).filter((d) => typeof d.file_path === "string" && d.file_path.length > 0);
  const truncated = rows.length > MAX_FILES;
  const use = truncated ? rows.slice(0, MAX_FILES) : rows;

  // ── Batch-sign (chunks of 100) ───────────────────────────────────────────
  const byPath = new Map<string, string>();
  for (let i = 0; i < use.length; i += 100) {
    const paths = use.slice(i, i + 100).map((d) => d.file_path as string);
    const { data: signed } = await svc.storage.from(BUCKET).createSignedUrls(paths, TTL);
    for (const s of signed ?? []) {
      if (s && !s.error && s.path && s.signedUrl) byPath.set(s.path, s.signedUrl);
    }
  }

  const files = use.map((d) => ({
    driver_id: d.driver_id,
    kind: d.kind,
    name: d.label || (d.file_path as string).split("/").pop() || "document",
    mime_type: d.mime_type ?? null,
    path: d.file_path,
    signed_url: byPath.get(d.file_path as string) ?? null,
  }));

  return jsonResponse({
    dsp_id: dspId,
    generated_at: new Date().toISOString(),
    expires_in_seconds: TTL,
    bucket: BUCKET,
    count: files.length,
    ...(truncated ? { truncated: true, note: `Capped at ${MAX_FILES} files; re-run to fetch the rest.` } : {}),
    files,
  }, { headers: CORS });
});
