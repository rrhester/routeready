-- Migration 0445 · Intra-tenant role gates on the P0 tables + client_errors
-- insert tightening.
--
-- WHY
-- ───
-- drivers / shifts / time_off_requests still carry their original
-- `for all using (dsp_id = private.current_dsp_id())` policies from
-- migrations 0013/0025. That correctly isolates tenants, but inside a
-- tenant EVERY authenticated app_user — including role='driver' (the
-- signup default in 0005) — can INSERT/UPDATE/DELETE every driver row,
-- every shift, and every PTO record. Newer tables (e.g. checklists,
-- 0415) already gate writes with private.is_staff(dsp_id,'dispatcher');
-- this migration brings the three core tables up to the same standard.
--
-- WHAT CHANGES
-- ────────────
--   · SELECT stays tenant-wide (any active app_user in the DSP).
--   · INSERT / UPDATE / DELETE now require is_staff(dsp_id,'dispatcher')
--     — i.e. dispatcher, ops, or owner. role='driver' app_users become
--     read-only on these tables.
--   · client_errors INSERT can no longer spoof another tenant/user:
--     dsp_id/user_id must be null or match the caller.
--
-- WHO IS UNAFFECTED
-- ─────────────────
--   · The driver PWA — it never holds a Supabase session; all its writes
--     go through SECURITY DEFINER RPCs validated by driver tokens.
--   · Invited team members — the invite flow (0076) grants 'dispatcher'
--     or higher.
--
-- ⚠ PREFLIGHT — check for legitimate operators stuck at role='driver'
-- (the 0005 signup default when the email wasn't in pending_owners):
--
--     select email, role, active from public.app_users
--     where active order by role, email;
--
-- Anyone who should be able to edit the schedule must be dispatcher+:
--
--     update public.app_users set role = 'dispatcher'
--     where email = 'person@example.com';
--
-- Idempotent: drop policy if exists / create; safe to re-run.

-- ─── drivers ─────────────────────────────────────────────────────────────

drop policy if exists "drivers_tenant_rw" on public.drivers;

drop policy if exists "drivers_tenant_select" on public.drivers;
create policy "drivers_tenant_select"
  on public.drivers for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "drivers_staff_insert" on public.drivers;
create policy "drivers_staff_insert"
  on public.drivers for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drivers_staff_update" on public.drivers;
create policy "drivers_staff_update"
  on public.drivers for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "drivers_staff_delete" on public.drivers;
create policy "drivers_staff_delete"
  on public.drivers for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── shifts ──────────────────────────────────────────────────────────────

drop policy if exists "shifts_tenant_rw" on public.shifts;

drop policy if exists "shifts_tenant_select" on public.shifts;
create policy "shifts_tenant_select"
  on public.shifts for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "shifts_staff_insert" on public.shifts;
create policy "shifts_staff_insert"
  on public.shifts for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "shifts_staff_update" on public.shifts;
create policy "shifts_staff_update"
  on public.shifts for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "shifts_staff_delete" on public.shifts;
create policy "shifts_staff_delete"
  on public.shifts for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── time_off_requests ───────────────────────────────────────────────────

drop policy if exists "time_off_tenant_rw" on public.time_off_requests;

drop policy if exists "time_off_tenant_select" on public.time_off_requests;
create policy "time_off_tenant_select"
  on public.time_off_requests for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "time_off_staff_insert" on public.time_off_requests;
create policy "time_off_staff_insert"
  on public.time_off_requests for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "time_off_staff_update" on public.time_off_requests;
create policy "time_off_staff_update"
  on public.time_off_requests for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "time_off_staff_delete" on public.time_off_requests;
create policy "time_off_staff_delete"
  on public.time_off_requests for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── client_errors · bind insert to the caller's identity ────────────────
-- Telemetry rows may omit dsp_id/user_id (errors before auth resolves),
-- but when present they must match the caller — no cross-tenant spoofing.

drop policy if exists "client_errors_insert_authed" on public.client_errors;
create policy "client_errors_insert_authed"
  on public.client_errors for insert
  to authenticated
  with check (
    (dsp_id  is null or dsp_id  = private.current_dsp_id())
    and (user_id is null or user_id = auth.uid())
  );

notify pgrst, 'reload schema';
