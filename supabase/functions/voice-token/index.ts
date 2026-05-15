// voice-token · Twilio Voice access-token minting for the dashboard softphone.
//
// POST {} — auth required (operator JWT)
//
// Verifies the caller is an active dispatcher/owner in some DSP,
// then mints a short-lived (1-hour) Twilio Access Token with a
// Voice grant scoped to the TwiML App.  The identity embedded in
// the token is `dsp:<dsp_id>|user:<user_id>` so that future
// inbound-routing logic can pin a call to a tenant.
//
// Env (Supabase secrets):
//   TWILIO_ACCOUNT_SID         AC…       (required)
//   TWILIO_API_KEY_SID         SK…       (required, separate from Auth Token)
//   TWILIO_API_KEY_SECRET                (required)
//   TWILIO_TWIML_APP_SID       AP…       (required — the TwiML App that points at voice-twiml)
//   SUPABASE_URL               auto-injected
//   SUPABASE_SERVICE_ROLE_KEY  auto-injected
//   SUPABASE_ANON_KEY          auto-injected
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

// Minimal JWT encoder — Twilio Access Tokens are HS256 JWTs with a
// specific payload shape.  Pulling in the full Twilio Node SDK isn't
// worth the bundle weight when we only need this one operation.
async function signJwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: string,
): Promise<string> {
  const enc = new TextEncoder();
  const b64u = (data: Uint8Array | string) => {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    let b = "";
    for (const x of bytes) b += String.fromCharCode(x);
    return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const h = b64u(JSON.stringify(header));
  const p = b64u(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64u(new Uint8Array(sig))}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
  const API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID");
  const API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET");
  const TWIML_APP_SID = Deno.env.get("TWILIO_TWIML_APP_SID");

  if (!ACCOUNT_SID || !API_KEY_SID || !API_KEY_SECRET || !TWIML_APP_SID) {
    return badRequest("twilio_not_configured", 503);
  }

  // ── Auth: must be an active operator ──────────────────────────
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return badRequest("not_authenticated", 401);

  const admin = serviceClient();
  const { data: profile } = await admin
    .from("app_users")
    .select("id, dsp_id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!profile || !profile.active) return badRequest("not_authorized", 403);
  if (!["owner", "dispatcher"].includes(profile.role)) {
    return badRequest("voice_role_required", 403);
  }

  // ── Build the Access Token ───────────────────────────────────
  // Twilio Access Token spec: HS256 JWT, header has cty + typ, payload
  // has iss=apiKeySid, sub=accountSid, iat, exp, jti, grants={...}.
  const now = Math.floor(Date.now() / 1000);
  const ttlSeconds = 3600;
  const identity = `dsp_${profile.dsp_id}__user_${profile.id}`;

  const header = {
    alg: "HS256",
    typ: "JWT",
    cty: "twilio-fpa;v=1",
  };

  const payload = {
    jti: `${API_KEY_SID}-${now}`,
    iss: API_KEY_SID,
    sub: ACCOUNT_SID,
    iat: now,
    exp: now + ttlSeconds,
    grants: {
      identity,
      voice: {
        incoming: { allow: true },
        outgoing: {
          application_sid: TWIML_APP_SID,
        },
      },
    },
  };

  const token = await signJwt(header, payload, API_KEY_SECRET);

  return jsonResponse(
    { token, identity, expires_at: new Date((now + ttlSeconds) * 1000).toISOString() },
    { headers: CORS },
  );
});
