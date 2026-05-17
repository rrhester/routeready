-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0287 · Onboarding · leaner default blueprint for new DSPs
--
-- Replaces private.onboarding_blueprint_default() with the slimmer set
-- a DSP actually wants on day one (operator direction): the three
-- compliance gates, both signing documents (job offer + handbook),
-- the I-9 flow, and trainer pairing. Drops the steps DSPs were
-- routinely deleting on first setup: Welcome email (handled by the
-- hiring messages template, not a blueprint step), the
-- send-instructions tasks for BG / Drug (the compliance gates
-- themselves are enough), the always-disabled Training task, and
-- Driver scheduled (the schedule view tracks that on its own).
--
-- Order matches the operator-approved screenshot:
--   1. Background check cleared   (compliance gate)
--   2. Drug test cleared          (compliance gate)
--   3. Job offer                  (document — DSP attaches template)
--   4. Employment handbook        (document — DSP attaches template)
--   5. Form I-9                   (dedicated Section 1 + 2)
--   6. Trainer pairing            (optional ride-along, non-blocking)
--
-- Existing DSPs are NOT affected — onboarding_blueprint_get only
-- consults the default when a DSP has no row yet (first dispatcher
-- load on a fresh workspace). Anyone with a saved blueprint keeps
-- exactly what they configured.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.onboarding_blueprint_default()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key','bg_check',     'type','background_check', 'title','Background check cleared', 'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','drug_test',    'type','drug_test',        'title','Drug test cleared',        'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','job_offer',    'type','document',         'title','Job offer',                'enabled',true,  'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','handbook',     'type','document',         'title','Employment handbook',      'enabled',true,  'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','i9',           'type','i9',               'title','Form I-9',                 'enabled',true,  'blocking',true,  'required',true,  'owner','driver'),
    jsonb_build_object('key','trainer_pair', 'type','task',             'title','Trainer pairing',          'enabled',true,  'blocking',false, 'required',false, 'owner','dsp')
  );
$$;

notify pgrst, 'reload schema';
