// interview-room · Creates a Whereby video room for a freshly-booked native
// interview, stores the join URL on the cal_event, and queues the DSP-branded
// confirmation email. Group sessions share ONE room (stored on the session).
// Fired by the cal_events trigger (private.fire_interview_room) via pg_net.
// Deployed --no-verify-jwt; gated by the shared x-rr-sync-token.
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";

const WHEREBY_API = "https://api.whereby.com/v1/meetings";

async function createRoom(endIso: string, group: boolean): Promise<string> {
  const res = await fetch(WHEREBY_API, {
    method: "POST",
    headers: {
      authorization: `Bearer ${(Deno.env.get("WHEREBY_API_KEY") || "").trim()}`,
      "content-type": "application/json",
      "accept": "application/json",
      // A real UA — Deno's default UA is blocked by Whereby's WAF (403 HTML).
      "user-agent": "RouteReady/1.0 (+https://gorouteready.com)",
    },
    body: JSON.stringify({ endDate: endIso, roomMode: group ? "group" : "normal", fields: ["hostRoomUrl"] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.roomUrl) throw new Error("whereby_create_failed: " + (j?.error || res.status));
  return j.roomUrl as string;
}

Deno.serve(async (req) => {
  if (req.headers.get("x-rr-sync-token") !== Deno.env.get("GOOGLE_SYNC_TRIGGER_TOKEN")) {
    return jsonResponse({ error: "unauthorized" }, { status: 401 });
  }
  const { cal_event_id } = await req.json().catch(() => ({}));
  if (!cal_event_id) return jsonResponse({ error: "cal_event_id required" }, { status: 400 });

  const supa = serviceClient();
  const { data: ev } = await supa.from("cal_events")
    .select("id,dsp_id,applicant_id,kind,title,metadata,starts_at,ends_at,meeting_url,interview_session_id,timezone")
    .eq("id", cal_event_id).maybeSingle();
  if (!ev) return jsonResponse({ ok: true, skipped: "no_event" });
  if (ev.meeting_url) return jsonResponse({ ok: true, skipped: "has_url" });
  if (!Deno.env.get("WHEREBY_API_KEY")) return jsonResponse({ ok: true, skipped: "no_key" });

  const endPlus = (iso: string | null) => new Date(new Date(iso || ev.starts_at).getTime() + 60 * 60_000).toISOString();

  // Free-form event (no applicant): invitees come from metadata.invitees.
  const invitees: string[] = Array.isArray(ev.metadata?.invitees)
    ? ev.metadata.invitees.filter((e: unknown) => typeof e === "string" && (e as string).includes("@"))
    : [];

  try {
    let roomUrl: string | null = null;

    if (ev.interview_session_id) {
      // One shared room per group session.
      const { data: s } = await supa.from("interview_sessions")
        .select("id,meeting_url,ends_at,capacity").eq("id", ev.interview_session_id).maybeSingle();
      if (s?.meeting_url) {
        roomUrl = s.meeting_url;
      } else if (s) {
        roomUrl = await createRoom(endPlus(s.ends_at), (s.capacity || 1) > 1);
        await supa.from("interview_sessions").update({ meeting_url: roomUrl }).eq("id", s.id);
      }
    } else {
      roomUrl = await createRoom(endPlus(ev.ends_at), invitees.length > 1);
    }
    if (!roomUrl) return jsonResponse({ ok: true, skipped: "no_room" });

    await supa.from("cal_events").update({ meeting_url: roomUrl }).eq("id", ev.id);

    const tz = ev.timezone || "America/Chicago";
    const when = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    }).format(new Date(ev.starts_at));

    // DSP-branded notification (send-email applies the DSP name + reply-to).
    if (ev.applicant_id) {
      const { data: app } = await supa.from("applicants")
        .select("first_name,full_name,email").eq("id", ev.applicant_id).maybeSingle();
      if (app?.email) {
        const name = app.first_name || (app.full_name || "").split(" ")[0] || "there";
        const body =
`Hi ${name},

Your interview is confirmed for:
${when} (${tz.replace("_", " ")})

Join the video interview here:
${roomUrl}

No app or download needed — just open the link on your phone or computer at your time. Reply to this email if you need to reschedule.`;
        await supa.from("email_messages").insert({
          dsp_id: ev.dsp_id, applicant_id: ev.applicant_id, direction: "outbound", status: "queued",
          to_email: app.email, subject: "Your interview is confirmed", body_text: body,
        });
      }
    } else if (invitees.length > 0) {
      // Free-form event — branded invite to every listed email.
      const title = (ev.title || "You're invited").trim();
      const note = typeof ev.metadata?.note === "string" ? ev.metadata.note.trim() : "";
      const body =
`Hi,

You're invited:
${title}
${when} (${tz.replace("_", " ")})

Join the video meeting here:
${roomUrl}
${note ? "\n" + note + "\n" : ""}
No app or download needed — just open the link on your phone or computer at the time above.`;
      const rows = invitees.map((email) => ({
        dsp_id: ev.dsp_id, direction: "outbound", status: "queued",
        to_email: email, subject: title, body_text: body,
      }));
      await supa.from("email_messages").insert(rows);
    }
    return jsonResponse({ ok: true, room: true });
  } catch (e) {
    return jsonResponse({ error: String(e) }, { status: 500 });
  }
});
