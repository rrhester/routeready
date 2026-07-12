-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0465 · RouteReady Meet — instant meetings skip the waiting room
--
-- The waiting room exists for INTERVIEWS: applicants knock, staff admit.
-- Those rooms are system-minted by the interview-room edge function with
-- host_id = null. Instant meetings, by contrast, are created by a person
-- (meet_create sets host_id = auth.uid()) and are meant to work like a
-- Google-Meet link — you share it and people join. Parking those guests
-- in a waiting room (where the host must notice + admit) was a trap:
-- if the host misses the knock, the guest is stuck with no way in.
--
-- Fix: expose whether a room has a personal host so the client can let
-- link-holders join instant meetings directly, while interview rooms
-- (host_id null) keep the knock/admit flow. The unguessable code stays
-- the security boundary — same as a Zoom link with an embedded passcode.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.meet_lookup(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_row  public.meetings;
begin
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'bad_code');
  end if;

  select * into v_row
    from public.meetings m
   where replace(m.code, '-', '') = v_norm
   limit 1;

  if v_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', v_row.code,
    'title', v_row.title,
    'host_name', v_row.host_name,
    'created_at', v_row.created_at,
    'ended', v_row.ended_at is not null,
    -- True for person-created instant meetings, false for system-minted
    -- interview rooms. The client lets guests of a personally-hosted room
    -- join directly (no waiting room).
    'personal_host', v_row.host_id is not null,
    -- Mirrors meet_end's authorization exactly: the personal host OR any
    -- staff of the owning DSP. Guests (anon) get false.
    'is_host', coalesce(v_row.host_id = auth.uid(), false)
               or private.is_staff(v_row.dsp_id, 'dispatcher'));
end; $$;

grant execute on function public.meet_lookup(text) to anon, authenticated;

-- PostgREST: pick up the changed function without a restart.
notify pgrst, 'reload schema';
