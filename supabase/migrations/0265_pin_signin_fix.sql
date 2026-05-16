-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0265 · Fix PIN sign-in · ensure driver_pin_attempts exists
--
-- Operator: "The pin selection showed up, but when I had to use it on
-- the webapp it didn't work." The user picked a PIN on the welcome
-- screen (0262 + 0264 + #1027), so pin_hash is on the driver row, but
-- driver_signin_with_phone (defined in 0253) reads from
-- public.driver_pin_attempts for its rate-limit check. That table was
-- created in the same migration but never made it onto this instance
-- — the earlier Ryan scrub also failed on it. Every PIN sign-in
-- attempt was erroring before bcrypt ever ran, surfacing as a generic
-- "invalid_phone_or_pin" toast in the app.
--
-- Two parts:
--   1. CREATE TABLE IF NOT EXISTS for driver_pin_attempts. Idempotent
--      on instances where 0253 did land.
--   2. CREATE OR REPLACE for driver_signin_with_phone with a
--      to_regclass() guard around the table reads. Future drops of
--      the table won't take sign-in out again — the function just
--      skips rate limiting in that case.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Ensure the rate-limit table exists ─────────────────────────────

create table if not exists public.driver_pin_attempts (
  phone_normalized text primary key,
  failed_count     int  not null default 0,
  last_failed_at   timestamptz,
  locked_until     timestamptz
);

alter table public.driver_pin_attempts enable row level security;
-- No public policies — only the SECURITY DEFINER RPCs touch it.


-- ── 2. driver_signin_with_phone · defensive against missing table ─────

create or replace function public.driver_signin_with_phone(
  p_phone text,
  p_pin   text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_phone_norm text;
  v_pin_clean  text;
  v_drv        public.drivers;
  v_dsp        public.dsps;
  v_token      text;
  v_locked     timestamptz;
  v_failed     int;
  v_has_attempts_tbl boolean;
begin
  v_phone_norm := private.normalize_phone(p_phone);
  v_pin_clean  := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  if v_phone_norm is null or length(v_pin_clean) < 4 then
    raise exception 'invalid_phone_or_pin' using errcode = '22023';
  end if;

  v_has_attempts_tbl := to_regclass('public.driver_pin_attempts') is not null;

  if v_has_attempts_tbl then
    execute 'select locked_until, failed_count from public.driver_pin_attempts where phone_normalized = $1'
      into v_locked, v_failed
      using v_phone_norm;
    if v_locked is not null and v_locked > now() then
      raise exception 'too_many_attempts' using errcode = '42501';
    end if;
  end if;

  select * into v_drv from public.drivers
   where phone_normalized = v_phone_norm
     and status in ('active','onboarding')
     and pin_hash is not null
   order by case status when 'active' then 0 when 'onboarding' then 1 else 2 end,
            updated_at desc
   limit 1;

  if v_drv.id is null
     or v_drv.pin_hash is null
     or v_drv.pin_hash <> extensions.crypt(v_pin_clean, v_drv.pin_hash) then
    if v_has_attempts_tbl then
      execute $rate$
        insert into public.driver_pin_attempts (phone_normalized, failed_count, last_failed_at)
        values ($1, 1, now())
        on conflict (phone_normalized) do update
          set failed_count   = public.driver_pin_attempts.failed_count + 1,
              last_failed_at = now(),
              locked_until   = case
                when public.driver_pin_attempts.failed_count + 1 >= 5 then now() + interval '15 minutes'
                else public.driver_pin_attempts.locked_until
              end
      $rate$ using v_phone_norm;
    end if;
    raise exception 'invalid_phone_or_pin' using errcode = '42501';
  end if;

  if v_has_attempts_tbl then
    execute 'delete from public.driver_pin_attempts where phone_normalized = $1'
      using v_phone_norm;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '')
          || replace(gen_random_uuid()::text, '-', '');

  insert into public.driver_sessions (token, dsp_id, driver_id, user_agent)
  values (v_token, v_drv.dsp_id, v_drv.id, p_user_agent);

  select * into v_dsp from public.dsps where id = v_drv.dsp_id;

  return jsonb_build_object(
    'token', v_token,
    'driver', jsonb_build_object(
      'id',         v_drv.id,
      'dsp_id',     v_drv.dsp_id,
      'full_name',  v_drv.full_name,
      'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
      'station_id', v_drv.station_id,
      'tier',       v_drv.tier,
      'status',     v_drv.status,
      'dsp_name',   coalesce(v_dsp.name, ''),
      'phone_normalized', v_drv.phone_normalized
    )
  );
end;
$$;
grant execute on function public.driver_signin_with_phone(text, text, text) to anon, authenticated;


notify pgrst, 'reload schema';
