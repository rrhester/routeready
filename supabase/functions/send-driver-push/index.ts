// send-driver-push · Sends an encrypted Web Push to every active
// subscription for a driver. Uses the standard `web-push` library for
// VAPID JWT signing + RFC 8291 (aes128gcm) payload encryption — that's
// the same library every production Web Push system uses, so we trust
// its crypto rather than rolling our own.
//
// Triggered by the AFTER INSERT trigger on driver_messages (only when
// sender_kind = 'dispatch').
//
// Env required:
//   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point
//   VAPID_PRIVATE_KEY  base64url, 32 raw bytes
//   VAPID_SUBJECT      e.g. mailto:support@gorouteready.com
//
// POST body: { driver_id: uuid, message_id?: uuid }
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import webpush from "npm:web-push@3.6.7";

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  // Diagnostic ack from the driver SW — confirms a push actually
  // reached the device. Logged and short-circuited before auth so the
  // SW can call us without credentials.
  const rawBody = await req.text();
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(rawBody || "{}"); } catch { /* ignore */ }
  if (parsed?.ack === true) {
    console.log(`push ack from device: ${JSON.stringify(parsed).slice(0, 500)}`);
    return jsonResponse({ ok: true });
  }

  const VAPID_PUBLIC  = Deno.env.get("VAPID_PUBLIC_KEY");
  const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE_KEY");
  const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT");
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !VAPID_SUBJECT) {
    return badRequest("vapid_secrets_missing", 500);
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

  const driverId: string | undefined = parsed?.driver_id as string | undefined;
  const messageId: string | undefined = parsed?.message_id as string | undefined;
  if (!driverId) return badRequest("driver_id_required");

  const supa = serviceClient();

  const { data: subs, error: subsErr } = await supa
    .from("driver_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("driver_id", driverId);
  if (subsErr) return badRequest(subsErr.message, 500);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  // Build the notification payload from the triggering message + unread count.
  let title = "Dispatch";
  let bodyText = "New message from dispatch";

  if (messageId) {
    const { data: msg } = await supa
      .from("driver_messages")
      .select("body")
      .eq("id", messageId)
      .single();
    if (msg?.body) {
      const txt = String(msg.body);
      bodyText = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
    }
  }

  const { data: conv } = await supa
    .from("driver_conversations")
    .select("driver_last_read_at")
    .eq("driver_id", driverId)
    .maybeSingle();
  let unreadQuery = supa.from("driver_messages")
    .select("id", { count: "exact", head: true })
    .eq("driver_id", driverId)
    .eq("sender_kind", "dispatch");
  if (conv?.driver_last_read_at) {
    unreadQuery = unreadQuery.gt("created_at", conv.driver_last_read_at);
  }
  const { count: unreadCount } = await unreadQuery;
  const unread = unreadCount ?? 1;

  const payload = JSON.stringify({
    title,
    body: bodyText,
    unread,
    url: "/app/#/chat",
  });

  let sent = 0, failed = 0, removed = 0;

  for (const sub of subs) {
    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };

    try {
      const result = await webpush.sendNotification(subscription, payload, {
        TTL: 60,
        urgency: "high",
      });
      console.log(`push ok endpoint=${sub.endpoint.slice(-12)} status=${result.statusCode}`);
      sent++;
      await supa.from("driver_push_subscriptions")
        .update({
          last_used_at:   new Date().toISOString(),
          last_failed_at: null,
          failure_count:  0,
        })
        .eq("endpoint", sub.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = (err as Error).message || String(err);
      console.warn(`push fail endpoint=${sub.endpoint.slice(-12)} status=${status} message=${message}`);
      if (status === 404 || status === 410) {
        await supa.from("driver_push_subscriptions")
          .delete()
          .eq("endpoint", sub.endpoint);
        removed++;
      } else {
        failed++;
        await supa.from("driver_push_subscriptions")
          .update({ last_failed_at: new Date().toISOString() })
          .eq("endpoint", sub.endpoint);
      }
    }
  }

  return jsonResponse({ sent, failed, removed, total: subs.length });
});
