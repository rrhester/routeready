-- ── Dispatcher-set driver app PIN ────────────────────────────────────
--
-- The driver's 4–6 digit app code is stored as a bcrypt hash (one-way),
-- so it can never be displayed back. This RPC lets a dispatcher SET/RESET
-- it from the driver record (e.g. the driver forgot it), then share the
-- new code with the driver. DSP-scoped: only dispatcher staff of the
-- driver's own DSP may set it. Mirrors the bcrypt treatment used by
-- driver_activate / driver_set_pin.
--
-- Idempotent: create or replace; safe to re-run.

create or replace function public.admin_set_driver_pin(p_driver_id uuid, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_clean text;
  v_row   public.drivers;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_clean := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  if length(v_clean) < 4 or length(v_clean) > 6 then
    raise exception 'pin_must_be_4_to_6_digits' using errcode = '22023';
  end if;

  update public.drivers
     set pin_hash   = extensions.crypt(v_clean, extensions.gen_salt('bf', 10)),
         pin_set_at = now(),
         updated_at = now()
   where id = p_driver_id
     and dsp_id = v_dsp
   returning * into v_row;

  if v_row.id is null then
    raise exception 'driver_not_found' using errcode = 'P0001';
  end if;

  return jsonb_build_object('ok', true, 'pin_set_at', v_row.pin_set_at);
end;
$$;

grant execute on function public.admin_set_driver_pin(uuid, text) to authenticated;
