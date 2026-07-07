-- Migration 0296 · Recognition · DSP settings + daily auto-fire
--
-- PR B of the celebration system.  Builds on 0290 (driver_recognitions
-- + recognition_send) and 0295 (27-kind whitelist) by adding:
--
--   1. dsp_recognition_settings — per-DSP, per-kind enable / customize
--      table.  Opt-in: nothing fires until a dispatcher flips a toggle.
--   2. private.recognition_holiday_kinds_on(date) — returns the
--      holiday_* kinds (if any) that fall on a given calendar date.
--      Covers all 17 holidays, including Easter (Meeus/Jones/Butcher),
--      Nth-weekday rules, and last-weekday rules.
--   3. recognition_settings_list() — returns one row per kind (27 total)
--      merged with the DSP's settings + the system default title/message.
--   4. recognition_settings_set(...) — upsert one kind's settings.
--   5. recognition_autofire(p_date) — the scheduled engine.  For each
--      enabled (DSP, kind) pair matching today, inserts birthday /
--      anniversary / holiday recognitions for active drivers.  Safely
--      re-runnable on the same day (idempotent on
--      (driver_id, kind, occasion_on)).
--   6. pg_cron schedule at 13:00 UTC daily (9am EDT / 6am PDT).
--
-- All idempotent: CREATE TABLE IF NOT EXISTS, CREATE OR REPLACE FUNCTION,
-- DROP POLICY IF EXISTS, cron schedule wrapped in DO block so missing
-- pg_cron doesn't fail the migration.


-- ── 1. dsp_recognition_settings table ───────────────────────────────
create table if not exists public.dsp_recognition_settings (
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  kind            text not null,
  enabled         boolean not null default false,
  custom_title    text,
  custom_message  text,
  -- 'all_active' = every active driver in the DSP.  Future: 'on_shift_only'.
  recipient_scope text not null default 'all_active',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (dsp_id, kind)
);

alter table public.dsp_recognition_settings enable row level security;

drop policy if exists "dsp_recognition_settings_rw" on public.dsp_recognition_settings;
create policy "dsp_recognition_settings_rw" on public.dsp_recognition_settings
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.dsp_recognition_settings to authenticated;


-- ── 2. Holiday date catalog ─────────────────────────────────────────
-- private.recognition_holiday_kinds_on(date) returns the array of
-- holiday_* kind names matching that calendar date.  Implements:
--   • 10 fixed-date holidays
--   • 6 Nth-weekday-of-month holidays
--   • 1 last-weekday-of-month (Memorial Day)
--   • Easter via Meeus/Jones/Butcher Gregorian algorithm (arithmetic
--     only — no extension needed).
--
-- DOW convention (PG extract): 0=Sunday … 6=Saturday.

-- Easter helper.  Returns the Gregorian Easter date for the given year.
-- Reference: Jean Meeus, "Astronomical Algorithms", 1991 (Anonymous
-- Gregorian algorithm).  Verified: easter(2026)=2026-04-05,
-- easter(2027)=2027-03-28, easter(2024)=2024-03-31.
create or replace function private.recognition_easter(p_year int)
returns date
language plpgsql immutable set search_path = ''
as $$
declare
  a int; b int; c int; d int; e int; f int; g int; h int; i int;
  k int; l int; m int; n int; o int;
  v_month int; v_day int;
begin
  a := p_year % 19;
  b := p_year / 100;
  c := p_year % 100;
  d := b / 4;
  e := b % 4;
  f := (b + 8) / 25;
  g := (b - f + 1) / 3;
  h := (19 * a + b - d - g + 15) % 30;
  i := c / 4;
  k := c % 4;
  l := (32 + 2 * e + 2 * i - h - k) % 7;
  m := (a + 11 * h + 22 * l) / 451;
  n := (h + l - 7 * m + 114) / 31;   -- month
  o := (h + l - 7 * m + 114) % 31;   -- day - 1
  v_month := n;
  v_day := o + 1;
  return make_date(p_year, v_month, v_day);
