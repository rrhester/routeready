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
import { serviceClient } from "../_shared/supabase.ts";

interface FetchPayload {
  token?: string;
  signing_token?: string;
}

// Now deployed --no-verify-jwt, so the Supabase gateway no longer
// injects CORS headers for us — the function must respond to the
// browser's preflight + tag every response itself.
const CORS = {
  "access-control-allow-origin":  "*",
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

const px = (s: string | undefined | null) => (s ? s.slice(0, 8) : "(none)");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const payload = (await req.json().catch(() => ({}))) as FetchPayload;
  if (!payload?.token || !payload?.signing_token) {
    console.log("missing token", { hasToken: !!payload?.token, hasSig: !!payload?.signing_token });
    return badRequest("missing_token", 400);
  }

  const ip = (req.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim() || null;
  const ua = req.headers.get("user-agent") || null;

  console.log("invoke", {
    token: px(payload.token),
    signing_token: px(payload.signing_token),
    ip, ua_len: ua?.length ?? 0,
  });

  const supa = serviceClient();

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
    // Log the FULL error so we can see Postgres code / details / hint
    // alongside the message — Supabase JS sometimes hides the useful
    // bits in those fields rather than .message.
    console.error("driver_envelope_view error", {
      code:    (viewErr as { code?: string }).code,
      message: viewErr.message,
      details: (viewErr as { details?: string }).details,
      hint:    (viewErr as { hint?: string }).hint,
    });
    // Stable error code only — the full PostgREST fields above go to logs.
    // Echoing code/details/hint to a token-authenticated public caller was
    // an internals leak (table names, constraint text).
    return jsonResponse({ error: "view_failed" }, { status: 400 });
  }

  const envelope = (viewResult as Record<string, unknown>)?.envelope as Record<string, unknown> | undefined;
  const template = (viewResult as Record<string, unknown>)?.template as Record<string, unknown> | undefined;
  if (!envelope || !template) {
    console.error("invalid_view_result", { viewResult });
    return badRequest("invalid_view_result", 500);
  }

  const sourcePath = template.source_path as string;
  console.log("creating signed url", { sourcePath });
  const { data: urlData, error: urlErr } = await supa.storage
    .from("documents")
    .createSignedUrl(sourcePath, 60 * 60);
  if (urlErr || !urlData?.signedUrl) {
    console.error("signed url failed", { message: urlErr?.message });
    return badRequest("signed_url_failed: " + (urlErr?.message ?? "unknown"), 500);
  }

  console.log("ok", { envelope_id: envelope.id });
  return jsonResponse({
    envelope,
    template,
    signed_url: urlData.signedUrl,
  });
});
