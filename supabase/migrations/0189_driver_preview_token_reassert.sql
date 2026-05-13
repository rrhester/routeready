-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0189 · Re-assert the dispatcher preview-token plumbing
--
-- Idempotent re-statement of everything migration 0188 added, plus a fresh
-- `notify pgrst` so PostgREST exposes the new RPCs.  Harmless if 0188 already
-- applied cleanly; this exists so a re-run of the Supabase deploy workflow
-- reliably leaves driver_preview_token / driver_preview_token_revoke in place
-- and visible to the API.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.driver_sessions
  add column if not exists expires_at timestamptz,
  add column if not exists is_preview boolean not null default false;


create or replace function private.driver_validate_token(p_token text)
returns public.drivers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_driver_id uuid;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_drv public.drivers;
begin
  select driver_id, revoked_at, expires_at into v_driver_id, v_revoked, v_expires
    from public.driver_sessions where token = p_token;
  if v_driver_id is null then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if v_revoked is not null then
    raise exception 'session_revoked' using errcode = '42501';
  end if;
  if v_expires is not null and v_expires < now() then
    raise exception 'session_expired' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = v_driver_id;
  if v_drv.status not in ('active','onboarding') then
    update public.driver_sessions set revoked_at = now() where token = p_token;
    raise exception 'driver_inactive' using errcode = '42501';
  end if;

  update public.driver_sessions
     set last_seen_at = now()
   where token = p_token;

  return v_drv;
end;
$$;


create or replace function public.driver_preview_token(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_driver public.drivers;
  v_token text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_driver from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_driver.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_driver.status not in ('active','onboarding') then
    raise exception 'driver_inactive' using errcode = 'P0001';
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent, is_preview, expires_at)
  values (v_token, v_dsp, v_driver.id, 'dispatcher-preview', true, now() + interval '2 hours');

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_driver.id,
      'dsp_id',     v_driver.dsp_id,
      'full_name',  v_driver.full_name,
      'name',       coalesce(nullif(trim(v_driver.preferred_name), ''), v_driver.full_name),
      'station_id', v_driver.station_id,
      'tier',       v_driver.tier,
      'status',     v_driver.status
    )
  );
end;
$$;
grant execute on function public.driver_preview_token(uuid) to authenticated;


create or replace function public.driver_preview_token_revoke(p_token text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.driver_sessions
     set revoked_at = now()
   where token = p_token and is_preview = true and dsp_id = v_dsp and revoked_at is null;
end;
$$;
grant execute on function public.driver_preview_token_revoke(text) to authenticated;

notify pgrst, 'reload schema';
