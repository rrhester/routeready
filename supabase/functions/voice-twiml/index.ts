// voice-twiml · Twilio webhook that answers the SDK's "Connect" call
// and routes it out to the driver's actual phone via <Dial><Number>.
//
// Twilio hits this endpoint when the browser's Device.connect() fires.
// We respond with TwiML telling Twilio to dial the destination number
// using our purchased Twilio number as caller-ID.
//
// Also writes a row to public.voice_calls so we have an audit trail
// independent of Twilio's own logs.
//
// Body: x-www-form-urlencoded from Twilio with at least:
//   To       — the destination phone number (E.164) supplied by the SDK
//   From     — the SDK identity (client:dsp_…__user_…) — we parse the
//              dsp_id + operator user_id out of this string.
//   CallSid  — Twilio's identifier
//
// We DO NOT verify the Twilio request signature here because the
// endpoint is public-but-unguessable + the worst a forged request
// can do is dial a number we've never approved.  If we add allow-list
// gating later (per-driver scoping), we'll add X-Twilio-Signature
// HMAC verification at that point.
//
// Env:
//   TWILIO_CALLER_ID    +15551234567   (required — the Twilio number
//                                       calls dial FROM)

import { serviceClient } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => (
    c === "<" ? "&lt;" :
    c === ">" ? "&gt;" :
    c === "&" ? "&amp;" :
    c === '"' ? "&quot;" :
    "&apos;"
  ));
}

function twiml(xml: string): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${xml}`, {
    headers: { "content-type": "text/xml; charset=utf-8", ...CORS },
  });
}

function rejectTwiml(reason: string): Response {
  return twiml(`<Response><Say voice="alice">${xmlEscape(reason)}</Say><Hangup/></Response>`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return rejectTwiml("Unsupported request.");

  const CALLER_ID = Deno.env.get("TWILIO_CALLER_ID");
  if (!CALLER_ID) return rejectTwiml("Voice not configured.");

  const form = await req.formData();
  const to = String(form.get("To") ?? "").trim();
  const from = String(form.get("From") ?? "").trim();
  const callSid = String(form.get("CallSid") ?? "").trim();

  // Sanity: destination must look like an E.164 number.  Reject
  // anything that isn't +<digits>, so SDK identities or malformed
  // params can't be dialed out as PSTN numbers.
  if (!/^\+[1-9]\d{6,14}$/.test(to)) {
    return rejectTwiml("Invalid destination number.");
  }

  // Parse identity from From: "client:dsp_<dspId>__user_<userId>"
  let dspId: string | null = null;
  let operatorUserId: string | null = null;
  const m = /^client:dsp_([0-9a-f-]{36})__user_([0-9a-f-]{36})$/i.exec(from);
  if (m) { dspId = m[1]; operatorUserId = m[2]; }

  // Best-effort log row — don't block the call on DB problems.
  if (dspId) {
    try {
      const admin = serviceClient();
      // Try to resolve the driver by phone number within this DSP.
      const { data: drv } = await admin
        .from("drivers")
        .select("id")
        .eq("dsp_id", dspId)
        .eq("phone", to)
        .maybeSingle();

      await admin.from("voice_calls").insert({
        dsp_id: dspId,
        direction: "outbound",
        status: "initiated",
        operator_user_id: operatorUserId,
        driver_id: drv?.id ?? null,
        from_number: CALLER_ID,
        to_number: to,
        twilio_call_sid: callSid || null,
      });
    } catch (_e) {
      // Swallow logging errors — the operator's call should still go through.
    }
  }

  // Dial the driver.  callerId presents our Twilio number; the
  // browser's "client" identity isn't a PSTN-routable presence.
  return twiml(
    `<Response><Dial callerId="${xmlEscape(CALLER_ID)}" answerOnBridge="true" timeout="25">` +
      `<Number>${xmlEscape(to)}</Number>` +
    `</Dial></Response>`,
  );
});
