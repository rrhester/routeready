-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0458 · RouteReady Meet — configurable ICE servers (TURN-ready)
--
-- Zoom-quality reliability pass. v1 (0457) shipped STUN-only, which fails
-- for symmetric-NAT↔symmetric-NAT pairs (strict corporate VPNs). This adds
-- meet_ice_servers(p_code): clients fetch their RTCPeerConnection server
-- list from the DB instead of hardcoding it, so adding a TURN relay later
-- is ONE insert — no deploy, no code change:
--
--   insert into private.app_settings (key, value) values (
--     'meet_turn_servers',
--     '[{"urls":["turn:turn.example.com:443?transport=tcp"],
--        "username":"user","credential":"secret"}]'
--   ) on conflict (key) do update set value = excluded.value;
--
-- The RPC is anon-callable (guests need it too) but only answers for a
-- VALID, un-ended meeting code — TURN credentials are never handed to
-- callers who don't already hold a live invite.
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
    -- Missing key or malformed JSON — fall back to STUN-only rather
    -- than failing the join.
    v_turn := null;
  end;

  if v_turn is null or jsonb_typeof(v_turn) <> 'array' then
    v_turn := '[]'::jsonb;
  end if;

  return jsonb_build_object('ok', true, 'ice_servers', v_stun || v_turn);
end; $$;

grant execute on function public.meet_ice_servers(text) to anon, authenticated;

-- PostgREST: pick up the new function without a restart.
notify pgrst, 'reload schema';
