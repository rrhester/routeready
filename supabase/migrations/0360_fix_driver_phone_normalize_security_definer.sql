-- ── Fix: "Add driver" fails with "permission denied for schema private" ──
--
-- The BEFORE INSERT OR UPDATE OF phone trigger trg_drivers_normalize_phone
-- on public.drivers calls private.drivers_normalize_phone(), which in turn
-- calls private.normalize_phone(). That trigger function was created
-- (0253, 0254) WITHOUT `security definer`, so it executes as the calling
-- role. The dashboard "Add driver" save is a plain client INSERT, so it
-- runs as the Supabase `authenticated` role — and `authenticated` has had
-- USAGE on schema `private` revoked since 0001_foundation.sql. Resolving
-- private.normalize_phone() therefore throws "permission denied for schema
-- private" before the row is ever inserted.
--
-- Every other private.* trigger function on public.drivers (coaching
-- token, channel sync, activation welcome, training-shift cleanup) is
-- already `security definer`. This brings the phone-normalize trigger
-- function in line: it now runs as its owner (postgres), which holds
-- USAGE on `private`, so the insert succeeds. We deliberately do NOT
-- grant `authenticated` access to `private` — it stays unreachable from
-- PostgREST by design (0001_foundation.sql).
--
-- `create or replace` preserves the existing trigger binding and is
-- idempotent (re-running is a no-op). search_path stays locked to '' —
-- the standard, injection-safe pattern for security-definer functions.

create or replace function private.drivers_normalize_phone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.phone_normalized := private.normalize_phone(new.phone);
  return new;
end;
$$;
