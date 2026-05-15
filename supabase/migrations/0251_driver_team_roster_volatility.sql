-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0251 · driver_team_roster · drop STABLE
--
-- 0250 shipped driver_team_roster as STABLE, but it calls
-- private.driver_validate_token, which does an UPDATE on
-- driver_sessions.last_seen_at. PostgREST runs STABLE functions in a
-- read-only transaction, so the call fails with:
--   "cannot execute UPDATE in a read-only transaction"
-- and the new Team tab in the PWA renders the error state.
--
-- Same root cause and fix as 0069 for driver_attendance_settings, and
-- 0055 for the chat function. The roster does not need STABLE volatility
-- to be correct — drop it.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_team_roster(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',           d.id,
      'name',         coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
      'full_name',    d.full_name,
      'phone',        nullif(trim(coalesce(d.phone, '')), ''),
      'photo_path',   d.photo_path,
      'status',       d.status,
      'station_code', s.code
    )
    order by coalesce(nullif(trim(d.preferred_name), ''), d.full_name)
  ), '[]'::jsonb)
  into v_rows
  from public.drivers d
  left join public.stations s on s.id = d.station_id
  where d.dsp_id = v_drv.dsp_id
    and d.id    <> v_drv.id
    and d.status in ('active', 'onboarding');

  return v_rows;
end;
$$;

grant execute on function public.driver_team_roster(text) to anon, authenticated;
