-- Migration 0291 · recognition_upcoming · fix double-precision modulo
--
-- The original 0290 leap-year branch used:
--   date_part('year', make_date(...)) % 4 = 0
-- date_part returns double precision and Postgres has no `double precision
-- % integer` operator → the function failed to compile on first run with
-- "operator does not exist: double precision % integer".
--
-- We don't actually need leap-year math.  Feb-29 birthdays / hire-dates
-- get celebrated on Feb-28 every year — clean, universal, no edge cases.
-- This rewrite simplifies the whole CTE accordingly.
--
-- Safe to re-run on a DB where 0290 partially applied: the function is
-- CREATE OR REPLACE, and the table from 0290 (driver_recognitions) is
-- untouched here.  If 0290 rolled back entirely and the table doesn't
-- exist, run 0290 again first — that's all the table + index DDL and
-- now-unrelated RPCs land just fine; only the function body needed
-- this fix.

create or replace function public.recognition_upcoming(p_days int default 30)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with today as (
    select current_date as d
  ),
  -- Compute the next occurrence of a MM-DD anchor (birthday or hire
  -- anniversary).  Feb-29 anchors fall back to Feb-28 every year so we
  -- never have to worry about leap-year arithmetic.
  base as (
    select
      d.id            as driver_id,
      coalesce(nullif(trim(d.preferred_name), ''),
               nullif(trim(d.full_name), ''),
               'Driver') as name,
      d.photo_path,
      d.birthday,
      d.hire_date,
      (select d from today) as today_d
    from public.drivers d
    where d.dsp_id = private.current_dsp_id()
      and d.status = 'active'
      and private.is_staff(d.dsp_id, 'dispatcher')
  ),
  -- Helper: for any (anchor) date column, project the next occurrence
  -- by combining the candidate year (this year if MM-DD still upcoming,
  -- else next year) with the anchor's MM-DD.  Feb-29 clamps to Feb-28.
  birthdays as (
    select
      b.driver_id, b.name, b.photo_path,
      'birthday'::text as kind,
      (
        select case
          when m = 2 and dy = 29 then
            -- Feb 29 → always Feb 28 of the candidate year.
            make_date(y, 2, 28)
          else
            make_date(y, m, dy)
        end
        from (
          select
            extract(month from b.birthday)::int as m,
            extract(day   from b.birthday)::int as dy,
            case
              when make_date(
                     extract(year from b.today_d)::int,
                     extract(month from b.birthday)::int,
                     least(extract(day from b.birthday)::int, 28)
                   ) >= b.today_d
                then extract(year from b.today_d)::int
              else extract(year from b.today_d)::int + 1
            end as y
        ) parts
      ) as occurs_on,
      null::int as years
    from base b
    where b.birthday is not null
  ),
  anniversaries as (
    select
      b.driver_id, b.name, b.photo_path,
      'work_anniversary'::text as kind,
      (
        select case
          when m = 2 and dy = 29 then make_date(y, 2, 28)
          else make_date(y, m, dy)
        end
        from (
          select
            extract(month from b.hire_date)::int as m,
            extract(day   from b.hire_date)::int as dy,
            case
              when make_date(
                     extract(year from b.today_d)::int,
                     extract(month from b.hire_date)::int,
                     least(extract(day from b.hire_date)::int, 28)
                   ) >= b.today_d
                then extract(year from b.today_d)::int
              else extract(year from b.today_d)::int + 1
            end as y
        ) parts
      ) as occurs_on,
      -- Years served on that next occurrence — used by the UI to render
      -- "5-year anniversary" pills.  Filtered out below if < 1.
      (
        case
          when make_date(
                 extract(year from b.today_d)::int,
                 extract(month from b.hire_date)::int,
                 least(extract(day from b.hire_date)::int, 28)
               ) >= b.today_d
            then extract(year from b.today_d)::int
          else extract(year from b.today_d)::int + 1
        end - extract(year from b.hire_date)::int
      )::int as years
    from base b
    where b.hire_date is not null
  ),
  combined as (
    select * from birthdays where occurs_on is not null
    union all
    select * from anniversaries where occurs_on is not null and years >= 1
  ),
  windowed as (
    select c.*
    from combined c, today t
    where c.occurs_on between t.d and (t.d + (p_days || ' days')::interval)::date
  ),
  decorated as (
    select
      w.*,
      exists (
        select 1 from public.driver_recognitions r
        where r.driver_id = w.driver_id
          and r.kind = w.kind
          and r.status in ('sent','scheduled')
          and r.occasion_on is not null
          and extract(year from r.occasion_on) = extract(year from w.occurs_on)
      ) as already_sent
    from windowed w
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'driver_id',     driver_id,
    'name',          name,
    'photo_path',    photo_path,
    'kind',          kind,
    'occurs_on',     occurs_on,
    'days_away',     (occurs_on - current_date)::int,
    'years',         years,
    'already_sent',  already_sent
  ) order by occurs_on asc, name asc), '[]'::jsonb)
  from decorated;
$$;
grant execute on function public.recognition_upcoming(int) to authenticated;

notify pgrst, 'reload schema';
