// Edge Function: send-sms
//
// Sends an SMS via Twilio. Used by the dashboard for:
//   - sendManualMessage (operator types a custom message to an applicant)
//
// Looks up the applicant by email (DSP-scoped) to get their phone number.
// Reads Twilio credentials from Edge Function secrets:
//   TWILIO_ACCOUNT_SID    — starts with 'AC...'
//   TWILIO_AUTH_TOKEN     — 32-char hex string
//   TWILIO_FROM_NUMBER    — E.164 number Twilio will send from (e.g. +15125551212)
//
// Request body: { email: string, message: string }
// Response:     { status: 'ok', sid: '...' } or { status: 'error', message: '...' }
//
// SINGLE FILE — paste into Supabase Studio Edge Functions editor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Normalize a US phone number to E.164. Returns null if it can't be coerced.
function toE164(raw: string): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(raw).trim().startsWith('+') && digits.length >= 8) return '+' + digits;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { email, message } = await req.json();
    if (!email || !message) {
      return Response.json(
        { status: 'error', message: 'email and message required' },
        { status: 400, headers: corsHeaders }
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return Response.json(
        { status: 'error', message: 'Auth required' },
        { status: 401, headers: corsHeaders }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const userClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return Response.json(
        { status: 'error', message: 'Invalid session' },
        { status: 401, headers: corsHeaders }
      );
    }

    const adminClient = createClient(
      supabaseUrl,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );
    const { data: profile } = await adminClient
      .from('profiles')
      .select('dsp_id')
      .eq('user_id', user.id)
      .single();
    if (!profile) {
      return Response.json(
        { status: 'error', message: 'No profile for user' },
        { status: 403, headers: corsHeaders }
      );
    }

    const { data: applicant } = await adminClient
      .from('applicants')
      .select('phone, first_name, last_name')
      .eq('dsp_id', profile.dsp_id)
      .eq('email', email)
      .maybeSingle();
    if (!applicant) {
      return Response.json(
        { status: 'error', message: 'Applicant not found for this DSP' },
        { status: 404, headers: corsHeaders }
      );
    }

    const toNumber = toE164(applicant.phone || '');
    if (!toNumber) {
      return Response.json(
        { status: 'error', message: 'Applicant has no valid phone number on file' },
        { status: 422, headers: corsHeaders }
      );
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken  = Deno.env.get('TWILIO_AUTH_TOKEN');
    const fromNumber = Deno.env.get('TWILIO_FROM_NUMBER');
    if (!accountSid || !authToken || !fromNumber) {
      return Response.json(
        { status: 'error', message: 'Twilio not configured (missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER secrets)' },
        { status: 500, headers: corsHeaders }
      );
    }

    const twilioUrl = 'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Messages.json';
    const form = new URLSearchParams();
    form.set('To', toNumber);
    form.set('From', fromNumber);
    form.set('Body', String(message));

    const twilioResp = await fetch(twilioUrl, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(accountSid + ':' + authToken),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    const twilioBody = await twilioResp.text();
    if (!twilioResp.ok) {
      let errMsg = 'Twilio API ' + twilioResp.status;
      try {
        const j = JSON.parse(twilioBody);
        if (j.message) errMsg = 'Twilio: ' + j.message;
      } catch (_) {}
      return Response.json(
        { status: 'error', message: errMsg, twilio_status: twilioResp.status },
        { status: 502, headers: corsHeaders }
      );
    }

    let sid = '';
    try { sid = (JSON.parse(twilioBody) || {}).sid || ''; } catch (_) {}

    return Response.json(
      { status: 'ok', sid, to: toNumber, applicant_name: ((applicant.first_name || '') + ' ' + (applicant.last_name || '')).trim() },
      { headers: corsHeaders }
    );
  } catch (e) {
    return Response.json(
      { status: 'error', message: (e as Error).message },
      { status: 500, headers: corsHeaders }
    );
  }
});
