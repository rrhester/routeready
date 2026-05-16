-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0261 · License back image + manual-shift kind selector
--
-- Two unrelated operator asks bundled because both add one column to an
-- existing table and extend the RPC that writes it. Splitting would just
-- mean two near-identical migrations on the same schema slice.
--
-- 1. Driver's license: today drivers.dl_image_path holds the front side.
--    DLs have a back. Add drivers.dl_back_image_path, surface it on
--    driver_get_profile, and thread a p_side argument through
--    driver_set_dl_image / driver_clear_dl_image so the existing
--    no-argument callers keep writing the front.
--
-- 2. Manual "Add shift" needs a shift type — "Training" is the
--    immediate ask but the operator will want more later. Add a
--    public.shift_kind enum (regular | training | ride_along | rescue |
--    other), add shifts.shift_kind defaulting to 'regular', and thread
--    it through create_shift. Existing rows backfill to 'regular' so
--    none of the schedule reads need to handle null.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Driver's license · back image ──────────────────────────────────

alter table public.drivers
  add column if not exists dl_back_image_path text;


create or replace function public.driver_get_profile(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return jsonb_build_object(
    'id',                            v_drv.id,
    'full_name',                     v_drv.full_name,
    'preferred_name',                v_drv.preferred_name,
    'pronouns',                      v_drv.pronouns,
    'phone',                         v_drv.phone,
    'email',                         v_drv.email,
    'address',                       v_drv.address,
    'emergency_contact_name',        v_drv.emergency_contact_name,
    'emergency_contact_phone',       v_drv.emergency_contact_phone,
    'dl_number',                     v_drv.dl_number,
    'dl_image_path',                 v_drv.dl_image_path,
    'dl_back_image_path',            v_drv.dl_back_image_path,
    'dl_expires_on',                 v_drv.dl_expires_on,
    'dot_certified',                 v_drv.dot_certified,
    'xl_certified',                  v_drv.xl_certified,
    'status',                        v_drv.status,
    'hire_date',                     v_drv.hire_date,
    'background_check_completed_at', v_drv.background_check_completed_at,
    'drug_test_completed_at',        v_drv.drug_test_completed_at,
    'dsp_id',                        v_drv.dsp_id,
    'birthday',                      v_drv.birthday,
    'pin_hash',                      case when v_drv.pin_hash is null then null else 'set' end
  );
end;
$$;
grant execute on function public.driver_get_profile(text) to anon, authenticated;


-- Drop the single-arg signature so the new two-arg version is the only
-- function with this name. PostgREST then resolves cleanly when callers
-- omit p_side (the new default kicks in).
drop function if exists public.driver_set_dl_image(text, text);

create or replace function public.driver_set_dl_image(
  p_token text,
  p_path  text,
  p_side  text default 'front'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_old text;
  v_prefix text;
  v_side text := lower(coalesce(p_side, 'front'));
begin
  if v_side not in ('front','back') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;

  v_drv := private.driver_validate_token(p_token);

  v_prefix := v_drv.dsp_id::text || '/' || v_drv.id::text || '/';
  if p_path is null or position(v_prefix in p_path) <> 1 then
    raise exception 'invalid_path' using errcode = '22023';
  end if;

  if v_side = 'back' then
    v_old := v_drv.dl_back_image_path;
    update public.drivers set dl_back_image_path = p_path where id = v_drv.id;
  else
    v_old := v_drv.dl_image_path;
    update public.drivers set dl_image_path = p_path where id = v_drv.id;
  end if;

  if v_old is not null and v_old <> p_path then
    begin
      delete from storage.objects
       where bucket_id = 'driver-documents'
         and name = v_old;
    exception when others then null;
    end;
  end if;

  return public.driver_get_profile(p_token);
end;
$$;
grant execute on function public.driver_set_dl_image(text, text, text) to anon, authenticated;


drop function if exists public.driver_clear_dl_image(text);

create or replace function public.driver_clear_dl_image(
  p_token text,
  p_side  text default 'front'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_old text;
  v_side text := lower(coalesce(p_side, 'front'));
begin
  if v_side not in ('front','back') then
    raise exception 'invalid_side' using errcode = '22023';
  end if;

  v_drv := private.driver_validate_token(p_token);

  if v_side = 'back' then
    v_old := v_drv.dl_back_image_path;
    update public.drivers set dl_back_image_path = null where id = v_drv.id;
  else
    v_old := v_drv.dl_image_path;
    update public.drivers set dl_image_path = null where id = v_drv.id;
  end if;

  if v_old is not null then
    begin
      delete from storage.objects
       where bucket_id = 'driver-documents'
         and name = v_old;
    exception when others then null;
    end;
  end if;

  return public.driver_get_profile(p_token);
end;
$$;
grant execute on function public.driver_clear_dl_image(text, text) to anon, authenticated;


-- ── 2. Manual shift · shift_kind enum + create_shift payload ──────────

do $$ begin
  create type public.shift_kind as enum (
    'regular',
    'training',
    'ride_along',
    'rescue',
    'other'
  );
exception when duplicate_object then null; end $$;

alter table public.shifts
  add column if not exists shift_kind public.shift_kind not null default 'regular';

create index if not exists shifts_kind_idx
  on public.shifts (dsp_id, date, shift_kind)
  where shift_kind <> 'regular';


create or replace function public.create_shift(p_payload jsonb)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.shifts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.shifts
    (dsp_id, station_id, driver_id, date, starts_at, ends_at, route_code, status, notes, source, shift_kind, created_by)
  values
    (v_dsp,
     (p_payload->>'station_id')::uuid,
     nullif(p_payload->>'driver_id','')::uuid,
     (p_payload->>'date')::date,
     nullif(p_payload->>'starts_at','')::timestamptz,
     nullif(p_payload->>'ends_at','')::timestamptz,
     p_payload->>'route_code',
     coalesce((p_payload->>'status')::public.shift_status, 'scheduled'),
     p_payload->>'notes',
     coalesce((p_payload->>'source')::public.shift_source, 'manual'),
     coalesce((p_payload->>'shift_kind')::public.shift_kind, 'regular'),
     auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.create_shift(jsonb) to authenticated;


notify pgrst, 'reload schema';