end;
$$;

-- Nth (1..5) weekday-of-month helper.  p_dow: 0=Sun … 6=Sat.
create or replace function private.recognition_nth_weekday(
  p_year int, p_month int, p_dow int, p_n int
) returns date
language plpgsql immutable set search_path = ''
as $$
declare
  v_first date := make_date(p_year, p_month, 1);
  v_first_dow int := extract(dow from v_first)::int;
  v_offset int;
begin
  v_offset := (p_dow - v_first_dow + 7) % 7;
  return v_first + (v_offset + (p_n - 1) * 7);
end;
$$;

-- Last weekday-of-month helper.
create or replace function private.recognition_last_weekday(
  p_year int, p_month int, p_dow int
) returns date
language plpgsql immutable set search_path = ''
as $$
declare
  -- last day of month
  v_last date := (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day')::date;
  v_last_dow int := extract(dow from v_last)::int;
  v_offset int;
begin
  v_offset := (v_last_dow - p_dow + 7) % 7;
  return v_last - v_offset;
end;
$$;

-- Return holiday_* kinds matching a date.  Bug-tolerant: returns an
-- empty array (never null) when no holiday matches.
create or replace function private.recognition_holiday_kinds_on(p_date date)
returns text[]
language plpgsql immutable set search_path = ''
as $$
declare
  v_year  int := extract(year  from p_date)::int;
  v_month int := extract(month from p_date)::int;
  v_day   int := extract(day   from p_date)::int;
  v_out   text[] := '{}';
begin
  -- Fixed-date holidays
  if v_month = 1  and v_day = 1  then v_out := v_out || 'holiday_new_years_day';    end if;
  if v_month = 2  and v_day = 14 then v_out := v_out || 'holiday_valentines_day';   end if;
  if v_month = 3  and v_day = 17 then v_out := v_out || 'holiday_st_patricks_day';  end if;
  if v_month = 6  and v_day = 19 then v_out := v_out || 'holiday_juneteenth';       end if;
  if v_month = 7  and v_day = 4  then v_out := v_out || 'holiday_independence_day'; end if;
  if v_month = 10 and v_day = 31 then v_out := v_out || 'holiday_halloween';        end if;
  if v_month = 11 and v_day = 11 then v_out := v_out || 'holiday_veterans_day';     end if;
  if v_month = 12 and v_day = 25 then v_out := v_out || 'holiday_christmas';        end if;

  -- Nth-weekday-of-month
  if v_month = 1  and p_date = private.recognition_nth_weekday(v_year, 1,  1, 3) then
    v_out := v_out || 'holiday_mlk_day';
  end if;
  if v_month = 2  and p_date = private.recognition_nth_weekday(v_year, 2,  1, 3) then
    v_out := v_out || 'holiday_presidents_day';
  end if;
  if v_month = 5  and p_date = private.recognition_nth_weekday(v_year, 5,  0, 2) then
    v_out := v_out || 'holiday_mothers_day';
  end if;
  if v_month = 6  and p_date = private.recognition_nth_weekday(v_year, 6,  0, 3) then
    v_out := v_out || 'holiday_fathers_day';
  end if;
  if v_month = 9  and p_date = private.recognition_nth_weekday(v_year, 9,  1, 1) then
    v_out := v_out || 'holiday_labor_day';
  end if;
  if v_month = 10 and p_date = private.recognition_nth_weekday(v_year, 10, 1, 2) then
    v_out := v_out || 'holiday_indigenous_peoples_day';
  end if;
  if v_month = 11 and p_date = private.recognition_nth_weekday(v_year, 11, 4, 4) then
    v_out := v_out || 'holiday_thanksgiving';
  end if;

  -- Last-weekday-of-month
  if v_month = 5  and p_date = private.recognition_last_weekday(v_year, 5, 1) then
    v_out := v_out || 'holiday_memorial_day';
  end if;

  -- Easter (Sunday — variable date)
  if p_date = private.recognition_easter(v_year) then
    v_out := v_out || 'holiday_easter';
  end if;

  return v_out;
end;
$$;


-- ── 3. recognition_settings_list ────────────────────────────────────
-- Returns the merged settings list for the caller's DSP: every one of
-- the 27 kinds is present, even those the DSP has never touched
-- (enabled=false, customs=null).  default_title / default_message
-- mirror what recognition_send would generate when called with NULL
-- title / message — keeps the UI in sync with server-side defaults
-- without hard-coding strings on the client.
create or replace function public.recognition_settings_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    with kinds(kind, default_title, default_message) as (
      values
        -- Core (5)
        ('birthday',                          'Happy birthday!',                 null),
        ('work_anniversary',                  'Happy work anniversary!',         null),
        ('safety_milestone',                  'Safety milestone',                null),
        ('welcome_to_team',                   'Welcome to the Team',             null),
        ('custom',                            'A note from your team',           null),
        -- Baby (3)
        ('baby_boy',                          'It''s a Boy!',                    null),
        ('baby_girl',                         'It''s a Girl!',                   null),
        ('baby_expecting',                    'Congratulations!',                null),
        -- Holidays (17)
        ('holiday_new_years_day',             'Happy New Year!',                 null),
        ('holiday_mlk_day',                   'Honoring Dr. King',               null),
        ('holiday_valentines_day',            'Happy Valentine''s Day!',         null),
        ('holiday_presidents_day',            'Happy Presidents'' Day',          null),
        ('holiday_st_patricks_day',           'Happy St. Patrick''s Day!',       null),
        ('holiday_easter',                    'Happy Easter!',                   null),
        ('holiday_mothers_day',               'Happy Mother''s Day!',            null),
        ('holiday_memorial_day',              'Memorial Day',                    null),
        ('holiday_juneteenth',                'Happy Juneteenth!',               null),
        ('holiday_fathers_day',               'Happy Father''s Day!',            null),
        ('holiday_independence_day',          'Happy 4th of July!',              null),
        ('holiday_labor_day',                 'Happy Labor Day!',                null),
        ('holiday_indigenous_peoples_day',    'Indigenous Peoples'' Day',        null),
        ('holiday_halloween',                 'Happy Halloween!',                null),
        ('holiday_veterans_day',              'Thank You, Veterans',             null),
        ('holiday_thanksgiving',              'Happy Thanksgiving!',             null),
        ('holiday_christmas',                 'Merry Christmas!',                null)
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind',            k.kind,
      'enabled',         coalesce(s.enabled, false),
      'custom_title',    s.custom_title,
      'custom_message',  s.custom_message,
      'recipient_scope', coalesce(s.recipient_scope, 'all_active'),
      'default_title',   k.default_title,
      'default_message', k.default_message
    ) order by k.kind), '[]'::jsonb)
    from kinds k
    left join public.dsp_recognition_settings s
      on s.dsp_id = v_dsp and s.kind = k.kind
  );
