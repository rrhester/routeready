-- Migration 0446 · Schedule concurrency: realtime shifts + optimistic
-- assign_shift.
--
-- Two managers editing the schedule at once was silent last-write-wins:
--
--   1. The dashboard has had a debounced, echo-suppressed realtime
--      subscription on shifts + shift_offers (_schedRealtimeStart) and on
--      driver_checkins + shifts for Today's Plan (_tpSubscribeRealtime)
--      for a long time — but none of those tables were ever added to the
--      supabase_realtime publication, so the subscriptions never fired
--      and freshness rode on 30-second polls. Adding the tables lights
--      the existing client machinery up with no client changes.
--      (Realtime respects RLS: subscribers only receive rows their
--      tenant-scoped SELECT policies allow.)
--
--   2. assign_shift() was an unconditional UPDATE — dispatcher A could
--      overwrite dispatcher B's just-made assignment without either
--      noticing. It now takes an optional optimistic expectation: when
--      p_check_expected is true the update only applies if the shift's
--      current driver matches p_expected_driver_id; otherwise it raises
--      'shift_conflict' (with the current assignment in DETAIL) and the
--      dashboard tells the operator and refreshes instead of clobbering.
--      Callers that don't pass the new args keep the old behavior, so
--      cached/older clients are unaffected.
--
-- Idempotent: publication adds swallow duplicate_object; the function is
-- dropped by exact old signature then recreated (drop needed — adding
-- defaulted parameters via create-or-replace would leave an ambiguous
-- overload that breaks PostgREST dispatch).

-- ─── 1. Realtime publication ────────────────────────────────────────────

do $$
declare
  t text;
  tables text[] := array['shifts', 'shift_offers', 'driver_checkins'];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then
      null; -- already a member
    end;
  end loop;
end $$;

-- ─── 2. assign_shift · optimistic concurrency ───────────────────────────

drop function if exists public.assign_shift(uuid, uuid);

create or replace function public.assign_shift(
  p_id                 uuid,
  p_driver_id          uuid,
  p_expected_driver_id uuid    default null,
  p_check_expected     boolean default false
)
returns public.shifts
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.shifts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_check_expected then
    update public.shifts
       set driver_id = p_driver_id, status = 'scheduled'
     where id = p_id and dsp_id = v_dsp
       and driver_id is not distinct from p_expected_driver_id
     returning * into v_row;
    if v_row.id is null then
      select * into v_row from public.shifts where id = p_id and dsp_id = v_dsp;
      if v_row.id is null then
        raise exception 'shift_not_found';
      end if;
      -- The shift exists but its assignment changed since the caller
      -- last looked. Surface who holds it now so the UI can explain.
      raise exception 'shift_conflict'
        using errcode = 'P0001',
              detail  = coalesce(v_row.driver_id::text, 'unassigned');
    end if;
  else
    update public.shifts
       set driver_id = p_driver_id, status = 'scheduled'
     where id = p_id and dsp_id = v_dsp
     returning * into v_row;
    if v_row.id is null then raise exception 'shift_not_found'; end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.assign_shift(uuid, uuid, uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
