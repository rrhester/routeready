-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510000000 · init
-- Extensions, common helper functions, and the private schema for
-- internals that should NOT be reachable via PostgREST.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── Extensions ──────────────────────────────────────────────────────────

create extension if not exists "uuid-ossp"     with schema extensions;
create extension if not exists "pgcrypto"      with schema extensions;
create extension if not exists "pgjwt"         with schema extensions;
create extension if not exists "pg_stat_statements";
create extension if not exists "pg_trgm"       with schema extensions;
create extension if not exists "moddatetime"   with schema extensions;
-- pg_cron and pg_net are managed at the project level via Supabase dashboard
-- (`select cron.schedule(...)` in the supabase SQL editor, not in this migration)

-- ─── Schemas ─────────────────────────────────────────────────────────────

-- `private` is for helpers that ONLY trusted code (security-definer
-- functions, triggers) should reach. Not exposed via PostgREST.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to postgres, supabase_auth_admin;

-- ─── Common helper: updated_at auto-touch ────────────────────────────────
-- Add via:  create trigger trg_updated_at before update on <table>
--           for each row execute function moddatetime(updated_at);

-- ─── Common helper: extract dsp_id from the current JWT ──────────────────
-- Always returns a uuid (or null if there's no claim — RLS policies will
-- then deny since no row will match).
create or replace function private.current_dsp_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'dsp_id', '')::uuid
$$;
grant execute on function private.current_dsp_id() to authenticated, service_role;

create or replace function private.current_role_claim()
returns text
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')
$$;
grant execute on function private.current_role_claim() to authenticated, service_role;

create or replace function private.current_driver_id()
returns uuid
language sql stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'driver_id', '')::uuid
$$;
grant execute on function private.current_driver_id() to authenticated, service_role;

-- Convenience: is the caller a staff role for the given dsp?
create or replace function private.is_staff(p_dsp uuid, p_min_role text default 'dispatcher')
returns boolean
language sql stable
as $$
  with caller as (
    select private.current_dsp_id()  as dsp_id,
           private.current_role_claim() as role
  )
  select
    caller.dsp_id = p_dsp
    and caller.role in
      (case p_min_role
         when 'owner'      then array['owner']
         when 'ops'        then array['owner','ops']
         when 'dispatcher' then array['owner','ops','dispatcher']
         else                   array['owner','ops','dispatcher']
       end)
  from caller
$$;
grant execute on function private.is_staff(uuid, text) to authenticated, service_role;

-- ─── Default privileges on future tables ─────────────────────────────────
-- Authenticated users get nothing by default; RLS policies grant access on
-- a per-table basis. Service role is unrestricted.

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

-- ─── Comments for documentation ──────────────────────────────────────────

comment on schema private is 'Internal helpers; never exposed via PostgREST.';
comment on function private.current_dsp_id() is 'Reads dsp_id claim from the request JWT.';
comment on function private.current_role_claim() is 'Reads role claim from the request JWT.';
comment on function private.current_driver_id() is 'Reads driver_id claim from the request JWT (only set for role=driver).';
comment on function private.is_staff(uuid, text) is 'True when the caller is staff for the given DSP at or above the minimum role.';
