-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0476 · Push-to-talk "dispatch radio" room (built on Meet)
--
-- A small-crew (2–6) walkie-talkie that reuses RouteReady Meet's mesh WebRTC
-- (dashboard/meet.html?ptt=1). All it needs from the DB is a STABLE room code
-- per DSP so dispatch and drivers always land in the SAME room. The code is
-- deterministic from the dsp_id (no create-race, no "everyone in a different
-- room" bug), and a persistent meetings row backs it so meet_lookup /
-- meet_ice_servers validate it like any room.
--
-- Surface:
--   meet_radio_code()               → staff (dispatcher+) get their DSP's code
--   driver_meet_radio_code(p_token) → drivers get the same code via their token
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- Deterministic Meet-shaped code (xxx-xxxx-xxx) from a dsp_id: map bytes of
-- md5(dsp) into the 23-letter alphabet Meet uses (a–z minus i/l/o). Same DSP
-- always yields the same code, so there is no room-split race.
create or replace function private.dsp_radio_code(p_dsp uuid)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_alpha text := 'abcdefghjkmnpqrstuvwxyz'; -- 23 chars
  v_b     bytea := decode(md5(p_dsp::text), 'hex'); -- 16 bytes
  v_c     text := '';
  i       int;
begin
  for i in 0..9 loop
    v_c := v_c || substr(v_alpha, 1 + (get_byte(v_b, i) % 23), 1);
  end loop;
  return substr(v_c, 1, 3) || '-' || substr(v_c, 4, 4) || '-' || substr(v_c, 8, 3);
end;
$$;

-- Ensure the DSP's radio meeting exists and is live (ended_at null), and
-- return its code. Persistent — the radio room is never ended.
create or replace function private.ensure_radio(p_dsp uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := private.dsp_radio_code(p_dsp);
begin
  insert into public.meetings (dsp_id, code, title)
  values (p_dsp, v_code, 'RouteReady Radio')
  on conflict (code) do update set ended_at = null;
  return v_code;
end;
$$;

-- Staff entry point (dispatcher and up).
create or replace function public.meet_radio_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return private.ensure_radio(v_dsp);
end;
$$;

grant execute on function public.meet_radio_code() to authenticated;

-- Driver entry point (opaque session token → same DSP code).
create or replace function public.driver_meet_radio_code(p_token text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return private.ensure_radio(v_drv.dsp_id);
end;
$$;

grant execute on function public.driver_meet_radio_code(text) to anon, authenticated;

notify pgrst, 'reload schema';
