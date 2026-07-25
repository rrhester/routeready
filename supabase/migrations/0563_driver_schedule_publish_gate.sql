-- ── 0563 · Draft/publish gate for the driver schedule feed ────────────────────
--
-- Closes launch-audit finding H-3. Today driver_my_schedule returns EVERY
-- shift assigned to a driver the instant it is written — a half-built Smart
-- Fill result, a mistaken manual assign, an un-reviewed week — all are
-- immediately visible (and push-notified) to drivers. There was no
-- draft/published boundary on what drivers see.
--
-- The product already has a per-week FINALIZE state
-- (public.scheduling_settings.finalized, migration 0037, toggled by
-- set_schedule_finalized() behind the dispatcher's finalize gate). This
-- migration lets a DSP require that finalize before drivers see a week:
--
--   dsps.metadata.scheduling.require_finalized_for_drivers  (default false)
--
--   • false (default — every existing DSP): driver_my_schedule is
--     byte-identical to before. No week vanishes, nothing changes.
--   • true (opt-in): a shift is returned to the driver only when its week is
--     finalized (scheduling_settings.finalized = true for that dsp+week).
--     Un-finalized (draft) weeks stay hidden until the dispatcher publishes.
--
-- Backward-safe by construction: the gate is off unless a DSP turns it on, so
-- this cannot empty an existing driver's schedule. The week→shift mapping
-- reuses private.week_start_for(sh.date), exactly as the report-lead lookup in
-- the same function already does, so "finalized" agrees with what the
-- dispatcher toggled. Re-issued verbatim from 0288 + the gate; re-grant kept.

create or replace function public.driver_my_schedule(p_token text, p_weeks int default 2)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_start date := private.week_start_for(current_date);
  v_end date;
  v_shifts jsonb;
  v_require_final boolean;
begin
  v_drv := private.driver_validate_token(p_token);
  v_end := v_start + (greatest(1, least(8, coalesce(p_weeks, 2))) * 7) - 1;

  -- Per-DSP opt-in: only show finalized weeks to drivers. Default false =
  -- unchanged behaviour (all assigned shifts visible).
  select coalesce((d.metadata->'scheduling'->>'require_finalized_for_drivers')::boolean, false)
    into v_require_final
    from public.dsps d
   where d.id = v_drv.dsp_id;
  v_require_final := coalesce(v_require_final, false);

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',                sh.id,
      'date',              sh.date,
      'starts_at',         sh.starts_at,
      'ends_at',           sh.ends_at,
      'wave_starts_at',    sh.starts_at + make_interval(mins => coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0)),
      'report_lead_minutes', coalesce((
        select ss.report_lead_minutes
          from public.scheduling_settings ss
         where ss.dsp_id = sh.dsp_id
           and ss.week_start = private.week_start_for(sh.date)
      ), 0),
      'station_id',        sh.station_id,
      'station_code',      s.code,
      'station_latitude',  s.latitude,
      'station_longitude', s.longitude,
      'status',            sh.status,
      'block_hours',       sh.block_hours,
      'wave_index',        sh.wave_index,
      'service_type_code', st.code,
      'service_type_color',st.color,
      'is_cushion',        sh.is_cushion,
      'route_code',        sh.route_code,
      'shift_kind',        sh.shift_kind,
      'trainer_driver_id', sh.trainer_driver_id,
      'trainer_name',      tr.full_name,
      'notes',             sh.notes
    ) order by sh.date, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.stations     s  on s.id  = sh.station_id
  left join public.service_types st on st.id = sh.service_type_id
  left join public.drivers      tr on tr.id = sh.trainer_driver_id
  where sh.driver_id = v_drv.id
    and sh.date between v_start and v_end
    and (
      not v_require_final
      or exists (
        select 1 from public.scheduling_settings ss
        where ss.dsp_id     = sh.dsp_id
          and ss.week_start = private.week_start_for(sh.date)
          and ss.finalized  = true
      )
    );

  return jsonb_build_object(
    'driver', jsonb_build_object(
      'id',        v_drv.id,
      'full_name', v_drv.full_name,
      'name',      coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name)
    ),
    'shifts', v_shifts,
    'start',  v_start,
    'end',    v_end
  );
end;
$$;

grant execute on function public.driver_my_schedule(text, int) to anon, authenticated;

-- ── Owner/dispatcher toggle for the gate ──────────────────────────────────
-- Mirrors the driver_pickup_enabled pattern (migration 0201): a per-DSP
-- scheduling boolean, staff-gated, read/written through an RPC pair.
create or replace function public.get_publish_gate_settings()
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
    'require_finalized_for_drivers',
    coalesce((v_m->>'require_finalized_for_drivers')::boolean, false)
  );
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

grant execute on function public.get_publish_gate_settings()        to authenticated;
grant execute on function public.set_publish_gate_settings(boolean) to authenticated;

notify pgrst, 'reload schema';
