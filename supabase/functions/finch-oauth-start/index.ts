// Returns the Finch Connect authorize URL for the caller's DSP. JWT-gated:
// deployed WITH jwt verification, so the caller's session identifies the DSP.
// Called from the browser via supabase.functions.invoke → needs CORS.
// Mirrors google-oauth-start. The DSP picks their ADP product inside Finch
// Connect; on success Finch redirects to finch-oauth-callback with ?code&state.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { signState, createConnectSession, isConfigured } from "../_shared/finch.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  if (!isConfigured()) return jsonResponse({ error: "finch_not_configured" }, { status: 503, headers: CORS });

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });

  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });

  const state = await signState({ dsp_id: appUser.dsp_id, user_id: user.id, exp: Date.now() + 30 * 60_000 });
  try {
    const url = await createConnectSession({ state, dspId: appUser.dsp_id });
    return jsonResponse({ url }, { headers: CORS });
  } catch (e) {
    return jsonResponse(
      { error: "connect_start_failed", message: e instanceof Error ? e.message : String(e) },
      { status: 502, headers: CORS },
    );
  }
});
