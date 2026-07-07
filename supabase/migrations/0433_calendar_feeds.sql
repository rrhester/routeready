-- ───────────────────────────────────────────────────────────────────────
-- 0433 · ICS subscribe feeds
--
-- A read-only, token-secret iCalendar URL per scope — the whole DSP
-- calendar or one custom calendar — that Google Calendar, Apple
-- Calendar, and Outlook can subscribe to. Served by the calendar-feed
-- edge function (GET ?t=<token>, no auth beyond the unguessable token,
-- same trust model as booking/RSVP links).
--
-- calendar_feed_link(p_calendar_id) mints (or returns) the scope's
-- token; calendar_feed_revoke(p_calendar_id) deletes it so the old URL
-- goes dead — the next _link call mints a fresh one (rotation).
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.calendar_feeds (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  calendar_id uuid        references public.calendars(id) on delete cascade,  -- null = all events
  token       text        not null unique,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

-- One feed per scope; the all-events scope keys on a sentinel uuid so the
-- unique index can cover the null calendar_id case.
create unique index if not exists calendar_feeds_scope_idx
  on public.calendar_feeds (dsp_id, coalesce(calendar_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- Service-role only (the edge function). Browsers go through the RPCs.
alter table public.calendar_feeds enable row level security;
revoke all on public.calendar_feeds from anon, authenticated;

create or replace function public.calendar_feed_link(p_calendar_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_token text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  select token into v_token from public.calendar_feeds
   where dsp_id = v_dsp
     and coalesce(calendar_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_calendar_id, '00000000-0000-0000-0000-000000000000'::uuid);
  if v_token is not null then
    return v_token;
  end if;

  -- 64 hex chars of entropy without a pgcrypto dependency.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.calendar_feeds (dsp_id, calendar_id, token, created_by)
  values (v_dsp, p_calendar_id, v_token, auth.uid());
  return v_token;
end;
$$;

grant execute on function public.calendar_feed_link(uuid) to authenticated;

create or replace function public.calendar_feed_revoke(p_calendar_id uuid default null)
returns void
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
  delete from public.calendar_feeds
   where dsp_id = v_dsp
     and coalesce(calendar_id, '00000000-0000-0000-0000-000000000000'::uuid)
       = coalesce(p_calendar_id, '00000000-0000-0000-0000-000000000000'::uuid);
end;
$$;

grant execute on function public.calendar_feed_revoke(uuid) to authenticated;
