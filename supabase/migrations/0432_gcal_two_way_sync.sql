-- ───────────────────────────────────────────────────────────────────────
-- 0432 · Two-way Google Calendar sync
--
-- Until now the Google link was outbound-only and interview-only: edits
-- made in Google silently diverged, free-form events never synced, and
-- the operator's own Google meetings were invisible to the booking
-- engine (candidates could self-book on top of them).
--
--   1. Outbound widens to free-form events (kind='event', tasks
--      excluded). Title joins the update-guard field list so renames
--      push. INSERTs that already carry a google_event_id are skipped —
--      those rows were just imported FROM Google by the pull function
--      and must not be pushed back as duplicates.
--   2. Inbound: google_calendar_accounts gains sync_token /
--      full_synced_at / last_pulled_at, and a 5-minute cron fires the
--      new google-calendar-pull edge function (URL derived from the
--      stored gcal_sync_url — no new settings needed). The pull applies
--      Google-side edits to RouteReady-pushed events and imports
--      Google-native timed busy events as provider='google' rows, which
--      makes them real busy-blocks for interview_open_slots.
--
-- Loop safety: pull-applied changes echo ONE outbound push with equal
-- values; the next pull compares equal and writes nothing. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.google_calendar_accounts
  add column if not exists sync_token text;
alter table public.google_calendar_accounts
  add column if not exists full_synced_at timestamptz;
alter table public.google_calendar_accounts
  add column if not exists last_pulled_at timestamptz;

-- Fast lookup for the pull's google_event_id matching.
create index if not exists cal_events_google_event_idx
  on public.cal_events (dsp_id, google_event_id)
  where google_event_id is not null;

-- ── fire_gcal_sync v4 (base: 0404) ──────────────────────────────────────
create or replace function private.fire_gcal_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_url   text;
  v_token text;
  v_id    uuid := coalesce(new.id, old.id);
  v_op    text := lower(tg_op);
  v_kind  text := coalesce(new.kind, old.kind);
  v_meta  jsonb := coalesce(new.metadata, old.metadata);
begin
  -- Interviews, orientations and free-form events sync; tasks stay local.
  if v_kind not in ('interview', 'orientation', 'event') then
    return coalesce(new, old);
  end if;
  if coalesce((v_meta->>'is_task')::boolean, false) then
    return coalesce(new, old);
  end if;
  -- Rows inserted WITH a google_event_id came from the pull import — they
  -- already exist on Google; pushing would duplicate them.
  if v_op = 'insert' and new.google_event_id is not null then
    return new;
  end if;

  -- Ignore the sync function's own writebacks (which only touch google_*
  -- columns) — otherwise the trigger loops forever.
  if v_op = 'update'
     and new.status       is not distinct from old.status
     and new.starts_at    is not distinct from old.starts_at
     and new.ends_at      is not distinct from old.ends_at
     and new.applicant_id is not distinct from old.applicant_id
     and new.location     is not distinct from old.location
     and new.meeting_url  is not distinct from old.meeting_url
     and new.title        is not distinct from old.title
     and new.kind         is not distinct from old.kind
  then
    return new;
  end if;

  select value into v_url   from private.integration_settings where key = 'gcal_sync_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return coalesce(new, old); end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
    body    := jsonb_build_object(
      'cal_event_id',       v_id,
      'op',                 v_op,
      -- Carried so a DELETE can act without the (already-gone) row.
      'dsp_id',             coalesce(new.dsp_id, old.dsp_id),
      'google_event_id',    coalesce(new.google_event_id, old.google_event_id),
      'google_calendar_id', coalesce(new.google_calendar_id, old.google_calendar_id)
    )
  );
  return coalesce(new, old);
end;
$$;

-- ── Inbound pull · every 5 minutes ──────────────────────────────────────
-- Reuses the 0367 settings: URL is gcal_sync_url with the function name
-- swapped, token is the same shared secret the sync trigger presents.
create or replace function private.fire_gcal_pull()
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_url   text;
  v_token text;
begin
  select value into v_url   from private.integration_settings where key = 'gcal_sync_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return; end if;
  perform net.http_post(
    url     := replace(v_url, 'google-calendar-sync', 'google-calendar-pull'),
    headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
    body    := '{}'::jsonb
  );
end;
$$;

do $$ begin
  perform cron.unschedule('gcal-pull');
exception when others then null; end $$;

select cron.schedule(
  'gcal-pull',
  '*/5 * * * *',
  $cron$ select private.fire_gcal_pull(); $cron$
);
