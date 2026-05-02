// ─────────────────────────────────────────────────────────────────────────
// Edge Function · run-license-reminders
//
// Cron-triggered (daily, 06:00 local). For each DSP with a license policy
// enabled, finds drivers whose license_expiry hits one of the configured
// thresholds today AND no reminder has been sent for that threshold for
// the current expiry_date. Calls enqueue_sms for each, then writes a
// license_reminders log row + an hr_events row.
//
// The actual SMS send is performed by send-driver-sms (separately
// triggered or batch-cron'd). This function only enqueues.
//
// Trigger: pg_cron via run-daily orchestrator, OR direct invocation:
//   POST /functions/v1/run-license-reminders
//   { dryRun?: true, dspId?: '<uuid>' }
// ─────────────────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface DspWithPolicy {
  id: string;
  name: string;
  timezone: string;
  enabled: boolean;
  days_before: number[];
  template: string;
  notify_owner: boolean;
}

interface DriverRow {
  id: string;
  full_name: string;
  phone: string | null;
  license_expiry: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const body = await req.json().catch(() => ({}));
  const dryRun = !!body.dryRun;
  const dspIdFilter = body.dspId as string | undefined;

  // 1. Get all DSPs with active license policy
  let dspQuery = supabase
    .from('license_policies')
    .select('dsp_id, enabled, days_before, template, notify_owner, dsps!inner(id, name, timezone)')
    .eq('enabled', true);
  if (dspIdFilter) dspQuery = dspQuery.eq('dsp_id', dspIdFilter);

  const { data: policies, error: policyErr } = await dspQuery;
  if (policyErr) {
    return jsonResponse({ status: 'error', message: policyErr.message }, 500);
  }

  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const summary: any[] = [];

  for (const p of policies ?? []) {
    const dspId = p.dsp_id as string;
    const days_before: number[] = (p.days_before as number[]) ?? [30, 14];

    // For each threshold, find drivers expiring exactly that many days from now
    for (const threshold of days_before) {
      const targetDate = new Date(today);
      targetDate.setDate(targetDate.getDate() + threshold);
      const targetIso = targetDate.toISOString().slice(0, 10);

      const { data: drivers, error: driversErr } = await supabase
        .from('drivers')
        .select('id, full_name, phone, license_expiry')
        .eq('dsp_id', dspId)
        .eq('status', 'active')
        .eq('license_expiry', targetIso);

      if (driversErr) {
        summary.push({ dsp_id: dspId, threshold, error: driversErr.message });
        continue;
      }

      for (const d of (drivers ?? []) as DriverRow[]) {
        if (!d.phone || !d.license_expiry) {
          summary.push({ dsp_id: dspId, driver_id: d.id, skipped: 'missing phone or expiry' });
          continue;
        }

        // Dedup: did we already send this threshold for this expiry?
        const { data: existing } = await supabase
          .from('license_reminders')
          .select('id')
          .eq('dsp_id', dspId)
          .eq('driver_id', d.id)
          .eq('threshold_days', threshold)
          .eq('expiry_date', d.license_expiry)
          .limit(1);

        if (existing && existing.length > 0) {
          summary.push({ dsp_id: dspId, driver_id: d.id, threshold, skipped: 'already sent' });
          continue;
        }

        if (dryRun) {
          summary.push({ dsp_id: dspId, driver_id: d.id, threshold, would_send: true });
          continue;
        }

        // Build the message from the template
        const template = (p.template as string) ??
          'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). Please renew ASAP.';
        const firstName = d.full_name.split(' ')[0];
        const dateStr = new Date(d.license_expiry + 'T12:00:00').toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        });
        const message = template
          .replace(/\{\{name\}\}/g, firstName)
          .replace(/\{\{days\}\}/g, threshold.toString())
          .replace(/\{\{date\}\}/g, dateStr);

        // Enqueue (RPC writes sms_messages row with status='queued')
        const { data: smsId, error: enqErr } = await supabase.rpc('enqueue_sms', {
          p_to_phone: d.phone,
          p_body: message,
          p_driver_id: d.id,
          p_applicant_id: null,
          p_related_kind: 'license_reminder',
          p_related_id: null,
          p_from_phone: null,
        });

        if (enqErr) {
          summary.push({ dsp_id: dspId, driver_id: d.id, threshold, error: enqErr.message });
          continue;
        }

        // Log the reminder
        await supabase.from('license_reminders').insert({
          dsp_id: dspId,
          driver_id: d.id,
          threshold_days: threshold,
          expiry_date: d.license_expiry,
          sms_message_id: smsId,
        });

        // HR file entry
        await supabase.from('hr_events').insert({
          dsp_id: dspId,
          driver_id: d.id,
          event_type: 'license_reminder_sent',
          severity: 'info',
          effective_date: todayIso,
          reason_category: 'license',
          reason_detail: `Auto license-renewal reminder sent (${threshold}d before expiry of ${d.license_expiry}).`,
        });

        summary.push({ dsp_id: dspId, driver_id: d.id, threshold, queued: true, sms_id: smsId });
      }
    }
  }

  return jsonResponse({
    status: 'ok',
    today: todayIso,
    dryRun,
    processed: summary.length,
    summary,
  });
});

function jsonResponse(payload: any, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    status,
  });
}
