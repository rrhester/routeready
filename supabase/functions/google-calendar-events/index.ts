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
    .select("dsp_id, google_email, calendar_id, refresh_token_enc, refresh_token_iv, access_token_enc, access_token_iv, access_token_expires_at, overlay_calendar_ids")
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

    // "Which calendars can we overlay?" (calendar 100-list #68) — the row's
    // ⋯ menu lists them and stores the chosen ids on the account.
    if (body.action === "list_calendars") {
      const res = await fetch("https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader", {
        headers: { authorization: `Bearer ${token}` },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || String(res.status));
      // deno-lint-ignore no-explicit-any
      const calendars = ((json.items || []) as any[]).map((c) => ({
        id: String(c.id), name: c.summaryOverride || c.summary || c.id,
        primary: !!c.primary, color: c.backgroundColor || null,
      }));
      const selected = Array.isArray(acct.overlay_calendar_ids) && acct.overlay_calendar_ids.length
        ? acct.overlay_calendar_ids
        : [acct.calendar_id || "primary"];
      return jsonResponse({ connected: true, calendars, selected }, { headers: CORS });
    }

    // Overlay across every selected calendar (default: the account's primary).
    const calIds: string[] = Array.isArray(acct.overlay_calendar_ids) && acct.overlay_calendar_ids.length
      ? acct.overlay_calendar_ids.slice(0, 8)
      : [acct.calendar_id || "primary"];
    let events: Awaited<ReturnType<typeof gcalListEvents>> = [];
    for (const cid of calIds) {
      try {
        const list = await gcalListEvents(token, cid, timeMin, timeMax);
        events = events.concat(list);
      } catch (_) { /* one broken calendar shouldn't sink the overlay */ }
    }
    // Drop events RouteReady pushed to Google (avoid duplicating interviews).
    const { data: mine } = await supa.from("cal_events")
      .select("google_event_id").eq("dsp_id", appUser.dsp_id).not("google_event_id", "is", null);
    const ours = new Set((mine || []).map((r) => r.google_event_id));
    events = events.filter((e) => !ours.has(e.id));
    events.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
    return jsonResponse({ connected: true, email: acct.google_email, events }, { headers: CORS });
  } catch (e) {
    return jsonResponse(
      { connected: true, events: [], error: String((e as Error)?.message || e) },
      { headers: CORS },
    );
  }
});
