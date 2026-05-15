-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0250 · driver_team_roster · driver-facing team directory
--
-- The PWA gets a new "Team" tab modeled on WhatsApp's contacts list: every
-- driver at the same DSP, each row a tap-to-call. This RPC powers it.
--
-- Scope:
--   * Validated by driver token, so RLS is enforced via private.driver_validate_token
--     just like driver_me / driver_chat_list (see 0054, 0064, 0069).
--   * Returns everyone at the caller's DSP except the caller themselves and
--     status='terminated' rows. Onboarding drivers are included so new hires
--     see their crew before they're flipped to active.
--   * No phone on a row → row still appears (so drivers can see who's there
--     even if a number isn't on file); the PWA hides the call button on
--     phoneless rows.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.driver_team_roster(p_token text)
returns jsonb
language plpgsql
stable
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
