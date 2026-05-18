// tremendous-oauth-callback · Receives Tremendous's redirect after the
// dispatcher grants access.  Exchanges the code for tokens, looks up
// the DSP's funding source, registers a per-DSP webhook so reward
// events route back to webhook-tremendous, and persists everything on
// dsp_reward_integrations.
//
// Public — no JWT required (Tremendous calls us via browser redirect).
// Authentication for the call is the state nonce we minted in
// tremendous-oauth-start, scoped to one DSP and good for 10 minutes.
//
// Env required:
//   TREMENDOUS_OAUTH_CLIENT_ID
//   TREMENDOUS_OAUTH_CLIENT_SECRET
//   TREMENDOUS_OAUTH_REDIRECT_URI   — must match the value used in
//                                     tremendous-oauth-start AND in
//                                     the OAuth app config inside
//                                     Tremendous.
//   PUBLIC_BASE_URL                 — where this function lives, used
//                                     to build the per-DSP webhook URL
//                                     we register on the DSP's account.
//                                     e.g. https://doiwrhkirgblcvuskhno
//                                       .functions.supabase.co
//
// Env optional:
//   TREMENDOUS_OAUTH_TOKEN_URL      — defaults to Tremendous's token
//                                     endpoint.  Override for sandbox.
//   TREMENDOUS_API_BASE             — for the funding-source + webhook
//                                     calls.  Default production; flip
//                                     to testflight for sandbox.
//   DASHBOARD_REWARDS_RETURN_URL    — fallback redirect after the
//                                     handshake if the original
//                                     return_url is missing.

import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const DEFAULT_TOKEN_URL = "https://www.tremendous.com/oauth/token";
const DEFAULT_API_BASE  = "https://api.tremendous.com/api/v2";
const DEFAULT_FALLBACK_RETURN = "https://gorouteready.com/dashboard/#/settings/rewards";

interface TokenResponse {
  access_token?:  string;
  refresh_token?: string;
  expires_in?:    number;
  scope?:         string;
  token_type?:    string;
  // Tremendous tokens carry a team_id on the response.  Defensive
  // fallbacks for documented variants.
  team_id?:       string;
  account_id?:    string;
}

