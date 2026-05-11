-- Migration 0172 · Form I-9 — slice 3 helper: i9_get (read RPC for the dashboard)
--
-- Dispatchers can already SELECT i9_records / i9_events via the RLS
-- policies from 0170, but the driver-record drawer wants the record +
-- its audit trail in one round trip. This bundles them and runs the
-- staff check so the call fails loudly (rather than returning [] from a
-- silently filtered query) if someone without dispatcher rights asks.

create or replace function public.i9_get(p_driver_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.i9_records;
  v_events jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id and dsp_id = v_dsp;
  if v_row.id is null then
    return jsonb_build_object('record', null, 'events', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',         e.id,
    'kind',       e.kind,
    'actor_kind', e.actor_kind,
    'actor_name', e.actor_name,
    'event_data', e.event_data,
    'created_at', e.created_at
  ) order by e.id), '[]'::jsonb)
  into v_events
  from public.i9_events e where e.i9_record_id = v_row.id;
  return jsonb_build_object('record', to_jsonb(v_row), 'events', v_events);
end;
$$;
grant execute on function public.i9_get(uuid) to authenticated;

notify pgrst, 'reload schema';
