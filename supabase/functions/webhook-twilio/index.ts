// webhook-twilio · Handles status callbacks AND inbound SMS in one fn.
//
// Configure both in the Twilio console pointing at the same URL:
//   - Messaging Service → Inbound webhook
//   - Messaging Service → Status callback
// The Twilio body distinguishes them: status callbacks include
// MessageStatus, inbound includes Body + From.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TWILIO_AUTH_TOKEN  (for signature verification)
//   PUBLIC_BASE_URL    (e.g. https://doiwrhkirgblcvuskhno.functions.supabase.co/webhook-twilio)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { timingSafeEqual } from "../_shared/http.ts";

async function verifyTwilioSignature(req: Request, rawBody: string): Promise<boolean> {
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const sig   = req.headers.get("x-twilio-signature");
  if (!token || !sig) return false;

  // Twilio's signature: HMAC-SHA1 of (URL + concatenated sorted POST params).
  const url = Deno.env.get("PUBLIC_BASE_URL") ?? new URL(req.url).toString();
  const params = new URLSearchParams(rawBody);
  const sortedKeys = [...params.keys()].sort();
  let payload = url;
  for (const k of sortedKeys) payload += k + (params.get(k) ?? "");

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const macB64 = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return timingSafeEqual(macB64, sig);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);
  const raw = await req.text();
  const ok  = await verifyTwilioSignature(req, raw);
  if (!ok) return badRequest("bad_signature", 403);

  const params = new URLSearchParams(raw);
  const supa = serviceClient();

  // Inbound message?
  if (params.get("Body") && params.get("From")) {
    const from = params.get("From")!;
    const to   = params.get("To") ?? null;
    const body = params.get("Body")!;
    const sid  = params.get("MessageSid") ?? null;

    // Find the most recent applicant we've messaged at this number.
    const { data: prior } = await supa.from("sms_messages")
      .select("dsp_id, applicant_id")
      .eq("to_phone", from)
      .eq("direction", "outbound")
      .order("created_at", { ascending: false })
      .limit(1);

    const dsp_id = prior?.[0]?.dsp_id ?? null;
    const applicant_id = prior?.[0]?.applicant_id ?? null;

    if (dsp_id) {
      await supa.from("sms_messages").insert({
        dsp_id, applicant_id, direction: "inbound", status: "received",
        to_phone: to ?? "", from_phone: from, body,
        provider: "twilio", provider_sid: sid,
      });
    }

    // Auto-reply for STOP / HELP, per CTIA / TCPA. Use the DSP's own name
    // so applicants/drivers see the operator they applied with, not the
    // platform brand.
    let dspName = "this service";
    if (dsp_id) {
      const { data: dspRow } = await supa.from("dsps").select("name").eq("id", dsp_id).maybeSingle();
      if (dspRow?.name) dspName = dspRow.name;
    }
    const upper = body.trim().toUpperCase();
    let reply: string | null = null;
    if (upper === "STOP" || upper === "STOPALL" || upper === "UNSUBSCRIBE" || upper === "CANCEL" || upper === "QUIT" || upper === "END") {
      reply = `You're unsubscribed and won't receive further ${dspName} messages. Reply START to opt back in.`;
      // Durable opt-out flag (project-review PR#58) — send-sms checks this
      // table instead of re-scanning message history, so the STOP can't age
      // out of a scan window and a later START genuinely re-enables sends.
      // Best-effort until migration 0502 creates the table (send-sms falls
      // back to the legacy history scan while it's missing).
      try {
        await supa.from("sms_optouts").upsert(
          { phone: from, dsp_id, opted_out_at: new Date().toISOString(), source: "twilio_stop" },
          { onConflict: "phone" },
        );
      } catch (e) { console.error("sms_optouts upsert failed:", (e as Error)?.message); }
    } else if (upper === "START" || upper === "UNSTOP" || upper === "YES") {
      try {
        await supa.from("sms_optouts").delete().eq("phone", from);
      } catch (e) { console.error("sms_optouts delete failed:", (e as Error)?.message); }
      reply = `You're re-subscribed to ${dspName} messages. Reply STOP to opt out.`;
    } else if (upper === "HELP" || upper === "INFO") {
      reply = `${dspName} · Driver hiring updates. Msg & data rates may apply. Reply STOP to opt out.`;
    }
    if (reply) {
      // TwiML response — Twilio will dispatch this back to the sender.
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`, {
        headers: { "content-type": "text/xml" },
      });
    }
    return new Response("<Response/>", { headers: { "content-type": "text/xml" } });
  }

  // Status callback?
  const status = params.get("MessageStatus");
  const sid    = params.get("MessageSid");
  if (status && sid) {
    const map: Record<string, string> = {
      queued: "queued", sending: "sending", sent: "sent",
      delivered: "delivered", undelivered: "failed", failed: "failed",
    };
    const next = map[status] ?? null;
    if (next) {
      const update: Record<string, unknown> = { status: next };
      if (next === "delivered") update.delivered_at = new Date().toISOString();
      if (next === "failed") {
        update.error_code = params.get("ErrorCode") ?? null;
        update.error_message = params.get("ErrorMessage") ?? null;
      }
      await supa.from("sms_messages").update(update)
        .eq("provider", "twilio").eq("provider_sid", sid);
    }
  }

  return jsonResponse({ ok: true });
});
