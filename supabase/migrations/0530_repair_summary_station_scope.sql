-- Migration 0530 · repair_center_summary · optional per-station scope
--
-- Multi-station lens: the Repair Center KPI strip is built from
-- repair_center_summary(), which aggregated every open case DSP-wide, so the
-- pills never changed when the operator toggled to a single station. This
-- re-issues it (0486) verbatim plus an optional p_station_id — when supplied,
-- every count/total is scoped to that station's cases (repair_cases.station_id).
-- NULL (the default, i.e. "All stations") = byte-identical to before.
--
-- The queue (repair_cases_list) already took p_station_id since 0486, so this
-- makes the summary strip agree with it. Adding the parameter creates a new
-- overload; drop the old no-arg function first so there's no ambiguity.
-- Safe: repair_center_summary is only ever called as a PostgREST RPC.

drop function if exists public.repair_center_summary();

create or replace function public.repair_center_summary(p_station_id uuid default null)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  with open_cases as (
    select rc.*,
           sv.promised_completion_at as v_promised,
           sv.revised_completion_at  as v_revised,
           sv.shop_status            as v_shop_status,
           sv.ready_for_pickup_at    as v_ready_at
    from public.repair_cases rc
    left join lateral (
      select * from public.repair_shop_visits
      where repair_case_id = rc.id and picked_up_at is null
      order by created_at desc limit 1
    ) sv on true
    where rc.dsp_id = private.current_dsp_id()
      and private.is_staff(rc.dsp_id, 'dispatcher')
      and rc.archived_at is null
      and rc.stage not in ('closed','cancelled')
      and (p_station_id is null or rc.station_id = p_station_id)
  )
  select jsonb_build_object(
    'open_cases',        (select count(*) from open_cases),
    'grounded',          (select count(*) from open_cases where availability = 'grounded'),
    'needs_review',      (select count(*) from open_cases where stage in ('reported','review')),
    'quoting',           (select count(*) from open_cases where stage in ('quoting','quotes_in')),
    'awaiting_approval', (select count(*) from open_cases where stage = 'awaiting_approval'),
    'scheduled',         (select count(*) from open_cases where stage in ('approved','scheduled')),
    'at_shop',           (select count(*) from open_cases where stage = 'at_shop'),
    'waiting_on_parts',  (select count(*) from open_cases where v_shop_status = 'parts_hold'),
    'past_promise',      (select count(*) from open_cases
                          where stage = 'at_shop'
                            and coalesce(v_revised, v_promised) is not null
                            and coalesce(v_revised, v_promised) < now()
                            and v_ready_at is null),
    'ready_for_pickup',  (select count(*) from open_cases
                          where stage in ('ready_for_pickup','quality_check')),
    'returned_this_week',(select count(*) from public.repair_cases
                          where dsp_id = private.current_dsp_id()
                            and (p_station_id is null or station_id = p_station_id)
                            and actual_return_to_service_at >= date_trunc('week', now())),
    'approved_total_cents', (select coalesce(sum(approved_total_cents), 0) from open_cases),
    'estimate_total_cents', (select coalesce(sum(estimate_total_cents), 0)
                             from open_cases where approved_total_cents is null),
    'grounded_oldest_at', (select min(ge.grounded_at)
                           from open_cases oc
                           join public.vehicle_grounding_events ge
                             on ge.vehicle_id = oc.vehicle_id and ge.ungrounded_at is null)
  );
$$;
grant execute on function public.repair_center_summary(uuid) to authenticated;

notify pgrst, 'reload schema';
