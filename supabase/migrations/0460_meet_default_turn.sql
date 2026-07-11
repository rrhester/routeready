-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0460 · RouteReady Meet — default TURN relay (hostile networks)
--
-- Reliability: STUN-only connects fine on typical networks but fails when
-- BOTH peers sit behind strict NATs (corporate VPNs, some hotel wifi) —
-- the "connecting…" tile that never resolves. A TURN relay fixes that by
-- carrying media when no direct path exists.
--
-- This adds the Open Relay Project (openrelay.metered.ca — Metered's free
-- public TURN service with published static credentials) as the DEFAULT
-- relay whenever no operator-owned relay is configured. Properties that
-- make this safe as a default:
--   · strictly additive: WebRTC ignores an unreachable TURN server, so
--     the worst case is exactly today's STUN-only behavior;
--   · relay is used ONLY when a direct path can't be punched — normal
--     calls stay peer-to-peer;
--   · media through a TURN relay stays SRTP-encrypted end-to-end; the
--     relay forwards packets it cannot decrypt.
--
-- An operator-owned relay (Cloudflare/Metered/coturn — see docs/MEET.md)
-- still wins the moment 'meet_turn_servers' is set in app_settings; this
-- default only fills the gap until then.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.meet_ice_servers(p_code text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_norm text := regexp_replace(lower(coalesce(p_code, '')), '[^a-z0-9]', '', 'g');
  v_turn jsonb;
  v_stun jsonb := jsonb_build_array(
    jsonb_build_object('urls', jsonb_build_array(
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302')));
  v_default_turn jsonb := jsonb_build_array(
    jsonb_build_object(
      'urls', jsonb_build_array(
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turns:openrelay.metered.ca:443?transport=tcp'),
      'username', 'openrelayproject',
      'credential', 'openrelayproject'));
begin
  if not exists (
    select 1 from public.meetings m
     where replace(m.code, '-', '') = v_norm and m.ended_at is null
  ) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  begin
    v_turn := private.app_setting('meet_turn_servers')::jsonb;
  exception when others then
    v_turn := null;
  end;

  -- Operator-configured relay wins; otherwise fall back to the free
  -- public relay rather than shipping no relay at all.
  if v_turn is null or jsonb_typeof(v_turn) <> 'array' or v_turn = '[]'::jsonb then
    v_turn := v_default_turn;
  end if;

  return jsonb_build_object('ok', true, 'ice_servers', v_stun || v_turn);
end; $$;

grant execute on function public.meet_ice_servers(text) to anon, authenticated;

-- PostgREST: pick up the changed function without a restart.
notify pgrst, 'reload schema';
