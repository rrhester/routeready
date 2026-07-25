-- ── 0546 · Server-side MFA enforcement primitive + opt-in on settings ─────────
--
-- Partial fix for launch-audit finding H-1. MFA is enforced only on the
-- client (the _rrMfaGateOnBoot login gate); the data API has NO server-side
-- assurance-level check, so a stolen password + the public anon key reaches
-- PostgREST at aal1 and never sees the challenge.
--
-- This ships the reusable server primitive and applies it, opt-in, to the
-- DSP settings mutators as the reference pattern. It deliberately does NOT
-- broadly enforce MFA across every table/RPC — that is the tested, live-device
-- rollout described in docs/MFA.md and must not be flipped on blind.
--
-- private.mfa_ok() — the safe assurance check:
--   true  when the session is aal2, OR the caller has NO verified factor.
--   So enforcing it can NEVER block a user who didn't enrol MFA, and an
--   enrolled user is already aal2 after the client login challenge — only an
--   enrolled session that reached the API at aal1 (the attack) is refused.
--   Mirrors the client gate's "challenge only if a factor exists" invariant.
--
-- Opt-in per DSP: dsps.metadata.security.require_mfa (default false). The
-- settings mutators enforce mfa_ok ONLY when their DSP has opted in, so this
-- migration changes nothing until an operator turns it on AFTER the tested
-- rollout. Break-glass: set require_mfa=false (or remove the factor) — see
-- docs/MFA.md.

create or replace function private.mfa_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
    or not exists (
      select 1 from auth.mfa_factors
      where user_id = auth.uid() and status = 'verified'
    );
$$;

-- Callable by authenticated (it only reflects the caller's own session).
do $$ begin grant execute on function private.mfa_ok() to authenticated; exception when undefined_object then null; end $$;

-- Helper: does this DSP require MFA for sensitive changes?
create or replace function private.dsp_requires_mfa(p_dsp uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select (metadata->'security'->>'require_mfa')::boolean
    from public.dsps where id = p_dsp
  ), false);
$$;

-- ── Opt-in MFA enforcement on the DSP settings mutators ───────────────────
-- Each re-issued from its live definition (0201 / 0203 / 0544) with one added
-- check after the existing staff gate. NULL/absent flag = unchanged behaviour.

create or replace function public.set_pickup_settings(p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.dsp_requires_mfa(v_dsp) and not private.mfa_ok() then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb)
         #- '{scheduling}' || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
       '{scheduling,driver_pickup_enabled}',
       to_jsonb(coalesce(p_enabled, false)),
       true)
   where id = v_dsp;

  return jsonb_build_object('driver_pickup_enabled', coalesce(p_enabled, false));
end;
$$;

create or replace function public.set_swap_settings(p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.dsp_requires_mfa(v_dsp) and not private.mfa_ok() then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb)
         #- '{scheduling}' || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
       '{scheduling,driver_swap_enabled}',
       to_jsonb(coalesce(p_enabled, false)),
       true)
   where id = v_dsp;
  return jsonb_build_object('driver_swap_enabled', coalesce(p_enabled, false));
end;
$$;

create or replace function public.set_publish_gate_settings(p_enabled boolean)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if private.dsp_requires_mfa(v_dsp) and not private.mfa_ok() then
    raise exception 'mfa_required' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb)
         #- '{scheduling}' || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
       '{scheduling,require_finalized_for_drivers}',
       to_jsonb(coalesce(p_enabled, false)),
       true)
   where id = v_dsp;

  return jsonb_build_object('require_finalized_for_drivers', coalesce(p_enabled, false));
end;
$$;

notify pgrst, 'reload schema';
