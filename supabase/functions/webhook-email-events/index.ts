// webhook-email-events · Resend deliverability events → email_messages
//
// Resend posts email.delivered / email.bounced / email.complained /
// email.delivery_delayed (Svix-signed) for OUTBOUND mail we sent via
// send-email. This function verifies the signature and forwards the
// event to the SQL side (repair_email_event_apply, migration 0490),
// which stamps email_messages.delivered_at / error_code and flips a
// bounced quote-request email's repair_quote_requests row to 'failed'
// — the one request state the dashboard paints red.
//
// Setup (Resend dashboard → Webhooks → Add endpoint):
//   URL:    https://<project>.functions.supabase.co/webhook-email-events
//   Events: email.delivered, email.bounced, email.complained,
//           email.delivery_delayed
//   Secret: store the endpoint's whsec_… as RESEND_EVENTS_WEBHOOK_SECRET
//           (falls back to RESEND_WEBHOOK_SECRET if you reuse the
//           inbound endpoint's secret).
//
// Matching key: Resend's `data.email_id` — the same id send-email
// stored in email_messages.provider_message_id. Unknown ids and
// unhandled event types return 200 so Resend never retries forever.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64encode(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// Verify a Svix webhook signature (identical scheme + rationale as
// webhook-email-inbound — no timestamp-age check on purpose: Resend
// retries reuse the original svix-timestamp, and the SQL side is
// idempotent per event anyway).
async function verifySvix(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  svixSignatureHeader: string,
): Promise<boolean> {
  const keyMaterial = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw", b64decode(keyMaterial),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
  } catch {
    return false;
  }
  const signed = `${svixId}.${svixTimestamp}.${rawBody}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed));
  const expected = b64encode(mac);
  return svixSignatureHeader
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean)
    .some((sig) => sig === expected);
}

interface EventPayload {
  type?: string;
  data?: {
    email_id?: string;
    id?: string;
    to?: unknown;
    subject?: string;
    bounce?: { message?: string; type?: string; subType?: string };
    failed?: { reason?: string };
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const secret = Deno.env.get("RESEND_EVENTS_WEBHOOK_SECRET")
    || Deno.env.get("RESEND_WEBHOOK_SECRET");
  if (!secret) return badRequest("events_secret_missing", 500);

  const rawBody = await req.text();
  const svixId  = req.headers.get("svix-id");
  const svixTs  = req.headers.get("svix-timestamp");
  const svixSig = req.headers.get("svix-signature");
  if (!svixId || !svixTs || !svixSig) return badRequest("unauthorized", 401);
  if (!(await verifySvix(secret, svixId, svixTs, rawBody, svixSig))) {
    return badRequest("unauthorized", 401);
  }

  let payload: EventPayload = {};
  try { payload = JSON.parse(rawBody || "{}") as EventPayload; } catch { /* keep {} */ }
  const type = String(payload.type ?? "");
  const emailId = payload.data?.email_id ?? payload.data?.id ?? null;
  if (!type || !emailId) return jsonResponse({ ok: true, ignored: "no_event_or_id" });

  // Detail text for the timeline / error_message (bounce reason etc.).
  const detail = payload.data?.bounce?.message
    ?? payload.data?.failed?.reason
    ?? [payload.data?.bounce?.type, payload.data?.bounce?.subType].filter(Boolean).join(" / ")
    ?? null;

  const supa = serviceClient();
  const { data, error } = await supa.rpc("repair_email_event_apply", {
    p_provider_message_id: String(emailId),
    p_event: type,
    p_detail: detail ? String(detail).slice(0, 500) : null,
  });
  if (error) {
    console.error("webhook-email-events:", error.message);
    // 200 anyway — a SQL hiccup shouldn't make Resend hammer retries;
    // deliverability events are best-effort enrichment.
    return jsonResponse({ ok: false, error: "apply_failed" });
  }
  return jsonResponse({ ok: true, ...data });
});
