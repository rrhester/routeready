-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0448 · "Repeat forever" tasks — pg_cron top-up sweep
--
-- My Tasks (team_tasks, migration 0432) materializes one row per occurrence
-- and the create RPC caps a series at 60 rows. A "Repeat forever" task is
-- therefore seeded with 60 occurrences by the client, but with no top-up it
-- would quietly run dry (a daily forever task only reaches ~2 months out).
--
-- This adds a rolling-buffer top-up: every forever series carries its
-- recurrence rule in meta.recur (stamped by the client on create), and a
-- daily pg_cron sweep re-materializes future occurrences so each series
-- always keeps a healthy runway of upcoming rows. Count-limited repeats
-- never set meta.recur, so the sweep skips them.
--
--   • private.team_task_forever_next_dates(last, rule, count, floor)
--       Pure date generator — continues the cadence (daily/weekly/monthly/
--       quarterly/annually) from `last`, phase-preserving, returning up to
--       `count` dates that are strictly after `last` and on/after `floor`
--       (so a dormant series resumes in the future, not the past). Mirrors
--       the client's expansion in live.js _rrAddTaskFromForm.
--   • public.team_task_forever_topup_run(min, target)
--       For each forever series, if it has fewer than `min` future
--       occurrences, append enough to reach `target`. New rows inherit the
--       series' title/assignee/visibility/meta so they stay forever too.
--   • pg_cron 'team-task-forever-topup' — daily at 08:00 UTC.
--
-- Idempotent. Requires 0432 (team_tasks) and pg_cron (0000); degrades to a
-- notice if pg_cron isn't installed.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Pure date generator ───────────────────────────────────────────────────
-- rule = meta.recur, e.g. {"forever":true,"pattern":"weekly","dows":[1,3,5]}
-- or {"pattern":"monthly","step":1,"mode":"dom-15","dom":15} or
-- {"pattern":"monthly","mode":"nthdow","dow":2,"nth":3} or
-- {"pattern":"annually","month":6,"day":15}. Postgres extract(dow) is
-- 0=Sunday..6=Saturday, matching the client's JS getDay() values.
create or replace function private.team_task_forever_next_dates(
  p_last  date,
  p_rule  jsonb,
  p_count int,
  p_floor date
) returns date[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_pattern text := coalesce(p_rule->>'pattern', 'weekly');
  v_out   date[] := '{}';
  v_guard int := 0;
  v_d     date;
  v_cand  date;
  v_dows  int[];
  v_step  int;
  v_mode  text;
  v_dom   int;
  v_dow   int;
  v_nth   int;
  v_month int;
  v_day   int;
  v_y     int;
  v_m     int;
  v_k     int;
begin
  if p_count is null or p_count <= 0 or p_last is null then
    return '{}';
  end if;

  if v_pattern = 'daily' then
    v_d := p_last;
    while coalesce(array_length(v_out, 1), 0) < p_count and v_guard < 6000 loop
      v_guard := v_guard + 1;
      v_d := v_d + 1;
      if v_d >= p_floor then v_out := v_out || v_d; end if;
    end loop;

  elsif v_pattern = 'weekly' then
    select coalesce(array_agg((x)::int), '{}') into v_dows
      from jsonb_array_elements_text(coalesce(p_rule->'dows', '[]'::jsonb)) as x;
    if array_length(v_dows, 1) is null then
      v_dows := array[extract(dow from p_last)::int];
    end if;
    v_d := p_last;
    while coalesce(array_length(v_out, 1), 0) < p_count and v_guard < 6000 loop
      v_guard := v_guard + 1;
      v_d := v_d + 1;
      if extract(dow from v_d)::int = any(v_dows) and v_d >= p_floor then
        v_out := v_out || v_d;
      end if;
    end loop;

  elsif v_pattern in ('monthly', 'quarterly') then
    v_step := coalesce((p_rule->>'step')::int,
                       case when v_pattern = 'quarterly' then 3 else 1 end);
    v_mode := coalesce(p_rule->>'mode', 'dom-' || extract(day from p_last)::text);
    v_dow  := coalesce((p_rule->>'dow')::int, extract(dow from p_last)::int);
    v_nth  := coalesce((p_rule->>'nth')::int, ((extract(day from p_last)::int - 1) / 7) + 1);
    v_dom  := coalesce((p_rule->>'dom')::int, extract(day from p_last)::int);
    v_y := extract(year  from p_last)::int;
    v_m := extract(month from p_last)::int;   -- 1..12
    v_k := 0;
    while coalesce(array_length(v_out, 1), 0) < p_count and v_guard < 6000 loop
      v_guard := v_guard + 1;
      v_k := v_k + 1;
      declare
        v_tot   int  := (v_y * 12 + (v_m - 1)) + v_k * v_step;  -- month index
        v_ty    int  := v_tot / 12;
        v_tm    int  := (v_tot % 12) + 1;                       -- 1..12
        v_first date := make_date(v_ty, v_tm, 1);
        v_dim   int  := extract(day from (v_first + interval '1 month' - interval '1 day'))::int;
        v_last_dom date;
      begin
        if v_mode = 'lastdow' then
          v_last_dom := (v_first + interval '1 month' - interval '1 day')::date;
          v_cand := v_last_dom - (((extract(dow from v_last_dom)::int - v_dow) + 7) % 7);
        elsif v_mode = 'nthdow' then
          v_cand := v_first + (((v_dow - extract(dow from v_first)::int) + 7) % 7)
                            + (v_nth - 1) * 7;
          if extract(month from v_cand)::int <> v_tm then v_cand := null; end if;  -- no Nth weekday this month
        else  -- day-of-month
          v_cand := make_date(v_ty, v_tm, least(v_dom, v_dim));
        end if;
      end;
      if v_cand is not null and v_cand > p_last and v_cand >= p_floor then
        v_out := v_out || v_cand;
      end if;
    end loop;

  elsif v_pattern = 'annually' then
    v_month := coalesce((p_rule->>'month')::int, extract(month from p_last)::int);
    v_day   := coalesce((p_rule->>'day')::int,   extract(day   from p_last)::int);
    v_y := extract(year from p_last)::int;
    v_k := 0;
    while coalesce(array_length(v_out, 1), 0) < p_count and v_guard < 6000 loop
      v_guard := v_guard + 1;
      v_k := v_k + 1;
      declare
        v_ty  int := v_y + v_k;
        v_dim int := extract(day from (make_date(v_ty, v_month, 1)
                             + interval '1 month' - interval '1 day'))::int;
      begin
        v_cand := make_date(v_ty, v_month, least(v_day, v_dim));   -- Feb 29 clamps
      end;
      if v_cand > p_last and v_cand >= p_floor then
        v_out := v_out || v_cand;
      end if;
    end loop;
  end if;

  return v_out;
end;
$$;


-- ── Top-up sweep ──────────────────────────────────────────────────────────
-- Keeps every forever series at >= p_min future occurrences, refilling to
-- p_target when it drops below. Runs across all DSPs (no auth context under
-- cron); security definer bypasses RLS. Returns the number of rows created.
create or replace function public.team_task_forever_topup_run(
  p_min    int default 20,
  p_target int default 40
) returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today  date := (now() at time zone 'utc')::date;
  v_made   int := 0;
  v_rep    record;
  v_future int;
  v_last   date;
  v_need   int;
  v_dates  date[];
begin
  -- One representative row per forever series (latest created carries the
  -- current title/assignee/meta).
  for v_rep in
    select distinct on (t.dsp_id, t.series_key)
           t.dsp_id, t.series_key, t.title, t.assignee_user_id, t.created_by,
           t.visibility, t.repeat_label, t.meta
      from public.team_tasks t
     where t.series_key is not null
       and coalesce(t.meta->'recur'->>'forever', 'false') = 'true'
     order by t.dsp_id, t.series_key, t.created_at desc
  loop
    select count(*) filter (where due_date >= v_today), max(due_date)
      into v_future, v_last
      from public.team_tasks
     where dsp_id = v_rep.dsp_id and series_key = v_rep.series_key;

    if v_last is null then continue; end if;       -- series fully deleted between scan + count
    if v_future >= p_min then continue; end if;     -- still has runway

    v_need := p_target - v_future;
    if v_need <= 0 then continue; end if;

    v_dates := private.team_task_forever_next_dates(v_last, v_rep.meta->'recur', v_need, v_today);
    if v_dates is null or array_length(v_dates, 1) is null then continue; end if;

    insert into public.team_tasks
        (dsp_id, title, due_date, assignee_user_id, created_by, visibility,
         series_key, repeat_label, meta)
    select v_rep.dsp_id, v_rep.title, d, v_rep.assignee_user_id, v_rep.created_by,
           v_rep.visibility, v_rep.series_key, v_rep.repeat_label, v_rep.meta
      from unnest(v_dates) as d;

    v_made := v_made + coalesce(array_length(v_dates, 1), 0);
  end loop;

  return v_made;
end;
$$;

grant execute on function public.team_task_forever_topup_run(int, int) to service_role;


-- ── Schedule · daily at 08:00 UTC ─────────────────────────────────────────
-- Wrapped so the migration still applies on hosts without pg_cron.
do $$
begin
  begin
    perform cron.unschedule('team-task-forever-topup');
  exception when others then null;   -- job didn't exist yet
  end;
  perform cron.schedule(
    'team-task-forever-topup',
    '0 8 * * *',
    $cron$ select public.team_task_forever_topup_run(); $cron$
  );
exception when undefined_function or undefined_table or insufficient_privilege then
  raise notice 'pg_cron not available — wire your own scheduler to call public.team_task_forever_topup_run() daily';
end $$;


notify pgrst, 'reload schema';
