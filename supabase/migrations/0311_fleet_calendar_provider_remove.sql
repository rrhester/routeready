-- Migration 0311 · Fleet calendar — remove a service provider
--
-- Lets the operator take a provider out of the calendar's provider
-- rail. This is a soft delete (paused = true): the vendor leaves the
-- rail (and any vendor picker) but its id is preserved, so repair
-- orders / calendar events that reference it keep their history.

create or replace function public.fleet_calendar_provider_remove(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.vendors
     set paused     = true,
         updated_at = now()
   where id = p_id and dsp_id = v_dsp;
  return jsonb_build_object('removed', true);
end;
$$;
grant execute on function public.fleet_calendar_provider_remove(uuid) to authenticated;


notify pgrst, 'reload schema';
