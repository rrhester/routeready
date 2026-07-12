-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0473 · Communications system — Phase 0 foundations
--
-- Additive schema for the RouteReady comms buildout (see
-- docs/COMMUNICATIONS-SYSTEM-ARCHITECTURE.md). Phase 0 lays the tables the
-- later phases fill in, without touching any existing flow:
--
--   device_push_tokens  · native APNs / PushKit(VoIP) / FCM tokens, beyond the
--                          existing Web Push subscriptions (0056/0074/0470).
--   call_sessions       · one row per live audio session (direct | group | ptt);
--                          livekit_room is the join identity for the SFU.
--   call_participants    · who is in a session (join/leave), for presence + audit.
--   ptt_floor           · optional half-duplex floor lock for push-to-talk.
--   voice_notes         · async audio messages (Storage-backed), direct or channel.
--   message_receipts    · per-recipient delivery / read receipts.
--
-- Plus the two device-token registration RPCs, mirroring the dual-identity
-- model already in the codebase:
--   device_push_register(...)          → staff, keyed to auth.uid()  (cf. 0470)
--   driver_device_push_register(...)   → drivers, keyed to an opaque session
--                                        token via private.driver_validate_token
--
-- Everything is dsp_id-scoped with RLS; driver-facing reads/writes go through
-- security-definer RPCs because drivers have no auth.uid() (cf. 0467).
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. device_push_tokens ────────────────────────────────────────────────
-- One row per (kind, token). Either user_id (staff) OR driver_id (driver) is
-- set, never both. Dead tokens are pruned by the sender via failure_count,
-- exactly like the Web Push subscription tables.
create table if not exists public.device_push_tokens (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id)     on delete cascade,
  user_id       uuid references public.app_users(id)         on delete cascade,
  driver_id     uuid references public.drivers(id)           on delete cascade,
  platform      text not null check (platform in ('ios','android')),
  kind          text not null check (kind in ('apns','voip','fcm')),
  token         text not null,
  app_version   text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz not null default now(),
  last_failed_at timestamptz,
  failure_count int  not null default 0,
  unique (kind, token),
  -- exactly one owner
  check ( (user_id is not null)::int + (driver_id is not null)::int = 1 )
);
create index if not exists device_push_tokens_dsp_idx    on public.device_push_tokens(dsp_id);
create index if not exists device_push_tokens_user_idx   on public.device_push_tokens(user_id);
create index if not exists device_push_tokens_driver_idx on public.device_push_tokens(driver_id);

alter table public.device_push_tokens enable row level security;

drop policy if exists device_push_tokens_tenant_r on public.device_push_tokens;
create policy device_push_tokens_tenant_r
  on public.device_push_tokens for select
  using (dsp_id = private.current_dsp_id());

grant select on public.device_push_tokens to authenticated;


-- ── 2. call_sessions ─────────────────────────────────────────────────────
-- The unit of live audio. livekit_room is globally unique and namespaced by
-- dsp so a token minted for one DSP can never join another's room.
create table if not exists public.call_sessions (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  kind         text not null check (kind in ('direct','group','ptt')),
  livekit_room text not null unique,
  channel_id   uuid references public.driver_channels(id) on delete cascade,
  initiator    text,                     -- user_id or driver_id, as text
  status       text not null default 'active' check (status in ('active','ended')),
  created_at   timestamptz not null default now(),
  ended_at     timestamptz
);
create index if not exists call_sessions_dsp_idx     on public.call_sessions(dsp_id, created_at desc);
create index if not exists call_sessions_channel_idx on public.call_sessions(channel_id) where channel_id is not null;

alter table public.call_sessions enable row level security;

drop policy if exists call_sessions_tenant_r on public.call_sessions;
create policy call_sessions_tenant_r
  on public.call_sessions for select
  using (dsp_id = private.current_dsp_id());

grant select on public.call_sessions to authenticated;


-- ── 3. call_participants ─────────────────────────────────────────────────
create table if not exists public.call_participants (
  session_id uuid not null references public.call_sessions(id) on delete cascade,
  party_kind text not null check (party_kind in ('driver','dispatch')),
  party_id   text not null,
  joined_at  timestamptz not null default now(),
  left_at    timestamptz,
  primary key (session_id, party_kind, party_id)
);
create index if not exists call_participants_session_idx on public.call_participants(session_id);

alter table public.call_participants enable row level security;

drop policy if exists call_participants_tenant_r on public.call_participants;
create policy call_participants_tenant_r
  on public.call_participants for select
  using (exists (
    select 1 from public.call_sessions s
     where s.id = call_participants.session_id
       and s.dsp_id = private.current_dsp_id()));

grant select on public.call_participants to authenticated;


-- ── 4. ptt_floor ─────────────────────────────────────────────────────────
-- One holder at a time per session. expires_at lets a dropped key free the
-- floor automatically (last-key-wins / dispatch-priority enforced in RPC later).
create table if not exists public.ptt_floor (
  session_id  uuid primary key references public.call_sessions(id) on delete cascade,
  holder_kind text check (holder_kind in ('driver','dispatch')),
  holder_id   text,
  acquired_at timestamptz,
  expires_at  timestamptz
);

alter table public.ptt_floor enable row level security;

