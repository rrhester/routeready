-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0046 · Force PostgREST to reload its schema cache so the
-- 4-arg public.okami_set_target signature added in 0044 becomes
-- callable from the dashboard.
--
-- Symptom on production right after 0044 / 0045 landed:
--   PGRST202 "Could not find the function
--   public.okami_set_target(p_date, p_station_id, p_target, p_wave_index)
--   in the schema cache."
--
-- Root cause: PostgREST caches function signatures and only refreshes
-- on schema-change notifications. If the previous migration completes
-- in a transaction whose NOTIFY was lost — or the cache was warmed
-- before the migration ran — calls with the new p_wave_index named
-- argument still fail until the next schema-cache reload.
--
-- This migration re-asserts the function shape (idempotent) and then
-- emits the standard "reload schema" notification PostgREST listens for.
-- ─────────────────────────────────────────────────────────────────────────

-- Re-assert the function in case 0044 didn't apply for any reason.
-- create-or-replace is a no-op when the signature already matches.
create or replace function public.okami_set_target(
  p_date date,
  p_station_id uuid,
  p_target int,
  p_wave_index int default 0
)
returns public.okami_demand
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.okami_demand;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.okami_demand
    (dsp_id, station_id, date, wave_index, target_routes, created_by)
  values
    (v_dsp, p_station_id, p_date, greatest(0, p_wave_index), greatest(0, p_target), auth.uid())
  on conflict (dsp_id, station_id, date, wave_index) do update
    set target_routes = excluded.target_routes,
        updated_at    = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.okami_set_target(date, uuid, int, int) to authenticated;

-- Tell PostgREST to refresh its schema cache. This is the official
-- channel PostgREST listens on (see PostgREST docs · "Schema reloading").
notify pgrst, 'reload schema';
