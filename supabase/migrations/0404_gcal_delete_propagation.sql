-- ───────────────────────────────────────────────────────────────────────
-- 0404 · Propagate cal_event deletions to Google Calendar
--
-- The sync trigger fires AFTER DELETE, so by the time google-calendar-sync
-- runs, the row is gone and cannot be re-fetched — the function found null and
-- silently skipped, leaving every hard-deleted interview orphaned on the DSP's
-- Google calendar forever.
--
-- Fix: ship the deleted row's Google linkage (google_event_id /
-- google_calendar_id / dsp_id) in the pg_net payload so the function can delete
-- the Google copy without needing the (now-absent) row. INSERT/UPDATE payloads
-- carry the same fields harmlessly.
--
-- Idempotent (create or replace).
-- ───────────────────────────────────────────────────────────────────────

create or replace function private.fire_gcal_sync()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_url   text;
  v_token text;
  v_id    uuid := coalesce(new.id, old.id);
  v_op    text := lower(tg_op);
begin
  if v_op <> 'delete' and new.kind not in ('interview','orientation') then return new; end if;
  if v_op =  'delete' and old.kind not in ('interview','orientation') then return old; end if;

  -- Ignore the sync function's own writebacks (which only touch google_*
  -- columns) — otherwise the trigger loops forever.
  if v_op = 'update'
     and new.status       is not distinct from old.status
     and new.starts_at    is not distinct from old.starts_at
     and new.ends_at      is not distinct from old.ends_at
     and new.applicant_id is not distinct from old.applicant_id
     and new.location     is not distinct from old.location
     and new.meeting_url  is not distinct from old.meeting_url
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
