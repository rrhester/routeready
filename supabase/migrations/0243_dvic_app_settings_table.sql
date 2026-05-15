-- Migration 0243 · Hold the DVIC AI Edge Function URL + service-role
-- key in a regular table instead of postgres GUCs.
--
-- Supabase Cloud's SQL editor runs as a role that can't ALTER DATABASE,
-- so the GUC-based approach from 0242 isn't usable.  Replace it with
-- private.app_settings — a tiny key/value table only callable from
-- SECURITY DEFINER functions (no grants to authenticated / anon).
--
-- After applying this migration, set the two values with the inserts at
-- the bottom of this file (in the migration notes — not run by the
-- migration itself, since they're per-project secrets).
--
-- Idempotent.

create schema if not exists private;

create table if not exists private.app_settings (
  key   text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- No grants — only SECURITY DEFINER functions running as the owner
-- can read this table.  Even the postgres role in the SQL editor can
-- read it (it's the owner), so inserts from the SQL editor still work.

-- Helper that returns the value or null without throwing on missing key.
create or replace function private.app_setting(p_key text)
returns text
language sql stable security definer set search_path = public
as $$
  select value from private.app_settings where key = p_key;
$$;
grant execute on function private.app_setting(text) to authenticated;

-- Re-issue dvic_request_ai_review to read from the table.
create or replace function private.dvic_request_ai_review(p_inspection_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text := private.app_setting('dvic_ai_review_url');
  v_key text := private.app_setting('service_role_key');
begin
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return;
  end if;
  begin
    perform extensions.http_post(
      url     := v_url,
      body    := jsonb_build_object('inspection_id', p_inspection_id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      )
    );
  exception when others then
    null;
  end;
end $$;
grant execute on function private.dvic_request_ai_review(uuid) to authenticated;

-- Migration notes (for the operator) — run these AFTER applying the
-- migration above, substituting the two values:
--
--   insert into private.app_settings (key, value) values
--     ('dvic_ai_review_url', 'https://<project>.functions.supabase.co/dvic-ai-review')
--     on conflict (key) do update set value = excluded.value, updated_at = now();
--
--   insert into private.app_settings (key, value) values
--     ('service_role_key',   'eyJhbGciOi...your-service-role-key...')
--     on conflict (key) do update set value = excluded.value, updated_at = now();
