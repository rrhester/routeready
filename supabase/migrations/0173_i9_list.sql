-- Migration 0173 · Form I-9 — slice 4 helper: i9_list (compliance queue)
--
-- One row per non-terminated driver in the DSP, left-joined to their
-- i9_records row so the dashboard's "Work Authorization" sub-tab can
-- show the whole picture — including employees who don't yet have an
-- I-9 record at all. The 3-business-day Section-2 clock and the
-- bucketing are computed client-side (it already needs the federal-
-- holiday calendar there); this just hands over the raw fields.

create or replace function public.i9_list()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',                d.id,
    'driver_name',              coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
    'driver_status',            d.status,
    'hire_date',                d.hire_date,
    'station_code',             s.code,
    'i9_id',                    r.id,
    'status',                   coalesce(r.status, 'no_record'),
    'first_day_of_employment',  r.first_day_of_employment,
    'section1_completed_at',    r.section1_completed_at,
    'section1_completed_via',   r.section1_completed_via,
    'section1_auth_expires',    r.section1->>'auth_expires',
    'section1_citizen_status',  r.section1->>'citizen_status',
    'section2_completed_at',    r.section2_completed_at,
    'section2_completed_by_name', r.section2_completed_by_name,
    'needs_correction_note',    r.needs_correction_note,
    'updated_at',               r.updated_at
  ) order by d.hire_date desc nulls last, d.full_name), '[]'::jsonb)
  into v_rows
  from public.drivers d
  left join public.stations s    on s.id = d.station_id
  left join public.i9_records r  on r.driver_id = d.id and r.dsp_id = v_dsp
  where d.dsp_id = v_dsp and d.status <> 'terminated';
  return v_rows;
end;
$$;
grant execute on function public.i9_list() to authenticated;

notify pgrst, 'reload schema';
