// Edge Function: cal-schedule
//
// Reads / writes the DSP's default Cal.com availability schedule.
// Used by the dashboard for:
//   - getCalSchedule    (load current availability + overrides)
//   - updateCalSchedule (save availability + overrides back to Cal.com)
//
// Reads the Cal.com API key from settings (key='CalComAPIKey'). The Edge
// Function looks up the user's default Cal.com schedule and proxies the
// GET/PATCH against Cal.com v2 (api.cal.com/v2). No CLI required —
// paste this single file into the Supabase Studio Edge Functions editor.
//
// Request body (JSON):
//   { op: 'get' }
//   { op: 'update', availability, timeZone, overrides }
//     where availability/overrides may be JSON strings or arrays.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CAL_BASE = 'https://api.cal.com/v2';
const CAL_VERSION = '2024-06-11';

async function calFetch(path: string, apiKey: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Authorization': 'Bearer ' + apiKey,
    'cal-api-version': CAL_VERSION,
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) || {}),
  };
  const resp = await fetch(CAL_BASE + path, { ...init, headers });
  const text = await resp.text();
  let json: any = {};
  try { json = JSON.parse(text); } catch (_) {}
  return { resp, json, text };
}

function parseMaybeJson(v: any): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await req.json();
    const op = body.op || 'get';

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

    const { data: setting } = await adminClient
      .from('settings')
      .select('value')
      .eq('dsp_id', profile.dsp_id)
      .eq('key', 'CalComAPIKey')
      .maybeSingle();

    const apiKey = setting?.value;
    if (!apiKey) {
      return Response.json(
        { status: 'error', message: 'Cal.com not configured (settings.CalComAPIKey missing)' },
        { status: 500, headers: corsHeaders }
      );
    }

    // Find the default schedule for this Cal.com account.
    const list = await calFetch('/schedules', apiKey);
    if (!list.resp.ok) {
      return Response.json(
        { status: 'error', message: 'Cal.com /schedules failed: ' + list.resp.status, body: list.text.substring(0, 300) },
        { status: 502, headers: corsHeaders }
      );
    }
    const schedules = Array.isArray(list.json?.data) ? list.json.data : [];
    const defaultSchedule = schedules.find((s: any) => s.isDefault) || schedules[0];
    if (!defaultSchedule) {
      return Response.json(
        { status: 'error', message: 'Cal.com account has no schedules' },
        { status: 404, headers: corsHeaders }
      );
    }
    const scheduleId = defaultSchedule.id;

    if (op === 'get') {
      const get = await calFetch('/schedules/' + scheduleId, apiKey);
      if (!get.resp.ok) {
        return Response.json(
          { status: 'error', message: 'Cal.com GET schedule failed: ' + get.resp.status, body: get.text.substring(0, 300) },
          { status: 502, headers: corsHeaders }
        );
      }
      const sched = get.json?.data || {};
      return Response.json(
        {
          status: 'ok',
          availability: Array.isArray(sched.availability) ? sched.availability : [],
          timeZone: sched.timeZone || 'America/Chicago',
          dateOverrides: Array.isArray(sched.overrides) ? sched.overrides : [],
        },
        { headers: corsHeaders }
      );
    }

    if (op === 'update') {
      const availability = parseMaybeJson(body.availability) || [];
      const overrides    = parseMaybeJson(body.overrides) || [];
      const timeZone     = body.timeZone || 'America/Chicago';

      const patch = await calFetch('/schedules/' + scheduleId, apiKey, {
        method: 'PATCH',
        body: JSON.stringify({ availability, timeZone, overrides }),
      });
      if (!patch.resp.ok) {
        return Response.json(
          { status: 'error', message: 'Cal.com PATCH failed: ' + patch.resp.status, body: patch.text.substring(0, 300) },
          { status: 502, headers: corsHeaders }
        );
      }
      return Response.json({ status: 'ok' }, { headers: corsHeaders });
    }

    return Response.json(
      { status: 'error', message: 'Unknown op: ' + op },
      { status: 400, headers: corsHeaders }
    );
  } catch (e) {
    return Response.json(
      { status: 'error', message: (e as Error).message },
      { status: 500, headers: corsHeaders }
    );
  }
});
