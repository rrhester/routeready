-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0481 · Per-operator channel preferences (mute)
--
-- Drivers can already mute a channel (driver_channel_members.muted, 0073) and
-- the push fan-out honors it — but the DASHBOARD operator had no equivalent:
-- a busy Room notified every dispatcher on every post.  This adds a per-
-- (operator, channel) preference row so a dispatcher can mute a channel for
-- themselves.  A muted channel is suppressed from the operator's unread
-- badge / notification treatment in the dashboard; other operators are
-- unaffected.
--
-- Kept OUT of dispatch_channels_list (0073/0388) so that auth-critical list
-- RPC is untouched — the dashboard reads prefs from a small dedicated RPC and
-- merges client-side.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Table ──
create table if not exists public.channel_operator_prefs (
  channel_id   uuid not null references public.driver_channels(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  muted        boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create index if not exists channel_operator_prefs_user_idx
  on public.channel_operator_prefs (user_id, dsp_id);


-- ── 2. RLS ──  An operator sees only their own prefs, within their DSP.
alter table public.channel_operator_prefs enable row level security;
drop policy if exists "channel_operator_prefs_own_r" on public.channel_operator_prefs;
create policy "channel_operator_prefs_own_r"
  on public.channel_operator_prefs for select
  using (user_id = auth.uid() and dsp_id = private.current_dsp_id());
grant select on public.channel_operator_prefs to authenticated;


-- ── 3. RPCs ──

-- 3a. Mute / unmute a channel for the calling operator.
create or replace function public.dispatch_channel_set_mute(
  p_channel_id uuid,
  p_muted      boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.driver_channels where id = p_channel_id and dsp_id = v_dsp) then
    raise exception 'not_found' using errcode = '42501';
  end if;

  insert into public.channel_operator_prefs (channel_id, user_id, dsp_id, muted, updated_at)
  values (p_channel_id, v_uid, v_dsp, coalesce(p_muted, false), now())
  on conflict (channel_id, user_id)
  do update set muted = excluded.muted, updated_at = now();

  return jsonb_build_object('channel_id', p_channel_id, 'muted', coalesce(p_muted, false));
end;
$$;
grant execute on function public.dispatch_channel_set_mute(uuid, boolean) to authenticated;

-- 3b. The calling operator's channel prefs (muted channels), for the DSP.
create or replace function public.dispatch_channel_prefs()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_uid  uuid := auth.uid();
  v_rows jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'channel_id', p.channel_id,
    'muted',      p.muted
  )), '[]'::jsonb) into v_rows
    from public.channel_operator_prefs p
   where p.user_id = v_uid and p.dsp_id = v_dsp and p.muted;

  return jsonb_build_object('prefs', v_rows);
end;
$$;
grant execute on function public.dispatch_channel_prefs() to authenticated;

notify pgrst, 'reload schema';
