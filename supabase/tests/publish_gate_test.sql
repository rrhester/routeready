-- supabase/tests/publish_gate_test.sql
--
-- Server-side regression test for migration 0542 (draft/publish gate on the
-- driver schedule feed). Runs against a fully-migrated DB (migration-check.yml).
--
-- What it proves:
--   • default (flag off): driver_my_schedule returns every assigned shift —
--     byte-identical to before 0542 (no existing driver's schedule vanishes);
--   • flag on (require_finalized_for_drivers): a shift is returned only when
--     its week is finalized; draft weeks stay hidden;
--   • finalizing a previously-draft week makes its shift appear.
--
-- Run locally from the repo root against any migrated DB:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/publish_gate_test.sql
--
-- One transaction, rolled back at the end — no residue.

\set ON_ERROR_STOP on

begin;

set local session_replication_role = replica;  -- skip FK-to-auth + triggers

insert into public.dsps (id, name, short_code, slug) values
  ('f0000000-0000-4000-8000-000000000001', 'Publish Gate DSP', 'PGATE', 'publish-gate');
insert into public.stations (id, dsp_id, code, name, active) values
  ('f0000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000001', 'PG1', 'PG Station', true);
insert into public.drivers (id, dsp_id, full_name, status) values
  ('f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000001', 'Dana Driver', 'active');
insert into public.driver_sessions (token, dsp_id, driver_id) values
  ('pgate-tok', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000003');

-- This week finalized; next week still draft.
insert into public.scheduling_settings (dsp_id, week_start, finalized) values
  ('f0000000-0000-4000-8000-000000000001', private.week_start_for(current_date),     true),
  ('f0000000-0000-4000-8000-000000000001', private.week_start_for(current_date) + 7, false);

-- One shift in each week for Dana.
insert into public.shifts (dsp_id, station_id, driver_id, date, status) values
  ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
     'f0000000-0000-4000-8000-000000000003', private.week_start_for(current_date) + 1, 'scheduled'),
  ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
     'f0000000-0000-4000-8000-000000000003', private.week_start_for(current_date) + 8, 'scheduled');

do $$
declare r jsonb; n int;
begin
  -- Flag off (default) → both weeks visible.
  r := public.driver_my_schedule('pgate-tok', 2);
  n := jsonb_array_length(r->'shifts');
  assert n = 2, 'flag off: expected 2 shifts, got ' || n;

  -- Flag on → only the finalized week.
  update public.dsps
     set metadata = jsonb_set(coalesce(metadata,'{}'::jsonb), '{scheduling}',
       '{"require_finalized_for_drivers": true}'::jsonb, true)
   where id = 'f0000000-0000-4000-8000-000000000001';
  r := public.driver_my_schedule('pgate-tok', 2);
  n := jsonb_array_length(r->'shifts');
  assert n = 1, 'flag on: expected 1 (finalized only), got ' || n;
  assert (r->'shifts'->0->>'date')::date = private.week_start_for(current_date) + 1,
    'flag on: the visible shift must be the finalized-week one';

  -- Publish the draft week → it appears.
  update public.scheduling_settings set finalized = true
   where dsp_id = 'f0000000-0000-4000-8000-000000000001'
     and week_start = private.week_start_for(current_date) + 7;
  r := public.driver_my_schedule('pgate-tok', 2);
  n := jsonb_array_length(r->'shifts');
  assert n = 2, 'flag on after publishing week 2: expected 2, got ' || n;

  raise notice 'publish-gate assertions passed';
end $$;

rollback;
