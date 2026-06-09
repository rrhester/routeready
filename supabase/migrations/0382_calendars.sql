-- ───────────────────────────────────────────────────────────────────────
-- 0382 · Custom calendars ("My Calendars", Outlook-style)
--
-- A DSP-shared set of named, colored calendars. Free-form events can belong
-- to one (cal_events.calendar_id); the dashboard's "My Calendars" sidebar
-- toggles each on/off so they overlap like Outlook. Built-in event kinds
-- (interviews / orientations / events / sessions) stay as-is and are toggled
-- client-side.
--
-- Tenant-scoped RLS (dsp_id = current_dsp_id), same shape as cal_events, so
-- the dashboard does direct CRUD — no RPCs needed for calendar management.
-- Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.calendars (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  name        text        not null,
  color       text        not null default '#0F6CBD',
  sort_order  int         not null default 0,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists calendars_dsp_idx
  on public.calendars (dsp_id, sort_order, created_at);

alter table public.cal_events
  add column if not exists calendar_id uuid references public.calendars(id) on delete set null;

create index if not exists cal_events_calendar_idx
  on public.cal_events (calendar_id) where calendar_id is not null;

alter table public.calendars enable row level security;

drop policy if exists "calendars_tenant_rw" on public.calendars;
create policy "calendars_tenant_rw"
  on public.calendars for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.calendars to authenticated;


-- ─── create_calendar_event: accept an optional calendar_id ─────────────
-- Same as 0377 plus p_calendar_id, stamped onto the new cal_events row so
-- the event shows up under its custom calendar in My Calendars. Drop the old
-- 10-arg signature first so adding the defaulted param can't create an
-- ambiguous overload — callers that omit p_calendar_id resolve to this one.
drop function if exists public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text);

create or replace function public.create_calendar_event(
  p_title       text,
  p_starts_at   timestamptz,
  p_ends_at     timestamptz,
  p_invitees    text[]  default '{}',
  p_note        text    default null,
  p_timezone    text    default null,
  p_meeting_url text    default null,
  p_body_text   text    default null,
  p_body_html   text    default null,
  p_rsvp_token  text    default null,
  p_calendar_id uuid    default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_id      uuid;
  v_email   text;
  v_subject text := coalesce(nullif(btrim(p_title), ''), 'You''re invited');
  v_text    text := p_body_text;
  v_html    text := p_body_html;
  v_has_inv boolean := array_length(p_invitees, 1) is not null;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required';
  end if;
  if p_starts_at is null then
    raise exception 'starts_at_required';
  end if;
  -- A calendar_id, if given, must belong to this DSP.
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone, title, meeting_url, calendar_id, rsvp, rsvp_token, metadata)
  values
    (v_dsp, null, 'event', 'scheduled', 'routeready', p_starts_at, p_ends_at, p_timezone, btrim(p_title), p_meeting_url, p_calendar_id,
     case when v_has_inv then 'pending' else 'accepted' end, p_rsvp_token,
     jsonb_build_object('invitees', to_jsonb(coalesce(p_invitees, '{}'::text[])), 'note', p_note))
  returning id into v_id;

  if v_has_inv then
    if v_text is null then
      v_text := 'You''re invited: ' || btrim(p_title)
        || case when p_meeting_url is not null then E'\n\nJoin the video meeting here:\n' || p_meeting_url else '' end;
    end if;
    if v_html is null then
      v_html := replace(v_text, E'\n', '<br>');
    end if;
    foreach v_email in array p_invitees loop
      if v_email is not null and position('@' in v_email) > 0 then
        insert into public.email_messages
          (dsp_id, cal_event_id, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_id, 'outbound', 'queued', v_email, v_subject, v_text, v_html);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

grant execute on function public.create_calendar_event(text, timestamptz, timestamptz, text[], text, text, text, text, text, text, uuid) to authenticated;