function htmlRedirect(target: string, opts: { ok: boolean; message?: string }): Response {
  const safeTarget = target.replace(/"/g, "&quot;");
  const status = opts.ok ? "connected" : "error";
  const sep = safeTarget.includes("?") ? "&" : "?";
  const finalUrl = `${safeTarget}${sep}rewards_${status}=1${opts.message ? `&rewards_msg=${encodeURIComponent(opts.message)}` : ""}`;
  const body = `<!doctype html><meta charset="utf-8"><title>RouteReady · Rewards</title>
<meta http-equiv="refresh" content="0; url=${finalUrl}">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;padding:40px;text-align:center;color:#0f172a}</style>
<p>${opts.ok ? "Connected to Tremendous — returning to RouteReady…" : "Couldn't complete connection — returning to RouteReady…"}</p>
<p><a href="${finalUrl}">Continue</a></p>`;
  return new Response(body, { status: 302, headers: { "content-type": "text/html; charset=utf-8", "location": finalUrl } });
}

Deno.serve(async (req) => {
  // Tremendous redirects with a GET; tolerate POST too in case they
  // ever switch to form_post response mode.
  if (req.method !== "GET" && req.method !== "POST") return badRequest("method_not_allowed", 405);

  const url = new URL(req.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const errorDesc  = url.searchParams.get("error_description");

  const fallbackReturn = Deno.env.get("DASHBOARD_REWARDS_RETURN_URL") || DEFAULT_FALLBACK_RETURN;

  if (errorParam) {
    return htmlRedirect(fallbackReturn, { ok: false, message: errorDesc || errorParam });
  }
  if (!code || !state) {
    return htmlRedirect(fallbackReturn, { ok: false, message: "missing_code_or_state" });
  }

  const clientId     = Deno.env.get("TREMENDOUS_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("TREMENDOUS_OAUTH_CLIENT_SECRET");
  const redirectUri  = Deno.env.get("TREMENDOUS_OAUTH_REDIRECT_URI");
  const publicBase   = Deno.env.get("PUBLIC_BASE_URL");
  if (!clientId || !clientSecret || !redirectUri || !publicBase) {
    return htmlRedirect(fallbackReturn, { ok: false, message: "oauth_not_configured" });
  }

  const tokenUrl = Deno.env.get("TREMENDOUS_OAUTH_TOKEN_URL") || DEFAULT_TOKEN_URL;
  const apiBase  = Deno.env.get("TREMENDOUS_API_BASE")        || DEFAULT_API_BASE;

  const admin = serviceClient();

  // 1. Validate + consume the state nonce.
  const { data: nonce, error: nErr } = await admin
    .from("oauth_state_nonces")
    .select("dsp_id, user_id, return_url, expires_at")
    .eq("state", state)
    .eq("provider", "tremendous")
    .maybeSingle();
  if (nErr || !nonce) {
    return htmlRedirect(fallbackReturn, { ok: false, message: "state_unknown" });
  }
  if (new Date(nonce.expires_at as string).getTime() < Date.now()) {
    await admin.from("oauth_state_nonces").delete().eq("state", state);
    return htmlRedirect(fallbackReturn, { ok: false, message: "state_expired" });
  }
  // Consume immediately so a replay is rejected.
  await admin.from("oauth_state_nonces").delete().eq("state", state);

  const finalReturn = (nonce.return_url as string | null) || fallbackReturn;
  const dspId = nonce.dsp_id as string;
  const userId = nonce.user_id as string | null;

  // 2. Exchange the code for tokens.
  let tokenJson: TokenResponse = {};
  try {
    const tokRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "accept":       "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        code,
        redirect_uri:  redirectUri,
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    tokenJson = await tokRes.json().catch(() => ({}));
    if (!tokRes.ok || !tokenJson.access_token) {
      console.error("tremendous token exchange failed", tokRes.status, tokenJson);
      return htmlRedirect(finalReturn, { ok: false, message: "token_exchange_failed" });
    }
  } catch (e) {
    console.error("tremendous token exchange network error", e);
    return htmlRedirect(finalReturn, { ok: false, message: "token_exchange_network" });
  }

  const accessToken  = tokenJson.access_token!;
  const refreshToken = tokenJson.refresh_token || null;
  const expiresIn    = typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : null;
  const expiresAt    = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;
  const providerAccountId = tokenJson.team_id || tokenJson.account_id || null;

  // 3. Pick a default funding source — we use the first one the API
  // returns, which is the same default Tremendous's own UI uses for
  // single-funding-source accounts.  Dispatcher can change it later
  // from Tremendous directly.
  let fundingSourceId: string | null = null;
  try {
    const fsRes = await fetch(`${apiBase}/funding_sources`, {
      headers: { "authorization": `Bearer ${accessToken}`, "accept": "application/json" },
    });
    if (fsRes.ok) {
      const fsJson = await fsRes.json();
      const list = Array.isArray(fsJson?.funding_sources) ? fsJson.funding_sources : [];
      if (list.length > 0) fundingSourceId = (list[0]?.id as string) || null;
    } else {
      console.warn("funding_sources lookup failed", fsRes.status);
    }
  } catch (e) {
    console.warn("funding_sources lookup error", e);
  }

  // 4. Register a per-DSP webhook so reward lifecycle events route
  // back to webhook-tremendous with the right DSP context.  We embed
  // the DSP id in the path; the webhook function uses that to look up
  // the correct signing secret.
  let webhookId: string | null = null;
  let webhookSecret: string | null = null;
  try {
    const whRes = await fetch(`${apiBase}/webhooks`, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${accessToken}`,
        "content-type": "application/json",
        "accept":       "application/json",
      },
      body: JSON.stringify({
        url: `${publicBase.replace(/\/$/, "")}/webhook-tremendous/${dspId}`,
      }),
    });
    if (whRes.ok) {
      const whJson = await whRes.json();
      const wh = whJson?.webhook || whJson;
      webhookId     = (wh?.id as string)          || null;
      webhookSecret = (wh?.private_key as string)
                  ?? (wh?.signing_secret as string)
                  ?? null;
    } else {
      const errBody = await whRes.text().catch(() => "");
      console.warn("webhook registration failed", whRes.status, errBody);
    }
  } catch (e) {
    console.warn("webhook registration error", e);
  }

  // 5. Upsert the integration row.
  const { error: upErr } = await admin
    .from("dsp_reward_integrations")
    .upsert({
      dsp_id:              dspId,
      provider:            "tremendous",
      access_token:        accessToken,
      refresh_token:       refreshToken,
      token_expires_at:    expiresAt,
      provider_account_id: providerAccountId,
      funding_source_id:   fundingSourceId,
      webhook_id:          webhookId,
      webhook_secret:      webhookSecret,
      connected_at:        new Date().toISOString(),
      disconnected_at:     null,
      connected_by:        userId,
      last_error:          null,
      last_error_at:       null,
    }, { onConflict: "dsp_id,provider" });
  if (upErr) {
    console.error("integration upsert failed", upErr);
    return htmlRedirect(finalReturn, { ok: false, message: "db_save_failed" });
  }

  return htmlRedirect(finalReturn, { ok: true });
});
