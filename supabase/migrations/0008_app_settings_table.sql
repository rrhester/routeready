-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0008 · Read trigger config from private.app_settings
--
-- 0007 read app.functions_base_url / app.service_role_key via
-- current_setting(). That requires `ALTER DATABASE postgres SET ...`
-- which needs superuser on Supabase — operators get permission denied
-- in the SQL editor.
--
-- This migration switches the trigger to read from a tiny key-value
-- table in the private schema. Operators populate it once via INSERT
-- (no superuser needed), and the trigger function (SECURITY DEFINER)
-- reads from it on every fire.
-- ─────────────────────────────────────────────────────────────────────────

-- Defensive: create the table if the operator hasn't yet (the migration
-- is idempotent so re-running is safe).
create table if not exists private.app_settings (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);

-- Lock the table down — only the trigger (security definer) reads it.
revoke all on private.app_settings from public, anon, authenticated;


-- Helper: read a setting by key, return null if missing.
create or replace function private.app_setting(p_key text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select value from private.app_settings where key = p_key;
$$;


-- Replace the trigger function to read from the table.
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

  v_base := private.app_setting('functions_base_url');
  v_key  := private.app_setting('service_role_key');

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
