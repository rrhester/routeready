-- 0386_effective_days_honor_null_effective_from.sql
--
-- Bug: Smart Fill ignored approved availability requests that have a
-- NULL effective_from (open-ended "effective now" requests), so a
-- driver whose current availability comes from such a request was
-- scheduled off their STALE metadata.availability.days default instead.
--
-- The driver Availability panel already honors these requests — it
-- treats a null effective_from as "effective from the beginning":
--   (!effective_from || effective_from <= today) && effective_until >= today
-- but the engine's driver_effective_days_on() required
-- `effective_from is not null`, so the panel and the engine disagreed:
-- the operator saw Mon-Fri (from the approved request) while Smart Fill
-- only used the old default (e.g. Tue-Wed-Thu) and left the driver
-- under-scheduled with open seats on days they were actually available.
--
-- Fix: honor approved requests with a null effective_from (treat as
-- "already started"), matching the panel. Dated requests still win over
-- open-ended ones, then the most recently decided request breaks ties,
-- so behavior is deterministic. Fallback to metadata is unchanged.
--
-- Idempotent (create or replace).

create or replace function public.driver_effective_days_on(
  p_driver_id uuid,
  p_date      date
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days text[];
begin
  -- Latest approved request in effect on p_date. A null effective_from
  -- means "effective immediately" (matches the Availability panel); a
  -- null effective_until means "open-ended". Dated starts sort ahead of
  -- null starts; decided_at breaks remaining ties.
  select r.days into v_days
    from public.driver_availability_requests r
   where r.driver_id      = p_driver_id
     and r.status         = 'approved'
     and (r.effective_from is null or r.effective_from <= p_date)
     and (r.effective_until is null or r.effective_until >= p_date)
   order by r.effective_from desc nulls last,
            r.decided_at     desc nulls last
   limit 1;

  if v_days is not null then return v_days; end if;

  -- Fallback: legacy metadata.availability.days from before the
  -- approval workflow.
  select array(
    select jsonb_array_elements_text(d.metadata -> 'availability' -> 'days')
  ) into v_days
   from public.drivers d where d.id = p_driver_id;

  return coalesce(v_days, '{}'::text[]);
end;
$$;
grant execute on function public.driver_effective_days_on(uuid, date) to authenticated;

notify pgrst, 'reload schema';
