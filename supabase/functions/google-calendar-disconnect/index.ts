// Disconnects the caller's DSP from Google Calendar: best-effort token revoke
// at Google, then deletes the stored account. JWT-gated.
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { decryptSecret } from "../_shared/google_crypto.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401 });
  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403 });

  const { data: acct } = await supa.from("google_calendar_accounts")
    .select("refresh_token_enc,refresh_token_iv").eq("dsp_id", appUser.dsp_id).maybeSingle();
  if (acct) {
    try {
      const rt = await decryptSecret(acct.refresh_token_enc, acct.refresh_token_iv);
      await fetch("https://oauth2.googleapis.com/revoke?token=" + encodeURIComponent(rt), { method: "POST" });
    } catch (_) { /* revoke is best-effort */ }
    await supa.from("google_calendar_accounts").delete().eq("dsp_id", appUser.dsp_id);
  }
  return jsonResponse({ ok: true });
});
