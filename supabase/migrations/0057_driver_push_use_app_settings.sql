-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0057 · Switch driver-push to private.app_settings
--
-- 0056 read VAPID + functions config via current_setting('app.*'), which
-- needs `ALTER DATABASE postgres SET ...` — and Supabase's SQL editor
-- role no longer has permission to set those. 0008 already solved this
-- exact problem for the SMS/email triggers by routing through a private
-- key-value table; this migration brings driver-push onto the same path.
--
-- Operator setup after this migration: one INSERT in the SQL editor:
--
--   insert into private.app_settings (key, value) values
--     ('vapid_public_key', 'BLC1Uqt...your_key...')
--   on conflict (key) do update set value = excluded.value, updated_at = now();
--
-- functions_base_url + service_role_key should already exist there (set
-- when SMS/email immediate-send was wired up via migration 0008).
-- ─────────────────────────────────────────────────────────────────────────


-- Read the VAPID public key from private.app_settings instead of a GUC.
create or replace function public.driver_push_vapid_key()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select nullif(private.app_setting('vapid_public_key'), '');
$$;
grant execute on function public.driver_push_vapid_key() to anon, authenticated;


-- Replace the trigger function to read all config from app_settings.
create or replace function private.fire_driver_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_base text;
  v_key  text;
begin
  if new.sender_kind <> 'dispatch' then
    return new;
  end if;

  v_base := private.app_setting('functions_base_url');
  v_key  := private.app_setting('service_role_key');
  if v_base is null or v_base = '' or v_key is null or v_key = '' then
    return new;
  end if;

  perform net.http_post(
    url     := v_base || '/send-driver-push',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || v_key
    ),
    body    := jsonb_build_object(
      'driver_id',  new.driver_id,
      'message_id', new.id
    )
  );

  return new;
end;
$$;


notify pgrst, 'reload schema';
