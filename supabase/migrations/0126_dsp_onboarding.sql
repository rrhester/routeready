-- Phase 6.1 of the DSP onboarding activation system: schema + RPCs.
--
-- This migration adds the columns the onboarding wizard will write
-- into and the SECURITY DEFINER RPCs the wizard will call.  No
-- frontend wiring lands in this migration — the new columns are
-- dormant until phase 6.3 ships the wizard UI.
--
-- Lifecycle reminder (see architecture doc):
--
--     status          ∈ { pending, onboarding, active, suspended }
--     onboarding_step ∈ { not_started, company, contact, billing, complete }
--
--     admin creates ──► pending
--     owner signs in ──► onboarding (auto-flipped by onboarding_get_state)
--     wizard completes ──► active (set by onboarding_complete)

-- ─── 1. Status check constraint · add 'onboarding' ────────────────────────
-- Migration 0124 created the status column with a CHECK that allows
-- only active / pending / suspended.  Drop and re-add to include the
-- new state.  The DROP IF EXISTS + ADD pattern survives re-runs.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'dsps_status_check'
      and conrelid = 'public.dsps'::regclass
  ) then
    execute 'alter table public.dsps drop constraint dsps_status_check';
  end if;
end $$;

alter table public.dsps
  add constraint dsps_status_check
  check (status in ('active', 'pending', 'onboarding', 'suspended'));

-- ─── 2. New columns for the onboarding wizard ─────────────────────────────
-- Some are mirrors / supersets of fields that 0124 already added
-- (phone, address); we keep both for now so the regular dispatcher
-- "Settings" page can keep reading the simpler legacy fields while
-- the onboarding wizard reads/writes the more specific ones.
alter table public.dsps
  add column if not exists dba                       text,
  add column if not exists business_phone            text,
  add column if not exists support_email             text,
  add column if not exists business_address          text,
  add column if not exists owner_name                text,
  add column if not exists owner_phone               text,
  add column if not exists emergency_contact_name    text,
  add column if not exists emergency_contact_phone   text,
  add column if not exists onboarding_step           text not null default 'not_started',
  add column if not exists onboarded_at              timestamptz,
  add column if not exists activated_at              timestamptz,
  add column if not exists welcome_sent_at           timestamptz,
  add column if not exists billing                   jsonb not null default '{}'::jsonb;

-- onboarding_step CHECK constraint (separate so IF NOT EXISTS on
-- the column add doesn't double-add it on re-run).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'dsps_onboarding_step_check'
      and conrelid = 'public.dsps'::regclass
  ) then
    execute $stmt$
      alter table public.dsps
        add constraint dsps_onboarding_step_check
        check (onboarding_step in ('not_started','company','contact','billing','complete'))
    $stmt$;
  end if;
end $$;

comment on column public.dsps.onboarding_step is
  'Wizard progress.  Decoupled from status so admin can resume/branch flows without state churn.';
comment on column public.dsps.billing is
  'Billing payload from the wizard.  Today: placeholder card details.  Forward-compatible with Stripe customer/subscription ids.';

-- ─── 3. Backfill existing DSPs ────────────────────────────────────────────
-- Any DSP that was already active before this migration is by
-- definition past onboarding.  Without this backfill, the dashboard
-- gate in phase 6.4 would (correctly per the new contract, wrongly
-- per the operator's experience) bounce them into the wizard on
-- first load.
update public.dsps
   set onboarding_step = 'complete',
       activated_at    = coalesce(activated_at, created_at)
 where status = 'active'
   and onboarding_step = 'not_started';

-- ─── 4. Onboarding RPCs ───────────────────────────────────────────────────
-- All gated to the DSP's own owner (or higher role; platform_admin
-- happens to satisfy is_staff(_, 'owner') in the role enum order so
-- they can complete the wizard for their own DSP if they want, but
-- they can NOT cross-tenant — current_dsp_id() pins them to their
-- own row).

-- 4a. onboarding_get_state — read wizard state for the caller's DSP.
-- Auto-advances pending → onboarding on first call so the wizard
-- doesn't have to issue a separate "begin" mutation.
create or replace function public.onboarding_get_state()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp_id uuid;
  v_dsp    public.dsps;
begin
  v_dsp_id := private.current_dsp_id();
  if v_dsp_id is null then
    raise exception 'forbidden';
  end if;
  if not private.is_staff(v_dsp_id, 'owner') then
    raise exception 'forbidden';
  end if;

  -- Idempotent transition.  Only flips when status is currently
  -- 'pending'; never demotes an already-active workspace.
  update public.dsps
     set status = 'onboarding'
   where id = v_dsp_id
     and status = 'pending';

  select * into v_dsp from public.dsps where id = v_dsp_id;

  return jsonb_build_object(
    'dsp_id',                   v_dsp.id,
    'name',                     v_dsp.name,
    'short_code',               v_dsp.short_code,
    'dba',                      v_dsp.dba,
    'business_address',         coalesce(v_dsp.business_address, v_dsp.address),
    'business_phone',           coalesce(v_dsp.business_phone, v_dsp.phone),
    'support_email',            v_dsp.support_email,
    'timezone',                 v_dsp.timezone,
    'owner_name',               v_dsp.owner_name,
    'owner_phone',              v_dsp.owner_phone,
    'emergency_contact_name',   v_dsp.emergency_contact_name,
    'emergency_contact_phone',  v_dsp.emergency_contact_phone,
    'subscription_plan',        v_dsp.subscription_plan,
    'billing',                  v_dsp.billing,
    'status',                   v_dsp.status,
    'onboarding_step',          v_dsp.onboarding_step
  );
