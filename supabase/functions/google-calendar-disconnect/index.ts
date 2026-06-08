// Disconnects the caller's DSP from Google Calendar: best-effort token revoke
// at Google, then deletes the stored account. JWT-gated. Browser-called via
// supabase.functions.invoke → needs CORS.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/google_crypto.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });

  const { data: acct } = await supa.from("google_calendar_accounts")
    .select("refresh_token_enc,refresh_token_iv").eq("dsp_id", appUser.dsp_id).maybeSingle();
  if (acct) {
    try {
      const rt = await decryptSecret(acct.refresh_token_enc, acct.refresh_token_iv);
      await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(rt), { method: "POST" });
    } catch (_) { /* revoke is best-effort */ }
    await supa.from("google_calendar_accounts").delete().eq("dsp_id", appUser.dsp_id);
  }
  return jsonResponse({ ok: true }, { headers: CORS });
});
