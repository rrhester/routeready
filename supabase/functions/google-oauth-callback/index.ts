// Google redirects here after consent (public; deploy with --no-verify-jwt).
// Security = the HMAC-signed `state` (verifies origin + binds to dsp/user) and
// the server-side code→token exchange. Returns a tiny page that posts the
// result back to the opener and closes.
import { serviceClient } from "../_shared/supabase.ts";
import { verifyState, encryptSecret } from "../_shared/google_crypto.ts";

function closePage(ok: boolean, msg: string) {
  const origin = Deno.env.get("DASHBOARD_URL") || "*";
  return new Response(
    `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:24px">
     ${ok ? "✅ Google Calendar connected. You can close this window." : "⚠️ " + msg}
     <script>
       try { window.opener && window.opener.postMessage(
         { type: "rr-gcal", ok: ${ok}, message: ${JSON.stringify(msg)} }, ${JSON.stringify(origin)}); } catch (e) {}
       setTimeout(function(){ window.close(); }, ${ok ? 800 : 3000});
     </script></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  const err = u.searchParams.get("error");
  if (err) return closePage(false, "Authorization cancelled: " + err);

  const code = u.searchParams.get("code") || "";
  const state = await verifyState(u.searchParams.get("state") || "");
  if (!code || !state) return closePage(false, "Invalid or expired authorization. Please retry.");

  // Exchange the code for tokens.
  const tokRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      redirect_uri: Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI")!,
    }),
  });
  const tok = await tokRes.json();
  if (!tokRes.ok || !tok.refresh_token) {
    // No refresh_token usually = already-consented; prompt=consent should avoid this.
    return closePage(false, "Could not obtain a refresh token. Remove RouteReady at myaccount.google.com and retry.");
  }

  // Identify the Google account.
  const me = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { authorization: `Bearer ${tok.access_token}` },
  }).then((r) => r.json());

  const supa = serviceClient();
  const rt = await encryptSecret(tok.refresh_token);
  const at = await encryptSecret(tok.access_token);
  const { error } = await supa.from("google_calendar_accounts").upsert({
    dsp_id: state.dsp_id,
    google_email: me.email,
    calendar_id: "primary",
    refresh_token_enc: rt.ct, refresh_token_iv: rt.iv,
    access_token_enc: at.ct, access_token_iv: at.iv,
    access_token_expires_at: new Date(Date.now() + (tok.expires_in ?? 3600) * 1000).toISOString(),
    scope: tok.scope, connected_by: state.user_id, updated_at: new Date().toISOString(),
  }, { onConflict: "dsp_id" });

  return error ? closePage(false, "Storage error: " + error.message) : closePage(true, "ok");
});
