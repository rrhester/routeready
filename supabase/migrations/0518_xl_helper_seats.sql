-- ── 0518 · XL routes dispatch a driver seat + a helper seat ────────────────
--
-- Operator staffing model: a dispatched XL route runs TWO people on the road
-- — one XL-certified driver plus one helper (the helper needs no cert). Until
-- now an XL route target of N generated N XL shifts (N seats), each of which
-- required an XL-certified driver, and no helper was ever scheduled. This
-- migration makes each XL route generate a PAIR of seats:
--
--   • the driver seat  — a regular XL shift (shift_kind 'regular'), still
--     gated on xl_certified by the solver / preview engine, and
--   • the helper seat  — an XL shift tagged shift_kind = 'helper', which the
--     eligibility gate treats as NON-cert-gated (rr_solver/eligibility.py +
--     engine/src/rules/r004_certification.ts already special-case it).
--
-- Both seats share the XL service_type_id and wave, so the orphan-prune (which
-- matches shifts to a positive okami_demand bucket by service_type + wave)
-- keeps them, and Smart Fill's payload builder marks the helper seat so an
-- uncertified driver can fill it.
--
-- Scope / not included (flagged for a follow-up + browser QA):
--   • Cushion (apply_cushion_to_week) sizes backups off the DRIVER seats only
--     (helpers are excluded from base_count below, preserving today's cushion
--     math). Helper seats therefore get no auto-backup from cushion yet.
--   • generate_shifts / regenerate_week_shifts are the ONLY generation seam
--     (regenerate calls generate_shifts per date), so this one function change
--     covers both the soft reconcile (Smart Fill) and the hard reset.
--
-- Idempotent: enum value guarded with IF NOT EXISTS; both functions are
-- create-or-replace. Re-running generate_shifts reconciles to target (creates
-- missing helper seats, prunes surplus) rather than duplicating.

-- 1. 'helper' shift_kind. (ADD VALUE ... IF NOT EXISTS is idempotent; the
--    value is only resolved when generate_shifts runs, never at definition
--    time, so defining the function below in the same migration is safe.)
alter type public.shift_kind add value if not exists 'helper';

