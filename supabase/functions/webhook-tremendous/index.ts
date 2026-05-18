// webhook-tremendous · Receives reward lifecycle events from Tremendous.
//
// In the per-DSP OAuth model, every DSP has their own webhook
// registered on their own Tremendous account during the OAuth
// handshake (tremendous-oauth-callback POSTs the webhook for them).
// To know which DSP's signing secret to validate against, we embed
// the DSP id in the URL path:
//
//   https://<base>/webhook-tremendous/<dsp_id>
//
// Auth: no JWT (--no-verify-jwt at deploy time).  Caller identity is
// proven by the HMAC-SHA256 signature on the body, validated against
// the per-DSP webhook_secret stored in dsp_reward_integrations.
//
// We accept POSTs at the legacy /webhook-tremendous path too — if no
// DSP id is present, we fall back to the global TREMENDOUS_WEBHOOK_SECRET
// env var, so an existing single-tenant deployment keeps working
// during the OAuth migration.

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const PROVIDER_SLUG = "tremendous";

async function verifySignature(rawBody: string, headerSig: string | null, secret: string): Promise<boolean> {
  if (!headerSig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  const got = headerSig.startsWith("sha256=") ? headerSig.slice(7) : headerSig;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Path can be:
  //   /webhook-tremendous            → legacy single-tenant
  //   /webhook-tremendous/<dsp_uuid> → per-DSP route
  const url = new URL(req.url);
  const segments = url.pathname.split("/").filter(Boolean);
  // The function name is always the second-to-last segment for the
  // multi-tenant case, or the last for the legacy case.
  const dspId = segments
    .slice()
    .reverse()
    .find((s) => UUID_RE.test(s)) || null;

  const raw = await req.text();
  const sig = req.headers.get("tremendous-webhook-signature")
           ?? req.headers.get("Tremendous-Webhook-Signature");

  const supa = serviceClient();

  let signingSecret: string | null = null;
  if (dspId) {
    const { data: row } = await supa
      .from("dsp_reward_integrations")
      .select("webhook_secret")
      .eq("dsp_id", dspId)
      .eq("provider", PROVIDER_SLUG)
      .maybeSingle();
    signingSecret = (row?.webhook_secret as string | undefined) ?? null;
  }
  if (!signingSecret) {
    // Legacy / fallback secret — supports a single-tenant deploy until
    // it migrates fully to OAuth.
    signingSecret = Deno.env.get("TREMENDOUS_WEBHOOK_SECRET") || null;
  }
  if (!signingSecret) {
    console.error(`no webhook secret for dsp=${dspId ?? "(none)"}`);
    return badRequest("webhook_secret_missing", 500);
  }

  const ok = await verifySignature(raw, sig, signingSecret);
  if (!ok) {
    console.warn(`tremendous webhook signature rejected for dsp=${dspId ?? "(legacy)"}`);
    return badRequest("bad_signature", 403);
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { return badRequest("invalid_json"); }

  const eventType = String(body.event ?? body.type ?? "").trim();
  const payload   = (body.payload ?? {}) as Record<string, unknown>;
  const rewardId  = String(
    payload.id
    ?? (payload.reward as Record<string, unknown> | undefined)?.id
    ?? (payload.rewards as Array<Record<string, unknown>> | undefined)?.[0]?.id
    ?? "",
  ).trim();

  if (!eventType) return badRequest("event_required");
  if (!rewardId) {
    console.log(`tremendous event ${eventType} carried no reward id; ack`);
    return jsonResponse({ ok: true, applied: false, reason: "no_reward_id" });
  }

  const { data: updatedId, error } = await supa.rpc("reward_webhook_apply", {
    p_provider:           PROVIDER_SLUG,
    p_provider_reward_id: rewardId,
    p_event_type:         eventType,
    p_payload:            payload,
  });

  if (error) {
    console.error("reward_webhook_apply failed", error);
    return badRequest("rpc_failed", 500);
  }
  if (!updatedId) {
    console.log(`tremendous event ${eventType} for unknown reward ${rewardId}; ack`);
    return jsonResponse({ ok: true, applied: false, reason: "no_match" });
  }

  return jsonResponse({ ok: true, applied: true, reward_id: updatedId, event: eventType });
});
