// webhook-tremendous · Receives reward lifecycle events from Tremendous.
//
// Configure in the Tremendous dashboard (Team Settings → Developers →
// Webhooks → Add):
//   - URL:     https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-tremendous
//   - Secret:  copy the signing secret Tremendous generates and store
//              it as TREMENDOUS_WEBHOOK_SECRET on the Supabase project.
//   - Events:  REWARDS.DELIVERED, REWARDS.LINK_CLICKED, REWARDS.REDEEMED
//              (subscribe to ORDERS.* too if you turn on order approval
//              later; we route every event through the same handler).
//
// Auth: this function is deployed with --no-verify-jwt (it's listed in
// the public-webhook section of deploy-migrations.yml).  Caller
// authentication is entirely via the HMAC-SHA256 signature header.
//
// Payload shape (Tremendous wraps every event identically):
//   {
//     "id":      "<event_id>",
//     "event":   "REWARDS.REDEEMED",
//     "created_at": "...",
//     "payload": {
//       "id":    "<reward_id>",       ← matches driver_rewards.provider_reward_id
//       ...
//     },
//     "meta":    {...}
//   }
//
// We return 200 on every accepted-shape request (even if no row
// matches), so Tremendous doesn't retry-loop on events whose reward
// came from a different environment / different account.  Real
// failures (bad signature, malformed body) return 4xx.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const PROVIDER_SLUG = "tremendous";

// Tremendous signs the raw request body with HMAC-SHA256 using the
// webhook's signing secret.  The hex-encoded digest arrives in the
// `Tremendous-Webhook-Signature` header (lowercase per HTTP).  This
// helper computes our own digest and compares constant-time.
async function verifyTremendousSignature(rawBody: string, headerSig: string | null, secret: string): Promise<boolean> {
  if (!headerSig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Tremendous historically sent the signature as a plain hex string;
  // some webhook tooling adds a `sha256=` prefix.  Accept either.
  const got = headerSig.startsWith("sha256=") ? headerSig.slice("sha256=".length) : headerSig;

  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const secret = Deno.env.get("TREMENDOUS_WEBHOOK_SECRET");
  if (!secret) {
    console.error("TREMENDOUS_WEBHOOK_SECRET not set");
    return badRequest("webhook_secret_missing", 500);
  }

  const raw = await req.text();
  const sig = req.headers.get("tremendous-webhook-signature")
           ?? req.headers.get("Tremendous-Webhook-Signature");
  const ok = await verifyTremendousSignature(raw, sig, secret);
  if (!ok) {
    console.warn("tremendous webhook signature rejected");
    return badRequest("bad_signature", 403);
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { return badRequest("invalid_json"); }

  const eventType = String(body.event ?? body.type ?? "").trim();
  const payload   = (body.payload ?? {}) as Record<string, unknown>;
  // The reward id sits at payload.id for REWARDS.* events.  Defensive
  // fallbacks for adjacent shapes (some Tremendous payloads nest
  // under payload.reward.id, especially older event types).
  const rewardId  = String(
    payload.id
    ?? (payload.reward as Record<string, unknown> | undefined)?.id
    ?? (payload.rewards as Array<Record<string, unknown>> | undefined)?.[0]?.id
    ?? "",
  ).trim();

  if (!eventType) return badRequest("event_required");
  if (!rewardId) {
    // Some Tremendous events (e.g. account-level) carry no reward id.
    // Acknowledge so the dashboard's delivery view shows success, but
    // don't try to mutate.
    console.log(`tremendous event ${eventType} carried no reward id; ack`);
    return jsonResponse({ ok: true, applied: false, reason: "no_reward_id" });
  }

  const supa = serviceClient();
  const { data: updatedId, error } = await supa.rpc("reward_webhook_apply", {
    p_provider:           PROVIDER_SLUG,
    p_provider_reward_id: rewardId,
    p_event_type:         eventType,
    p_payload:            payload,
  });

  if (error) {
    console.error("reward_webhook_apply failed", error);
    // 500 so Tremendous retries — this is OUR transient error, not
    // a payload problem.
    return badRequest("rpc_failed", 500);
  }

  if (!updatedId) {
    // Reward id is real but not in our table — likely a stray event
    // from a different environment.  Ack to stop retries.
    console.log(`tremendous event ${eventType} for unknown reward ${rewardId}; ack`);
    return jsonResponse({ ok: true, applied: false, reason: "no_match" });
  }

  return jsonResponse({ ok: true, applied: true, reward_id: updatedId, event: eventType });
});
