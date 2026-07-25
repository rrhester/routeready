// driver-file-sign · mints a short-lived signed URL for a driver-owned file
// in one of the private driver buckets, AFTER a server-side ownership check.
//
// Part of the fix for launch-audit finding B-1. The driver PWA authenticates
// with the identity-less `anon` role, so it cannot be scoped per-tenant by
// storage RLS. This service-role function validates the driver's session
// token and confirms — via public.driver_can_read_file (migration 0561) —
// that the requested path belongs to that driver (own/teammate photo, own
// document, or an attachment in their own chat thread) before signing. That
// replaces the bucket-wide `anon SELECT` policies (dropped in migration 0562),
// which let any anon-key holder sign any tenant's files.
//
// Same auth model as driver-document-fetch / driver_chat_list: the driver's
// session token in the POST body, no user JWT (deployed --no-verify-jwt).
//
// Request:  POST { token, bucket, path, expires_in? }
// Response: { signed_url }  |  { error }  (400/403/500)
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { serviceClient } from "../_shared/supabase.ts";

interface SignPayload {
  token?: string;
  bucket?: string;
  path?: string;
  expires_in?: number;
}

// Only the three driver-owned private buckets may be signed here.
const ALLOWED_BUCKETS = new Set([
  "driver-photos",
  "driver-documents",
  "driver-chat-attachments",
]);
const MAX_TTL = 60 * 60 * 24 * 7; // 7 days — matches the app's longest reads
const DEFAULT_TTL = 60 * 60;      // 1 hour

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-client-info, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};
function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...CORS, ...(init.headers || {}) },
  });
}
function badRequest(msg: string, status = 400) {
  return jsonResponse({ error: msg }, { status });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const payload = (await req.json().catch(() => ({}))) as SignPayload;
  const token  = payload?.token;
  const bucket = payload?.bucket;
  const path   = payload?.path;

  if (!token || !bucket || !path) return badRequest("missing_params", 400);
  if (!ALLOWED_BUCKETS.has(bucket)) return badRequest("invalid_bucket", 400);

  const ttl = Math.max(
    60,
    Math.min(MAX_TTL, Math.floor(Number(payload?.expires_in)) || DEFAULT_TTL),
  );

  const supa = serviceClient();

  // Ownership check (migration 0561). Fails closed on a bad/revoked token,
  // an unknown bucket, or a path the driver doesn't own.
  const { data: allowed, error: chkErr } = await supa.rpc("driver_can_read_file", {
    p_token:  token,
    p_bucket: bucket,
    p_path:   path,
  });
  if (chkErr) {
    // Stable code to the caller; full detail to the function logs only.
    console.error("driver_can_read_file error", {
      code: (chkErr as { code?: string }).code, message: chkErr.message,
    });
    return jsonResponse({ error: "check_failed" }, { status: 500 });
  }
  if (allowed !== true) {
    return jsonResponse({ error: "forbidden" }, { status: 403 });
  }

  const { data: urlData, error: urlErr } = await supa.storage
    .from(bucket)
    .createSignedUrl(path, ttl);
  if (urlErr || !urlData?.signedUrl) {
    console.error("sign failed", { bucket, message: urlErr?.message });
    return jsonResponse({ error: "sign_failed" }, { status: 500 });
  }

  return jsonResponse({ signed_url: urlData.signedUrl });
});
