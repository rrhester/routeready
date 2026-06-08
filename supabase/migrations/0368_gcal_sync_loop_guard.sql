-- ───────────────────────────────────────────────────────────────────────
-- 0368 · Guard the Google Calendar sync trigger against self-retriggering
--
-- google-calendar-sync writes google_event_id / google_synced_at back to the
-- cal_events row. The 0367 trigger fired on ANY update, so that writeback
-- re-fired the trigger → another sync → another writeback → infinite loop.
-- Fix: on UPDATE, only fire when an operator-relevant field actually changed
-- (status / time / applicant / location / kind). INSERT + DELETE still fire.
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
    body    := jsonb_build_object('cal_event_id', v_id, 'op', v_op)
  );
  return coalesce(new, old);
end;
$$;