drop policy if exists ptt_floor_tenant_r on public.ptt_floor;
create policy ptt_floor_tenant_r
  on public.ptt_floor for select
  using (exists (
    select 1 from public.call_sessions s
     where s.id = ptt_floor.session_id
       and s.dsp_id = private.current_dsp_id()));

grant select on public.ptt_floor to authenticated;


-- ── 5. voice_notes ───────────────────────────────────────────────────────
-- Polymorphic by scope: `conversation` points at driver_conversations.id
-- (direct) or driver_channels.id (channel). No FK because it's polymorphic;
-- integrity is enforced by the write RPCs in a later phase.
create table if not exists public.voice_notes (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  conversation uuid,
  scope        text not null check (scope in ('direct','channel')),
  sender_kind  text not null check (sender_kind in ('dispatch','driver')),
  sender_id    text not null,
  storage_path text not null,
  duration_ms  int,
  waveform     jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists voice_notes_dsp_idx  on public.voice_notes(dsp_id, created_at desc);
create index if not exists voice_notes_conv_idx on public.voice_notes(conversation, created_at desc);

alter table public.voice_notes enable row level security;

drop policy if exists voice_notes_tenant_r on public.voice_notes;
create policy voice_notes_tenant_r
  on public.voice_notes for select
  using (dsp_id = private.current_dsp_id());

grant select on public.voice_notes to authenticated;


-- ── 6. message_receipts ──────────────────────────────────────────────────
-- Per-recipient delivery/read state for text messages and voice notes.
-- Kept deliberately narrow; the highest-write table in the comms system.
create table if not exists public.message_receipts (
  message_id     uuid not null,
  message_kind   text not null check (message_kind in ('text','voice_note')),
  recipient_kind text not null check (recipient_kind in ('driver','dispatch')),
  recipient_id   text not null,
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  delivered_at   timestamptz,
  read_at        timestamptz,
  primary key (message_id, message_kind, recipient_kind, recipient_id)
);
create index if not exists message_receipts_recipient_idx
  on public.message_receipts(recipient_kind, recipient_id);

alter table public.message_receipts enable row level security;

drop policy if exists message_receipts_tenant_r on public.message_receipts;
create policy message_receipts_tenant_r
  on public.message_receipts for select
  using (dsp_id = private.current_dsp_id());

grant select on public.message_receipts to authenticated;


-- ─────────────────────────────────────────────────────────────────────────
-- 7. Device-token registration RPCs
-- ─────────────────────────────────────────────────────────────────────────

-- Staff register their native token from the authenticated session. DSP is
-- derived from the caller — identity is never taken from the client. Upsert on
-- (kind, token) so a re-registered token just re-homes to the current user.
create or replace function public.device_push_register(
  p_platform    text,
  p_kind        text,
  p_token       text,
  p_app_version text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_dsp uuid;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = 'P0001';
  end if;
  v_dsp := private.current_dsp_id();
  if v_dsp is null then
    raise exception 'no_dsp' using errcode = 'P0001';
  end if;
  if p_token is null or p_token = '' then
    raise exception 'token_required' using errcode = 'P0001';
  end if;
  if p_kind not in ('apns','voip','fcm') then
    raise exception 'bad_kind' using errcode = 'P0001';
  end if;
  if p_platform not in ('ios','android') then
    raise exception 'bad_platform' using errcode = 'P0001';
  end if;

  insert into public.device_push_tokens
    (dsp_id, user_id, driver_id, platform, kind, token, app_version)
  values
    (v_dsp, v_uid, null, p_platform, p_kind, p_token, p_app_version)
  on conflict (kind, token) do update
    set dsp_id       = excluded.dsp_id,
        user_id      = excluded.user_id,
        driver_id    = null,
        platform     = excluded.platform,
        app_version  = excluded.app_version,
        last_used_at = now(),
        failure_count = 0,
        last_failed_at = null;
end;
$$;

grant execute on function public.device_push_register(text, text, text, text) to authenticated;


-- Drivers have no auth.uid(); they authenticate with an opaque session token,
-- validated exactly like every other driver RPC. DSP comes from the driver row.
create or replace function public.driver_device_push_register(
  p_token        text,        -- driver session token
  p_platform     text,
  p_kind         text,
  p_device_token text,        -- the APNs/VoIP/FCM token
  p_app_version  text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);   -- raises if invalid/revoked

  if p_device_token is null or p_device_token = '' then
    raise exception 'token_required' using errcode = 'P0001';
  end if;
  if p_kind not in ('apns','voip','fcm') then
    raise exception 'bad_kind' using errcode = 'P0001';
  end if;
  if p_platform not in ('ios','android') then
    raise exception 'bad_platform' using errcode = 'P0001';
  end if;

  insert into public.device_push_tokens
    (dsp_id, user_id, driver_id, platform, kind, token, app_version)
  values
    (v_drv.dsp_id, null, v_drv.id, p_platform, p_kind, p_device_token, p_app_version)
  on conflict (kind, token) do update
    set dsp_id        = excluded.dsp_id,
        driver_id     = excluded.driver_id,
        user_id       = null,
        platform      = excluded.platform,
        app_version   = excluded.app_version,
        last_used_at  = now(),
        failure_count = 0,
        last_failed_at = null;
end;
$$;

grant execute on function public.driver_device_push_register(text, text, text, text, text) to anon, authenticated;


-- PostgREST: pick up the new tables + functions without a restart.
notify pgrst, 'reload schema';
