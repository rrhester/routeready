-- Migration 0310 · Fleet calendar — reliable service-provider list
--
-- The Service Providers rail read vendors_for_dsp() (invoker-rights,
-- RLS-bound), which could come back empty even when vendors exist —
-- the rail showed "No service providers yet" while calendar events
-- still resolved their provider names.
--
-- This adds a security-definer reader shaped exactly like
-- fleet_calendar_events_list (which works), so the rail and the
-- calendar always agree.

create or replace function public.fleet_calendar_providers()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',   v.id,
           'name', v.name,
           'kind', v.kind
         ) order by v.name), '[]'::jsonb)
  from public.vendors v
  where v.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
    and coalesce(v.paused, false) = false;
$$;
grant execute on function public.fleet_calendar_providers() to authenticated;


notify pgrst, 'reload schema';
