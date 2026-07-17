// Microsoft redirects here after consent (public; deploy with
// --no-verify-jwt). Security = the HMAC-signed state + server-side
// code→token exchange — the same posture as google-oauth-callback. Reuses
// the dashboard's gcal-callback.html landing page to notify the opener.
import { serviceClient } from "../_shared/supabase.ts";
import { verifyState, encryptSecret } from "../_shared/google_crypto.ts";

function closePage(ok: boolean, msg: string) {
  const base = (Deno.env.get("DASHBOARD_URL") || "https://gorouteready.com/dashboard").replace(/\/+$/, "");
  const url = `${base}/gcal-callback.html?ok=${ok ? "1" : "0"}` + (msg ? `&msg=${encodeURIComponent(msg)}` : "");
  return new Response(null, { status: 302, headers: { location: url } });
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const err = u.searchParams.get("error");
  if (err) return closePage(false, "Authorization cancelled: " + err);

  const code = u.searchParams.get("code") || "";
  const state = await verifyState(u.searchParams.get("state") || "");
  if (!code || !state) return closePage(false, "Invalid or expired authorization. Please retry.");

  const tokRes = await fetch("https://login.microsoftonline.com/common/oauth2/v2.0/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: Deno.env.get("MS_CLIENT_ID")!,
      client_secret: Deno.env.get("MS_CLIENT_SECRET")!,
      redirect_uri: Deno.env.get("MS_OAUTH_REDIRECT_URI")!,
      scope: "openid email offline_access User.Read Calendars.ReadWrite",
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok || !tok.refresh_token) {
    return closePage(false, "Could not obtain a Microsoft refresh token — retry the connection.");
  }

  const me = await fetch("https://graph.microsoft.com/v1.0/me", {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then((r) => r.json());
  const email = me.mail || me.userPrincipalName || "";

  const supa = serviceClient();
  const rt = await encryptSecret(tok.refresh_token);
  const at = await encryptSecret(tok.access_token);
  const { error } = await supa.from("ms_calendar_accounts").upsert({
    dsp_id: state.dsp_id,
    ms_email: email,
    refresh_token_enc: rt.ct, refresh_token_iv: rt.iv,
    access_token_enc: at.ct, access_token_iv: at.iv,
    access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    scope: tok.scope, connected_by: state.user_id, updated_at: new Date().toISOString(),
  }, { onConflict: "dsp_id" });

  return error ? closePage(false, "Storage error: " + error.message) : closePage(true, "ok");
});
