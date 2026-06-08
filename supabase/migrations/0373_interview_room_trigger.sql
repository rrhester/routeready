-- ───────────────────────────────────────────────────────────────────────
-- 0373 · Native interviews — Whereby room on booking
--
-- When a native interview is booked (cal_events insert, provider='routeready',
-- kind='interview'), fire the interview-room edge function (pg_net). That
-- function creates a Whereby room, stores meeting_url, and queues the
-- DSP-branded confirmation email. Group sessions share one room (stored on
-- interview_sessions.meeting_url). Reuses the existing trigger token. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

alter table public.interview_sessions add column if not exists meeting_url text;

insert into private.integration_settings (key, value) values
  ('interview_room_url', 'https://doiwrhkirgblcvuskhno.supabase.co/functions/v1/interview-room')
on conflict (key) do nothing;

create or replace function private.fire_interview_room()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_url text; v_token text;
begin
  if new.provider is distinct from 'routeready' or new.kind <> 'interview' then return new; end if;
  select value into v_url   from private.integration_settings where key = 'interview_room_url';
  select value into v_token from private.integration_settings where key = 'gcal_sync_token';
  if v_url is null or v_token is null then return new; end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object('content-type','application/json','x-rr-sync-token', v_token),
    body    := jsonb_build_object('cal_event_id', new.id)
  );
  return new;
end; $$;

drop trigger if exists trg_cal_events_interview_room on public.cal_events;
create trigger trg_cal_events_interview_room
  after insert on public.cal_events
  for each row execute function private.fire_interview_room();
