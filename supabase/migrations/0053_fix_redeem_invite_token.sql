-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0053 · Fix redeem_driver_invite token generation
--
-- 0052 used encode(gen_random_bytes(32),'hex') for the session token,
-- but gen_random_bytes lives in the pgcrypto extension and is not on
-- the empty search_path the function declares. Result: every redeem
-- call raised "function gen_random_bytes(integer) does not exist".
--
-- Switch to gen_random_uuid (in pg_catalog, always available even with
-- search_path = ''). Two UUIDs concatenated and stripped of hyphens
-- give us 64 hex chars / 244 bits of entropy — plenty for a bearer
-- token.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.redeem_driver_invite(p_code text, p_user_agent text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite public.driver_invite_codes;
  v_driver public.drivers;
  v_token text;
begin
  select * into v_invite
    from public.driver_invite_codes
   where code = upper(trim(p_code))
     and consumed_at is null
     and expires_at > now();
  if v_invite.code is null then
    raise exception 'invalid_or_expired_code' using errcode = 'P0001';
  end if;

  select * into v_driver from public.drivers where id = v_invite.driver_id;
  if v_driver.id is null then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_driver.status not in ('active','onboarding') then
    raise exception 'driver_inactive' using errcode = 'P0001';
  end if;

  -- 64-char hex bearer token sourced from two UUIDs (no pgcrypto needed).
  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent)
  values (v_token, v_invite.dsp_id, v_invite.driver_id, p_user_agent);

  update public.driver_invite_codes
     set consumed_at = now()
   where code = v_invite.code;

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_driver.id,
      'dsp_id',     v_driver.dsp_id,
      'full_name',  v_driver.full_name,
      'name',       coalesce(nullif(trim(v_driver.preferred_name), ''), v_driver.full_name),
      'station_id', v_driver.station_id,
      'tier',       v_driver.tier
    )
  );
end;
$$;
grant execute on function public.redeem_driver_invite(text, text) to anon, authenticated;
