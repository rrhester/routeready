// Mirrors an interview/orientation cal_event into the DSP's Google Calendar.
// Fired by the cal_events trigger (private.fire_gcal_sync) via pg_net.
// Deployed with --no-verify-jwt; gated by the x-rr-sync-token shared secret.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { getAccessToken, gcalCreate, gcalUpdate, gcalDelete } from "../_shared/google_calendar.ts";

// A 404/410 from Google means the event is already gone — for a delete that's
// success, not a failure to record forever.
const isGone = (e: unknown) => /\b(404|410)\b|not.?found|\bgone\b/i.test(String(e));

Deno.serve(async (req) => {
  if (req.headers.get("x-rr-sync-token") !== Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN")) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const { cal_event_id, op } = body;
  if (!cal_event_id) return jsonResponse({ error: "cal_event_id required" }, { status: 400 });

  const supa = serviceClient();

  // ── Delete ────────────────────────────────────────────────────────────────
  // The trigger fires AFTER DELETE, so the row is already gone and cannot be
  // re-fetched. The trigger therefore ships the deleted row's Google IDs in the
  // payload; act on those directly (the previous code re-read the missing row,
  // found null, and silently skipped — orphaning every deleted event on Google).
  if (op === "delete") {
    const dspId = body.dsp_id;
    const gid = body.google_event_id;
    const gcal = body.google_calendar_id;
    if (!dspId || !gid) return jsonResponse({ ok: true, skipped: "nothing_to_delete" });
    const { data: acct } = await supa.from("google_calendar_accounts")
      .select("*").eq("dsp_id", dspId).maybeSingle();
    if (!acct) return jsonResponse({ ok: true, skipped: "not_connected" });
    try {
      const token = await getAccessToken(supa, acct);
      await gcalDelete(token, gcal || acct.calendar_id, gid);
      return jsonResponse({ ok: true, deleted: true });
    } catch (e) {
      if (isGone(e)) return jsonResponse({ ok: true, deleted: "already_gone" });
      return jsonResponse({ error: String(e) }, { status: 500 });
    }
  }

  const { data: ev } = await supa.from("cal_events")
    .select("id,dsp_id,applicant_id,kind,status,starts_at,ends_at,timezone,location,meeting_url,title,metadata,google_event_id,google_calendar_id")
    .eq("id", cal_event_id).maybeSingle();

  const dspId = ev?.dsp_id;
  if (!dspId) return jsonResponse({ ok: true, skipped: "no_event" });
  // Tasks live on the RouteReady calendar only (Google models them separately).
  if (ev?.metadata && (ev.metadata as Record<string, unknown>).is_task === true) {
    return jsonResponse({ ok: true, skipped: "task" });
  }

  const { data: acct } = await supa.from("google_calendar_accounts")
    .select("*").eq("dsp_id", dspId).maybeSingle();
  if (!acct) return jsonResponse({ ok: true, skipped: "not_connected" });

  try {
    const token = await getAccessToken(supa, acct);
    const cal = ev?.google_calendar_id || acct.calendar_id;

    // Interviews: only the applicant's name goes to Google — NEVER internal
    // recruiter notes. The event lands on the connecting user's primary
    // calendar, which may be shared, so screening notes/PII must not leak.
    // Free-form events: the composer note is invitee-facing (it already goes
    // in the invite email), so it's safe to carry into the description.
    let title: string, description: string;
    if (ev?.kind === "event") {
      title = (ev.title || "").trim() || "Event";
      const md = (ev.metadata ?? {}) as Record<string, unknown>;
      const note = typeof md.note === "string" ? md.note.trim() : "";
      description = [note, ev.location, ev.meeting_url].filter(Boolean).join("\n\n");
    } else {
      const { data: app } = ev?.applicant_id
        ? await supa.from("applicants").select("full_name").eq("id", ev.applicant_id).maybeSingle()
        : { data: null };
      const word = ev?.kind === "orientation" ? "Orientation" : "Interview";
      title = `${word} · ${app?.full_name || "Applicant"}`;
      description = [ev?.location, ev?.meeting_url].filter(Boolean).join("\n\n");
    }
    // Google Meet as the event's video provider (calendar 100-list #39): the
    // composer stores metadata.video_provider = "google" with no meeting_url;
    // asking Google for a conference here and mirroring hangoutLink back is
    // what turns that into a working Join link.
    const mdAll = (ev?.metadata ?? {}) as Record<string, unknown>;
    const wantsMeet = mdAll.video_provider === "google" && !ev?.meeting_url;
    const payload = { title, description, startsAt: ev!.starts_at, endsAt: ev!.ends_at, timezone: ev!.timezone, requestMeet: wantsMeet };

    const cancelled = ["cancelled", "no_show"].includes(ev?.status ?? "");
    const meetLinkOf = (g: unknown) => {
      const j = g as { hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } };
      return j?.hangoutLink
        || j?.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri
        || null;
    };
    const writeMeet = async (g: unknown) => {
      const link = wantsMeet ? meetLinkOf(g) : null;
      if (link) await supa.from("cal_events").update({ meeting_url: link }).eq("id", cal_event_id);
    };

    if (cancelled && ev?.google_event_id) {
      try {
        await gcalDelete(token, cal, ev.google_event_id);
      } catch (e) {
        if (!isGone(e)) throw e; // already-deleted on Google → treat as done
      }
      await supa.from("cal_events").update({
        google_event_id: null, google_sync_status: "synced", google_sync_error: null,
        google_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    } else if (!cancelled && ev?.google_event_id) {
      try {
        const updated = await gcalUpdate(token, cal, ev.google_event_id, payload);
        await writeMeet(updated);
      } catch (e) {
        // The Google copy was deleted out from under us — recreate it so the
        // link self-heals instead of sticking at 'error' forever.
        if (!isGone(e)) throw e;
        const created = await gcalCreate(token, cal, payload);
        await supa.from("cal_events").update({ google_event_id: (created as { id: string }).id, google_calendar_id: cal }).eq("id", cal_event_id);
        await writeMeet(created);
      }
      await supa.from("cal_events").update({
        google_sync_status: "synced", google_sync_error: null, google_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    } else if (!cancelled) {
      const created = await gcalCreate(token, cal, payload);
      await supa.from("cal_events").update({
        google_event_id: (created as { id: string }).id, google_calendar_id: cal,
        google_sync_status: "synced", google_sync_error: null, google_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
      await writeMeet(created);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    await supa.from("cal_events").update({
      google_sync_status: "error", google_sync_error: String(e).slice(0, 500),
    }).eq("id", cal_event_id);
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
});
