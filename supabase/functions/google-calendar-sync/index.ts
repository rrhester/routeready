// Mirrors an interview/orientation cal_event into the DSP's Google Calendar.
// Fired by the cal_events trigger (private.fire_gcal_sync) via pg_net.
// Deployed with --no-verify-jwt; gated by the x-rr-sync-token shared secret.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { getAccessToken, gcalCreate, gcalUpdate, gcalDelete } from "../_shared/google_calendar.ts";

Deno.serve(async (req) => {
  if (req.headers.get("x-rr-sync-token") !== Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN")) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const { cal_event_id, op } = await req.json().catch(() => ({}));
  if (!cal_event_id) return jsonResponse({ error: "cal_event_id required" }, { status: 400 });

  const supa = serviceClient();

  const { data: ev } = await supa.from("cal_events")
    .select("id,dsp_id,applicant_id,kind,status,starts_at,ends_at,timezone,location,meeting_url,google_event_id,google_calendar_id")
    .eq("id", cal_event_id).maybeSingle();

  const dspId = ev?.dsp_id;
  if (!dspId) return jsonResponse({ ok: true, skipped: "no_event" });

  const { data: acct } = await supa.from("google_calendar_accounts")
    .select("*").eq("dsp_id", dspId).maybeSingle();
  if (!acct) return jsonResponse({ ok: true, skipped: "not_connected" });

  try {
    const token = await getAccessToken(supa, acct);
    const cal = ev?.google_calendar_id || acct.calendar_id;

    const { data: app } = ev?.applicant_id
      ? await supa.from("applicants").select("full_name,notes").eq("id", ev.applicant_id).maybeSingle()
      : { data: null };
    const title = `Interview · ${app?.full_name || "Applicant"}`;
    const description = [app?.notes, ev?.location, ev?.meeting_url].filter(Boolean).join("\n\n");
    const payload = { title, description, startsAt: ev!.starts_at, endsAt: ev!.ends_at, timezone: ev!.timezone };

    const cancelled = op === "delete" || ["cancelled", "no_show"].includes(ev?.status ?? "");

    if (cancelled && ev?.google_event_id) {
      await gcalDelete(token, cal, ev.google_event_id);
      if (op !== "delete") {
        await supa.from("cal_events").update({
          google_event_id: null, google_sync_status: "synced", google_sync_error: null,
          google_synced_at: new Date().toISOString(),
        }).eq("id", cal_event_id);
      }
    } else if (!cancelled && ev?.google_event_id) {
      await gcalUpdate(token, cal, ev.google_event_id, payload);
      await supa.from("cal_events").update({
        google_sync_status: "synced", google_sync_error: null, google_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    } else if (!cancelled) {
      const created = await gcalCreate(token, cal, payload);
      await supa.from("cal_events").update({
        google_event_id: (created as { id: string }).id, google_calendar_id: cal,
        google_sync_status: "synced", google_sync_error: null, google_synced_at: new Date().toISOString(),
      }).eq("id", cal_event_id);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    await supa.from("cal_events").update({
      google_sync_status: "error", google_sync_error: String(e).slice(0, 500),
    }).eq("id", cal_event_id);
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
});
