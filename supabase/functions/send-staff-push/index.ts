// send-staff-push · Rings a dispatcher whose dashboard is CLOSED for a
// driver's direct call. Fans an encrypted Web Push out to every active staff
// subscription in the DSP. Mirrors send-driver-push (same web-push library,
// same VAPID secrets) but reads staff_push_subscriptions and deep-links into
// the dashboard.
//
// POST body: { dsp_id: uuid, call: { callId, caller_name, media } }
//   (No room — a driver can't mint one; the dispatcher who answers mints it.)
//
// Env required (same as send-driver-push):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const rawBody = await req.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(rawBody || "{}"); } catch { /* ignore */ }

  // Diagnostic ack from a dashboard SW (parity with send-driver-push).
  if (parsed?.ack === true) {
    console.log(`staff push ack: ${JSON.stringify(parsed).slice(0, 500)}`);
    return jsonResponse({ ok: true });
  }

  const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_SUBJECT) {
    return badRequest("vapid_secrets_missing", 500);
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const dspId = parsed?.dsp_id as string | undefined;
  const call  = parsed?.call as
    { callId?: string; caller_name?: string; media?: string } | undefined;
  // A driver hailing the push-to-talk radio (no ring/answer handshake — just
  // "someone needs you on the radio").
  const radio = parsed?.radio as { caller_name?: string } | undefined;
  if (!dspId) return badRequest("dsp_id_required");
  if (!call && !radio) return badRequest("call_or_radio_required");

  const supa = serviceClient();
  const { data: subs, error: subsErr } = await supa
    .from("staff_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("dsp_id", dspId);
  if (subsErr) return badRequest(subsErr.message, 500);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  let payload: string;
  if (radio) {
    payload = JSON.stringify({
      title: "📻 Driver on the radio",
      body:  `${radio.caller_name || "A driver"} needs you on the radio`,
      // from rides along so the dashboard's boot-time ?rrradio consumer can
      // name the caller in the Join banner it surfaces.
      url:   "/dashboard/?rrradio=1&from=" + encodeURIComponent(radio.caller_name || ""),
      type:  "radio",
    });
  } else {
    const media = call!.media === "audio" ? "audio" : "video";
    const qp = new URLSearchParams({
      rrcall: "1",
      callid: call!.callId || "",
      from:   call!.caller_name || "Driver",
      media,
    });
    payload = JSON.stringify({
      title: `Incoming ${media === "audio" ? "voice" : "video"} call`,
      body:  `${call!.caller_name || "A driver"} is calling`,
      url:   "/dashboard/?" + qp.toString(),
      type:  "call",
    });
  }

  let sent = 0, failed = 0, removed = 0;
  for (const sub of subs) {
    const subscription = { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } };
    try {
      const result = await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: "high" });
      console.log(`staff push ok endpoint=${sub.endpoint.slice(-12)} status=${result.statusCode}`);
      sent++;
      await supa.from("staff_push_subscriptions")
        .update({ last_used_at: new Date().toISOString(), last_failed_at: null, failure_count: 0 })
        .eq("endpoint", sub.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = (err as Error).message || String(err);
      console.warn(`staff push fail endpoint=${sub.endpoint.slice(-12)} status=${status} message=${message}`);
      if (status === 404 || status === 410) {
        await supa.from("staff_push_subscriptions").delete().eq("endpoint", sub.endpoint);
        removed++;
      } else {
        failed++;
        await supa.from("staff_push_subscriptions")
          .update({ last_failed_at: new Date().toISOString() })
          .eq("endpoint", sub.endpoint);
      }
    }
  }
  return jsonResponse({ sent, failed, removed, total: subs.length });
});
