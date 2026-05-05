-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0069 · Driver app polish: DSP brand · undo checkout · volatility
--
-- 1. driver_attendance_settings was marked STABLE but calls
--    private.driver_validate_token, which does an UPDATE on
--    driver_sessions.last_seen_at. PostgREST runs STABLE functions in
--    a read-only transaction, so the UPDATE fails with
--    "cannot execute UPDATE in a read-only transaction" — surfaces in
--    the PWA's Tasks → Attendance screen as "Couldn't load
--    attendance." Same fix 0055/0058 applied for chat / schedule:
--    drop STABLE.
--
-- 2. driver_me now returns the dsp's display name so the PWA can show
--    each operator's brand instead of the generic "RouteReady".
--
-- 3. New driver_undo_checkout RPC lets a driver undo a mistaken
--    check-out (clears checked_out_at, leaves the check-in intact).
--    The shift-complete card was a dead end before this.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Drop STABLE from driver_attendance_settings ──
create or replace function public.driver_attendance_settings(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_set public.scheduling_settings;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_set from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  return jsonb_build_object(
    'checkin_lead_minutes', coalesce(v_set.checkin_lead_minutes, 15),
    'tardy_grace_minutes',  coalesce(v_set.tardy_grace_minutes,  10),
    'ncns_after_minutes',   coalesce(v_set.ncns_after_minutes,   60)
  );
end;
$$;
grant execute on function public.driver_attendance_settings(text) to anon, authenticated;


-- ── 2. driver_me also returns dsp_name for the brand chip ──
create or replace function public.driver_me(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_dsp public.dsps;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_dsp from public.dsps where id = v_drv.dsp_id;
  return jsonb_build_object(
    'id',         v_drv.id,
    'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
    'full_name',  v_drv.full_name,
    'photo_path', v_drv.photo_path,
    'dsp_id',     v_drv.dsp_id,
    'dsp_name',   coalesce(v_dsp.name, '')
  );
end;
$$;
grant execute on function public.driver_me(text) to anon, authenticated;


-- ── 3. driver_undo_checkout · clears today's checked_out_at ──
-- Lets a driver fix an accidental tap on Check Out without dispatch
-- intervention. Resets only the "you're done for the day" half of the
-- record; the original check-in time stays.
create or replace function public.driver_undo_checkout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_chk public.driver_checkins;
begin
  v_drv := private.driver_validate_token(p_token);
  select c.* into v_chk from public.driver_checkins c
    join public.shifts s on s.id = c.shift_id
   where c.driver_id = v_drv.id
     and s.date = current_date
     and c.checked_out_at is not null
   order by c.checked_in_at desc nulls last
   limit 1;
  if v_chk.id is null then
    raise exception 'no_checkout_to_undo' using errcode = 'P0001';
  end if;
  if v_chk.finalized then
    -- Once the day is finalized by a leader, the driver can't unwind.
    raise exception 'day_finalized' using errcode = 'P0001';
  end if;
  update public.driver_checkins
     set checked_out_at = null,
         checkout_lat   = null,
         checkout_lng   = null
   where id = v_chk.id
   returning * into v_chk;
  return jsonb_build_object(
    'id',            v_chk.id,
    'checked_in_at', to_jsonb(v_chk.checked_in_at)
  );
end;
$$;
grant execute on function public.driver_undo_checkout(text) to anon, authenticated;


notify pgrst, 'reload schema';
