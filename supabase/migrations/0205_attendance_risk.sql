-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0205 · Attendance risk scoring
--
-- Returns a per-driver attendance-risk signal computed from the last
-- N days of shifts. Powers the "high no-show risk" badge surfaced on
-- Today's Plan's daily-attendance tool and on Cover-candidate rows.
-- Pure read RPC; no new tables.
--
-- Risk model (intentionally simple — the dispatcher doesn't want a
-- mystery score, they want an honest count):
--   incidents  = shifts in the window with status in
--                ('no_show', 'called_off', 'late')
--   total      = shifts scheduled in the window where the date <= today
--                (so we don't penalize drivers for shifts that haven't
--                happened yet)
--   rate       = incidents / total when total > 0, else null
--   label      = high     when rate >= 0.15
--                moderate when rate >= 0.07
--                low      otherwise
--
-- "high" and "moderate" surface as a quiet pill in the UI; "low" /
-- unknown render nothing so the surface stays calm.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.attendance_risk_all(p_days_back int default 90)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_since date := (current_date - greatest(coalesce(p_days_back, 90), 7) * interval '1 day')::date;
  v_rows  jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  with windowed as (
    select
      s.driver_id,
      count(*) filter (where s.date <= current_date)              as total_in_window,
      count(*) filter (where s.status = 'no_show')                as no_show,
      count(*) filter (where s.status = 'called_off')             as called_off,
      count(*) filter (where s.status = 'late')                   as late
    from public.shifts s
    where s.dsp_id    = v_dsp
      and s.driver_id is not null
      and s.date     >= v_since
      and s.date     <= current_date
    group by s.driver_id
  ),
  scored as (
    select
      w.driver_id,
      w.total_in_window,
      w.no_show,
      w.called_off,
      w.late,
      (w.no_show + w.called_off + w.late) as incidents,
      case when w.total_in_window > 0
           then round(((w.no_show + w.called_off + w.late)::numeric
                       / w.total_in_window) * 100, 1)
           else null end as rate_pct
    from windowed w
  )
  select coalesce(jsonb_object_agg(
           s.driver_id,
           jsonb_build_object(
             'incidents',   s.incidents,
             'no_show',     s.no_show,
             'called_off',  s.called_off,
             'late',        s.late,
             'total',       s.total_in_window,
             'rate_pct',    s.rate_pct,
             'label',       case
                              when s.rate_pct is null         then 'unknown'
                              when s.rate_pct >= 15           then 'high'
                              when s.rate_pct >=  7           then 'moderate'
                              else                                'low'
                            end
           )
         ), '{}'::jsonb)
    into v_rows
  from scored s
  where s.incidents > 0;   -- skip drivers with a clean record

  return jsonb_build_object(
    'days_back', greatest(coalesce(p_days_back, 90), 7),
    'since',     v_since,
    'drivers',   v_rows
  );
end;
$$;
grant execute on function public.attendance_risk_all(int) to authenticated;

notify pgrst, 'reload schema';
