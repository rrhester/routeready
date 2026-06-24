// Safe Google Workspace status for the Vault banner: is the caller's DSP
// connected, and does the connection carry a Drive scope we can create files
// with? JWT-gated; browser-called via supabase.functions.invoke → needs CORS.
// Reads google_calendar_accounts (service-role; the scope column is never
// exposed to the browser directly) and returns only booleans + the email.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { hasDriveScope } from "../_shared/google_drive.ts";

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
    .select("google_email, scope").eq("dsp_id", appUser.dsp_id).maybeSingle();

  if (!acct) return jsonResponse({ connected: false, drive: false }, { headers: CORS });
  return jsonResponse({ connected: true, drive: hasDriveScope(acct.scope), email: acct.google_email || "" }, { headers: CORS });
});
