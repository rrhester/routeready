// vehicle-document-fetch · returns a short-lived signed URL for the
// driver's assigned van's insurance / registration document.
//
// The driver app uses the anon key and lacks RLS access to the
// `vehicle-documents` bucket; this service-role function does the
// ownership check (via driver_vehicle_document_view, which validates
// the session token, confirms the document belongs to the driver's
// resolved van, and logs the audit event), then mints the signed URL.
//
// Same shape as driver-document-fetch (the e-signature flow) so the
// frontend pattern is identical.
//
// Auth: the driver's session token in the request body. No bearer
// header — same model as driver_chat_list / driver_chat_send.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { serviceClient } from "../_shared/supabase.ts";

interface FetchPayload {
  token?: string;
  vehicle_document_id?: string;
}

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
  if (!payload?.token || !payload?.vehicle_document_id) {
    return badRequest("missing_token", 400);
  }

  const ip = (req.headers.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim() || null;
  const ua = req.headers.get("user-agent") || null;

  console.log("invoke", {
    token: px(payload.token),
    vehicle_document_id: px(payload.vehicle_document_id),
    ip, ua_len: ua?.length ?? 0,
  });

  const supa = serviceClient();

  const { data: viewResult, error: viewErr } = await supa.rpc(
    "driver_vehicle_document_view",
    {
      p_token:               payload.token,
      p_vehicle_document_id: payload.vehicle_document_id,
      p_ip:                  ip,
      p_user_agent:          ua,
    },
  );
  if (viewErr) {
    console.error("driver_vehicle_document_view error", {
      code:    (viewErr as { code?: string }).code,
      message: viewErr.message,
      details: (viewErr as { details?: string }).details,
      hint:    (viewErr as { hint?: string }).hint,
    });
    return jsonResponse(
      {
        error:   viewErr.message || "view_failed",
        code:    (viewErr as { code?: string }).code   ?? null,
        details: (viewErr as { details?: string }).details ?? null,
        hint:    (viewErr as { hint?: string }).hint   ?? null,
      },
      { status: 400 },
    );
  }

  const r = viewResult as Record<string, unknown> | null;
  const filePath = r?.file_path as string | undefined;
  if (!filePath) return badRequest("no_file", 404);

  const { data: urlData, error: urlErr } = await supa.storage
    .from("vehicle-documents")
    .createSignedUrl(filePath, 60 * 30);
  if (urlErr || !urlData?.signedUrl) {
    console.error("signed url failed", { message: urlErr?.message });
    return badRequest("signed_url_failed: " + (urlErr?.message ?? "unknown"), 500);
  }

  return jsonResponse({
    vehicle_document_id: r?.vehicle_document_id,
    kind:                r?.kind,
    file_name:           r?.file_name,
    file_mime:           r?.file_mime,
    expiration_date:     r?.expiration_date,
    signed_url:          urlData.signedUrl,
  });
});
