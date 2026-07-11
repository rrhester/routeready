-- Migration 0452 · Intra-tenant role gates on hiring_targets + route_forecasts.
--
-- WHY
-- ───
-- Continues the 0445 role-gating pass. These two planning tables still carry
-- their original `for all using (dsp_id = private.current_dsp_id())` policies
-- (hiring_targets 0136, route_forecasts 0137) with NO is_staff check. So
-- inside a tenant, every authenticated app_user — including role='driver'
-- (the 0005 signup default) — can INSERT/UPDATE/DELETE hiring targets and
-- route forecasts DIRECTLY via PostgREST, bypassing the
-- is_staff(dsp,'dispatcher') gate their write RPCs already enforce
-- (hiring_target_upsert 0136:15, route_forecast_set 0137). This closes the
-- direct-write hole so the RLS matches the RPC.
--
-- WHAT CHANGES (mirrors 0445 exactly)
-- ───────────────────────────────────
--   · SELECT stays tenant-wide (any active app_user in the DSP). No read
--     regression — the original _rw policy already allowed tenant-wide reads.
--   · INSERT / UPDATE / DELETE now require is_staff(dsp_id,'dispatcher') —
--     dispatcher, ops, or owner. role='driver' app_users become read-only.
--
-- WHO IS UNAFFECTED
-- ─────────────────
--   · The write RPCs (SECURITY DEFINER) already gate is_staff and bypass RLS,
--     so the dashboard's normal Save path is unchanged.
--   · The driver PWA never holds a Supabase session — its writes go through
--     driver-token SECURITY DEFINER RPCs, not these tables.
--
-- NOT INCLUDED (follow-up): compliance_dismissals (0240) is also over-
-- permissive, but its compliance_dismiss() RPC does NOT yet gate is_staff,
-- so closing it correctly needs an RPC change too — handled separately.
--
-- Idempotent: drop policy if exists / create; safe to re-run.

-- ─── hiring_targets ───────────────────────────────────────────────────────

drop policy if exists "hiring_targets_tenant_rw" on public.hiring_targets;

drop policy if exists "hiring_targets_tenant_select" on public.hiring_targets;
create policy "hiring_targets_tenant_select"
  on public.hiring_targets for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "hiring_targets_staff_insert" on public.hiring_targets;
create policy "hiring_targets_staff_insert"
  on public.hiring_targets for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "hiring_targets_staff_update" on public.hiring_targets;
create policy "hiring_targets_staff_update"
  on public.hiring_targets for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "hiring_targets_staff_delete" on public.hiring_targets;
create policy "hiring_targets_staff_delete"
  on public.hiring_targets for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

-- ─── route_forecasts ──────────────────────────────────────────────────────

drop policy if exists "route_forecasts_tenant_rw" on public.route_forecasts;

drop policy if exists "route_forecasts_tenant_select" on public.route_forecasts;
create policy "route_forecasts_tenant_select"
  on public.route_forecasts for select
  to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists "route_forecasts_staff_insert" on public.route_forecasts;
create policy "route_forecasts_staff_insert"
  on public.route_forecasts for insert
  to authenticated
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "route_forecasts_staff_update" on public.route_forecasts;
create policy "route_forecasts_staff_update"
  on public.route_forecasts for update
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id()
              and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists "route_forecasts_staff_delete" on public.route_forecasts;
create policy "route_forecasts_staff_delete"
  on public.route_forecasts for delete
  to authenticated
  using (dsp_id = private.current_dsp_id()
         and private.is_staff(dsp_id, 'dispatcher'));

notify pgrst, 'reload schema';
