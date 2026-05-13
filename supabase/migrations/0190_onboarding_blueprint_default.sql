-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0190 · Slimmer default onboarding blueprint
--
-- A brand-new DSP now starts with just the three compliance gates every
-- hire has to clear — Background check cleared, Drug test cleared, Form I-9.
-- The rest of RouteReady's step catalogue (welcome email, handbook, job
-- offer, training, scheduled, …) still ships in the default array so a DSP
-- can switch any of them back on from the Onboarding Builder, but they
-- arrive disabled so the builder isn't a wall of boilerplate on day one.
--
-- This only affects DSPs that haven't been seeded yet (onboarding_blueprint
-- has no row): public.onboarding_blueprint_get() lazily inserts the default
-- on first read.  Existing configured blueprints are untouched.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.onboarding_blueprint_default()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key','bg_check',        'type','background_check',  'title','Background check cleared',     'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','drug_test',       'type','drug_test',        'title','Drug test cleared',            'enabled',true,  'blocking',true,  'required',true,  'owner','dsp'),
    jsonb_build_object('key','i9',              'type','i9',               'title','Form I-9',                     'enabled',true,  'blocking',true,  'required',true,  'owner','driver'),
    jsonb_build_object('key','welcome_email',   'type','welcome',          'title','Welcome email',                'enabled',false, 'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','bg_instructions', 'type','task',             'title','Background-check instructions', 'enabled',false, 'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','drug_info',       'type','task',             'title','Drug-testing information',     'enabled',false, 'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','handbook',        'type','document',         'title','Employment handbook',          'enabled',false, 'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','job_offer',       'type','document',         'title','Job offer',                    'enabled',false, 'blocking',true,  'required',true,  'owner','driver', 'document_template_id', null),
    jsonb_build_object('key','training',        'type','task',             'title','Training',                     'enabled',false, 'blocking',false, 'required',false, 'owner','dsp'),
    jsonb_build_object('key','scheduled',       'type','schedule',         'title','Driver scheduled',             'enabled',false, 'blocking',false, 'required',false, 'owner','dsp')
  );
$$;

notify pgrst, 'reload schema';
