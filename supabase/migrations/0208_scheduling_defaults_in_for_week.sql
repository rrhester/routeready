-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0208 · Surface DSP defaults alongside per-week settings
--
-- Adds a `defaults` sub-object to scheduling_settings_for_week pulled
-- straight from dsps.metadata.scheduling, so the per-week drawer can show
-- "Default: 10h" hints next to each field and highlight when the visible
-- week overrides a DSP-wide baseline.
--
-- Idempotent: existing keys keep the same shape; clients that don't read
-- `defaults` are unaffected.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.scheduling_settings_for_week(p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp       uuid := private.current_dsp_id();
  v_exact     public.scheduling_settings;
  v_eff       public.scheduling_settings;
  v_inherited boolean;
  v_meta      jsonb;
  v_defaults  jsonb;
begin
  v_eff := private.get_week_settings(v_dsp, p_week_start);
  select * into v_exact from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  v_inherited := not found;

  select metadata into v_meta from public.dsps where id = v_dsp;
  v_defaults := jsonb_build_object(
    'default_block_hours',         coalesce((v_meta->'scheduling'->>'default_block_hours')::int, 10),
    'cushion_pct',                 coalesce((v_meta->'scheduling'->>'cushion_pct')::numeric, 10),
    'max_days_per_week',           coalesce((v_meta->'scheduling'->>'max_days_per_week')::int, 5),
    'report_lead_minutes',         coalesce((v_meta->'scheduling'->>'report_lead_minutes')::int, 0),
    'allow_availability_override', coalesce((v_meta->'scheduling'->>'allow_availability_override')::boolean, false),
    'preference_tiebreaker',       coalesce(v_meta->'scheduling'->>'preference_tiebreaker', 'least_loaded'),
    'waves',                       coalesce(
                                     v_meta->'scheduling'->'waves',
                                     jsonb_build_array(jsonb_build_object(
                                       'start',
                                       coalesce(v_meta->'scheduling'->>'wave_start', '07:00')
                                     ))
                                   )
  );

  return jsonb_build_object(
    'week_start',                   v_eff.week_start,
    'default_block_hours',          v_eff.default_block_hours,
    'cushion_pct',                  v_eff.cushion_pct,
    'max_days_per_week',            v_eff.max_days_per_week,
    'waves',                        v_eff.waves,
    'timezone',                     v_eff.timezone,
    'allow_availability_override',  v_eff.allow_availability_override,
    'report_lead_minutes',          coalesce(v_eff.report_lead_minutes, 0),
    'preference_tiebreaker',        coalesce(v_eff.preference_tiebreaker, 'least_loaded'),
    'finalized',                    coalesce(v_exact.finalized, false),
    'is_inherited',                 v_inherited,
    'defaults',                     v_defaults
  );
end;
$$;
grant execute on function public.scheduling_settings_for_week(date) to authenticated;

notify pgrst, 'reload schema';
