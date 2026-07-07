-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0441 · In-app read access to client error telemetry
--
-- 0385 created public.client_errors as WRITE-ONLY (the dashboard hook inserts
-- JS errors, but the only way to read them was the Supabase SQL editor). For
-- a launch with paying customers, production errors need to be visible in the
-- app so the RouteReady operator isn't flying blind.
--
-- This adds a SELECT policy scoped to platform_admin only — the SaaS operator
-- monitoring ALL customers' dashboard errors (cross-tenant is correct here;
-- DSP customers still cannot read the table). Capture behaviour is unchanged.
--
-- Idempotent: safe to re-run.
-- ─────────────────────────────────────────────────────────────────────────

do $$ begin
  create policy client_errors_platform_admin_read
    on public.client_errors
    for select to authenticated
    using (private.is_platform_admin());
exception when duplicate_object then null; end $$;

-- SELECT must be granted for the policy to be reachable; RLS still restricts
-- the visible rows to platform_admins (everyone else sees an empty set).
grant select on public.client_errors to authenticated;
