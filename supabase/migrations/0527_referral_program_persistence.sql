-- 0527_referral_program_persistence.sql
--
-- The referral MILESTONE payouts (on-hire / 30 / 60 / 90-day amounts) and the
-- ELIGIBILITY rules (must-be-active / good-standing / count-once) had no
-- persistence: the dashboard's "Save program" button only fired a toast. Only
-- the auto-invite settings (enabled / weeks / payout-per-hire) were stored,
-- via referral_settings_save into dsps.metadata.referrals.
--
-- This migration reissues both referral RPCs so the program config persists
-- alongside the auto-invite config in the SAME dsps.metadata.referrals bucket:
--   * referral_settings_save now PATCHES only the keys present in the payload
--     (so the auto-invite autosave and the program save never clobber each
--     other's keys), and accepts program_enabled / milestones / eligibility.
--   * referral_summary now RETURNS those fields (with sensible defaults) so the
--     dashboard can prefill them.
--
-- Idempotent (create or replace). Both functions keep their existing
-- authenticated grant. dsps.metadata.referrals shape after this:
--   { enabled, send_weeks_after_hire, payout_cents,           -- auto-invite
--     program_enabled,                                         -- program on/off
--     milestones: { hire_cents, d30_cents, d60_cents, d90_cents },
--     eligibility: { must_active, must_standing, count_once } }

create or replace function public.referral_settings_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_patch jsonb := '{}'::jsonb;
  v_new jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Patch only the keys the caller sent, so the two save paths (auto-invite
  -- autosave vs. program Save) don't overwrite each other's fields.
  if p_payload ? 'enabled' then
    v_patch := v_patch || jsonb_build_object('enabled', coalesce((p_payload->>'enabled')::boolean, false));
  end if;
  if p_payload ? 'weeks' then
    v_patch := v_patch || jsonb_build_object('send_weeks_after_hire', coalesce((p_payload->>'weeks')::int, 4));
  end if;
  if p_payload ? 'payout_cents' then
    v_patch := v_patch || jsonb_build_object('payout_cents', coalesce((p_payload->>'payout_cents')::int, 0));
  end if;
  if p_payload ? 'program_enabled' then
    v_patch := v_patch || jsonb_build_object('program_enabled', coalesce((p_payload->>'program_enabled')::boolean, true));
  end if;
  if p_payload ? 'milestones' then
    v_patch := v_patch || jsonb_build_object('milestones', p_payload->'milestones');
  end if;
  if p_payload ? 'eligibility' then
    v_patch := v_patch || jsonb_build_object('eligibility', p_payload->'eligibility');
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{referrals}',
       coalesce(metadata->'referrals', '{}'::jsonb) || v_patch,
       true
     )
   where id = v_dsp
   returning metadata->'referrals' into v_new;

  return v_new;
end;
$$;
grant execute on function public.referral_settings_save(jsonb) to authenticated;


create or replace function public.referral_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with my as (select private.current_dsp_id() as dsp_id),
       d   as (select * from public.dsps where id = (select dsp_id from my)),
       a_active as (
         select count(*)::int as n from public.applicants
         where dsp_id = (select dsp_id from my)
           and referrer_driver_id is not null
           and status not in ('hired','rejected','no_show','not_hired','auto_declined')
       ),
       a_hired as (
         select count(*)::int as n from public.applicants
         where dsp_id = (select dsp_id from my)
           and referrer_driver_id is not null
           and status = 'hired'
       )
  select jsonb_build_object(
    'active',    (select n from a_active),
    'hired',     (select n from a_hired),
    'enabled',   coalesce((d.metadata->'referrals'->>'enabled')::boolean, false),
    'weeks',     coalesce((d.metadata->'referrals'->>'send_weeks_after_hire')::int, 4),
    'payout_cents', coalesce((d.metadata->'referrals'->>'payout_cents')::int, 0),
    -- Program config (milestones + eligibility). Defaults mirror the
    -- dashboard's original hardcoded values ($500 / $250 / $250 / $500,
    -- all eligibility rules on, program enabled).
    'program_enabled', coalesce((d.metadata->'referrals'->>'program_enabled')::boolean, true),
    'milestones', coalesce(d.metadata->'referrals'->'milestones', jsonb_build_object(
        'hire_cents', 50000, 'd30_cents', 25000, 'd60_cents', 25000, 'd90_cents', 50000)),
    'eligibility', coalesce(d.metadata->'referrals'->'eligibility', jsonb_build_object(
        'must_active', true, 'must_standing', true, 'count_once', true))
  )
  from d;
$$;
grant execute on function public.referral_summary() to authenticated;
