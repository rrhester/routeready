-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0193 · Default onboarding blueprint = the three compliance gates
--
-- A fresh DSP's onboarding blueprint now starts with just Background check
-- cleared, Drug test cleared, and Form I-9 — all enabled. Everything else
-- (a handbook, a policy acknowledgement, an orientation video, a job offer)
-- is something the DSP adds in the Onboarding Builder; removing a step is a
-- delete. There's no enabled/disabled toggle anymore — a step is either in
-- the blueprint or it isn't.
--
-- Only affects DSPs that haven't been seeded yet (onboarding_blueprint has
-- no row). Existing configured blueprints are untouched; the builder simply
-- stops showing any steps that were left disabled (it filters enabled rows
-- and re-saves only those on the next edit).
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.onboarding_blueprint_default()
returns jsonb language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key','bg_check',  'type','background_check', 'title','Background check cleared', 'enabled',true, 'blocking',true, 'required',true, 'owner','dsp'),
    jsonb_build_object('key','drug_test', 'type','drug_test',        'title','Drug test cleared',        'enabled',true, 'blocking',true, 'required',true, 'owner','dsp'),
    jsonb_build_object('key','i9',        'type','i9',               'title','Form I-9',                 'enabled',true, 'blocking',true, 'required',true, 'owner','driver')
  );
$$;

notify pgrst, 'reload schema';
