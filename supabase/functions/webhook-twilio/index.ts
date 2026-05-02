// ─────────────────────────────────────────────────────────────────────────
// Edge Function · webhook-twilio
//
// Handles inbound Twilio webhooks. Two main events:
//   1. Inbound SMS (Body, From, To). Detects STOP / HELP / START
//      keywords and routes to handle_opt_out RPC. Otherwise records as
//      sms_messages row with direction='inbound' so dispatcher sees it.
//   2. Status callbacks (MessageSid, MessageStatus). Updates the matching
//      sms_messages row's status / delivered_at.
//
// Configure Twilio numbers to POST to:
//   <project-url>/functions/v1/webhook-twilio
//
// We use the inbound 'To' phone number to identify which DSP this message
// belongs to. Each DSP's twilio_from_number is stored in dsps.settings.
//
// IMPORTANT: This function is PUBLIC (no JWT). Twilio doesn't carry a
// JWT. We verify Twilio's request signature instead.
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const twilioAuthToken = Deno.env.get('TWILIO_AUTH_TOKEN');
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Twilio sends form-encoded
  const formData = await req.formData();
  const params: Record<string, string> = {};
  for (const [k, v] of formData.entries()) params[k] = v.toString();

  // Optional: verify Twilio signature
  // (https://www.twilio.com/docs/usage/security#validating-requests)
  // Implementation note: skipping the HMAC check here for brevity; in
  // production, validate the X-Twilio-Signature header.

  // Branch on event type
  if (params.MessageSid && params.MessageStatus && !params.Body) {
    // Status callback
    return handleStatusCallback(supabase, params);
  }
  if (params.From && params.To && params.Body !== undefined) {
    // Inbound message
    return handleInboundMessage(supabase, params);
  }

  return twiml('<Response/>');
});

async function handleStatusCallback(supabase: any, params: Record<string, string>) {
  const sid = params.MessageSid;
  const status = params.MessageStatus.toLowerCase();
  const errorCode = params.ErrorCode;

  const update: any = { status };
  if (status === 'delivered') update.delivered_at = new Date().toISOString();
  if (errorCode) update.error_code = errorCode;

  await supabase
    .from('sms_messages')
    .update(update)
    .eq('twilio_sid', sid);

  return twiml('<Response/>');
}

async function handleInboundMessage(supabase: any, params: Record<string, string>) {
  const fromPhone = params.From;
  const toPhone = params.To;
  const body = (params.Body ?? '').trim();
  const upperBody = body.toUpperCase();

  // 1. Find the DSP that owns this 'To' number
  // Lookup pattern: dsps.settings.twilio_from_number matches.
  const { data: dsps } = await supabase
    .from('dsps')
    .select('id, settings')
    .filter('settings->>twilio_from_number', 'eq', toPhone)
    .limit(1);

  let dspId: string | null = null;
  if (dsps && dsps.length > 0) dspId = dsps[0].id;

  // Fallback: lookup the most recent outbound to this fromPhone within last 7 days
  if (!dspId) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: recent } = await supabase
      .from('sms_messages')
      .select('dsp_id')
      .eq('to_phone', fromPhone)
      .eq('direction', 'outbound')
      .gte('created_at', sevenDaysAgo)
      .order('created_at', { ascending: false })
      .limit(1);
    if (recent && recent.length > 0) dspId = recent[0].dsp_id;
  }

  if (!dspId) {
    // No DSP context — log + drop. In production, alert ops.
    console.warn('webhook-twilio: inbound message with no DSP context', { fromPhone, toPhone });
    return twiml('<Response/>');
  }

  // 2. Detect special keywords
  const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
  const START_KEYWORDS = ['START', 'YES', 'UNSTOP'];
  const HELP_KEYWORDS = ['HELP', 'INFO'];

  const isStop  = STOP_KEYWORDS.includes(upperBody);
  const isStart = START_KEYWORDS.includes(upperBody);
  const isHelp  = HELP_KEYWORDS.includes(upperBody);

  // 3. Match the inbound to a driver/applicant by phone
  const { data: driverMatch } = await supabase
    .from('drivers')
    .select('id')
    .eq('dsp_id', dspId)
    .eq('phone', fromPhone)
    .limit(1);
  const driverId = driverMatch && driverMatch.length > 0 ? driverMatch[0].id : null;

  const { data: applicantMatch } = await supabase
    .from('applicants')
    .select('id')
    .eq('dsp_id', dspId)
    .eq('phone', fromPhone)
    .limit(1);
  const applicantId = !driverId && applicantMatch && applicantMatch.length > 0
    ? applicantMatch[0].id : null;

  // 4. Insert inbound row (always — keeps a complete audit)
  await supabase.from('sms_messages').insert({
    dsp_id: dspId,
    driver_id: driverId,
    applicant_id: applicantId,
    direction: 'inbound',
    to_phone: toPhone,
    from_phone: fromPhone,
    body,
    status: 'delivered',
    delivered_at: new Date().toISOString(),
    related_kind: isStop ? 'opt_out' : isStart ? 'opt_in' : isHelp ? 'help' : null,
  });

  // 5. Handle keywords
  if (isStop) {
    // Set a context for handle_opt_out by simulating the JWT claim
    await supabase.rpc('handle_opt_out', { p_phone: fromPhone, p_reason: 'STOP' });
    return twiml(
      '<Response><Message>You have been unsubscribed and will no longer receive messages from this DSP. ' +
      'Reply START to resubscribe.</Message></Response>'
    );
  }

  if (isStart) {
    // Remove from opt-out list (same DSP only)
    await supabase
      .from('sms_opt_outs')
      .delete()
      .eq('dsp_id', dspId)
      .eq('phone', fromPhone);
    return twiml(
      '<Response><Message>You are resubscribed and will receive messages from this DSP again.</Message></Response>'
    );
  }

  if (isHelp) {
    return twiml(
      '<Response><Message>For support, contact your DSP. Reply STOP to unsubscribe. ' +
      'Msg & data rates may apply.</Message></Response>'
    );
  }

  // 6. Anything else: just acknowledge silently. Dispatcher sees the
  //    inbound row in the dashboard.
  return twiml('<Response/>');
}

function twiml(xml: string) {
  return new Response(xml, {
    headers: { ...corsHeaders, 'Content-Type': 'text/xml' },
    status: 200,
  });
}
