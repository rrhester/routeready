// webhook-cal · Receives Cal.com booking lifecycle events and writes the
// canonical row into cal_events via book_event / cancel_event /
// complete_event RPCs.
//
// In Cal.com → Settings → Webhooks, point at this URL and subscribe to:
//   BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELLED,
//   MEETING_ENDED, BOOKING_NO_SHOW_UPDATED
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   CAL_WEBHOOK_SECRET   (Cal sends X-Cal-Signature-256 = HMAC-SHA256 of body)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { timingSafeEqual } from "../_shared/http.ts";

async function verifySignature(secret: string, sig: string | null, body: string): Promise<boolean> {
  if (!sig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, sig);
}

interface CalPayload {
  triggerEvent: string;
  payload: {
    bookingId?: number;
    uid?: string;
    title?: string;
    type?: string;             // event-type slug
    startTime?: string;
    endTime?: string;
    location?: string;
    metadata?: Record<string, string>;
    attendees?: Array<{ email?: string; name?: string; timeZone?: string }>;
    organizer?: { timeZone?: string };
    cancellationReason?: string;
    additionalNotes?: string;
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  const raw = await req.text();

  const secret = Deno.env.get("CAL_WEBHOOK_SECRET");
  if (!secret) return badRequest("cal_secret_missing", 500);
  const sigOk = await verifySignature(secret, req.headers.get("x-cal-signature-256"), raw);
  if (!sigOk) return badRequest("bad_signature", 403);

  const data = JSON.parse(raw) as CalPayload;
  const supa = serviceClient();

  const meta = data.payload.metadata ?? {};
  let applicantId = meta.applicant_id ?? null;

  // Fallback: match by attendee email if metadata missing.
  if (!applicantId) {
    const email = data.payload.attendees?.[0]?.email?.toLowerCase();
    if (email) {
      const { data: app } = await supa.from("applicants")
        .select("id").ilike("email", email).limit(1);
      applicantId = app?.[0]?.id ?? null;
    }
  }

  const providerEventId = data.payload.uid ?? (data.payload.bookingId ? String(data.payload.bookingId) : null);
  if (!providerEventId) return jsonResponse({ ok: true, ignored: "no_event_id" });

  // Map Cal event-type slug to our enum.
  const slug = data.payload.type ?? "";
  const kind = /orientation/i.test(slug) ? "orientation" : "interview";

  switch (data.triggerEvent) {
    case "BOOKING_CREATED":
    case "BOOKING_RESCHEDULED": {
      if (!applicantId) return jsonResponse({ ok: true, ignored: "no_applicant" });
      const meetingUrl = data.payload.location?.startsWith("http") ? data.payload.location : null;
      const location   = data.payload.location?.startsWith("http") ? null : data.payload.location;
      const { data: booked } = await supa.rpc("book_event", {
        p_applicant_id: applicantId,
        p_kind: kind,
        p_starts_at: data.payload.startTime,
        p_ends_at: data.payload.endTime,
        p_provider_event_id: providerEventId,
        p_meeting_url: meetingUrl,
        p_location: location,
        p_timezone: data.payload.organizer?.timeZone ?? data.payload.attendees?.[0]?.timeZone ?? null,
      });
      // book_event returns the cal_events row (single composite, but tolerate
      // an array shape just in case) — we pass its id so the confirmation
      // message is linked to the event and shows in the calendar detail.
      const calEventId = Array.isArray(booked) ? booked?.[0]?.id ?? null : (booked as { id?: string } | null)?.id ?? null;
      // Idempotency (project-review PR#63): Cal.com RETRIES failed webhook
      // deliveries, and send_booking_confirmation used to fire on every
      // delivery — duplicate email+SMS to the applicant. Claim
      // (provider_event_id, trigger) first; a conflict means we already
      // confirmed this exact delivery. Table lands in migration 0502 —
      // until then the insert errors and we send (legacy behaviour) rather
      // than drop confirmations.
      let alreadyConfirmed = false;
      {
        const { data: claim, error: claimErr } = await supa.from("cal_webhook_events")
          .upsert(
            { provider_event_id: providerEventId, trigger_event: data.triggerEvent, starts_at: data.payload.startTime ?? "" },
            { onConflict: "provider_event_id,trigger_event,starts_at", ignoreDuplicates: true },
          )
          .select("provider_event_id");
        if (!claimErr && Array.isArray(claim) && claim.length === 0) alreadyConfirmed = true;
        if (claimErr) console.error("cal_webhook_events claim failed (migration 0502 pending?):", claimErr.message);
      }
      if (alreadyConfirmed) return jsonResponse({ ok: true, deduped: true });
      // Replace cal.com's "interview between RouteReady and …" email
      // with our DSP-branded booking_confirmed template. Operator
      // disables cal.com's outgoing confirmation in event-type
      // settings so the applicant only receives one message per book.
      await supa.rpc("send_booking_confirmation", {
        p_applicant_id: applicantId,
        p_starts_at:    data.payload.startTime,
        p_meeting_url:  meetingUrl,
        p_location:     location,
        p_cal_event_id: calEventId,
      });
      break;
    }
    case "BOOKING_CANCELLED": {
      await supa.rpc("cancel_event", {
        p_provider_event_id: providerEventId,
        p_reason: data.payload.cancellationReason ?? null,
      });
      break;
    }
    case "MEETING_ENDED": {
      await supa.rpc("complete_event", {
        p_provider_event_id: providerEventId,
        p_no_show: false,
      });
      break;
    }
    case "BOOKING_NO_SHOW_UPDATED": {
      await supa.rpc("complete_event", {
        p_provider_event_id: providerEventId,
        p_no_show: true,
      });
      break;
    }
    default:
      return jsonResponse({ ok: true, ignored: data.triggerEvent });
  }

  return jsonResponse({ ok: true });
});
