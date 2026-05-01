// Edge Function: record-config
//
// Public (no JWT required) — used by record.html to load the applicant's
// config when they open their personalized recording link
//   https://record.gorouteready.com/?id=<applicant-uuid>
//
// Returns the same shape Apps Script's getRecordConfig returned:
//   {
//     status:        'ok',
//     dspName:       string,
//     firstName:     string,
//     formQuestions: [{ id, label, filter }],
//     videoEnabled:  boolean,
//     videoPrompts:  [string,string,string],   // 3 prompts (empty strings if unset)
//     videoMaxSeconds: number,
//   }
//
// Looks up the applicant by id (applicants.id UUID), pulls the DSP's
// settings + screening_selections + question_bank, and assembles the
// config the recording page renders. SINGLE FILE — paste into the
// Supabase Studio Edge Functions editor and turn OFF "Verify JWT"
// (this is a public unauthenticated endpoint).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const STARTER_IDS = ['q_age21', 'q_workauth', 'q_license', 'q_10hrshift'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    let applicantId = '';
    if (req.method === 'GET') {
      const url = new URL(req.url);
      applicantId = url.searchParams.get('id') || '';
    } else {
      const body = await req.json().catch(() => ({}));
      applicantId = body.id || '';
    }
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
      .select('id, dsp_id, first_name')
      .eq('id', applicantId)
      .maybeSingle();
    if (apErr) throw apErr;
    if (!applicant) {
      return Response.json(
        { status: 'error', message: 'Application link is invalid or expired.' },
        { status: 404, headers: corsHeaders }
      );
    }

    const dspId = applicant.dsp_id;

    const [dspNameRes, settingsRes, selRes, libRes] = await Promise.all([
      adminClient.from('dsps').select('name').eq('id', dspId).maybeSingle(),
      adminClient.from('settings')
        .select('key, value')
        .eq('dsp_id', dspId)
        .in('key', ['DSPName','VideoScreeningEnabled','VideoPrompt1','VideoPrompt2','VideoPrompt3','VideoMaxSeconds']),
      adminClient.from('screening_selections')
        .select('slot_order, question_id, source, custom_text, filter_override')
        .eq('dsp_id', dspId)
        .order('slot_order'),
      adminClient.from('question_bank')
        .select('id, label, default_filter')
        .order('id'),
    ]);

    if (settingsRes.error) throw settingsRes.error;
    if (selRes.error)      throw selRes.error;
    if (libRes.error)      throw libRes.error;

    const settingsMap: Record<string, string> = {};
    (settingsRes.data || []).forEach((r: any) => { settingsMap[r.key] = r.value; });

    const dspName =
      settingsMap.DSPName ||
      (dspNameRes.data && (dspNameRes.data as any).name) ||
      'Driver Application';

    const videoEnabled =
      String(settingsMap.VideoScreeningEnabled || '').toLowerCase() !== 'false';

    const videoPrompts = [
      settingsMap.VideoPrompt1 || '',
      settingsMap.VideoPrompt2 || '',
      settingsMap.VideoPrompt3 || '',
    ];

    const videoMaxSeconds = parseInt(settingsMap.VideoMaxSeconds || '60', 10) || 60;

    const libraryById: Record<string, any> = {};
    (libRes.data || []).forEach((q: any) => { libraryById[q.id] = q; });

    type Q = { id: string; label: string; filter: boolean };
    let formQuestions: Q[] = [];
    const selections = selRes.data || [];

    if (selections.length === 0) {
      formQuestions = STARTER_IDS.map((id) => {
        const lib = libraryById[id];
        if (!lib) return null;
        return { id, label: lib.label || '', filter: !!lib.default_filter } as Q;
      }).filter((q): q is Q => q !== null);
    } else {
      formQuestions = selections.map((s: any) => {
        if (s.source === 'custom') {
          return {
            id:     'custom_' + (s.slot_order || 0),
            label:  s.custom_text || '',
            filter: s.filter_override === true,
          };
        }
        const lib = libraryById[s.question_id];
        if (!lib) return null;
        const filter =
          s.filter_override === true  ? true  :
          s.filter_override === false ? false :
          !!lib.default_filter;
        return { id: s.question_id, label: lib.label || '', filter };
      }).filter((q: any): q is Q => q !== null);
    }

    return Response.json(
      {
        status:          'ok',
        dspName,
        firstName:       applicant.first_name || '',
        formQuestions,
        videoEnabled,
        videoPrompts,
        videoMaxSeconds,
      },
      { headers: corsHeaders }
    );
  } catch (e) {
    return Response.json(
      { status: 'error', message: (e as Error).message },
      { status: 500, headers: corsHeaders }
    );
  }
});
