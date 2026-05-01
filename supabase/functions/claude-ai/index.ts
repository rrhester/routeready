// Edge Function: claude-ai
//
// Generic Claude API caller. Used by the dashboard for:
//   - aiWriteMessage          (rewrite/generate marketing copy)
//   - aiReviewScreeningQuestion (employment-law compliance check)
//   - generateCoachingMessage (driver coaching SMS draft)
//
// Reads the Anthropic API key from the user's settings row
// (key='Claude API Key'), falling back to env var ANTHROPIC_API_KEY.
//
// SINGLE FILE — paste into Supabase Studio Edge Functions editor.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { prompt, model, max_tokens } = await req.json();
    if (!prompt) {
      return Response.json(
        { status: 'error', message: 'prompt required' },
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

    // Service-role client to read Claude API key without RLS getting in the way
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
      .eq('key', 'Claude API Key')
      .maybeSingle();

    const apiKey = setting?.value || Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return Response.json(
        { status: 'error', message: 'Claude API key not configured (settings.Claude API Key or env ANTHROPIC_API_KEY)' },
        { status: 500, headers: corsHeaders }
      );
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 512,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const responseText = await resp.text();
    if (!resp.ok) {
      return Response.json(
        { status: 'error', message: 'Anthropic API ' + resp.status, body: responseText.substring(0, 500) },
        { status: 502, headers: corsHeaders }
      );
    }

    const json = JSON.parse(responseText);
    const text = (json.content?.[0]?.text || '').trim();
    if (!text) {
      return Response.json(
        { status: 'error', message: 'Claude returned empty response' },
        { status: 502, headers: corsHeaders }
      );
    }

    return Response.json(
      { status: 'ok', text },
      { headers: corsHeaders }
    );
  } catch (e) {
    return Response.json(
      { status: 'error', message: e.message },
      { status: 500, headers: corsHeaders }
    );
  }
});
