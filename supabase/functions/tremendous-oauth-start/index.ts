// tremendous-oauth-start · Begins the OAuth handshake for a DSP.
//
// Called by the dashboard's Settings → Rewards → "Connect Tremendous"
// button.  The JWT in the Authorization header tells us which
// dispatcher is connecting — we look up their DSP, mint a CSRF state
// nonce, and return the authorize URL.  The dashboard then redirects
// the browser to that URL; Tremendous handles login + scope approval
// and redirects back to tremendous-oauth-callback with ?code + ?state.
//
// Env required:
//   TREMENDOUS_OAUTH_CLIENT_ID      — from Tremendous → Developers →
//                                     Applications → new app.
//   TREMENDOUS_OAUTH_REDIRECT_URI   — must match what's set in the
//                                     Tremendous OAuth app config.
//                                     Recommended:
//                                     https://doiwrhkirgblcvuskhno
//                                       .functions.supabase.co/
//                                       tremendous-oauth-callback
//
// Env optional:
//   TREMENDOUS_OAUTH_AUTHORIZE_URL  — defaults to Tremendous's
//                                     production authorize endpoint.
//                                     Override to the sandbox URL for
//                                     dev (testflight.tremendous.com).
//   TREMENDOUS_OAUTH_SCOPE          — space-separated scopes.  Default
//                                     covers send + read funding +
//                                     webhook management.
//
// POST body: { return_url?: string }   // where to bounce back to after
//                                       // the handshake completes (e.g.
//                                       // the dashboard's settings URL).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin":  "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const DEFAULT_AUTHORIZE = "https://www.tremendous.com/oauth/authorize";
// Tremendous's documented scope set for sending rewards + managing
// webhooks on behalf of the team.  Adjust if Tremendous renames them
// (their docs use slightly different scope names in sandbox vs prod —
// fall back to what `Developers → Applications → New` shows you when
// you register the OAuth app).
const DEFAULT_SCOPE = "rewards funding_sources webhooks";

function randomState(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST")    return badRequest("method_not_allowed", 405);

  const clientId    = Deno.env.get("TREMENDOUS_OAUTH_CLIENT_ID");
  const redirectUri = Deno.env.get("TREMENDOUS_OAUTH_REDIRECT_URI");
  if (!clientId || !redirectUri) return badRequest("oauth_not_configured", 500);

  const authorizeBase = Deno.env.get("TREMENDOUS_OAUTH_AUTHORIZE_URL") || DEFAULT_AUTHORIZE;
  const scope         = Deno.env.get("TREMENDOUS_OAUTH_SCOPE") || DEFAULT_SCOPE;

  let body: { return_url?: string } = {};
  try { body = await req.json(); } catch { /* allow empty body */ }
  const returnUrl = (body.return_url || "").trim() || null;

  const url  = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return badRequest("server_misconfigured", 500);

  // 1. Resolve caller → DSP.
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth:   { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  if (!userData?.user) return badRequest("not_authenticated", 401);

  const admin = serviceClient();
  const { data: caller } = await admin
    .from("app_users")
    .select("id, dsp_id, role, active")
    .eq("id", userData.user.id)
    .maybeSingle();
  if (!caller)        return badRequest("no_profile", 403);
  if (!caller.active) return badRequest("inactive_caller", 403);
  if (!["dispatcher","ops","owner","platform_admin"].includes(caller.role)) {
    return badRequest("insufficient_role", 403);
  }
  if (!caller.dsp_id) return badRequest("no_dsp", 403);

  // 2. Mint a CSRF state nonce.  Stored server-side with 10-minute
  // TTL; tremendous-oauth-callback validates + deletes it.
  const state = randomState();
  const { error: insErr } = await admin
    .from("oauth_state_nonces")
    .insert({
      state,
      dsp_id:     caller.dsp_id,
      user_id:    caller.id,
      provider:   "tremendous",
      return_url: returnUrl,
    });
  if (insErr) {
    console.error("oauth state insert failed", insErr);
    return badRequest("state_insert_failed", 500);
  }

  // 3. Build the authorize URL and hand it back to the dashboard.
  const params = new URLSearchParams({
    response_type: "code",
    client_id:     clientId,
    redirect_uri:  redirectUri,
    scope,
    state,
  });
  return jsonResponse({ ok: true, authorize_url: `${authorizeBase}?${params.toString()}` }, { headers: CORS });
});
