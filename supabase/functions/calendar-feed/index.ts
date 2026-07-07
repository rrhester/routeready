// calendar-feed · Read-only ICS subscribe feed (webcal). GET ?t=<token>
// returns a VCALENDAR of the DSP's upcoming events so Google/Apple/Outlook
// can subscribe. Token-secret URL (calendar_feeds, 0433) — same trust model
// as booking/RSVP links; revoking the feed kills the URL.
//
// Content rules mirror the Google push (0367): interview titles carry the
// applicant's name but NEVER recruiter notes; free-form events include
// their invitee-facing composer note. Tasks stay out of feeds.
// Deployed --no-verify-jwt (calendar apps fetch with no auth headers).
import { serviceClient } from "../_shared/supabase.ts";
import { buildIcsFeed, type FeedEvent } from "../_shared/ics.ts";

const WINDOW_PAST_DAYS = 30;
const WINDOW_FUTURE_DAYS = 400;

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("method_not_allowed", { status: 405 });
  const token = (new URL(req.url).searchParams.get("t") || "").trim();
  if (!/^[a-f0-9]{32,80}$/i.test(token)) return new Response("not_found", { status: 404 });

  const supa = serviceClient();
  const { data: feed } = await supa.from("calendar_feeds")
    .select("dsp_id, calendar_id").eq("token", token).maybeSingle();
  if (!feed) return new Response("not_found", { status: 404 });

  const { data: dsp } = await supa.from("dsps").select("name").eq("id", feed.dsp_id).maybeSingle();
  let calName: string | null = null;
  if (feed.calendar_id) {
    const { data: cal } = await supa.from("calendars")
      .select("name").eq("id", feed.calendar_id).maybeSingle();
    calName = cal?.name || null;
  }

  let q = supa.from("cal_events")
    .select("id, kind, status, starts_at, ends_at, timezone, title, location, meeting_url, metadata, applicants:applicant_id (full_name)")
    .eq("dsp_id", feed.dsp_id)
    .in("status", ["scheduled", "rescheduled"])
    .gte("starts_at", new Date(Date.now() - WINDOW_PAST_DAYS * 864e5).toISOString())
    .lte("starts_at", new Date(Date.now() + WINDOW_FUTURE_DAYS * 864e5).toISOString())
    .order("starts_at", { ascending: true })
    .limit(2000);
  if (feed.calendar_id) q = q.eq("calendar_id", feed.calendar_id);
  const { data: rows } = await q;

  const events: FeedEvent[] = [];
  for (const ev of rows || []) {
    const md = (ev.metadata ?? {}) as Record<string, unknown>;
    if (md.is_task === true) continue;
    const isEvent = ev.kind === "event";
    // deno-lint-ignore no-explicit-any
    const who = (ev.applicants as any)?.full_name || "Applicant";
    const title = isEvent
      ? ((ev.title || "").trim() || "Event")
      : `${ev.kind === "orientation" ? "Orientation" : "Interview"} · ${who}`;
    const note = isEvent && typeof md.note === "string" ? md.note.trim() : "";
    const desc = [note, ev.meeting_url ? `Join: ${ev.meeting_url}` : ""].filter(Boolean).join("\n");
    events.push({
      uid: `${ev.id}@gorouteready.com`,
      start: ev.starts_at,
      end: ev.ends_at,
      title,
      description: desc || undefined,
      location: ev.location || ev.meeting_url || undefined,
      allDay: md.all_day === true,
      tzid: ev.timezone || undefined,
    });
  }

  const name = [dsp?.name || "RouteReady", calName].filter(Boolean).join(" · ");
  const body = buildIcsFeed(name, events);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="routeready.ics"',
      "cache-control": "public, max-age=300",
    },
  });
});
