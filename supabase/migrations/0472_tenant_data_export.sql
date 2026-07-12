-- Migration 0472 · Owner-initiated tenant data export (portability / DSR).
--
-- WHY
-- ───
-- A DSP owner should be able to walk away with their own data — it's a trust
-- signal ("your data isn't locked in") and the floor of a GDPR/CCPA data-
-- subject-request workflow. This exposes ONE owner-only function that returns
-- the tenant's core HR/ops data as a single JSON bundle the dashboard (or an
-- operator fulfilling a request) can download.
--
-- SECURITY
-- ────────
-- SECURITY DEFINER (so it can read across the tenant's tables in one call) but
-- it resolves the caller's DSP from their JWT via private.current_dsp_id() and
-- filters EVERY query to that dsp_id — it can never reach another tenant. Only
-- role='owner' may call it (is_staff(…, 'owner')); dispatchers/drivers are
-- refused. Proven by supabase/tests/data_export_test.sql.
--
-- Note: driver_documents are exported as metadata (labels, kinds, storage
-- paths, expiries) — not the file bytes. The files live in a private bucket and
-- are fetched via signed URLs; a bulk file export is a separate follow-up.
--
-- Idempotent: create or replace.

create or replace function public.export_my_dsp_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if v_dsp is null then
    raise exception 'no_tenant';
  end if;
  -- Full-tenant export is an owner action.
  if not private.is_staff(v_dsp, 'owner') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'exported_at', now(),
    'dsp_id',      v_dsp,
    'dsp',         (select to_jsonb(d) from public.dsps d where d.id = v_dsp),
    'team', coalesce((
      select jsonb_agg(jsonb_build_object(
               'email', a.email, 'full_name', a.full_name,
               'role', a.role, 'active', a.active))
      from public.app_users a where a.dsp_id = v_dsp), '[]'::jsonb),
    'drivers', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.drivers x where x.dsp_id = v_dsp), '[]'::jsonb),
    'driver_documents', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.driver_documents x where x.dsp_id = v_dsp), '[]'::jsonb),
    'applicants', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.applicants x where x.dsp_id = v_dsp), '[]'::jsonb),
    'coachings', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.coachings x where x.dsp_id = v_dsp), '[]'::jsonb),
    'shifts', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.shifts x where x.dsp_id = v_dsp), '[]'::jsonb),
    'time_off_requests', coalesce((
      select jsonb_agg(to_jsonb(x)) from public.time_off_requests x where x.dsp_id = v_dsp), '[]'::jsonb)
  ) into v_out;

  return v_out;
end;
$$;

grant execute on function public.export_my_dsp_data() to authenticated;
revoke all on function public.export_my_dsp_data() from anon;

notify pgrst, 'reload schema';
