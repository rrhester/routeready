-- ───────────────────────────────────────────────────────────────────────
-- 0431 · True recurring events (series model)
--
-- "Repeat weekly" used to fan out into up to 60 UNLINKED cal_events rows
-- from the client — no way to edit or cancel the series, invites only on
-- the first copy, nothing past occurrence 60, and a partial failure left
-- a half-created series behind.
--
-- Model: keep one real row per occurrence (every RPC, realtime channel,
-- RSVP token, reminder log and Google-sync row in this codebase keys on a
-- concrete cal_events.id) and add a series layer on top:
--
--   • cal_series           — one row per series, stores the recurrence
--                            rule verbatim for display/re-editing.
--   • cal_events.series_id — links each occurrence to its series.
--   • cal_events.series_exception — an occurrence the operator moved or
--                            edited individually; series-wide rewrites
--                            skip it (Google's "detached instance").
--
--   • create_calendar_series() — atomic insert of every occurrence, rule
--                            stamped, invites/rsvp_token on the anchor
--                            (first occurrence) only.
--   • update_calendar_series() — scoped rewrite: 'following' | 'all',
--                            shifting times and/or patching fields.
--                            "Just this one" stays a plain row UPDATE
--                            from the client (which also flags the row
--                            series_exception).
--   • cancel_calendar_series() — scoped cancel, including exceptions
--                            (deleting a series takes detached
--                            instances with it, like Google).
--
-- The 0429 ics_sequence trigger bumps per-row on these rewrites, so
-- invite updates/cancellations stay RFC-5545-correct. Busy-block slot
-- logic (0403/0407), reminders (0406/0430), realtime and gcal sync all
-- keep working unchanged because occurrences remain real rows.
-- Requires 0429 (calendar_method). Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create table if not exists public.cal_series (
  id          uuid        primary key default gen_random_uuid(),
  dsp_id      uuid        not null references public.dsps(id) on delete cascade,
  rule        jsonb       not null,          -- composer rule, stored verbatim
  timezone    text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists cal_series_dsp_idx on public.cal_series (dsp_id);

alter table public.cal_series enable row level security;
drop policy if exists cal_series_select on public.cal_series;
create policy cal_series_select on public.cal_series
  for select to authenticated
  using (dsp_id = private.current_dsp_id());
-- Writes go through the security-definer RPCs below only.

alter table public.cal_events
  add column if not exists series_id uuid references public.cal_series(id) on delete set null;
alter table public.cal_events
  add column if not exists series_exception boolean not null default false;

create index if not exists cal_events_series_idx
  on public.cal_events (series_id) where series_id is not null;

-- ── create_calendar_series ──────────────────────────────────────────────
-- p_occurrences: ordered jsonb array of {"s": iso-start, "e": iso-end};
-- the first element is the anchor (carries invitees + rsvp_token + invite
-- emails). p_extra is merged into every occurrence's metadata (is_task,
-- all_day, attachments, reminders — same keys the composer merges today).
create or replace function public.create_calendar_series(
  p_title       text,
  p_occurrences jsonb,
  p_rule        jsonb   default null,
  p_invitees    text[]  default '{}',
  p_note        text    default null,
  p_timezone    text    default null,
  p_meeting_url text    default null,
  p_body_text   text    default null,
  p_body_html   text    default null,
  p_rsvp_token  text    default null,
  p_calendar_id uuid    default null,
  p_extra       jsonb   default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp       uuid := private.current_dsp_id();
  v_series    uuid;
  v_id        uuid;
  v_anchor    uuid;
  v_email     text;
  v_subject   text := coalesce(nullif(btrim(p_title), ''), 'You''re invited');
  v_text      text := p_body_text;
  v_html      text := p_body_html;
  v_has_inv   boolean := array_length(p_invitees, 1) is not null;
  v_occ       jsonb;
  v_i         int := 0;
  v_n         int;
  v_meta      jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_title is null or btrim(p_title) = '' then
    raise exception 'title_required';
  end if;
  if p_occurrences is null or jsonb_typeof(p_occurrences) <> 'array' then
    raise exception 'occurrences_required';
  end if;
  v_n := jsonb_array_length(p_occurrences);
  if v_n < 1 or v_n > 366 then
    raise exception 'occurrence_count_out_of_range';
  end if;
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  insert into public.cal_series (dsp_id, rule, timezone, created_by)
  values (v_dsp, coalesce(p_rule, '{}'::jsonb), p_timezone, auth.uid())
  returning id into v_series;

  for v_occ in select * from jsonb_array_elements(p_occurrences) loop
    if v_occ->>'s' is null then
      raise exception 'occurrence_missing_start';
    end if;

    v_meta := jsonb_build_object(
      'invitees', case when v_i = 0 then to_jsonb(coalesce(p_invitees, '{}'::text[])) else '[]'::jsonb end,
      'note', p_note
    ) || coalesce(p_extra, '{}'::jsonb);

    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, provider, starts_at, ends_at, timezone,
       title, meeting_url, calendar_id, series_id, rsvp, rsvp_token, metadata)
    values
      (v_dsp, null, 'event', 'scheduled', 'routeready',
       (v_occ->>'s')::timestamptz, (v_occ->>'e')::timestamptz, p_timezone,
       btrim(p_title), p_meeting_url, p_calendar_id, v_series,
       case when v_i = 0 and v_has_inv then 'pending' else 'accepted' end,
       case when v_i = 0 then p_rsvp_token else null end,
       v_meta)
    returning id into v_id;

    if v_i = 0 then v_anchor := v_id; end if;
    v_i := v_i + 1;
  end loop;

  -- Invite emails for the anchor occurrence only, tagged for the .ics
  -- attach (0429) exactly like create_calendar_event does.
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
          (dsp_id, cal_event_id, calendar_method, direction, status, to_email, subject, body_text, body_html)
        values
          (v_dsp, v_anchor, 'request', 'outbound', 'queued', v_email, v_subject, v_text, v_html);
      end if;
    end loop;
  end if;

  return jsonb_build_object('series_id', v_series, 'anchor_id', v_anchor, 'count', v_n);
end;
$$;

grant execute on function public.create_calendar_series(text, jsonb, jsonb, text[], text, text, text, text, text, text, uuid, jsonb) to authenticated;

-- ── update_calendar_series ──────────────────────────────────────────────
-- Scoped rewrite anchored at p_event_id's occurrence. p_scope:
--   'following' — this occurrence and everything after it
--   'all'       — every occurrence in the series
-- Detached instances (series_exception) are left alone. Null args leave
-- the field unchanged; p_reminders = '[]' clears reminders; times move by
-- p_start_shift_seconds and stretch to p_duration_seconds when given.
create or replace function public.update_calendar_series(
  p_event_id            uuid,
  p_scope               text,
  p_title               text    default null,
  p_location            text    default null,
  p_note                text    default null,
  p_calendar_id         uuid    default null,
  p_clear_calendar      boolean default false,
  p_start_shift_seconds int     default null,
  p_duration_seconds    int     default null,
  p_reminders           jsonb   default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_ev    public.cal_events;
  v_count int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_scope not in ('following', 'all') then
    raise exception 'bad_scope';
  end if;
  select * into v_ev from public.cal_events
   where id = p_event_id and dsp_id = v_dsp;
  if v_ev.id is null then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;
  if v_ev.series_id is null then
    raise exception 'not_a_series';
  end if;
  if p_calendar_id is not null and not exists (
    select 1 from public.calendars c where c.id = p_calendar_id and c.dsp_id = v_dsp
  ) then
    raise exception 'calendar_not_found';
  end if;

  update public.cal_events ce set
    starts_at   = case when p_start_shift_seconds is not null
                       then ce.starts_at + make_interval(secs => p_start_shift_seconds)
                       else ce.starts_at end,
    ends_at     = case
                    when p_duration_seconds is not null
                    then ce.starts_at + make_interval(secs => coalesce(p_start_shift_seconds, 0))
                                      + make_interval(secs => p_duration_seconds)
                    when p_start_shift_seconds is not null
                    then ce.ends_at + make_interval(secs => p_start_shift_seconds)
                    else ce.ends_at end,
    title       = coalesce(nullif(btrim(coalesce(p_title, '')), ''), ce.title),
    location    = coalesce(p_location, ce.location),
    calendar_id = case when p_clear_calendar then null else coalesce(p_calendar_id, ce.calendar_id) end,
    metadata    = coalesce(ce.metadata, '{}'::jsonb)
                  || case when p_note is not null then jsonb_build_object('note', p_note) else '{}'::jsonb end
                  || case when p_reminders is not null and jsonb_typeof(p_reminders) = 'array' and jsonb_array_length(p_reminders) > 0
                          then jsonb_build_object('reminders', p_reminders) else '{}'::jsonb end,
    updated_at  = now()
  where ce.series_id = v_ev.series_id
    and ce.dsp_id = v_dsp
    and ce.status in ('scheduled', 'rescheduled')
    and ce.series_exception = false
    and (p_scope = 'all' or ce.starts_at >= v_ev.starts_at);

  get diagnostics v_count = row_count;

  -- Explicit clear: an empty array removes the reminders key entirely.
  if p_reminders is not null and jsonb_typeof(p_reminders) = 'array' and jsonb_array_length(p_reminders) = 0 then
    update public.cal_events ce
       set metadata = coalesce(ce.metadata, '{}'::jsonb) - 'reminders'
     where ce.series_id = v_ev.series_id
       and ce.dsp_id = v_dsp
       and ce.status in ('scheduled', 'rescheduled')
       and ce.series_exception = false
       and (p_scope = 'all' or ce.starts_at >= v_ev.starts_at);
  end if;

  return v_count;
end;
$$;

grant execute on function public.update_calendar_series(uuid, text, text, text, text, uuid, boolean, int, int, jsonb) to authenticated;

-- ── cancel_calendar_series ──────────────────────────────────────────────
-- Scoped cancel. Includes detached instances — deleting a series should
-- take moved copies with it, matching Google/Outlook.
create or replace function public.cancel_calendar_series(
  p_event_id uuid,
  p_scope    text
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_ev    public.cal_events;
  v_count int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_scope not in ('following', 'all') then
    raise exception 'bad_scope';
  end if;
  select * into v_ev from public.cal_events
   where id = p_event_id and dsp_id = v_dsp;
  if v_ev.id is null then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;
  if v_ev.series_id is null then
    raise exception 'not_a_series';
  end if;

  update public.cal_events ce set
    status = 'cancelled',
    cancelled_at = now(),
    cancellation_reason = 'Series removed by operator',
    updated_at = now()
  where ce.series_id = v_ev.series_id
    and ce.dsp_id = v_dsp
    and ce.status in ('scheduled', 'rescheduled')
    and (p_scope = 'all' or ce.starts_at >= v_ev.starts_at);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function public.cancel_calendar_series(uuid, text) to authenticated;
