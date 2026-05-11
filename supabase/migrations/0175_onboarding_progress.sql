-- Migration 0175 · Onboarding progress — per-driver step tracking
--
-- Granular onboarding milestones the DSP records during hire, beyond the
-- couple of columns already on public.drivers (background_check_completed_at,
-- drug_test_completed_at) and the Form I-9 lifecycle (public.i9_records).
-- One row per driver; staff (dispatcher+) of the owning DSP read/write.
--
-- "sent" timestamps are operator-recorded ("I sent the welcome email /
-- the handbook / the offer") — the actual automated send is a later
-- phase. The dashboard combines this table with public.drivers (status,
-- background_check_completed_at, drug_test_completed_at) and i9_records
-- (Section 2 verified) to render the full onboarding step funnel.

create table if not exists public.onboarding_progress (
  driver_id                uuid primary key references public.drivers(id) on delete cascade,
  dsp_id                   uuid not null references public.dsps(id) on delete cascade,
  welcome_email_sent_at    timestamptz,   -- 1. welcome email
  bg_instructions_sent_at  timestamptz,   -- 2. background-check instructions sent  (3. "cleared" = drivers.background_check_completed_at)
  drug_info_sent_at        timestamptz,   -- 4. drug-testing information sent        (5. "cleared" = drivers.drug_test_completed_at)
  handbook_sent_at         timestamptz,   -- 6a. employment handbook sent
  handbook_completed_at    timestamptz,   -- 6b. employment handbook completed
  i9_sent_at               timestamptz,   -- 7a. Form I-9 sent                       (7b. "completed" = i9_records.section2_completed_at / verified)
  job_offer_sent_at        timestamptz,   -- 8a. job offer sent
  job_offer_completed_at   timestamptz,   -- 8b. job offer signed / completed        (9. "driver active" = drivers.status = 'active')
  scheduled_at             timestamptz,   -- 10. driver scheduled (first shift assigned)
  updated_at               timestamptz not null default now()
);
create index if not exists onboarding_progress_dsp_idx on public.onboarding_progress (dsp_id);

alter table public.onboarding_progress enable row level security;
create policy "onboarding_progress_rw" on public.onboarding_progress
  for all using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));


-- ── onboarding_progress_set · set or clear one timestamp field ─────────
-- p_value NULL clears the step. Field name is checked against an
-- allowlist; the per-column CASE keeps the other fields untouched.
create or replace function public.onboarding_progress_set(p_driver_id uuid, p_field text, p_value timestamptz)
returns public.onboarding_progress
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.onboarding_progress;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_field not in (
    'welcome_email_sent_at','bg_instructions_sent_at','drug_info_sent_at',
    'handbook_sent_at','handbook_completed_at','i9_sent_at',
    'job_offer_sent_at','job_offer_completed_at','scheduled_at'
  ) then raise exception 'unknown_field' using errcode = '22023'; end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;

  insert into public.onboarding_progress (driver_id, dsp_id)
  values (p_driver_id, v_dsp)
  on conflict (driver_id) do nothing;

  update public.onboarding_progress set
    welcome_email_sent_at   = case when p_field = 'welcome_email_sent_at'   then p_value else welcome_email_sent_at end,
    bg_instructions_sent_at = case when p_field = 'bg_instructions_sent_at' then p_value else bg_instructions_sent_at end,
    drug_info_sent_at       = case when p_field = 'drug_info_sent_at'       then p_value else drug_info_sent_at end,
    handbook_sent_at        = case when p_field = 'handbook_sent_at'        then p_value else handbook_sent_at end,
    handbook_completed_at   = case when p_field = 'handbook_completed_at'   then p_value else handbook_completed_at end,
    i9_sent_at              = case when p_field = 'i9_sent_at'              then p_value else i9_sent_at end,
    job_offer_sent_at       = case when p_field = 'job_offer_sent_at'       then p_value else job_offer_sent_at end,
    job_offer_completed_at  = case when p_field = 'job_offer_completed_at'  then p_value else job_offer_completed_at end,
    scheduled_at            = case when p_field = 'scheduled_at'            then p_value else scheduled_at end,
    updated_at = now()
  where driver_id = p_driver_id
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.onboarding_progress_set(uuid, text, timestamptz) to authenticated;

notify pgrst, 'reload schema';
