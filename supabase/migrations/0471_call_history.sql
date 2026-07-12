-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0471 · Call history (direct calling)
--
-- Records every direct call a dispatcher is party to — placed or received —
-- so Messages can show recent + missed calls with click-to-call-back. Purely
-- additive: the live realtime call flow is unchanged; the dashboard just logs
-- events best-effort. One row per (staff user, call), so each dispatcher sees
-- their own history. Keyed to app_users via auth.uid().
--
-- Surface:
--   call_log_event(call_id, direction, peer_kind, peer_id, peer_name, media, status)
--   call_history(limit)  → the caller's recent calls, newest first
--
-- Idempotent — safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.app_users(id) on delete cascade,
  dsp_id      uuid not null references public.dsps(id)      on delete cascade,
  call_id     text not null,                 -- client correlation id
  direction   text not null,                 -- 'outgoing' | 'incoming'
  peer_kind   text,                          -- 'driver' | 'dispatch'
  peer_id     text,
  peer_name   text,
  media       text,                          -- 'video' | 'audio'
  status      text not null default 'ringing', -- ringing|answered|declined|missed|cancelled
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  unique (user_id, call_id)
);
create index if not exists calls_user_started_idx on public.calls(user_id, started_at desc);

alter table public.calls enable row level security;

drop policy if exists "calls_own_r" on public.calls;
create policy "calls_own_r"
  on public.calls for select
  using (user_id = auth.uid());

grant select on public.calls to authenticated;

-- Upsert a call event. Status only advances toward a terminal state, so an
-- out-of-order 'ringing' can't clobber a recorded 'answered'/'missed'.
create or replace function public.call_log_event(
  p_call_id   text,
  p_direction text,
  p_peer_kind text,
  p_peer_id   text,
  p_peer_name text,
  p_media     text,
  p_status    text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
  v_dsp uuid;
  v_terminal boolean;
begin
  v_uid := auth.uid();
  if v_uid is null then return; end if;
  v_dsp := private.current_dsp_id();
  if v_dsp is null then return; end if;
  if p_call_id is null or p_call_id = '' then return; end if;

  v_terminal := p_status in ('answered', 'declined', 'missed', 'cancelled');

  insert into public.calls
    (user_id, dsp_id, call_id, direction, peer_kind, peer_id, peer_name, media, status,
     ended_at)
  values
    (v_uid, v_dsp, p_call_id, p_direction, p_peer_kind, p_peer_id, p_peer_name, p_media,
     coalesce(nullif(p_status, ''), 'ringing'),
     case when v_terminal and p_status <> 'answered' then now() else null end)
  on conflict (user_id, call_id) do update set
    -- ringing never overwrites a terminal status already recorded
    status    = case when public.calls.status in ('answered','declined','missed','cancelled')
                       and excluded.status = 'ringing'
                     then public.calls.status else excluded.status end,
    peer_name = coalesce(nullif(excluded.peer_name, ''), public.calls.peer_name),
    ended_at  = case when excluded.status in ('declined','missed','cancelled')
                     then now() else public.calls.ended_at end;
end;
$$;
grant execute on function public.call_log_event(text, text, text, text, text, text, text) to authenticated;

create or replace function public.call_history(p_limit int default 30)
returns setof public.calls
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.calls
  where user_id = auth.uid()
  order by started_at desc
  limit greatest(1, least(coalesce(p_limit, 30), 100));
$$;
grant execute on function public.call_history(int) to authenticated;
