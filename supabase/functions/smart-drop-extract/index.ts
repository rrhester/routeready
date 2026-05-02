// ─────────────────────────────────────────────────────────────────────────
// Edge Function · smart-drop-extract
//
// Reads a smart_drop_uploads row, downloads the file from Storage, calls
// Claude API to (a) detect what kind of data it is and (b) extract
// normalized rows. Updates the row with detected_kind + extracted_rows
// + status='extracted'. The frontend then shows the user the routing
// suggestion and they call route_smart_drop to commit.
//
// This is a research-grade feature — production use should add:
//   - Specific prompt templates per detected_kind (payroll vs scorecard)
//   - Confidence scoring + reject below threshold
//   - Per-DSP schema customization (column name overrides)
//
// Body: { uploadId: string }
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ANTHROPIC_MODEL = 'claude-opus-4-7';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return jsonResponse({ status: 'error', message: 'ANTHROPIC_API_KEY not set' }, 500);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const body = await req.json();
  const uploadId = body.uploadId as string;
  if (!uploadId) return jsonResponse({ status: 'error', message: 'uploadId required' }, 400);

  // Fetch upload row
  const { data: upload, error: uErr } = await supabase
    .from('smart_drop_uploads')
    .select('*')
    .eq('id', uploadId)
    .single();
  if (uErr || !upload) return jsonResponse({ status: 'error', message: 'upload not found' }, 404);

  // Mark processing
  await supabase.from('smart_drop_uploads').update({ status: 'processing' }).eq('id', uploadId);

  try {
    // Download file from Storage
    const { data: fileData, error: dlErr } = await supabase.storage
      .from('smart-drop')
      .download(upload.storage_path);
    if (dlErr || !fileData) throw new Error(`Download failed: ${dlErr?.message}`);

    // Read as text (works for CSV / TSV / plain text Excel exports)
    const fileText = await fileData.text();
    // Trim very large files for the LLM context (first 10k chars + last 2k for tail context)
    const truncated = fileText.length > 12000
      ? fileText.slice(0, 10000) + '\n\n... [truncated] ...\n\n' + fileText.slice(-2000)
      : fileText;

    const systemPrompt = `You are a data-extraction assistant for an Amazon DSP operations platform.
Given a messy file (CSV / Excel export / payroll dump / Mentor scorecard / etc.),
identify what kind of data it is and extract structured rows.

Possible "kinds":
  - "payroll"          (timeclock data: driver_id, clock_in, clock_out, hours)
  - "scorecard"        (Amazon Mentor scorecard: driver_name, score, week_ending)
  - "attendance"       (callout / late / no-show records)
  - "drivers"          (roster: full_name, phone, station, hire_date)
  - "vehicles"         (van_number, vin, make, model, mileage)
  - "delivery_records" (per-package delivery / scan log)
  - "other"            (unknown — set extracted_rows to null)

Return strict JSON: {
  "kind": "<one of above>",
  "confidence": 0.0..1.0,
  "rows": [...]      // normalized rows ready to insert; field names match RouteReady schema
  "notes": "..."     // short description of what you detected
}`;

    const userPrompt = `File: ${upload.filename}
Mime type: ${upload.mime_type ?? 'unknown'}

Contents:
${truncated}

Detect the kind, extract the rows, return JSON only.`;

    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: Deno.env.get('ANTHROPIC_MODEL') ?? ANTHROPIC_MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!anthropicResp.ok) {
      const txt = await anthropicResp.text();
      throw new Error(`Anthropic ${anthropicResp.status}: ${txt}`);
    }

    const aiJson = await anthropicResp.json();
    const aiText: string = aiJson.content?.[0]?.text?.trim() ?? '';

    // Parse the JSON response (Claude returns it as text)
    let parsed: any;
    try {
      // Strip markdown fences if present
      const cleaned = aiText.replace(/^```(?:json)?\n?|\n?```$/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      throw new Error(`Failed to parse Claude response as JSON: ${parseErr}\n\nResponse: ${aiText.slice(0, 500)}`);
    }

    await supabase.from('smart_drop_uploads').update({
      status: 'extracted',
      detected_kind: parsed.kind ?? 'other',
      extracted_rows: parsed.rows ?? null,
      ai_model: aiJson.model,
      ai_tokens_used: (aiJson.usage?.input_tokens ?? 0) + (aiJson.usage?.output_tokens ?? 0),
      processed_at: new Date().toISOString(),
    }).eq('id', uploadId);

    // Log usage
    await supabase.rpc('log_ai_usage', {
      p_function_name: 'smart-drop-extract',
      p_model: aiJson.model ?? ANTHROPIC_MODEL,
      p_input_tokens: aiJson.usage?.input_tokens ?? 0,
      p_output_tokens: aiJson.usage?.output_tokens ?? 0,
      p_cost_cents: null,
      p_related_kind: 'smart_drop',
      p_related_id: uploadId,
    });

    return jsonResponse({
      status: 'ok',
      uploadId,
      detected_kind: parsed.kind,
      confidence: parsed.confidence,
      row_count: parsed.rows?.length ?? 0,
      notes: parsed.notes,
    });
  } catch (err: any) {
    await supabase.from('smart_drop_uploads').update({
      status: 'failed',
      error_message: err.message ?? String(err),
      processed_at: new Date().toISOString(),
    }).eq('id', uploadId);

    return jsonResponse({ status: 'error', message: err.message ?? String(err) }, 500);
  }
});

function jsonResponse(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}
