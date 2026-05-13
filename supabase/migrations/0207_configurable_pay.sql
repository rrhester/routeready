-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0207 · Configurable pay & overtime defaults
--
-- Surfaces the three pay-related scheduling values that previously lived
-- only on dsps.metadata.scheduling and required a direct DB edit to
-- change: overtime_threshold_hours, default_overtime_multiplier,
-- default_hourly_rate. These are read by the Cover-shift candidates RPC
-- (migration 0198) and the schedule forecast RPC (migration 0202).
--
-- Defaults match the prior hardcoded fallbacks: 40h / 1.5× / null
-- (no DSP-wide hourly default — per-driver pay applies first).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. get_pay_settings ────────────────────────────────────────────────
create or replace function public.get_pay_settings()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_m   jsonb;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  return jsonb_build_object(
    'overtime_threshold_hours',    coalesce((v_m->>'overtime_threshold_hours')::int, 40),
    'default_overtime_multiplier', coalesce((v_m->>'default_overtime_multiplier')::numeric, 1.5),
    'default_hourly_rate',         (v_m->>'default_hourly_rate')::numeric
  );
end;
$$;
grant execute on function public.get_pay_settings() to authenticated;


-- ── 2. set_pay_settings ────────────────────────────────────────────────
-- Dispatcher-level write. Null inputs leave the existing key unchanged
-- (matching set_woc_settings). Hourly rate is the exception — a previously
-- unset rate stays unset until the dispatcher types one in. Sanity bounds
-- match what payroll could plausibly need.
create or replace function public.set_pay_settings(
  p_overtime_threshold_hours    int     default null,
  p_default_overtime_multiplier numeric default null,
  p_default_hourly_rate         numeric default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_m             jsonb;
  v_new_threshold int;
  v_new_mult      numeric;
  v_new_rate      numeric;
begin
  if v_dsp is null then raise exception 'dsp_id_required' using errcode = '22023'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_overtime_threshold_hours is not null
     and (p_overtime_threshold_hours < 0 or p_overtime_threshold_hours > 168) then
    raise exception 'overtime_threshold_hours_out_of_range' using errcode = '22023';
  end if;
  if p_default_overtime_multiplier is not null
     and (p_default_overtime_multiplier < 1 or p_default_overtime_multiplier > 5) then
    raise exception 'default_overtime_multiplier_out_of_range' using errcode = '22023';
  end if;
  if p_default_hourly_rate is not null
     and (p_default_hourly_rate < 0 or p_default_hourly_rate > 500) then
    raise exception 'default_hourly_rate_out_of_range' using errcode = '22023';
  end if;

  v_new_threshold := coalesce(
    p_overtime_threshold_hours,
    (select (metadata->'scheduling'->>'overtime_threshold_hours')::int
       from public.dsps where id = v_dsp),
    40
  );
  v_new_mult := coalesce(
    p_default_overtime_multiplier,
    (select (metadata->'scheduling'->>'default_overtime_multiplier')::numeric
       from public.dsps where id = v_dsp),
    1.5
  );
  -- Hourly rate intentionally has no fallback default — null means
  -- "no DSP-wide default; only per-driver rates apply."
  v_new_rate := coalesce(
    p_default_hourly_rate,
    (select (metadata->'scheduling'->>'default_hourly_rate')::numeric
       from public.dsps where id = v_dsp)
  );

  update public.dsps
     set metadata = jsonb_set(
       jsonb_set(
         jsonb_set(
           coalesce(metadata, '{}'::jsonb)
             #- '{scheduling}'
             || jsonb_build_object('scheduling', coalesce(metadata->'scheduling', '{}'::jsonb)),
           '{scheduling,overtime_threshold_hours}',
           to_jsonb(v_new_threshold),
           true),
         '{scheduling,default_overtime_multiplier}',
         to_jsonb(v_new_mult),
         true),
       '{scheduling,default_hourly_rate}',
       case when v_new_rate is null then 'null'::jsonb else to_jsonb(v_new_rate) end,
       true)
   where id = v_dsp;

  select coalesce(metadata->'scheduling', '{}'::jsonb) into v_m
    from public.dsps where id = v_dsp;
  return jsonb_build_object(
    'overtime_threshold_hours',    (v_m->>'overtime_threshold_hours')::int,
    'default_overtime_multiplier', (v_m->>'default_overtime_multiplier')::numeric,
    'default_hourly_rate',         (v_m->>'default_hourly_rate')::numeric
  );
end;
$$;
grant execute on function public.set_pay_settings(int, numeric, numeric) to authenticated;

notify pgrst, 'reload schema';
