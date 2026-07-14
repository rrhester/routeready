// repair-shop-portal · the no-login shop API behind dashboard/shop.html
//
// A repair shop opens /q/<token> from a quote-request email. The token
// (32 random bytes, hex) is the entire capability — the same model as
// document-verify. Deployed --no-verify-jwt; every action revalidates
// the token server-side via the SECURITY DEFINER repair_portal_* RPCs
// (migration 0487), which are granted to service_role only. Tokens are
// stored hashed; expiry/revocation/abuse ceilings live in SQL.
//
// Input: POST { token, action, ...payload }
//   action "load"       → request + shop-visible case projection, with
//                         short-lived signed URLs for attachments
//   action "save_quote" → { quote, submit } draft or submit
//   action "decline"    → { reason }
//   action "question"   → { message }
//   action "upload"     → { file_name, mime_type, data_base64 }
//
// The shop never sees other shops, competing quotes, internal notes, or
// tenant identifiers — the SQL projection is the boundary.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { serviceClient } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

// Best-effort per-isolate rate limiting (the SQL use_count ceiling is
// the durable backstop): 60 requests/minute per client IP.
const hits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now - h.t > 60_000) { hits.set(ip, { n: 1, t: now }); return false; }
  h.n += 1;
  if (hits.size > 10_000) hits.clear();
  return h.n > 60;
}

const UPLOAD_MAX_BYTES = 15 * 1024 * 1024;
const UPLOAD_MIMES = new Set([
  "application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic",
]);

// Map the machine-readable RPC errors to stable client codes.
function errCode(message: string): { code: string; status: number } {
  if (message.includes("invalid_link"))  return { code: "invalid_link", status: 404 };
  if (message.includes("link_expired"))  return { code: "link_expired", status: 410 };
  if (message.includes("link_revoked"))  return { code: "link_revoked", status: 410 };
  if (message.includes("request_closed")) return { code: "request_closed", status: 409 };
  if (message.includes("message_required")) return { code: "message_required", status: 400 };
  return { code: "portal_error", status: 500 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (rateLimited(ip)) return json({ error: "rate_limited" }, 429);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }

  const token = String(body.token ?? "").trim().toLowerCase();
  const action = String(body.action ?? "load");
  if (!/^[a-f0-9]{32,128}$/.test(token)) return json({ error: "invalid_link" }, 404);

  const supa = serviceClient();
  try {
    if (action === "load") {
      const { data, error } = await supa.rpc("repair_portal_load", { p_token: token });
      if (error) throw error;
      // Mint short-lived signed URLs for the shop-visible attachments.
      const atts = Array.isArray(data?.attachments) ? data.attachments : [];
      const signed = await Promise.all(atts.map(async (a: Record<string, unknown>) => {
        try {
          const { data: s } = await supa.storage
            .from(String(a.storage_bucket || "repair-attachments"))
            .createSignedUrl(String(a.storage_path), 1800);
          return { id: a.id, file_name: a.file_name, mime_type: a.mime_type,
                   url: s?.signedUrl ?? null };
        } catch {
          return { id: a.id, file_name: a.file_name, mime_type: a.mime_type, url: null };
        }
      }));
      return json({ ...data, attachments: signed });
    }

    if (action === "save_quote") {
      const { data, error } = await supa.rpc("repair_portal_save_quote", {
        p_token: token,
        p_quote: body.quote ?? {},
        p_submit: body.submit === true,
      });
      if (error) throw error;
      return json(data);
    }

    if (action === "decline") {
      const { data, error } = await supa.rpc("repair_portal_decline", {
        p_token: token,
        p_reason: typeof body.reason === "string" ? body.reason : null,
      });
      if (error) throw error;
      return json(data);
    }

    if (action === "question") {
      const { data, error } = await supa.rpc("repair_portal_question", {
        p_token: token,
        p_message: typeof body.message === "string" ? body.message : "",
      });
      if (error) throw error;
      return json(data);
    }

    if (action === "upload") {
      const fileName = String(body.file_name ?? "estimate");
      const mime = String(body.mime_type ?? "");
      const b64 = String(body.data_base64 ?? "");
      if (!UPLOAD_MIMES.has(mime)) return json({ error: "unsupported_type" }, 415);
      if (!b64 || b64.length > UPLOAD_MAX_BYTES * 1.4) return json({ error: "file_too_large" }, 413);
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch { return json({ error: "bad_file" }, 400); }
      if (bytes.length === 0) return json({ error: "bad_file" }, 400);
      if (bytes.length > UPLOAD_MAX_BYTES) return json({ error: "file_too_large" }, 413);

      const { data: target, error: tErr } = await supa.rpc("repair_portal_upload_target", {
        p_token: token, p_file_name: fileName,
      });
      if (tErr) throw tErr;

      const { error: upErr } = await supa.storage
        .from(String(target.bucket))
        .upload(String(target.path), bytes.buffer as ArrayBuffer, { contentType: mime, upsert: false });
      if (upErr) return json({ error: "upload_failed" }, 500);

      const { data: reg, error: regErr } = await supa.rpc("repair_portal_register_upload", {
        p_token: token,
        p_storage_path: String(target.path),
        p_file_name: fileName,
        p_mime_type: mime,
        p_byte_size: bytes.length,
      });
      if (regErr) throw regErr;
      return json(reg);
    }

    return json({ error: "bad_action" }, 400);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { code, status } = errCode(msg);
    if (code === "portal_error") console.error("repair-shop-portal:", msg);
    return json({ error: code }, status);
  }
});
