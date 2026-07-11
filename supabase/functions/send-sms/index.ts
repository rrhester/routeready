// send-sms · Drains queued SMS rows and dispatches via Twilio.
//
// Triggered by a Supabase scheduled function (every 1 min) or directly
// after a queue insert via pg_net. Honors per-DSP quiet hours and aborts
// on TCPA opt-out (any sms_messages row with body matching STOP).
//
// Env required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//   TWILIO_MESSAGING_SERVICE_SID  (preferred; routes from any pool)
//   TWILIO_FROM_NUMBER            (fallback if no messaging service)
//
// POST body (optional): { applicant_id?: uuid, limit?: int }
//   - no body: drain up to 50 oldest queued for any tenant
//   - applicant_id: drain only that applicant's queue (used after RPC)
import { serviceClient, jsonResponse, badRequest, isWithinQuietHours, signMessageAttachment } from "../_shared/supabase.ts";

const TWILIO_BASE = "https://api.twilio.com/2010-04-01";

interface Attachment { name?: string; url?: string; path?: string; content_type?: string; size?: number }
interface QueuedRow {
  id: string;
  dsp_id: string;
  applicant_id: string | null;
  to_phone: string;
  body: string;
  attachments: Attachment[] | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  // No in-function auth gate. The function only DRAINS queued rows
  // out of sms_messages — it never accepts a recipient or body from
  // the request payload, so an unauthenticated caller can at worst
  // cause the queue to drain (which is the intended behavior anyway).
  // Rows themselves are RLS-gated on insert by the original DSP user.
  // Deployed with --no-verify-jwt so the post-key-rotation gateway
  // (which doesn't accept the legacy JWT in the drain cron headers)
  // doesn't 401 before the function runs.

  const sid   = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const messagingService = Deno.env.get("TWILIO_MESSAGING_SERVICE_SID");
  const fromNumber       = Deno.env.get("TWILIO_FROM_NUMBER");
  if (!sid || !token) return badRequest("twilio_credentials_missing", 500);
  if (!messagingService && !fromNumber) return badRequest("twilio_sender_missing", 500);

  const supa = serviceClient();
  const payload = await req.json().catch(() => ({}));
  const limit = Math.min(payload?.limit ?? 50, 200);

  let q = supa.from("sms_messages")
    .select("id, dsp_id, applicant_id, to_phone, body, attachments")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (payload?.applicant_id) q = q.eq("applicant_id", payload.applicant_id);

  const { data: rows, error } = await q;
  if (error) return badRequest(error.message, 500);
  if (!rows || rows.length === 0) return jsonResponse({ sent: 0, skipped: 0 });

  // Group by dsp so we can quiet-hours-check once per tenant.
  const dspIds = [...new Set(rows.map(r => r.dsp_id))];
  const { data: dsps } = await supa.from("dsps").select("id, timezone, metadata").in("id", dspIds);
  const dspMap = new Map(dsps?.map(d => [d.id, d]) ?? []);

  const now = new Date();
  let sent = 0, skipped = 0;

  for (const row of rows as QueuedRow[]) {
    const dsp = dspMap.get(row.dsp_id);
    const sms = dsp?.metadata?.sms ?? {};
    const tz  = dsp?.timezone ?? "America/New_York";
    const start = sms.quiet_hours_start ?? "21:00";
    const end   = sms.quiet_hours_end   ?? "08:00";

    if (isWithinQuietHours(now, tz, start, end)) {
      skipped++;
      continue; // leave row queued; will be retried after quiet hours
    }

    // Check opt-out: any prior inbound row whose body looks like a STOP
    // keyword for this phone number disables future sends.
    const { data: optOut } = await supa.from("sms_messages")
      .select("id")
      .eq("dsp_id", row.dsp_id)
      .eq("direction", "inbound")
      .ilike("body", "%stop%")
      .or(`to_phone.eq.${row.to_phone},from_phone.eq.${row.to_phone}`)
      .limit(1);
    if (optOut && optOut.length > 0) {
      await supa.from("sms_messages").update({
        status: "failed", error_code: "opted_out",
        error_message: "Recipient previously sent STOP",
      }).eq("id", row.id);
      skipped++;
      continue;
    }

    // Atomically claim the row: flip queued→sending only if it is STILL
    // queued. The pg_net insert trigger and the 1-minute cron drainer both
    // select status='queued' and can race for the same row; without this
    // guard both would send it (duplicate SMS = Twilio cost + TCPA
    // exposure). The conditional update returns the row only to the worker
    // that won the claim; a loser gets zero rows and skips.
    const { data: claimed } = await supa.from("sms_messages")
      .update({ status: "sending" })
      .eq("id", row.id)
      .eq("status", "queued")
      .select("id");
    if (!claimed || claimed.length === 0) { skipped++; continue; }

    const form = new URLSearchParams();
    form.set("To", row.to_phone);
    form.set("Body", row.body);
    if (messagingService) form.set("MessagingServiceSid", messagingService);
    else form.set("From", fromNumber!);
    // Twilio supports up to 10 MediaUrl params per MMS message. Attachments
    // from the private message-attachments bucket (0447) must be signed fresh
    // here; attachments from other buckets (e.g. fleet-bridge-attachments)
    // already carry a valid signed url. Best-effort — a failure just drops
    // that one attachment; the text still sends.
    const attachments = Array.isArray(row.attachments) ? row.attachments : [];
    for (const a of attachments.slice(0, 10)) {
      if (!a) continue;
      const isMsgAtt = !!a.path || /\/object\/(?:public|sign)\/message-attachments\//.test(String(a.url || ""));
      const url = isMsgAtt ? await signMessageAttachment(supa, a) : (a.url || null);
      if (url) form.append("MediaUrl", url);
    }

    const resp = await fetch(`${TWILIO_BASE}/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${sid}:${token}`),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const body = await resp.json();

    if (!resp.ok) {
      await supa.from("sms_messages").update({
        status: "failed",
        error_code: String(body.code ?? resp.status),
        error_message: body.message ?? "twilio_error",
      }).eq("id", row.id);
      continue;
    }

    await supa.from("sms_messages").update({
      status: "sent",
      provider: "twilio",
      provider_sid: body.sid,
      from_phone: body.from ?? fromNumber ?? null,
      sent_at: new Date().toISOString(),
    }).eq("id", row.id);
    sent++;
  }

  return jsonResponse({ sent, skipped, total: rows.length });
});
