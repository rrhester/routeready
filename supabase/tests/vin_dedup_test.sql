-- supabase/tests/vin_dedup_test.sql
--
-- Regression test for migration 0547 (BEFORE INSERT trigger preventing
-- duplicate vehicle VINs within a DSP). Runs against a fully-migrated DB.
--
-- Proves: exact and case/whitespace-variant duplicate VINs are blocked within
-- a DSP; the same VIN is allowed in a different DSP; blank/null VINs are
-- allowed in multiples; a unique VIN inserts fine.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/vin_dedup_test.sql
--
-- NOTE: does NOT set session_replication_role=replica — that would skip the
-- trigger under test. It only inserts into public.vehicles (dsp_id is the sole
-- FK touched) and rolls back, so no auth/trigger fixtures are needed.

\set ON_ERROR_STOP on

begin;

insert into public.dsps (id, name, short_code, slug) values
  ('d1de0000-0000-4000-8000-000000000001', 'VIN DSP 1', 'VIN1', 'vin1'),
  ('d1de0000-0000-4000-8000-000000000002', 'VIN DSP 2', 'VIN2', 'vin2');

do $$
declare
  d1 uuid := 'd1de0000-0000-4000-8000-000000000001';
  d2 uuid := 'd1de0000-0000-4000-8000-000000000002';
  dup boolean;
begin
  insert into public.vehicles (dsp_id, name, vin) values (d1, 'Van A', '1HGCM82633A004352');

  -- exact duplicate in the same DSP → blocked
  dup := false;
  begin
    insert into public.vehicles (dsp_id, name, vin) values (d1, 'Van A dup', '1HGCM82633A004352');
  exception when unique_violation then dup := true;
    when others then if sqlstate = '23505' then dup := true; end if;
  end;
  assert dup, 'exact duplicate VIN must be blocked within a DSP';

  -- case / whitespace variant → blocked
  dup := false;
  begin
    insert into public.vehicles (dsp_id, name, vin) values (d1, 'Van A messy', '  1hgcm82633a004352 ');
  exception when others then if sqlstate = '23505' then dup := true; end if;
  end;
  assert dup, 'case/whitespace-variant duplicate VIN must be blocked';

  -- same VIN, different DSP → allowed
  insert into public.vehicles (dsp_id, name, vin) values (d2, 'Van B', '1HGCM82633A004352');

  -- blank / null VINs → multiples allowed
  insert into public.vehicles (dsp_id, name, vin) values (d1, 'No VIN 1', null);
  insert into public.vehicles (dsp_id, name, vin) values (d1, 'No VIN 2', '   ');

  -- unique VIN → allowed
  insert into public.vehicles (dsp_id, name, vin) values (d1, 'Van C', '2HGCM82633A004353');

  raise notice 'vin-dedup: block exact + variant, allow cross-DSP + null + unique (correct)';
end $$;

rollback;
