// Returns the Google OAuth consent URL for the caller's DSP. JWT-gated:
// deployed WITH jwt verification, so the caller's session identifies the DSP.
// Called from the browser via supabase.functions.invoke → needs CORS.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { signState } from "../_shared/google_crypto.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

const SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  // RouteReady Vault — create + manage only the Google files RouteReady makes
  // (Docs/Sheets/Slides). drive.file is per-file and non-sensitive, so it needs
  // no Google security review and can never see the user's other Drive files.
  "https://www.googleapis.com/auth/drive.file",
].join(" ");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });

  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });

  const state = await signState({ dsp_id: appUser.dsp_id, user_id: user.id, exp: Date.now() + 10 * 60_000 });
  const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
    redirect_uri: Deno.env.get("GOOGLE_OAUTH_REDIRECT_URI")!,
    response_type: "code",
    access_type: "offline",       // → refresh token
    prompt: "consent",            // force a refresh token even on re-consent
    include_granted_scopes: "true",
    scope: SCOPES,
    state,
  });
  return jsonResponse({ url }, { headers: CORS });
});