end;
$$;
grant execute on function public.recognition_settings_list() to authenticated;


-- ── 4. recognition_settings_set ─────────────────────────────────────
create or replace function public.recognition_settings_set(
  p_kind            text,
  p_enabled         boolean,
  p_custom_title    text default null,
  p_custom_message  text default null,
  p_recipient_scope text default 'all_active'
) returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in (
    'birthday','work_anniversary','safety_milestone','welcome_to_team','custom',
    'baby_boy','baby_girl','baby_expecting',
    'holiday_new_years_day','holiday_mlk_day','holiday_valentines_day',
    'holiday_presidents_day','holiday_st_patricks_day','holiday_easter',
    'holiday_mothers_day','holiday_memorial_day','holiday_juneteenth',
    'holiday_fathers_day','holiday_independence_day','holiday_labor_day',
    'holiday_indigenous_peoples_day','holiday_halloween',
    'holiday_veterans_day','holiday_thanksgiving','holiday_christmas'
  ) then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if coalesce(p_recipient_scope, 'all_active') not in ('all_active','on_shift_only') then
    raise exception 'bad_recipient_scope' using errcode = '22023';
  end if;

  insert into public.dsp_recognition_settings as s
    (dsp_id, kind, enabled, custom_title, custom_message, recipient_scope, updated_at)
  values
    (v_dsp, p_kind, coalesce(p_enabled, false),
     nullif(trim(coalesce(p_custom_title, '')), ''),
     nullif(trim(coalesce(p_custom_message, '')), ''),
     coalesce(p_recipient_scope, 'all_active'),
     now())
  on conflict (dsp_id, kind) do update
    set enabled         = excluded.enabled,
        custom_title    = excluded.custom_title,
        custom_message  = excluded.custom_message,
        recipient_scope = excluded.recipient_scope,
        updated_at      = now();