-- 2. generate_shifts — driver seat (unchanged) + paired helper seat per XL
--    route. Body is 0348 verbatim except: the driver-seat count/prune now
--    exclude shift_kind 'helper'; the group query surfaces requires_xl; and a
--    helper-seat reconcile block runs for XL service types.
create or replace function private.generate_shifts(p_dsp_id uuid, p_date date, p_station_id uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_settings public.scheduling_settings;
  v_wave_count int;
  v_lead int;
  v_total_created int := 0;
  r record;
  v_existing int;
  v_to_create int;
  v_to_delete int;
  v_existing_helper int;
  v_to_create_helper int;
  v_to_delete_helper int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  v_settings := private.get_week_settings(p_dsp_id, private.week_start_for(p_date));

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then
    v_wave_count := 1;
    v_settings.waves := jsonb_build_array(jsonb_build_object('start','07:00'));
  end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  for r in
    select
      coalesce(od.wave_index, 0) as wave_index,
      od.service_type_id          as service_type_id,
      sum(od.target_routes)::int  as target_routes,
      bool_or(st.requires_xl)     as requires_xl
      from public.okami_demand od
      join public.service_types st
        on st.id = od.service_type_id
       and st.active = true
     where od.dsp_id     = p_dsp_id
       and od.date       = p_date
       and od.station_id = p_station_id
       and od.target_routes > 0
       and coalesce(od.wave_index, 0) >= 0
       and coalesce(od.wave_index, 0) < v_wave_count
     group by 1, 2
  loop
    v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
    v_starts := ((p_date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                - make_interval(mins => v_lead);
    -- ends_at = wave + block: re-add the lead so the block is anchored
    -- to the wave time, not the earlier clock-in time.
    v_ends := v_starts
              + make_interval(mins => v_lead)
              + (v_settings.default_block_hours || ' hours')::interval;

    -- ── Driver seats (the cert-gated route seat). Excludes helper rows so
    --    the helper block below owns them. ─────────────────────────────────
    select count(*)::int
      into v_existing
    from public.shifts
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          in ('scheduled', 'completed')
       and coalesce(is_cushion, false) = false
       and coalesce(shift_kind, 'regular') <> 'helper';

    if v_existing > r.target_routes then
      v_to_delete := v_existing - r.target_routes;
      -- Prune the surplus back to plan. Delete unassigned rows first, then
      -- the newest assigned rows (manual/auto over-plan adds). Never touch
      -- 'completed' shifts (status = 'scheduled' filter).
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id          = p_dsp_id
            and station_id      = p_station_id
            and date            = p_date
            and wave_index      = r.wave_index
            and service_type_id = r.service_type_id
            and status          = 'scheduled'
            and coalesce(is_cushion, false) = false
            and coalesce(shift_kind, 'regular') <> 'helper'
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_delete
       );
      v_existing := r.target_routes;
    end if;

    v_to_create := greatest(0, r.target_routes - v_existing);
    if v_to_create > 0 then
      for i in 1..v_to_create loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, false, r.wave_index, r.service_type_id);
        v_total_created := v_total_created + 1;
      end loop;
    end if;

    update public.shifts
       set starts_at  = v_starts,
           ends_at    = v_ends,
           block_hours = v_settings.default_block_hours
     where dsp_id          = p_dsp_id
       and station_id      = p_station_id
       and date            = p_date
       and wave_index      = r.wave_index
       and service_type_id = r.service_type_id
       and status          = 'scheduled'
       and (starts_at is distinct from v_starts
            or ends_at  is distinct from v_ends);

    -- ── Helper seats (XL routes only). One helper per XL route target: the
    --    second body on the road, shift_kind 'helper', NOT cert-gated. Same
    --    reconcile shape as the driver seats, filtered to helper rows. ──────
    if r.requires_xl then
      select count(*)::int
        into v_existing_helper
      from public.shifts
       where dsp_id          = p_dsp_id
         and station_id      = p_station_id
         and date            = p_date
         and wave_index      = r.wave_index
         and service_type_id = r.service_type_id
         and status          in ('scheduled', 'completed')
         and coalesce(is_cushion, false) = false
         and coalesce(shift_kind, 'regular') = 'helper';

      if v_existing_helper > r.target_routes then
        v_to_delete_helper := v_existing_helper - r.target_routes;
        delete from public.shifts
         where id in (
           select id from public.shifts
            where dsp_id          = p_dsp_id
              and station_id      = p_station_id
              and date            = p_date
              and wave_index      = r.wave_index
              and service_type_id = r.service_type_id
              and status          = 'scheduled'
              and coalesce(is_cushion, false) = false
              and coalesce(shift_kind, 'regular') = 'helper'
            order by (driver_id is not null) asc,
                     created_at desc
            limit v_to_delete_helper
         );
        v_existing_helper := r.target_routes;
      end if;

      v_to_create_helper := greatest(0, r.target_routes - v_existing_helper);
      if v_to_create_helper > 0 then
        for i in 1..v_to_create_helper loop
          insert into public.shifts
            (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id, shift_kind)
          values
            (p_dsp_id, p_station_id, p_date, v_starts, v_ends, 'scheduled', 'auto',
             v_settings.default_block_hours, false, r.wave_index, r.service_type_id, 'helper');
          v_total_created := v_total_created + 1;
        end loop;
      end if;
    end if;
  end loop;

  -- ── Prune orphan over-plan rows (cushion included) ─────────────────────
  -- Any remaining 'scheduled' shift at this station/date whose
  -- (service_type_id, wave_index) is NOT backed by a positive okami_demand
  -- group. Helper seats sit on the XL service_type + wave, which HAS positive
  -- demand, so they match a positive group and are KEPT alongside their
  -- driver seats. 'completed' rows protected (status filter).
  delete from public.shifts s
   where s.dsp_id     = p_dsp_id
     and s.station_id = p_station_id
     and s.date       = p_date
     and s.status     = 'scheduled'
     and not exists (
       select 1
         from public.okami_demand od
         join public.service_types st
           on st.id = od.service_type_id
          and st.active = true
        where od.dsp_id        = p_dsp_id
          and od.date          = p_date
          and od.station_id    = p_station_id
          and od.target_routes > 0
          and od.service_type_id = s.service_type_id
          and coalesce(od.wave_index, 0) = coalesce(s.wave_index, 0)
     );

  return v_total_created;
end;
$$;

-- 3. apply_cushion_to_week — size cushion off DRIVER seats only. Body is 0347
--    verbatim except base_count now excludes shift_kind 'helper', so helper
--    seats neither inflate the XL cushion target nor get their own cushion.
create or replace function public.apply_cushion_to_week(p_week_start date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_end date := p_week_start + 6;
  v_cushion_pct numeric;
  v_settings public.scheduling_settings;
  v_lead int;
  v_wave_count int;
  v_added int := 0;
  r record;
  v_target_cushion int;
  v_existing_cushion int;
  v_to_add int;
  v_to_remove int;
  v_index int;
  v_wave_start text;
  v_starts timestamptz;
  v_ends timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_settings := private.get_week_settings(v_dsp, p_week_start);
  v_cushion_pct := coalesce(v_settings.cushion_pct, 0);

  v_wave_count := jsonb_array_length(coalesce(v_settings.waves, '[]'::jsonb));
  if v_wave_count = 0 then v_wave_count := 1; end if;
  v_lead := coalesce(v_settings.report_lead_minutes, 0);

  -- Reconcile cushion per (date, station, wave_index, service_type_id)
  -- bucket. base_count is the real non-cushion, non-helper shift count for
  -- that bucket (helpers are excluded so cushion mirrors the driver seats it
  -- backs up), so a cushion shift always mirrors the wave + service type it
  -- cushions.
  for r in
    select
      s.date,
      s.station_id,
      coalesce(s.wave_index, 0)  as wave_index,
      s.service_type_id          as service_type_id,
      count(*)::int              as base_count
      from public.shifts s
     where s.dsp_id = v_dsp
       and s.date between p_week_start and v_week_end
       and s.status in ('scheduled', 'completed')
       and coalesce(s.is_cushion, false) = false
       and coalesce(s.shift_kind, 'regular') <> 'helper'
       and s.service_type_id is not null
     group by s.date, s.station_id, coalesce(s.wave_index, 0), s.service_type_id
  loop
    v_target_cushion := case
      when v_cushion_pct <= 0 then 0
      else round(r.base_count::numeric * v_cushion_pct / 100)::int
    end;

    select count(*)::int into v_existing_cushion
      from public.shifts
     where dsp_id                  = v_dsp
       and station_id              = r.station_id
       and date                    = r.date
       and coalesce(wave_index, 0) = r.wave_index
       and service_type_id         = r.service_type_id
       and is_cushion              = true
       and status                  in ('scheduled', 'completed');

    if v_existing_cushion < v_target_cushion then
      v_to_add := v_target_cushion - v_existing_cushion;
      v_wave_start := coalesce(v_settings.waves->r.wave_index->>'start', '07:00');
      v_starts := ((r.date::text || ' ' || v_wave_start)::timestamp at time zone v_settings.timezone)
                  - make_interval(mins => v_lead);
      v_ends := v_starts
                + make_interval(mins => v_lead)
                + (v_settings.default_block_hours || ' hours')::interval;
      for v_index in 1..v_to_add loop
        insert into public.shifts
          (dsp_id, station_id, date, starts_at, ends_at, status, source, block_hours, is_cushion, wave_index, service_type_id)
        values
          (v_dsp, r.station_id, r.date, v_starts, v_ends, 'scheduled', 'auto',
           v_settings.default_block_hours, true, r.wave_index, r.service_type_id);
        v_added := v_added + 1;
      end loop;
    elsif v_existing_cushion > v_target_cushion then
      -- Trim surplus cushion in this bucket. Unassigned rows first, then the
      -- newest assigned ones; never touch 'completed'.
      v_to_remove := v_existing_cushion - v_target_cushion;
      delete from public.shifts
       where id in (
         select id from public.shifts
          where dsp_id                  = v_dsp
            and station_id              = r.station_id
            and date                    = r.date
            and coalesce(wave_index, 0) = r.wave_index
            and service_type_id         = r.service_type_id
            and is_cushion              = true
            and status                  = 'scheduled'
          order by (driver_id is not null) asc,
                   created_at desc
          limit v_to_remove
       );
    end if;
  end loop;

  -- ── Prune orphan cushion rows ──────────────────────────────────────────
  -- Any UNASSIGNED cushion shift whose (wave_index, service_type_id) no
  -- longer matches a non-cushion demand bucket on that day/station. Assigned
  -- cushion rows (real commitments) and 'completed' rows are protected.
  delete from public.shifts c
   where c.dsp_id     = v_dsp
     and c.date between p_week_start and v_week_end
     and c.is_cushion = true
     and c.status     = 'scheduled'
     and c.driver_id is null
     and not exists (
       select 1
         from public.shifts s
        where s.dsp_id     = v_dsp
          and s.date       = c.date
          and s.station_id = c.station_id
          and s.status     in ('scheduled', 'completed')
          and coalesce(s.is_cushion, false) = false
          and s.service_type_id         = c.service_type_id
          and coalesce(s.wave_index, 0) = coalesce(c.wave_index, 0)
     );

  return v_added;
end;
$$;

grant execute on function public.apply_cushion_to_week(date) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0518_xl_helper_seats.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
