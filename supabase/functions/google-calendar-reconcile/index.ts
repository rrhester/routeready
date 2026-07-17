// Daily drift reconciliation between RouteReady and Google Calendar
// (calendar 100-list #88). RouteReady is the source of truth: for every
// upcoming event we previously pushed (google_event_id set), check the copy
// on Google; if it was moved, cancelled, or deleted over there, clear the
// row's sync status — the fire-gcal-sync trigger then re-pushes the truth.
// Fired by pg_cron via pg_net (migration 0498); gated by the shared token.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { timingSafeEqual } from "../_shared/http.ts";
import { getAccessToken, type GCalAccount } from "../_shared/google_calendar.ts";

Deno.serve(async (req) => {
  // Timing-safe compare; an unset env token must REJECT (never match empty).
  const _syncTok = Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN") || "";
  if (!_syncTok || !timingSafeEqual(req.headers.get("x-rr-sync-token") || "", _syncTok)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const supa = serviceClient();
  const { data: accounts } = await supa.from("google_calendar_accounts").select("*");
  if (!accounts?.length) return jsonResponse({ ok: true, checked: 0, repushed: 0 });

  let checked = 0, repushed = 0, failures = 0;
  for (const acct of accounts) {
    let token: string;
    try {
      token = await getAccessToken(supa, acct as GCalAccount);
    } catch (_) { failures++; continue; }
    const calId = encodeURIComponent(acct.calendar_id || "primary");

    const { data: events } = await supa.from("cal_events")
      .select("id, starts_at, ends_at, google_event_id")
      .eq("dsp_id", acct.dsp_id)
      .not("google_event_id", "is", null)
      .in("status", ["scheduled", "rescheduled"])
      .gt("starts_at", new Date().toISOString())
      .order("starts_at")
      .limit(50);

    for (const ev of events || []) {
      checked++;
      let drifted = false;
      try {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(ev.google_event_id)}`,
          { headers: { authorization: `Bearer ${token}` } },
        );
        if (res.status === 404 || res.status === 410) {
          drifted = true;   // deleted on the Google side
        } else if (res.ok) {
          const g = await res.json();
          if (g.status === "cancelled") drifted = true;
          else {
            const gStart = g.start?.dateTime ? Date.parse(g.start.dateTime) : NaN;
            const gEnd = g.end?.dateTime ? Date.parse(g.end.dateTime) : NaN;
            const ours = Date.parse(ev.starts_at);
            const ourEnd = ev.ends_at ? Date.parse(ev.ends_at) : NaN;
            // >60s divergence on either edge = someone moved it in Google.
            if (!isNaN(gStart) && Math.abs(gStart - ours) > 60_000) drifted = true;
            if (!isNaN(gEnd) && !isNaN(ourEnd) && Math.abs(gEnd - ourEnd) > 60_000) drifted = true;
          }
        }
        // Non-OK non-404 responses (rate limits, transient 5xx): skip quietly;
        // tomorrow's run gets another look.
      } catch (_) { continue; }

      if (drifted) {
        // Clearing sync status touches the row → trigger re-pushes our copy.
        const { error } = await supa.from("cal_events")
          .update({ google_sync_status: null, google_sync_error: null })
          .eq("id", ev.id);
        if (!error) repushed++;
      }
    }
  }
  return jsonResponse({ ok: true, checked, repushed, failures });
});
