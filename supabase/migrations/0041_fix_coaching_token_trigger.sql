-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0041 · Fix coaching_view_token trigger
--
-- Migration 0038's trigger used encode(gen_random_bytes(16), 'hex') to
-- generate per-driver coaching access tokens. gen_random_bytes lives in
-- the pgcrypto extension, which isn't enabled here, so every INSERT into
-- public.drivers failed with:
--   function gen_random_bytes(integer) does not exist
--
-- Replace with replace(gen_random_uuid()::text, '-', '') — same idea
-- (random hex string) but uses gen_random_uuid which is already in use
-- elsewhere in the schema.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.drivers_set_coaching_token()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if NEW.coaching_view_token is null then
    NEW.coaching_view_token := replace(gen_random_uuid()::text, '-', '');
  end if;
  return NEW;
end $$;

-- Backfill: any rows still missing a token (e.g. inserted between 0038
-- failing and this fix) get one now.
update public.drivers
   set coaching_view_token = replace(gen_random_uuid()::text, '-', '')
 where coaching_view_token is null;