end;
$$;
grant execute on function public.recognition_settings_set(text, boolean, text, text, text) to authenticated;


-- ── 5. recognition_autofire ─────────────────────────────────────────
-- The scheduled engine.  For each DSP that has enabled birthdays /
-- anniversaries / matching-holidays for p_date, inserts one recognition
-- per qualifying active driver.  Idempotent: skips drivers who already
-- have a (driver_id, kind, occasion_on=p_date) row, so safe to re-run.
--
-- Returns the number of recognitions CREATED on this invocation.
--
-- SECURITY: definer.  Bypasses RLS to scan all DSPs.  Granted to
-- service_role (for the cron job) AND authenticated (for the manual
-- "Run today's auto-fire now" button — gated inside the function by
-- the cron-or-staff check below).
create or replace function public.recognition_autofire(p_date date default current_date)
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_created     int := 0;
  v_holidays    text[] := private.recognition_holiday_kinds_on(p_date);
  v_p_year      int := extract(year  from p_date)::int;
  v_p_month     int := extract(month from p_date)::int;
  v_p_day       int := extract(day   from p_date)::int;
  v_caller_dsp  uuid := null;
  v_is_service  boolean := false;
  v_rec         record;
  v_drv         record;
  v_title       text;
  v_message     text;
  v_years       int;
  v_holiday     text;
