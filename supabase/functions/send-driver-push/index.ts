// send-driver-push · Sends an encrypted Web Push to every active
// subscription for a driver. Uses the standard `web-push` library for
// VAPID JWT signing + RFC 8291 (aes128gcm) payload encryption — that's
// the same library every production Web Push system uses, so we trust
// its crypto rather than rolling our own.
//
// Two trigger paths:
//   • driver_messages AFTER INSERT (sender_kind='dispatch') → calls us
//     with { driver_id, message_id }: push to that one driver.
//   • driver_channel_messages AFTER INSERT → calls us with
//     { channel_id, message_id }: fan out to every member of the channel
//     except the sender, skipping muted members.
//
// Env required:
//   VAPID_PUBLIC_KEY   base64url, 65-byte uncompressed P-256 point
//   VAPID_PRIVATE_KEY  base64url, 32 raw bytes
//   VAPID_SUBJECT      e.g. mailto:support@gorouteready.com
//
// POST body: { driver_id: uuid, message_id?: uuid }
//        OR  { channel_id: uuid, message_id: uuid }
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

  const driverId:  string | undefined = parsed?.driver_id  as string | undefined;
  const channelId: string | undefined = parsed?.channel_id as string | undefined;
  const messageId: string | undefined = parsed?.message_id as string | undefined;
  if (!driverId && !channelId) return badRequest("driver_id_or_channel_id_required");

  const supa = serviceClient();

  // ── Channel fan-out path ──
  if (channelId && messageId) {
    return await handleChannelFanOut(supa, channelId, messageId);
  }
  if (!driverId) return badRequest("driver_id_required");

  const { data: subs, error: subsErr } = await supa
    .from("driver_push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("driver_id", driverId);
  if (subsErr) return badRequest(subsErr.message, 500);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  // Build the notification payload from the triggering message + unread count.
  let title = "Dispatch";
  let bodyText = "New message from dispatch";
  // Where tapping the notification lands. Chat messages default to the chat
  // thread; schedule events (offers / swaps / confirmations / publish) carry
  // an explicit link_url so the tap opens the card the driver needs.
  let linkUrl = "/app/#/chat";
  let unread = 1;
  let notifType = "message";

  // ── Direct-call push ──────────────────────────────────────────────
  // POST { driver_id, call: { callId, room, caller_name, media } } rings a
  // driver whose app is CLOSED (a live realtime broadcast can't wake it).
  // Tapping deep-links into the app with ?rrcall= params; on boot the app
  // auto-accepts (broadcasts call-accept) and opens the Meet room, so the
  // waiting caller connects. No DB message lookup for this path.
  const callInfo = parsed?.call as
    { callId?: string; room?: string; caller_name?: string; media?: string } | undefined;

  if (callInfo && callInfo.room) {
    const media = callInfo.media === "audio" ? "audio" : "video";
    title = `Incoming ${media === "audio" ? "voice" : "video"} call`;
    bodyText = `${callInfo.caller_name || "Dispatch"} is calling you`;
    notifType = "call";
    const qp = new URLSearchParams({
      rrcall: "1",
      callid: callInfo.callId || "",
      room:   callInfo.room,
      from:   callInfo.caller_name || "Dispatch",
      media,
    });
    linkUrl = "/app/?" + qp.toString();
  } else {
    if (messageId) {
      const { data: msg } = await supa
        .from("driver_messages")
        .select("body, link_url")
        .eq("id", messageId)
        .single();
      if (msg?.body) {
        const txt = String(msg.body);
        bodyText = txt.length > 80 ? txt.slice(0, 80) + "…" : txt;
      }
      if (msg?.link_url) linkUrl = String(msg.link_url);
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
    unread = unreadCount ?? 1;
  }

  const payload = JSON.stringify({
    title,
    body: bodyText,
    unread,
    url: linkUrl,
    type: notifType,
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


// ── Channel fan-out ──
// Pull the channel + the triggering message; build a single payload;
// loop over every non-muted member except the sender; for each, push to
// every active subscription.  Subscription failure handling matches the
// driver path (404/410 deletes; other errors mark last_failed_at).
async function handleChannelFanOut(
  supa: ReturnType<typeof serviceClient>,
  channelId: string,
  messageId: string,
): Promise<Response> {
  const { data: channel } = await supa
    .from("driver_channels")
    .select("id, name, dsp_id")
    .eq("id", channelId)
    .single();
  if (!channel) return jsonResponse({ sent: 0, total: 0, skipped: "channel_not_found" });

  const { data: msg } = await supa
    .from("driver_channel_messages")
    .select("id, sender_kind, sender_driver_id, body, attachment_name")
    .eq("id", messageId)
    .single();
  if (!msg) return jsonResponse({ sent: 0, total: 0, skipped: "message_not_found" });

  // Sender display name — for "Alice: hi everyone" style preview.
  let senderName = "Dispatch";
  if (msg.sender_kind === "driver" && msg.sender_driver_id) {
    const { data: drv } = await supa
      .from("drivers").select("full_name").eq("id", msg.sender_driver_id).single();
    if (drv?.full_name) senderName = String(drv.full_name);
  }

  const preview = (msg.body || msg.attachment_name || "(attachment)").toString();
  const bodyText = `${senderName}: ${preview.length > 80 ? preview.slice(0, 80) + "…" : preview}`;
  const title = `#${channel.name}`;
  const url = `/app/#/chat`;

  // Members minus the sender, minus anyone muted.  Pull subscriptions
  // for everyone in one shot to keep the loop tight.
  const { data: members } = await supa
    .from("driver_channel_members")
    .select("driver_id, muted, last_read_at")
    .eq("channel_id", channelId);
  const recipients = (members || [])
    .filter(m => !m.muted)
    .filter(m => !(msg.sender_kind === "driver" && m.driver_id === msg.sender_driver_id));
  if (recipients.length === 0) return jsonResponse({ sent: 0, total: 0 });

  const driverIds = recipients.map(m => m.driver_id);
  const { data: subs } = await supa
    .from("driver_push_subscriptions")
    .select("driver_id, endpoint, p256dh, auth")
    .in("driver_id", driverIds);
  if (!subs || subs.length === 0) return jsonResponse({ sent: 0, total: 0 });

  // Per-driver unread count.  Counts every message in the channel
  // posted after that driver's last_read_at — including their own
  // contributions, which is fine for a notification preview.  Cheap:
  // one COUNT per recipient and channels are DSP-scoped.
  async function unreadFor(_driverId: string, lastReadAt: string | null): Promise<number> {
    let q = supa.from("driver_channel_messages")
      .select("id", { count: "exact", head: true })
      .eq("channel_id", channelId);
    if (lastReadAt) q = q.gt("created_at", lastReadAt);
    const { count } = await q;
    return count ?? 1;
  }

  const lastReadByDriver = new Map<string, string | null>();
  for (const m of recipients) lastReadByDriver.set(m.driver_id, m.last_read_at as string | null);

  let sent = 0, failed = 0, removed = 0;
  for (const sub of subs) {
    const lastRead = lastReadByDriver.get(sub.driver_id) ?? null;
    const unread = await unreadFor(sub.driver_id, lastRead);
    const payload = JSON.stringify({ title, body: bodyText, unread, url });

    const subscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      const result = await webpush.sendNotification(subscription, payload, {
        TTL: 60,
        urgency: "high",
      });
      console.log(`channel push ok endpoint=${sub.endpoint.slice(-12)} status=${result.statusCode}`);
      sent++;
      await supa.from("driver_push_subscriptions")
        .update({ last_used_at: new Date().toISOString(), last_failed_at: null, failure_count: 0 })
        .eq("endpoint", sub.endpoint);
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      const message = (err as Error).message || String(err);
      console.warn(`channel push fail endpoint=${sub.endpoint.slice(-12)} status=${status} message=${message}`);
      if (status === 404 || status === 410) {
        await supa.from("driver_push_subscriptions").delete().eq("endpoint", sub.endpoint);
        removed++;
      } else {
        failed++;
        await supa.from("driver_push_subscriptions")
          .update({ last_failed_at: new Date().toISOString() })
          .eq("endpoint", sub.endpoint);
      }
    }
  }

  return jsonResponse({ sent, failed, removed, total: subs.length, channel: channelId });
}
