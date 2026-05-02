-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0007 · Immediate-send triggers for sms_messages + email_messages
--
-- The 1-minute cron drainer (configured outside migrations via
-- cron.schedule) pulls queued rows in batches. That's a fine safety net
-- but it adds 0-60s of latency. This trigger fires the moment a queued
-- row lands, calling the matching edge function via pg_net so the
-- recipient sees the SMS / email in seconds.
--
-- Required runtime config (set once via `ALTER DATABASE postgres SET ...`,
-- documented in supabase/SECRETS.md):
--   app.functions_base_url    e.g. https://doiwrhkirgblcvuskhno.functions.supabase.co
--   app.service_role_key      service-role JWT used to authenticate to functions
--
-- If either setting is missing the trigger silently no-ops, and the cron
-- drainer will still pick up the row on its next pass.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.fire_message_send()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_function text;
  v_base     text;
  v_key      text;
begin
  if new.status <> 'queued' then
    return new;
  end if;

  v_function := case tg_table_name
    when 'sms_messages'   then 'send-sms'
    when 'email_messages' then 'send-email'
    else null
  end;
  if v_function is null then return new; end if;

  v_base := current_setting('app.functions_base_url', true);
  v_key  := current_setting('app.service_role_key',   true);

  -- Either setting missing → leave to cron drainer.
  if v_base is null or v_base = '' or v_key is null or v_key = '' then
    return new;
  end if;

  perform net.http_post(
    url     := v_base || '/' || v_function,
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := jsonb_build_object('applicant_id', new.applicant_id)
  );

  return new;
end;
$$;

create trigger trg_sms_messages_fire_send
  after insert on public.sms_messages
  for each row execute function private.fire_message_send();

create trigger trg_email_messages_fire_send
  after insert on public.email_messages
  for each row execute function private.fire_message_send();
