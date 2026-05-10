-- Migration 0135 · Per-DSP "who gets their preferred day" tiebreaker
--
-- Drivers can flag preferred days (migration 0134).  Auto-schedule
-- honors them when there's enough coverage to do so; when there isn't —
-- two drivers prefer Saturday but only one Saturday shift is left — the
-- DSP picks how the tie breaks:
--
--   'least_loaded' (default) — whoever currently has the fewest shifts
--                              that week wins. The existing balancing
--                              behavior; no new concept.
--   'seniority'              — earliest hire_date wins.
--   'fairness'               — whoever's had their preference honored the
--                              fewest times (lifetime counter
--                              drivers.metadata.scheduling.pref_honored,
--                              bumped by the auto-assigner) wins.
--
-- Stored per (dsp_id, week_start) like every other scheduling setting,
-- so future weeks inherit it via private.get_week_settings.

alter table public.scheduling_settings
  add column if not exists preference_tiebreaker text not null default 'least_loaded'
    check (preference_tiebreaker in ('least_loaded','seniority','fairness'));


-- ── upsert_scheduling_settings · accept preference_tiebreaker ───────────
create or replace function public.upsert_scheduling_settings(p_payload jsonb)
returns public.scheduling_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_week_start date := (p_payload->>'week_start')::date;
  v_tb text := lower(coalesce(nullif(trim(p_payload->>'preference_tiebreaker'), ''), 'least_loaded'));
  v_row public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_tb not in ('least_loaded','seniority','fairness') then v_tb := 'least_loaded'; end if;

  insert into public.scheduling_settings
    (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week,
     waves, timezone, allow_availability_override, report_lead_minutes, preference_tiebreaker)
  values
    (v_dsp,
     v_week_start,
     coalesce((p_payload->>'default_block_hours')::int, 10),
     coalesce((p_payload->>'cushion_pct')::numeric, 10),
     coalesce((p_payload->>'max_days_per_week')::int, 5),
     coalesce(p_payload->'waves', jsonb_build_array(jsonb_build_object('start','07:00'))),
     coalesce(p_payload->>'timezone', 'UTC'),
     coalesce((p_payload->>'allow_availability_override')::boolean, false),
     greatest(0, least(120, coalesce((p_payload->>'report_lead_minutes')::int, 0))),
     v_tb)
  on conflict (dsp_id, week_start) do update
    set default_block_hours          = excluded.default_block_hours,
        cushion_pct                  = excluded.cushion_pct,
        max_days_per_week            = excluded.max_days_per_week,
        waves                        = excluded.waves,
        timezone                     = excluded.timezone,
        allow_availability_override  = excluded.allow_availability_override,
        report_lead_minutes          = excluded.report_lead_minutes,
        preference_tiebreaker        = excluded.preference_tiebreaker,
        updated_at                   = now()
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.upsert_scheduling_settings(jsonb) to authenticated;


-- ── scheduling_settings_for_week · surface preference_tiebreaker ────────
create or replace function public.scheduling_settings_for_week(p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_exact public.scheduling_settings;
  v_eff   public.scheduling_settings;
  v_inherited boolean;
begin
  v_eff := private.get_week_settings(v_dsp, p_week_start);
  select * into v_exact from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  v_inherited := not found;
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
    'is_inherited',                 v_inherited
  );
end;
$$;
grant execute on function public.scheduling_settings_for_week(date) to authenticated;

notify pgrst, 'reload schema';