end;
$$;

-- 4b. onboarding_save_step — autosave a single step's fields.
-- Unknown payload fields are silently ignored so the wizard can
-- evolve without coordinated SQL deploys.  Step progression is
-- monotonic: never moves backwards (so a refresh on step 3 doesn't
-- demote progress to step 2).
create or replace function public.onboarding_save_step(p_step text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp_id     uuid;
  v_step_order int;
  v_curr_order int;
  v_new_step   text;
begin
  v_dsp_id := private.current_dsp_id();
  if v_dsp_id is null then raise exception 'forbidden'; end if;
  if not private.is_staff(v_dsp_id, 'owner') then raise exception 'forbidden'; end if;
  if p_step not in ('company','contact','billing') then
    raise exception 'invalid_step: %', p_step;
  end if;

  if p_step = 'company' then
    update public.dsps set
      name             = coalesce(nullif(trim(p_payload->>'name'),'') , name),
      dba              = coalesce(p_payload->>'dba', dba),
      business_address = coalesce(p_payload->>'business_address', business_address),
      address          = coalesce(p_payload->>'business_address', address),
      business_phone   = coalesce(p_payload->>'business_phone', business_phone),
      phone            = coalesce(p_payload->>'business_phone', phone),
      support_email    = coalesce(p_payload->>'support_email', support_email),
      timezone         = coalesce(nullif(trim(p_payload->>'timezone'),'') , timezone)
    where id = v_dsp_id;
  elsif p_step = 'contact' then
    update public.dsps set
      owner_name              = coalesce(p_payload->>'owner_name', owner_name),
      owner_phone             = coalesce(p_payload->>'owner_phone', owner_phone),
      emergency_contact_name  = coalesce(p_payload->>'emergency_contact_name',  emergency_contact_name),
      emergency_contact_phone = coalesce(p_payload->>'emergency_contact_phone', emergency_contact_phone)
    where id = v_dsp_id;
  elsif p_step = 'billing' then
    update public.dsps set
      billing = jsonb_strip_nulls(billing || jsonb_build_object(
        'cardholder',    p_payload->>'cardholder',
        'card_last4',    p_payload->>'card_last4',
        'billing_email', p_payload->>'billing_email'
      ))
    where id = v_dsp_id;
  end if;

  -- Monotonic step advancement.
  select case onboarding_step
           when 'not_started' then 0
           when 'company'     then 1
           when 'contact'     then 2
           when 'billing'     then 3
           when 'complete'    then 4
         end
    into v_curr_order
    from public.dsps where id = v_dsp_id;

  v_step_order := case p_step when 'company' then 1 when 'contact' then 2 when 'billing' then 3 end;
  v_new_step   := p_step;

  if v_step_order > v_curr_order then
    update public.dsps set onboarding_step = v_new_step where id = v_dsp_id;
  end if;

  return jsonb_build_object('ok', true, 'onboarding_step',
    (select onboarding_step from public.dsps where id = v_dsp_id));
end;
$$;

-- 4c. onboarding_complete — finalize.  Saves billing payload one
-- last time, flips status onboarding/pending → active, stamps
-- activated_at + onboarded_at.  Idempotent: re-calling on an
-- already-complete DSP is a no-op.
create or replace function public.onboarding_complete(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp_id uuid;
begin
  v_dsp_id := private.current_dsp_id();
  if v_dsp_id is null then raise exception 'forbidden'; end if;
  if not private.is_staff(v_dsp_id, 'owner') then raise exception 'forbidden'; end if;

  -- Save the final billing payload (handles the case where the user
  -- hits "Activate workspace" without blurring fields).
  if p_payload is not null and p_payload <> '{}'::jsonb then
    perform public.onboarding_save_step('billing', p_payload);
  end if;

  update public.dsps set
    status          = 'active',
    onboarding_step = 'complete',
    onboarded_at    = coalesce(onboarded_at, now()),
    activated_at    = coalesce(activated_at, now())
  where id = v_dsp_id;

  return jsonb_build_object(
    'ok', true,
    'status', 'active',
    'activated_at', (select activated_at from public.dsps where id = v_dsp_id)
  );
end;
$$;

-- ─── 5. Grants ────────────────────────────────────────────────────────────
grant execute on function public.onboarding_get_state()                to authenticated;
grant execute on function public.onboarding_save_step(text, jsonb)     to authenticated;
grant execute on function public.onboarding_complete(jsonb)            to authenticated;
