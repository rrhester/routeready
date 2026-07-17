// Mirrors an interview/orientation/event cal_event into the DSP's Outlook
// calendar (calendar 100-list #63) — the Microsoft twin of
// google-calendar-sync. Fired by the cal_events trigger
// (private.fire_mscal_sync) via pg_net; gated by the shared sync token.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { timingSafeEqual } from "../_shared/http.ts";
import { getMsAccessToken, msEventCreate, msEventUpdate, msEventDelete, type MsCalAccount } from "../_shared/ms_graph.ts";

const isGone = (e: unknown) => /\b(404|410)\b|not.?found|\bgone\b|ErrorItemNotFound/i.test(String(e));

Deno.serve(async (req) => {
  // Timing-safe compare; an unset env token must REJECT (never match empty).
  const _syncTok = Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN") || "";
  if (!_syncTok || !timingSafeEqual(req.headers.get("x-rr-sync-token") || "", _syncTok)) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  const { cal_event_id, op } = body;
  if (!cal_event_id) return jsonResponse({ error: "cal_event_id required" }, { status: 400 });

  const supa = serviceClient();

  if (op === "delete") {
    const dspId = body.dsp_id;
    const mid = body.ms_event_id;
    if (!dspId || !mid) return jsonResponse({ ok: true, skipped: "nothing_to_delete" });
    const { data: acct } = await supa.from("ms_calendar_accounts")
      .select("*").eq("dsp_id", dspId).maybeSingle();
    if (!acct) return jsonResponse({ ok: true, skipped: "not_connected" });
    try {
      const token = await getMsAccessToken(supa, acct as MsCalAccount);
      await msEventDelete(token, mid);
      return jsonResponse({ ok: true, deleted: true });
    } catch (e) {
      if (isGone(e)) return jsonResponse({ ok: true, deleted: "already_gone" });
      return jsonResponse({ error: String(e) }, { status: 500 });
    }
  }

  const { data: ev } = await supa.from("cal_events")
    .select("id,dsp_id,applicant_id,kind,status,starts_at,ends_at,timezone,location,meeting_url,title,metadata,ms_event_id")
    .eq("id", cal_event_id).maybeSingle();

  const dspId = ev?.dsp_id;
  if (!dspId) return jsonResponse({ ok: true, skipped: "no_event" });
  if (ev?.metadata && (ev.metadata as Record<string, unknown>).is_task === true) {
    return jsonResponse({ ok: true, skipped: "task" });
  }

  const { data: acct } = await supa.from("ms_calendar_accounts")
    .select("*").eq("dsp_id", dspId).maybeSingle();
  if (!acct) return jsonResponse({ ok: true, skipped: "not_connected" });

  try {
    const token = await getMsAccessToken(supa, acct as MsCalAccount);

    // Same privacy posture as the Google push: interviews carry only the
    // applicant's name — never internal notes.
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
    const payload = { title, description, startsAt: ev!.starts_at, endsAt: ev!.ends_at, timezone: ev!.timezone };
    const cancelled = ["cancelled", "no_show"].includes(ev?.status ?? "");

    if (cancelled && ev?.ms_event_id) {
      try { await msEventDelete(token, ev.ms_event_id); }
      catch (e) { if (!isGone(e)) throw e; }
      await supa.from("cal_events").update({
        ms_event_id: null, ms_sync_status: "synced", ms_sync_error: null, ms_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    } else if (!cancelled && ev?.ms_event_id) {
      try {
        await msEventUpdate(token, ev.ms_event_id, payload);
      } catch (e) {
        if (!isGone(e)) throw e;
        const created = await msEventCreate(token, payload);
        await supa.from("cal_events").update({ ms_event_id: (created as { id: string }).id }).eq("id", cal_event_id);
      }
      await supa.from("cal_events").update({
        ms_sync_status: "synced", ms_sync_error: null, ms_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    } else if (!cancelled) {
      const created = await msEventCreate(token, payload);
      await supa.from("cal_events").update({
        ms_event_id: (created as { id: string }).id,
        ms_sync_status: "synced", ms_sync_error: null, ms_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    await supa.from("cal_events").update({
      ms_sync_status: "error", ms_sync_error: String(e).slice(0, 500),
    }).eq("id", cal_event_id);
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
});
