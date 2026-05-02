// ─────────────────────────────────────────────────────────────────────────
// Edge Function · generate-coaching-sms
//
// Calls Claude API to draft a coaching SMS for a driver, given:
//   - driver context (name, score, recent attendance events, prior coaching)
//   - coaching category (attendance, safety, quality, behavior)
//   - tone preference (firm / supportive / final-warning)
//
// Returns the drafted message text. Does NOT send — the frontend reviews,
// optionally edits, then calls enqueue_sms separately.
//
// Tracks token usage via log_ai_usage RPC for per-DSP cost visibility.
//
// Auth: requires authenticated session (caller's JWT determines DSP scope).
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_MODEL = 'claude-opus-4-7';   // reads from env if overridden

interface RequestBody {
  driverId: string;
  category: 'attendance' | 'safety' | 'quality' | 'behavior';
  tone?: 'firm' | 'supportive' | 'final-warning';
  context?: string;        // any extra context the dispatcher wants to feed
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return jsonResponse({ status: 'error', message: 'ANTHROPIC_API_KEY not set' }, 500);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const authHeader = req.headers.get('Authorization');
  const supabase = createClient(supabaseUrl, anonKey, {
    global: authHeader ? { headers: { Authorization: authHeader } } : undefined,
  });

  const body = (await req.json()) as RequestBody;
  if (!body.driverId || !body.category) {
    return jsonResponse({ status: 'error', message: 'driverId + category required' }, 400);
  }

  // Fetch driver context (RLS-scoped via the user's JWT)
  const { data: driver, error: driverErr } = await supabase
    .from('drivers')
    .select('id, full_name, composite_score, attendance_rate_30d, station_id')
    .eq('id', body.driverId)
    .single();
  if (driverErr || !driver) {
    return jsonResponse({ status: 'error', message: 'driver not found' }, 404);
  }

  // Recent attendance events (last 30 days, non-exempt)
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  const { data: events } = await supabase
    .from('attendance_events')
    .select('event_type, event_date, notes, exempt')
    .eq('driver_id', body.driverId)
    .gte('event_date', thirtyDaysAgo)
    .eq('exempt', false)
    .order('event_date', { ascending: false })
    .limit(10);

  // Build the prompt
  const tone = body.tone ?? 'firm';
  const firstName = driver.full_name.split(' ')[0];
  const eventSummary = (events ?? []).map(e => `  - ${e.event_date}: ${e.event_type}${e.notes ? ` (${e.notes})` : ''}`).join('\n')
    || '  (no recent attendance events)';

  const systemPrompt = `You are an Amazon DSP operations manager drafting a coaching SMS to a driver. Keep it under 320 characters (2 SMS segments). Direct, professional, no emoji. Address the driver by first name. Reference specific facts from the context. End with a clear next step.`;

  const userPrompt = `Driver context:
- Name: ${driver.full_name}
- Composite score: ${driver.composite_score ?? 'unknown'}
- Attendance rate (30d): ${driver.attendance_rate_30d ?? 'unknown'}%

Recent attendance events:
${eventSummary}

Coaching category: ${body.category}
Tone: ${tone}
${body.context ? `Additional context: ${body.context}` : ''}

Draft the SMS now. Return only the message text — no preamble, no explanation.`;

  // Call Anthropic
  const t0 = Date.now();
  const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('ANTHROPIC_MODEL') ?? ANTHROPIC_MODEL,
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!anthropicResp.ok) {
    const txt = await anthropicResp.text();
    return jsonResponse({ status: 'error', message: `Anthropic ${anthropicResp.status}: ${txt}` }, 502);
  }

  const aiJson = await anthropicResp.json();
  const text: string = aiJson.content?.[0]?.text?.trim() ?? '';
  const inputTokens = aiJson.usage?.input_tokens ?? 0;
  const outputTokens = aiJson.usage?.output_tokens ?? 0;

  // Log usage
  await supabase.rpc('log_ai_usage', {
    p_function_name: 'generate-coaching-sms',
    p_model: aiJson.model ?? ANTHROPIC_MODEL,
    p_input_tokens: inputTokens,
    p_output_tokens: outputTokens,
    p_cost_cents: null,
    p_related_kind: 'coaching',
    p_related_id: body.driverId,
  });

  return jsonResponse({
    status: 'ok',
    text,
    driver_name: driver.full_name,
    tokens: { input: inputTokens, output: outputTokens },
    latency_ms: Date.now() - t0,
  });
});

function jsonResponse(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}
