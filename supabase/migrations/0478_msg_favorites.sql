-- 0478_msg_favorites.sql
--
-- Persist Messages "favorites" (starred driver conversations) server-side,
-- per operator, so they survive a sign-out, a browser data wipe, a private
-- window, or moving to another device.
--
-- Until now favorites lived only in the browser's localStorage. A prior fix
-- (0-side) carried the localStorage key across the forced-relogin wipe, but
-- anything that clears site data — a second device, incognito, the browser's
-- "clear on exit", or the PWA vs. browser split — still dropped them. The
-- operator's complaint ("my favorites won't stay fixed, they get unfavorited")
-- is exactly this fragility. Moving the source of truth to the database fixes
-- it for good; the client keeps a localStorage copy purely as an instant-paint
-- cache that reconciles against these rows.
--
-- Surface:
--   dispatch_chat_threads()                        → now includes is_favorite
--   dispatch_chat_set_favorite(driver_id, on)      → star / unstar
--
-- Idempotent: create table if not exists, create or replace, drop policy
-- if exists before create.


-- ── 1. Table ──
-- One row per (operator, driver) star, scoped to the operator's DSP so RLS
-- can enforce tenant + owner isolation cheaply.
create table if not exists public.msg_favorites (
  user_id    uuid        not null references public.app_users(id) on delete cascade,
  driver_id  uuid        not null references public.drivers(id)   on delete cascade,
  dsp_id     uuid        not null references public.dsps(id)      on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, driver_id)
);
create index if not exists msg_favorites_user_idx on public.msg_favorites(user_id);

alter table public.msg_favorites enable row level security;

-- An operator sees and manages only their own stars, within their own DSP.
drop policy if exists "msg_favorites_own_r" on public.msg_favorites;
create policy "msg_favorites_own_r"
  on public.msg_favorites for select
  using (user_id = private.current_user_id() and dsp_id = private.current_dsp_id());

drop policy if exists "msg_favorites_own_w" on public.msg_favorites;
create policy "msg_favorites_own_w"
  on public.msg_favorites for all
  using (user_id = private.current_user_id() and dsp_id = private.current_dsp_id())
  with check (user_id = private.current_user_id() and dsp_id = private.current_dsp_id());

grant select, insert, delete on public.msg_favorites to authenticated;


-- ── 2. dispatch_chat_set_favorite ──
-- Star (p_on = true) or unstar (p_on = false) a driver for the calling
-- operator. Staff-gated and DSP-scoped; the driver must belong to the
-- caller's DSP. Idempotent on both sides (upsert / delete-if-present).
create or replace function public.dispatch_chat_set_favorite(p_driver_id uuid, p_on boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := private.current_user_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Guard against starring a driver outside the caller's tenant.
  if not exists (
    select 1 from public.drivers d where d.id = p_driver_id and d.dsp_id = v_dsp
  ) then
    raise exception 'driver not found' using errcode = 'P0002';
  end if;

  if coalesce(p_on, false) then
    insert into public.msg_favorites (user_id, driver_id, dsp_id)
    values (v_user, p_driver_id, v_dsp)
    on conflict (user_id, driver_id) do nothing;
    return true;
  else
    delete from public.msg_favorites
     where user_id = v_user and driver_id = p_driver_id;
    return false;
  end if;
end;
$$;
grant execute on function public.dispatch_chat_set_favorite(uuid, boolean) to authenticated;


-- ── 3. dispatch_chat_threads (redefined to include is_favorite) ──
-- Same shape as 0054, plus an is_favorite flag per driver so the inbox can
-- pin/star from server truth instead of localStorage alone.
create or replace function public.dispatch_chat_threads()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := private.current_user_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by (t->>'last_at') desc nulls last) from (
      select jsonb_build_object(
        'driver_id',   d.id,
        'name',        coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'full_name',   d.full_name,
        'station_code', s.code,
        'status',      d.status,
        'last_at',     c.last_message_at,
        'is_favorite', exists (
          select 1 from public.msg_favorites f
           where f.driver_id = d.id and f.user_id = v_user
        ),
        'unread',      coalesce((
          select count(*) from public.driver_messages m
           where m.driver_id = d.id
             and m.sender_kind = 'driver'
             and m.created_at > coalesce(c.dispatch_last_read_at, '-infinity'::timestamptz)
        ), 0),
        'last_message', (
          select jsonb_build_object('body', m.body, 'sender_kind', m.sender_kind, 'created_at', m.created_at)
            from public.driver_messages m
           where m.driver_id = d.id
           order by m.created_at desc
           limit 1
        )
      ) as t
      from public.drivers d
      left join public.driver_conversations c on c.driver_id = d.id
      left join public.stations s on s.id = d.station_id
      where d.dsp_id = v_dsp
        and d.status in ('active', 'onboarding')
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.dispatch_chat_threads() to authenticated;
