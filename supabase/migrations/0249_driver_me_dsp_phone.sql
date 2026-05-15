-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0249 · driver_me returns dsp_phone for tap-to-call dispatch
--
-- The driver PWA now exposes a "Call dispatch" button on the chat header.
-- It dials the DSP's office number via a tel: link, which means the PWA
-- needs that number in the same session bootstrap it already uses for
-- dsp_name (see 0069). We extend driver_me's jsonb to include dsp_phone;
-- everything else returned by 0069 is preserved so existing callers stay
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
    'id',         v_drv.id,
    'name',       coalesce(nullif(trim(v_drv.preferred_name), ''), v_drv.full_name),
    'full_name',  v_drv.full_name,
    'photo_path', v_drv.photo_path,
    'dsp_id',     v_drv.dsp_id,
    'dsp_name',   coalesce(v_dsp.name, ''),
    'dsp_phone',  nullif(trim(coalesce(v_dsp.phone, '')), '')
  );
end;
$$;
grant execute on function public.driver_me(text) to anon, authenticated;
