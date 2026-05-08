-- Operator: route plan inputs producing 2,2,5,5,2,2,5 instead of
-- the 5/day they typed. Agent investigation pinpointed two bugs;
-- this migration handles the SQL side.
--
-- 1. okami_set_target's SP fallback (introduced in 0050) was:
--      select id into v_st from public.service_types
--       where dsp_id = v_dsp and code = 'SP' limit 1;
--    No `active = true` filter, no stable ORDER BY. If a DSP somehow
--    has more than one row with code='SP' (legacy migration leftover,
--    seed double-run, or future re-seeding), `limit 1` returns an
--    arbitrary row across calls. Two consecutive saveOkamiDaily
--    invocations for "SP" could land on different service_type_ids,
--    each writing to its own okami_demand row. Result: scattered
--    target_routes across what looks like the same logical bucket.
--
--    Fix: filter to active=true, stable ORDER BY created_at.
--
-- 2. Add public.debug_okami_demand(week_start) — a read-only RPC the
--    operator (or future me) can call from devtools to dump the raw
--    okami_demand state for a week, surfacing exactly what the UI
--    has written. Catches "the input save isn't reaching the DB"
--    bugs without guesswork.

drop function if exists public.okami_set_target(date, uuid, int, int, uuid);

create or replace function public.okami_set_target(
  p_date date,
  p_station_id uuid,
  p_target int,
  p_wave_index int default 0,
  p_service_type_id uuid default null
)
returns public.okami_demand
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_st  uuid := p_service_type_id;
  v_row public.okami_demand;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Resolve SP fallback deterministically: active rows only, oldest
  -- first. With the unique-by-code seed in 0050 there should only
  -- be one, but we don't trust 'limit 1' to pick the same row across
  -- calls without an ORDER BY.
  if v_st is null then
    select id into v_st
      from public.service_types
     where dsp_id = v_dsp
       and code = 'SP'
       and active = true
     order by created_at
     limit 1;
  end if;

  insert into public.okami_demand
    (dsp_id, station_id, date, wave_index, service_type_id, target_routes, created_by)
  values
    (v_dsp, p_station_id, p_date, greatest(0, p_wave_index), v_st, greatest(0, p_target), auth.uid())
  on conflict (dsp_id, station_id, date, wave_index, service_type_id) do update
    set target_routes = excluded.target_routes,
        updated_at    = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.okami_set_target(date, uuid, int, int, uuid) to authenticated;


-- Diagnostic dump for a week. Runs in devtools console:
--   await sb.rpc('debug_okami_demand', { p_week_start: '2026-05-11' })
--     .then(r => console.table(r.data))
-- Surfaces the raw demand the schedule will rebuild from.
create or replace function public.debug_okami_demand(p_week_start date)
returns table (
  date              date,
  station_code      text,
  wave_index        int,
  service_type_code text,
  service_type_active bool,
  target_routes     int
)
language sql
stable
security definer
set search_path = ''
as $$
  select od.date,
         s.code,
         od.wave_index,
         st.code,
         st.active,
         od.target_routes
    from public.okami_demand od
    join public.stations      s  on s.id  = od.station_id
    join public.service_types st on st.id = od.service_type_id
   where od.dsp_id = private.current_dsp_id()
     and od.date between p_week_start and p_week_start + 6
   order by od.date, s.code, od.wave_index, st.code;
$$;

grant execute on function public.debug_okami_demand(date) to authenticated;

notify pgrst, 'reload schema';
