// Returns the Microsoft OAuth consent URL for the caller's DSP (calendar
// 100-list #63 — Outlook calendar push). JWT-gated; browser-called via
// supabase.functions.invoke → needs CORS. Config-gated: without MS_CLIENT_ID
// it answers not_configured instead of erroring.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { signState } from "../_shared/google_crypto.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SCOPES = ["openid", "email", "offline_access", "User.Read", "Calendars.ReadWrite"].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });
  if (!Deno.env.get("MS_CLIENT_ID") || !Deno.env.get("MS_OAUTH_REDIRECT_URI")) {
    return jsonResponse({ error: "not_configured" }, { status: 501, headers: CORS });
  }

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });

  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });

  const state = await signState({ dsp_id: appUser.dsp_id, user_id: user.id, exp: Date.now() + 10 * 60_000 });
  const url = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?" + new URLSearchParams({
    client_id: Deno.env.get("MS_CLIENT_ID")!,
    redirect_uri: Deno.env.get("MS_OAUTH_REDIRECT_URI")!,
    response_type: "code",
    response_mode: "query",
    scope: SCOPES,
    state,
  });
  return jsonResponse({ url }, { headers: CORS });
});
