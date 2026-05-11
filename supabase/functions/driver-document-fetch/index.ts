// driver-document-fetch · returns the envelope payload + a short-lived
// signed URL for the source PDF so the driver PWA can render it.
//
// The driver app uses the anon key and lacks RLS access to the
// `documents` bucket; this service-role function does the ownership
// check (via driver_envelope_view, which validates the session token,
// confirms the envelope belongs to this driver, flips status to viewed
// on first open, and logs the audit event), then mints the signed URL.
//
// Auth: the driver's session token in the request body. No bearer
// header — same model as driver_chat_list / driver_chat_send.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

interface FetchPayload {
  token?: string;
  signing_token?: string;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const payload = (await req.json().catch(() => ({}))) as FetchPayload;
  if (!payload?.token || !payload?.signing_token) {
    return badRequest("missing_token", 400);
  }

  // Capture caller metadata for the audit chain. The Supabase edge
  // gateway preserves x-forwarded-for for the client IP; user-agent
  // is the standard browser header.
  const ip = (req.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim() || null;
  const ua = req.headers.get("user-agent") || null;

  const supa = serviceClient();

  // Validate session + envelope ownership; flip to viewed on first open.
  const { data: viewResult, error: viewErr } = await supa.rpc(
    "driver_envelope_view",
    {
      p_token:         payload.token,
      p_signing_token: payload.signing_token,
      p_ip:            ip,
      p_user_agent:    ua,
    },
  );
  if (viewErr) {
    // driver_validate_token raises 'unauthorized' / 'revoked' / 'inactive'
    // on a bad token; envelope_not_found surfaces as 'envelope_not_found'.
    const msg = String(viewErr.message || "");
    if (/unauthorized|revoked|inactive/i.test(msg)) return badRequest("unauthorized", 401);
    if (/envelope_not_found/i.test(msg))            return badRequest("envelope_not_found", 404);
    return badRequest(msg || "view_failed", 400);
  }

  const envelope = (viewResult as Record<string, unknown>)?.envelope as Record<string, unknown> | undefined;
  const template = (viewResult as Record<string, unknown>)?.template as Record<string, unknown> | undefined;
  if (!envelope || !template) return badRequest("invalid_view_result", 500);

  const sourcePath = template.source_path as string;
  const { data: urlData, error: urlErr } = await supa.storage
    .from("documents")
    .createSignedUrl(sourcePath, 60 * 60);  // 1 hour
  if (urlErr || !urlData?.signedUrl) {
    return badRequest("signed_url_failed: " + (urlErr?.message ?? "unknown"), 500);
  }

  return jsonResponse({
    envelope,
    template,
    signed_url: urlData.signedUrl,
  });
});
