// Reads the caller DSP's connected Google Calendar events for a window so the
// dashboard can overlay them on the RouteReady calendar (read-only). JWT-gated;
// browser-called via supabase.functions.invoke → needs CORS.
//
// We exclude any Google events that RouteReady itself pushed (matched by
// cal_events.google_event_id) so interviews don't show up twice.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { getAccessToken, gcalListEvents, type GCalAccount } from "../_shared/google_calendar.ts";

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
    .select("dsp_id, google_email, calendar_id, refresh_token_enc, refresh_token_iv, access_token_enc, access_token_iv, access_token_expires_at")
    .eq("dsp_id", appUser.dsp_id).maybeSingle();
  if (!acct) return jsonResponse({ connected: false, events: [] }, { headers: CORS });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* empty body ok */ }
  const now = Date.now();
  const timeMin = body.timeMin || new Date(now - 7 * 864e5).toISOString();
  const timeMax = body.timeMax || new Date(now + 60 * 864e5).toISOString();

  try {
    const token = await getAccessToken(supa, acct as GCalAccount);
    let events = await gcalListEvents(token, acct.calendar_id || "primary", timeMin, timeMax);
    // Drop events RouteReady pushed to Google (avoid duplicating interviews).
    const { data: mine } = await supa.from("cal_events")
      .select("google_event_id").eq("dsp_id", appUser.dsp_id).not("google_event_id", "is", null);
    const ours = new Set((mine || []).map((r) => r.google_event_id));
    events = events.filter((e) => !ours.has(e.id));
    return jsonResponse({ connected: true, email: acct.google_email, events }, { headers: CORS });
  } catch (e) {
    return jsonResponse(
      { connected: true, events: [], error: String((e as Error)?.message || e) },
      { headers: CORS },
    );
  }
});
