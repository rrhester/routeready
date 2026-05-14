-- Migration 0234 · One primary + one backup slot per driver, DSP-wide.
--
-- New rules for vehicle_driver_assignments:
--
--   1. A driver can be primary (rank = 0) on at most ONE van across
--      the whole DSP.
--   2. A driver can be backup (rank = 1) on at most ONE van across
--      the whole DSP.
--   3. The same driver CAN be both primary and backup on the SAME
--      van.  (Old schema blocked this via `unique (vehicle_id,
--      driver_id)`; we drop that constraint here.)
--
-- We also pre-validate inside vehicle_assignment_set so the dispatcher
-- gets a useful error message ("Sarah is already primary of 4271 —
-- remove her there first") instead of a raw constraint violation.
--
-- Idempotent · safe to re-run.


-- ── 1. De-dupe existing data per (driver_id, rank) ──────────────────
-- If any driver currently holds the same rank on multiple vans, keep
-- the most recently updated row and delete the rest.  This makes the
-- partial unique indexes below installable on a live DB.
with ranked as (
  select id,
         row_number() over (
           partition by dsp_id, driver_id, rank
           order by updated_at desc, created_at desc, id desc
         ) as rn
    from public.vehicle_driver_assignments
)
delete from public.vehicle_driver_assignments a
 using ranked r
 where a.id = r.id and r.rn > 1;


-- ── 2. Drop the legacy (vehicle_id, driver_id) uniqueness ───────────
-- This is what previously blocked the same driver from being both
-- primary and backup on the same van.  We now allow that case.
do $$
declare
  c_name text;
begin
  select conname into c_name
    from pg_constraint
   where conrelid = 'public.vehicle_driver_assignments'::regclass
     and contype  = 'u'
     and pg_get_constraintdef(oid) ilike '%(vehicle_id, driver_id)%';
  if c_name is not null then
    execute format('alter table public.vehicle_driver_assignments drop constraint %I', c_name);
  end if;
end $$;


-- ── 3. Per-rank partial unique indexes (DSP-wide) ───────────────────
-- One primary slot per driver, one backup slot per driver.
create unique index if not exists vehicle_driver_assignments_primary_unique_idx
  on public.vehicle_driver_assignments (dsp_id, driver_id)
  where rank = 0;

create unique index if not exists vehicle_driver_assignments_backup_unique_idx
  on public.vehicle_driver_assignments (dsp_id, driver_id)
  where rank = 1;


-- ── 4. vehicle_assignment_set — pre-validate + clean errors ─────────
-- p_driver_ids is the new chain for p_vehicle_id, position 0 = primary,
-- position 1 = backup.  Before we wipe and re-insert, we check whether
-- any of those drivers already hold that rank on a different van and
-- raise a useful error that the UI can show verbatim.
create or replace function public.vehicle_assignment_set(
  p_vehicle_id uuid,
  p_driver_ids uuid[]
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id uuid;
  v_rank int := 0;
  v_other_vehicle text;
  v_driver_name text;
  v_role text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp
  ) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  -- Pre-validation pass.  We use the same index position → rank mapping
  -- the existing RPC uses (0 = primary, 1 = backup), and only check
  -- the first two slots because rank > 1 isn't surfaced anywhere yet.
  for v_rank in 0 .. least(array_length(coalesce(p_driver_ids, '{}'::uuid[]), 1), 2) - 1 loop
    v_id := p_driver_ids[v_rank + 1];
    if v_id is null then continue; end if;

    select coalesce(nullif(trim(v.nickname), ''), v.name)
      into v_other_vehicle
      from public.vehicle_driver_assignments a
      join public.vehicles v on v.id = a.vehicle_id
     where a.dsp_id = v_dsp
       and a.driver_id = v_id
       and a.rank = v_rank
       and a.vehicle_id <> p_vehicle_id
     limit 1;

    if v_other_vehicle is not null then
      select coalesce(nullif(trim(d.preferred_name), ''), nullif(trim(d.full_name), ''), 'That driver')
        into v_driver_name
        from public.drivers d
       where d.id = v_id;
      v_role := case when v_rank = 0 then 'primary' else 'backup' end;
      raise exception
        '% is already % of %. Remove them there first.',
        v_driver_name, v_role, v_other_vehicle
        using errcode = 'P0001';
    end if;
  end loop;

  -- Wipe + rewrite.  unique (vehicle_id, rank) still prevents two
  -- drivers at the same rank on this van; the partial uniques on
  -- (dsp_id, driver_id) where rank in (0,1) prevent cross-van
  -- duplicates if the pre-check above misses something (defense in
  -- depth).
  delete from public.vehicle_driver_assignments where vehicle_id = p_vehicle_id;

  v_rank := 0;
  foreach v_id in array coalesce(p_driver_ids, '{}'::uuid[]) loop
    if v_id is not null
       and exists (select 1 from public.drivers d where d.id = v_id and d.dsp_id = v_dsp)
    then
      insert into public.vehicle_driver_assignments (dsp_id, vehicle_id, driver_id, rank)
      values (v_dsp, p_vehicle_id, v_id, v_rank);
    end if;
    v_rank := v_rank + 1;
  end loop;
end;
$$;
grant execute on function public.vehicle_assignment_set(uuid, uuid[]) to authenticated;

notify pgrst, 'reload schema';
