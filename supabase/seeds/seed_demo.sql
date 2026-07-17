-- ───────────────────────────────────────────────────────────────────────
-- seed_demo.sql · Demo tenant for local development (project-review PR#55)
--
-- A local `supabase db start` + migrations gives an EMPTY database — every
-- e2e/verify flow had to fabricate its own data. This seeds one demo DSP
-- with drivers, a week of shifts around today, and a few pipeline
-- applicants. Idempotent (fixed UUIDs + on conflict do nothing) and safe
-- to re-run. NEVER run against production — guarded by refusing to run
-- when any real dsps row already exists unless FORCE_DEMO_SEED is set.
--
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/seeds/seed_demo.sql
-- ───────────────────────────────────────────────────────────────────────

do $$
declare
  v_dsp uuid := '00000000-0000-4000-8000-00000000d590';
  v_station uuid := '00000000-0000-4000-8000-00000000517a';
  v_names text[] := array[
    'Avery Brooks','Jordan Lane','Sam Whitfield','Riley Chen','Casey Morgan',
    'Drew Patel','Alex Rivera','Quinn Harper','Jamie Ford','Taylor Brooks'
  ];
  v_driver uuid;
  v_day date;
  v_status text;
  i int; d int;
begin
  if current_setting('app.force_demo_seed', true) is null
     and exists (select 1 from public.dsps where id <> v_dsp) then
    raise notice 'seed_demo: real tenant data present — refusing to seed (set app.force_demo_seed to override)';
    return;
  end if;

  insert into public.dsps (id, name, timezone, metadata)
  values (v_dsp, 'Demo Logistics LLC', 'America/Chicago',
          jsonb_build_object('demo', true, 'short_code', 'demo'))
  on conflict (id) do nothing;

  begin
    insert into public.stations (id, dsp_id, code, name)
    values (v_station, v_dsp, 'DDX9', 'Demo Station DDX9')
    on conflict (id) do nothing;
  exception when undefined_table or undefined_column then null;
  end;

  for i in 1..array_length(v_names, 1) loop
    v_driver := ('00000000-0000-4000-8000-0000000000' || lpad(i::text, 2, '0'))::uuid;
    insert into public.drivers (id, dsp_id, full_name, first_name, last_name, email, phone, status, hire_date)
    values (
      v_driver, v_dsp, v_names[i],
      split_part(v_names[i], ' ', 1), split_part(v_names[i], ' ', 2),
      lower(replace(v_names[i], ' ', '.')) || '@demo.example',
      '+1555000' || lpad((1000 + i)::text, 4, '0'),
      'active', current_date - (180 + i * 7)
    )
    on conflict (id) do nothing;

    -- A week of shifts around today: past days completed (with the odd
    -- late/no_show for attendance math), today scheduled, future open.
    for d in -5..2 loop
      v_day := current_date + d;
      v_status := case
        when d < 0 and i = 3 and d = -2 then 'no_show'
        when d < 0 and i = 5 and d = -1 then 'late'
        when d < 0 then 'completed'
        else 'scheduled'
      end;
      begin
        insert into public.shifts (dsp_id, driver_id, date, status, start_time, end_time)
        values (v_dsp, v_driver, v_day, v_status, '09:00', '19:00')
        on conflict do nothing;
      exception when undefined_column or check_violation or invalid_text_representation then
        -- Column set / status enum varies across migration eras; a demo
        -- seed must never block a local boot over shape drift.
        null;
      end;
    end loop;
  end loop;

  -- Pipeline applicants at a few stages.
  begin
    insert into public.applicants (id, dsp_id, full_name, first_name, last_name, email, phone, status)
    values
      ('00000000-0000-4000-8000-000000000a01', v_dsp, 'Morgan Reyes', 'Morgan', 'Reyes', 'morgan.reyes@demo.example', '+15550002001', 'applied'),
      ('00000000-0000-4000-8000-000000000a02', v_dsp, 'Skyler Nash',  'Skyler', 'Nash',  'skyler.nash@demo.example',  '+15550002002', 'contacted'),
      ('00000000-0000-4000-8000-000000000a03', v_dsp, 'Devon Cole',   'Devon',  'Cole',  'devon.cole@demo.example',   '+15550002003', 'interview_scheduled')
    on conflict (id) do nothing;
  exception when undefined_column or check_violation or invalid_text_representation then null;
  end;

  raise notice 'seed_demo: demo tenant ready (dsp %)', v_dsp;
end $$;
