// Edge Function: finalize-application
//
// Public (no JWT required) — used by record.html to finalize an applicant
// submission after they fill out the form (and optionally record video).
//
// Two paths the recording page calls into:
//   1. Filter beacon ("filteredOnly: 1") — fired when answers match a
//      hard-filter screening question. Just records the failure; no
//      video is uploaded.
//   2. Real submission — saves the applicant's answers + the URLs of the
//      uploaded video clips, scores them against screening rules, and
//      flips applicants.status to 'screening' / 'passed' / 'failed' /
//      'filtered' so the dashboard pipeline picks them up.
//
// Request body (JSON or x-www-form-urlencoded):
//   {
//     applicantId:  uuid,
//     firstName, lastName, email, phone,    (overrides if applicant typed them)
//     formAnswers:  '[{"id":"q_age21","answer":"Yes"}, ...]'   (JSON string)
//     fileIds:      '[{"promptNum":1,"publicUrl":"..."}]'      (JSON string)
//     videoSkipped: '1' | undefined,
//     filteredOnly: '1' | undefined,
//     uploadId:     ignored (legacy from Apps Script)
//     userAgent:    ignored
//   }
//
// Response:
//   { status: 'ok' | 'filtered' | 'error', message? }
//
// SINGLE FILE — paste into the Supabase Studio editor and turn OFF
// "Verify JWT".

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function parseMaybeJson(v: any): any {
  if (v == null) return null;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}

async function readParams(req: Request): Promise<Record<string, any>> {
  const ct = (req.headers.get('content-type') || '').toLowerCase();
  if (req.method === 'GET') {
    const out: Record<string, any> = {};
    const url = new URL(req.url);
    url.searchParams.forEach((v, k) => { out[k] = v; });
    return out;
  }
  if (ct.includes('application/json')) {
    return await req.json().catch(() => ({}));
  }
  // x-www-form-urlencoded or multipart
  const text = await req.text();
  const out: Record<string, any> = {};
  text.split('&').forEach(kv => {
    if (!kv) return;
    const eq = kv.indexOf('=');
    const k = decodeURIComponent((eq === -1 ? kv : kv.substring(0, eq)).replace(/\+/g, ' '));
    const v = eq === -1 ? '' : decodeURIComponent(kv.substring(eq + 1).replace(/\+/g, ' '));
    out[k] = v;
  });
  return out;
}

function answerSaysYes(s: string): boolean {
  return /yes|y|true|1/i.test(String(s || '').trim());
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const params = await readParams(req);
    const applicantId = params.applicantId || params.id;
    if (!applicantId) {
      return Response.json(
        { status: 'error', message: 'Missing applicant id' },
        { status: 400, headers: corsHeaders }
      );
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: applicant, error: apErr } = await adminClient
      .from('applicants')
      .select('id, dsp_id, first_name, last_name, email, phone')
      .eq('id', applicantId)
      .maybeSingle();
    if (apErr) throw apErr;
    if (!applicant) {
      return Response.json(
        { status: 'error', message: 'Application link is invalid or expired.' },
        { status: 404, headers: corsHeaders }
      );
    }

    // Filter beacon — log the failure and bail without scoring/storing.
    if (params.filteredOnly === '1' || params.filteredOnly === 1 || params.filteredOnly === true) {
      await adminClient.from('applicants')
        .update({ status: 'filtered' })
        .eq('id', applicant.id);
      await adminClient.from('failures').insert({
        dsp_id:     applicant.dsp_id,
        type:       'filtered',
        identifier: applicant.email || applicant.id,
        reason:     'Filtered on screening questions',
      });
      return Response.json({ status: 'ok' }, { headers: corsHeaders });
    }

    const formAnswers: any[] = parseMaybeJson(params.formAnswers) || [];
    const fileIds:     any[] = parseMaybeJson(params.fileIds)     || [];

    // Pull screening rules so we can score / decide pass-fail.
    const { data: selections, error: selErr } = await adminClient
      .from('screening_selections')
      .select('slot_order, question_id, source, custom_text, filter_override')
      .eq('dsp_id', applicant.dsp_id)
      .order('slot_order');
    if (selErr) throw selErr;

    const { data: library, error: libErr } = await adminClient
      .from('question_bank')
      .select('id, label, default_filter');
    if (libErr) throw libErr;
    const libraryById: Record<string, any> = {};
    (library || []).forEach((q: any) => { libraryById[q.id] = q; });

    // Build answer lookup keyed by question id (or 'custom_<slot>' for custom).
    const answerById: Record<string, string> = {};
    formAnswers.forEach((a: any) => {
      const k = a && (a.id || a.questionId || a.key);
      if (k) answerById[String(k)] = String(a.answer ?? a.value ?? '');
    });

    // Determine if any hard-filter question failed.
    let filteredOut = false;
    let passedCount = 0;
    let totalGraded = 0;
    (selections || []).forEach((s: any) => {
      const qid = s.source === 'custom' ? ('custom_' + s.slot_order) : s.question_id;
      const lib = s.source === 'custom' ? null : libraryById[s.question_id];
      const filter =
        s.filter_override === true  ? true  :
        s.filter_override === false ? false :
        (lib ? !!lib.default_filter : false);
      const ans = answerById[qid] || '';
      if (!ans) return;
      totalGraded++;
      const passed = answerSaysYes(ans);
      if (passed) passedCount++;
      if (filter && !passed) filteredOut = true;
    });

    // Score 0..9 — same rough shape getCoachingRecord/Performance.gs uses.
    let score = 0;
    if (totalGraded > 0) {
      score = Math.round((passedCount / totalGraded) * 9);
    }

    // Compose the update.
    const videoSkipped =
      params.videoSkipped === '1' || params.videoSkipped === 1 || params.videoSkipped === true;

    const videoUrl =
      Array.isArray(fileIds) && fileIds.length
        ? (fileIds[0].publicUrl || fileIds[0].fileId || '')
        : '';

    const update: Record<string, any> = {
      first_name: params.firstName || applicant.first_name,
      last_name:  params.lastName  || applicant.last_name,
      email:      params.email     || applicant.email,
      phone:      params.phone     || applicant.phone,
      score,
      contacted:  'yes',
    };

    if (filteredOut) update.status = 'filtered';
    else if (videoSkipped) update.status = 'screening';
    else update.status = 'screening';   // dashboard moves to passed/booked later

    if (videoUrl) {
      update.video_url = videoUrl;
      update.video_status = 'Recorded';
      update.video_recorded_at = new Date().toISOString();
    } else if (!videoSkipped) {
      update.video_status = 'Sent';
    }

    const { error: upErr } = await adminClient
      .from('applicants')
      .update(update)
      .eq('id', applicant.id);
    if (upErr) throw upErr;

    if (filteredOut) {
      return Response.json({ status: 'filtered' }, { headers: corsHeaders });
    }
    return Response.json({ status: 'ok' }, { headers: corsHeaders });
  } catch (e) {
    return Response.json(
      { status: 'error', message: (e as Error).message },
      { status: 500, headers: corsHeaders }
    );
  }
});