begin
  -- Allow service_role (cron) to run unconditionally; otherwise require
  -- the caller to be a dispatcher and restrict to their own DSP.
  begin
    v_caller_dsp := private.current_dsp_id();
  exception when others then
    v_caller_dsp := null;
  end;

  -- Detect service-role contexts: no auth.uid() AND no dsp.
  v_is_service := (auth.uid() is null);

  if not v_is_service then
    if v_caller_dsp is null
       or not private.is_staff(v_caller_dsp, 'dispatcher') then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  -- Walk DSPs with at least one enabled setting.  When invoked
  -- interactively, restrict to the caller's own DSP.
  for v_rec in
    select distinct s.dsp_id, s.kind, s.custom_title, s.custom_message, s.recipient_scope
    from public.dsp_recognition_settings s
    where s.enabled = true
      and (v_is_service or s.dsp_id = v_caller_dsp)
  loop
    -- BIRTHDAYS
    if v_rec.kind = 'birthday' then
      for v_drv in
        select d.id, d.dsp_id
        from public.drivers d
        where d.dsp_id = v_rec.dsp_id
          and d.status = 'active'
          and d.birthday is not null
          and extract(month from d.birthday)::int = v_p_month
          and (
            extract(day from d.birthday)::int = v_p_day
            -- Feb 29 birthdays celebrate on Feb 28 in non-leap years
            or (
              extract(month from d.birthday)::int = 2
              and extract(day   from d.birthday)::int = 29
              and v_p_month = 2 and v_p_day = 28
              and not (
                (v_p_year % 4 = 0 and v_p_year % 100 <> 0) or (v_p_year % 400 = 0)
              )
            )
          )
          and not exists (
            select 1 from public.driver_recognitions r
            where r.driver_id = d.id
              and r.kind = 'birthday'
              and r.occasion_on = p_date
          )
      loop
        v_title   := coalesce(nullif(trim(coalesce(v_rec.custom_title, '')), ''),   'Happy birthday!');
        v_message := nullif(trim(coalesce(v_rec.custom_message, '')), '');
        insert into public.driver_recognitions
          (dsp_id, driver_id, kind, title, message, animation,
           occasion_on, sent_at, status, metadata)
        values
          (v_drv.dsp_id, v_drv.id, 'birthday', v_title, v_message, 'cake',
           p_date, now(), 'sent',
           jsonb_build_object('source', 'autofire'));
        v_created := v_created + 1;
        raise notice 'autofire birthday: dsp=% driver=% date=%', v_drv.dsp_id, v_drv.id, p_date;
      end loop;

    -- WORK ANNIVERSARIES
    elsif v_rec.kind = 'work_anniversary' then
      for v_drv in
        select d.id, d.dsp_id, d.hire_date
        from public.drivers d
        where d.dsp_id = v_rec.dsp_id
          and d.status = 'active'
          and d.hire_date is not null
          and extract(month from d.hire_date)::int = v_p_month
          and (
            extract(day from d.hire_date)::int = v_p_day
            or (
              extract(month from d.hire_date)::int = 2
              and extract(day   from d.hire_date)::int = 29
              and v_p_month = 2 and v_p_day = 28
              and not (
                (v_p_year % 4 = 0 and v_p_year % 100 <> 0) or (v_p_year % 400 = 0)
              )
            )
          )
          and (v_p_year - extract(year from d.hire_date)::int) >= 1
          and not exists (
            select 1 from public.driver_recognitions r
            where r.driver_id = d.id
              and r.kind = 'work_anniversary'
              and r.occasion_on = p_date
          )
      loop
        v_years := v_p_year - extract(year from v_drv.hire_date)::int;
        v_title := coalesce(
          nullif(trim(coalesce(v_rec.custom_title, '')), ''),
          v_years || '-year anniversary'
        );
        v_message := nullif(trim(coalesce(v_rec.custom_message, '')), '');
        insert into public.driver_recognitions
          (dsp_id, driver_id, kind, title, message, animation,
           occasion_on, sent_at, status, years, metadata)
        values
          (v_drv.dsp_id, v_drv.id, 'work_anniversary', v_title, v_message, 'trophy',
           p_date, now(), 'sent', v_years,
           jsonb_build_object('source', 'autofire'));
        v_created := v_created + 1;
        raise notice 'autofire anniversary: dsp=% driver=% years=% date=%',
          v_drv.dsp_id, v_drv.id, v_years, p_date;
      end loop;

    -- HOLIDAYS (each enabled holiday kind that matches today)
    elsif v_rec.kind like 'holiday_%' then
      if v_rec.kind = any(v_holidays) then
        v_holiday := v_rec.kind;
        for v_drv in
          select d.id, d.dsp_id
          from public.drivers d
          where d.dsp_id = v_rec.dsp_id
            and d.status = 'active'
            and not exists (
              select 1 from public.driver_recognitions r
              where r.driver_id = d.id
                and r.kind = v_holiday
                and r.occasion_on = p_date
            )
        loop
          v_title := coalesce(
            nullif(trim(coalesce(v_rec.custom_title, '')), ''),
            case v_holiday
              when 'holiday_new_years_day'          then 'Happy New Year!'
              when 'holiday_mlk_day'                then 'Honoring Dr. King'
              when 'holiday_valentines_day'         then 'Happy Valentine''s Day!'
              when 'holiday_presidents_day'         then 'Happy Presidents'' Day'
              when 'holiday_st_patricks_day'        then 'Happy St. Patrick''s Day!'
              when 'holiday_easter'                 then 'Happy Easter!'
              when 'holiday_mothers_day'            then 'Happy Mother''s Day!'
              when 'holiday_memorial_day'           then 'Memorial Day'
              when 'holiday_juneteenth'             then 'Happy Juneteenth!'
              when 'holiday_fathers_day'            then 'Happy Father''s Day!'
              when 'holiday_independence_day'       then 'Happy 4th of July!'
              when 'holiday_labor_day'              then 'Happy Labor Day!'
              when 'holiday_indigenous_peoples_day' then 'Indigenous Peoples'' Day'
              when 'holiday_halloween'              then 'Happy Halloween!'
              when 'holiday_veterans_day'           then 'Thank You, Veterans'
              when 'holiday_thanksgiving'           then 'Happy Thanksgiving!'
              when 'holiday_christmas'              then 'Merry Christmas!'
              else 'Happy holiday!'
            end
          );
          v_message := nullif(trim(coalesce(v_rec.custom_message, '')), '');
          insert into public.driver_recognitions
            (dsp_id, driver_id, kind, title, message, animation,
             occasion_on, sent_at, status, metadata)
          values
            (v_drv.dsp_id, v_drv.id, v_holiday, v_title, v_message,
             case v_holiday
               when 'holiday_new_years_day'       then 'fireworks'
               when 'holiday_valentines_day'      then 'hearts'
               when 'holiday_st_patricks_day'    then 'leaf'
               when 'holiday_easter'              then 'egg'
               when 'holiday_mothers_day'         then 'flower'
               when 'holiday_fathers_day'         then 'star'
               when 'holiday_independence_day'    then 'flag'
               when 'holiday_memorial_day'        then 'flag'
               when 'holiday_juneteenth'          then 'flag'
               when 'holiday_veterans_day'        then 'flag'
               when 'holiday_labor_day'           then 'flag'
               when 'holiday_indigenous_peoples_day' then 'flag'
               when 'holiday_mlk_day'             then 'flag'
               when 'holiday_presidents_day'      then 'flag'
               when 'holiday_halloween'           then 'pumpkin'
               when 'holiday_thanksgiving'        then 'leaf'
               when 'holiday_christmas'           then 'tree'
               else 'confetti'
             end,
             p_date, now(), 'sent',
             jsonb_build_object('source', 'autofire'));
          v_created := v_created + 1;
          raise notice 'autofire holiday: dsp=% driver=% kind=% date=%',
            v_drv.dsp_id, v_drv.id, v_holiday, p_date;
        end loop;
      end if;
    end if;
  end loop;

  return v_created;
end;
$$;

grant execute on function public.recognition_autofire(date) to authenticated;
grant execute on function public.recognition_autofire(date) to service_role;


-- ── 6. Daily schedule via pg_cron ───────────────────────────────────
-- 13:00 UTC = 9am EDT / 6am PDT.  Wrapped in DO so the migration
-- doesn't fail on hosts without pg_cron installed; the user is told to
-- wire their own scheduler in that case.
do $$
begin
  -- Unschedule any prior run of this job to keep the migration idempotent.
  begin
    perform cron.unschedule('recognition-autofire-daily');
  exception when others then
    -- Job didn't exist (or pg_cron not enabled) — fine to swallow.
    null;
  end;
  perform cron.schedule(
    'recognition-autofire-daily',
    '0 13 * * *',
    $cron$ select public.recognition_autofire(current_date); $cron$
  );
exception when undefined_function or undefined_table or invalid_schema_name then
  raise notice 'pg_cron not enabled — wire your own scheduler to call public.recognition_autofire(current_date) daily';
end $$;


notify pgrst, 'reload schema';
