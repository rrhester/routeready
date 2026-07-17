// Disconnects the caller's DSP from Outlook: deletes the stored account
// (Microsoft has no simple token-revoke endpoint for refresh tokens — the
// user can revoke app access at myapps.microsoft.com). JWT-gated; CORS for
// supabase.functions.invoke.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

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

  await supa.from("ms_calendar_accounts").delete().eq("dsp_id", appUser.dsp_id);
  return jsonResponse({ ok: true }, { headers: CORS });
});
