-- 0387_effective_days_match_panel_override_rule.sql
--
-- Bug: the engine scheduled drivers on a NARROWER day-set than their
-- profile/Availability panel showed, leaving open seats on days the
-- operator believed the driver was available.
--
-- Root cause: the Availability panel and the engine disagreed on when an
-- approved availability request counts as the "active override":
--
--   Panel (live.js activeOverride):
--     (effective_from is null OR effective_from <= today)
--     AND effective_until IS NOT NULL AND effective_until >= today
--
--   Engine RPC (driver_effective_days_on, prior):
--     (effective_from is null OR effective_from <= date)
--     AND (effective_until IS NULL OR effective_until >= date)   ← diverges
--
-- So an APPROVED request with a NULL effective_until (open-ended) was
-- applied by the engine but IGNORED by the panel. If that request had a
-- narrower day-set than drivers.metadata.availability.days, the engine
-- under-scheduled the driver while the panel/card still showed the full
-- profile availability — the "available 6 days but engine only used 3,
-- open seats on the other days" defect.
--
-- Fix: make the RPC's active-override test identical to the panel's, so
-- the engine honors exactly the availability the operator sees. An
-- open-ended (null effective_until) approved request is no longer treated
-- as a standing override here — the driver's profile availability wins.
--
-- Pairs with 0386 (which aligned the effective_from / null-start half of
-- this rule). Idempotent (create or replace).

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
  -- Active override == the panel's rule: started (or open start) AND has
  -- a real end date still in the future. Dated starts sort ahead of null
  -- starts; decided_at breaks remaining ties.
  select r.days into v_days
    from public.driver_availability_requests r
   where r.driver_id      = p_driver_id
     and r.status         = 'approved'
     and (r.effective_from is null or r.effective_from <= p_date)
     and r.effective_until is not null
     and r.effective_until >= p_date
   order by r.effective_from desc nulls last,
            r.decided_at     desc nulls last
   limit 1;

  if v_days is not null then return v_days; end if;

  -- Fallback: the driver's profile availability (what the panel shows
  -- when there's no active override).
  select array(
    select jsonb_array_elements_text(d.metadata -> 'availability' -> 'days')
  ) into v_days
   from public.drivers d where d.id = p_driver_id;

  return coalesce(v_days, '{}'::text[]);
end;
$$;
grant execute on function public.driver_effective_days_on(uuid, date) to authenticated;

notify pgrst, 'reload schema';
