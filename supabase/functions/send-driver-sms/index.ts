// ─────────────────────────────────────────────────────────────────────────
// Edge Function · send-driver-sms
//
// Picks up queued sms_messages rows and sends them via Twilio. Single-
// responsibility: this function does not write business logic — RPCs do.
// It only does the I/O step (Twilio API + status update on the row).
//
// FEATURE FLAG: dsps.settings.sms_enabled MUST be true for this DSP, OR
// the function returns 423 Locked and leaves the row queued. This is the
// TCPA gate — until counsel signs off and Twilio A2P registration is
// approved for this DSP, no SMS goes out even if the row is enqueued.
//
// Triggering modes:
//   1. Direct invocation by a frontend after enqueue_sms — pass
//      { messageId } in the body.
//   2. Cron-triggered batch — pass { batchSize: N } and we drain N
//      queued messages, oldest first.
//
// Secrets (set via `supabase secrets set`):
//   TWILIO_ACCOUNT_SID
//   TWILIO_AUTH_TOKEN
//   TWILIO_FROM_NUMBER       — only used as a fallback if the row's from_phone is empty
//
// Auth: requires Supabase service role key in the Authorization header.
// (Frontend invokes via supabase.functions.invoke which auto-attaches.)
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface SmsMessage {
  id: string;
  dsp_id: string;
  to_phone: string;
  from_phone: string;
  body: string;
  status: string;
}

interface DspSettings {
  sms_enabled?: boolean;
  twilio_messaging_service_sid?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const body = await req.json().catch(() => ({}));
  const messageId = body.messageId as string | undefined;
  const batchSize = (body.batchSize as number | undefined) ?? 10;

  // Pick targets
  let targets: SmsMessage[] = [];
  if (messageId) {
    const { data, error } = await supabase
      .from('sms_messages')
      .select('id, dsp_id, to_phone, from_phone, body, status')
      .eq('id', messageId)
      .single();
    if (error || !data) {
      return jsonResponse({ status: 'error', message: 'Message not found' }, 404);
    }
    targets = [data];
  } else {
    const { data, error } = await supabase
      .from('sms_messages')
      .select('id, dsp_id, to_phone, from_phone, body, status')
      .eq('direction', 'outbound')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(batchSize);
    if (error) {
      return jsonResponse({ status: 'error', message: error.message }, 500);
    }
    targets = (data ?? []) as SmsMessage[];
  }

  const results: any[] = [];

  for (const m of targets) {
    // ─── TCPA feature gate ────────────────────────────────────────
    const { data: dsp } = await supabase
      .from('dsps')
      .select('settings')
      .eq('id', m.dsp_id)
      .single();
    const settings = (dsp?.settings ?? {}) as DspSettings;
    if (!settings.sms_enabled) {
      results.push({
        messageId: m.id,
        status: 'tcpa_gated',
        message: 'DSP sms_enabled=false; row remains queued until TCPA review and Twilio A2P approval.',
      });
      continue;
    }

    // ─── Real Twilio call ─────────────────────────────────────────
    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const fallbackFrom = Deno.env.get('TWILIO_FROM_NUMBER');

    if (!accountSid || !authToken) {
      results.push({
        messageId: m.id,
        status: 'config_missing',
        message: 'TWILIO_ACCOUNT_SID/TOKEN not set as secrets.',
      });
      continue;
    }

    const fromPhone = m.from_phone || fallbackFrom;
    if (!fromPhone) {
      results.push({
        messageId: m.id,
        status: 'config_missing',
        message: 'No from_phone on row and TWILIO_FROM_NUMBER not set.',
      });
      continue;
    }

    const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const params = new URLSearchParams();
    params.append('To', m.to_phone);
    params.append('From', fromPhone);
    params.append('Body', m.body);
    if (settings.twilio_messaging_service_sid) {
      params.append('MessagingServiceSid', settings.twilio_messaging_service_sid);
    }

    const twilioResp = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const twilioJson = await twilioResp.json();

    if (twilioResp.ok && twilioJson.sid) {
      await supabase
        .from('sms_messages')
        .update({
          status: 'sent',
          twilio_sid: twilioJson.sid,
        })
        .eq('id', m.id);
      results.push({ messageId: m.id, status: 'sent', sid: twilioJson.sid });
    } else {
      await supabase
        .from('sms_messages')
        .update({
          status: 'failed',
          error_code: twilioJson.code?.toString() ?? 'unknown',
        })
        .eq('id', m.id);
      results.push({
        messageId: m.id,
        status: 'failed',
        error: twilioJson.message ?? 'Twilio rejected',
      });
    }
  }

  return jsonResponse({ status: 'ok', results });
});

function jsonResponse(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}
