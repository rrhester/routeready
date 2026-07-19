-- Migration 0529 · vehicles_list · surface the vehicle's station
--
-- Multi-station lens: the Van-assignments board (Fleet → Assignments, and the
-- Schedule van-assignments view) is built from vehicles_list(), which didn't
-- carry each van's station, so the board couldn't scope. This re-issues
-- vehicles_list (0232) verbatim plus two keys — station_id + station_code —
-- on each vehicle object. Return type stays jsonb, so no drop is needed.
-- The client filters the board to the selected station; "All" shows every van.

create or replace function public.vehicles_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'kind',               vh.kind,
      'status',             vh.status,
      'operational_status', vh.operational_status,
      'grounded_since',     ge.grounded_at,
      'grounded_reason',    ge.reason,
      'notes',              vh.notes,
      'archived_at',        vh.archived_at,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'drivers', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'driver_id', a.driver_id, 'rank', a.rank,
                 'name', coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver')
               ) order by a.rank)
        from public.vehicle_driver_assignments a
        join public.drivers d on d.id = a.driver_id
        where a.vehicle_id = vh.id
      ), '[]'::jsonb)
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join lateral (
      select grounded_at, reason
      from public.vehicle_grounding_events
      where vehicle_id = vh.id and ungrounded_at is null
      order by grounded_at desc
      limit 1
    ) ge on true
    where vh.dsp_id = private.current_dsp_id()
      and private.is_staff(private.current_dsp_id(), 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_list() to authenticated;

notify pgrst, 'reload schema';
