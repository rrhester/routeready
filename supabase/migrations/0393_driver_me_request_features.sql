-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0393 · driver_me returns request_features
--
-- The dispatcher Settings dropdown (Requests tab) lets a DSP turn driver-app
-- request features on/off — time off requests, availability requests, and the
-- availability questions (preferred days, start time, 5th day). Those flags
-- live in dsps.metadata.request_features. The driver PWA needs them in the
-- same session bootstrap it already uses for dsp_name / dsp_phone so it can
-- add/remove the matching sections. We extend driver_me's jsonb to include
-- request_features (defaulting to an empty object ⇒ every feature ON);
-- everything else returned by 0249 is preserved so existing callers stay
-- compatible.
-- ─────────────────────────────────────────────────────────────────────────

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
    'id',               v_drv.id,
    'name',             coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
    'full_name',        v_drv.full_name,
    'photo_path',       v_drv.photo_path,
    'dsp_id',           v_drv.dsp_id,
    'dsp_name',         coalesce(v_dsp.name, ''),
    'dsp_phone',        nullif(trim(coalesce(v_dsp.phone, '')), ''),
    'request_features', coalesce(v_dsp.metadata -> 'request_features', '{}'::jsonb)
  );
end;
$$;
grant execute on function public.driver_me(text) to anon, authenticated;
