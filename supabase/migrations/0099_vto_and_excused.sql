-- VTO + Excused improvements on the daily attendance decide flow.
--
-- Operator request:
--   1. Add a VTO button on the daily check-in tool (driver took
--      voluntary time off — doesn't count against attendance).
--   2. Rename the existing Decline button to Excused (notes still
--      required) — frontend-only, but make sure decision='deny' is
--      surfaced as final_outcome='excused' in reports.
--   3. Notes from Excused decisions need to appear inline in the
--      attendance record (today + history).
--   4. Add an Excused KPI card on the Attendance Report screen with
--      its own drill-down listing each excused entry + notes.
--
-- This migration handles the data side:
--   • attendance_decisions.decision check constraint adds 'vto'.
--   • attendance_decide RPC accepts decision='vto' and stamps
--     shifts.status = 'vto' (the enum already supports it).
--   • attendance_approve_day consults attendance_decisions when
--     stamping final_outcome — so a denied (excused) row actually
--     resolves to 'excused' on the permanent log instead of falling
--     through to ncns/tardy/absent. Same for vto → 'vto'.
--   • today_attendance + attendance_history surface decision_notes
--     per row.
--   • New RPC attendance_excused_list(p_from, p_to) backs the
--     Excused KPI drill-down.

-- ── 1. Allow 'vto' as a decision ────────────────────────────────────────
alter table public.attendance_decisions
  drop constraint if exists attendance_decisions_decision_check;
alter table public.attendance_decisions
  add constraint attendance_decisions_decision_check
  check (decision in ('approve','deny','vto'));


-- ── 2. attendance_decide · accept decision='vto' ────────────────────────
create or replace function public.attendance_decide(
  p_shift_id  uuid,
  p_outcome   text,
  p_decision  text,
  p_notes     text default null,
  p_auto_fire boolean default false,
  p_level     text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_uid        uuid := auth.uid();
  v_app_user_id uuid;
  v_shift      public.shifts;
  v_drv        public.drivers;
  v_status     text;
  v_summary    text;
  v_dsp_meta   jsonb;
  v_policy     jsonb;
  v_delivery   text;
  v_severity   text;
  v_did_auto   boolean := false;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_decision not in ('approve','deny','vto') then
    raise exception 'invalid_decision' using errcode = 'P0001';
  end if;
  if p_outcome not in ('ncns','tardy','missed_reported') then
    raise exception 'invalid_outcome' using errcode = 'P0001';
  end if;
  if p_decision = 'deny' and (p_notes is null or trim(p_notes) = '') then
    raise exception 'notes_required' using errcode = 'P0001';
  end if;

  select * into v_shift from public.shifts where id = p_shift_id and dsp_id = v_dsp;
  if v_shift.id is null then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;
  if v_shift.driver_id is null then
    raise exception 'shift_unassigned' using errcode = 'P0002';
  end if;

  select * into v_drv from public.drivers where id = v_shift.driver_id;
  select id into v_app_user_id from public.app_users where id = v_uid limit 1;

  insert into public.attendance_decisions
    (dsp_id, driver_id, shift_id, outcome, decision, notes, decided_by)
  values
    (v_dsp, v_drv.id, p_shift_id, p_outcome, p_decision,
     nullif(trim(coalesce(p_notes, '')), ''), v_uid)
  on conflict (shift_id) do update
    set outcome    = excluded.outcome,
        decision   = excluded.decision,
        notes      = excluded.notes,
        decided_by = excluded.decided_by,
        created_at = now();

  -- Approve  → stamp the original outcome (no_show/late/called_off).
  -- VTO      → stamp shifts.status = 'vto'. No coaching ever.
  -- Deny     → leave shifts.status alone (the row counts as excused
  --            on final_outcome via attendance_approve_day).
  v_status := case p_outcome
    when 'ncns'            then 'no_show'
    when 'tardy'           then 'late'
    when 'missed_reported' then 'called_off'
  end;
  if p_decision = 'approve' then
    update public.shifts set status = v_status::public.shift_status where id = p_shift_id;
  elsif p_decision = 'vto' then
    update public.shifts set status = 'vto'::public.shift_status where id = p_shift_id;
  end if;

  -- Coaching insert ONLY when auto-fire is set up to actually
  -- deliver. Termination never auto-fires by design. Otherwise the
  -- approval is silent on the coaching side — operator decides what
  -- to do from the Report row's Send coaching button. Excused / VTO
  -- never auto-coach.
  if p_decision = 'approve' and p_auto_fire and p_level is not null and p_level <> 'termination' then
    v_summary := case p_outcome
      when 'ncns'            then 'No-call no-show on ' || to_char(v_shift.date, 'Mon DD')
      when 'tardy'           then 'Tardy on '           || to_char(v_shift.date, 'Mon DD')
      when 'missed_reported' then 'Callout on '         || to_char(v_shift.date, 'Mon DD')
    end;

    v_severity := case p_level
      when 'verbal'      then 'verbal'
      when 'written'     then 'written'
      when 'final'       then 'final'
      else 'verbal'
    end;

    select metadata into v_dsp_meta from public.dsps where id = v_dsp;
    v_policy := coalesce(v_dsp_meta->'attendance'->'policy', '{}'::jsonb);
    v_delivery := coalesce(v_policy->>('delivery_' || v_severity), 'ack');

    v_did_auto := true;

    insert into public.coachings
      (dsp_id, driver_id, coach_user_id, topic, type, severity,
       summary, notes,
       driver_visible, delivery_required, triggering_shift_id,
       metadata)
    values
      (v_dsp, v_drv.id, v_app_user_id,
       'attendance'::public.coaching_topic,
       'documented_warning'::public.coaching_type,
       v_severity::public.coaching_severity,
       v_summary,
       coalesce(p_notes, ''),
       true,
       v_delivery::public.coaching_delivery,
       p_shift_id,
       jsonb_build_object(
         'source',   'attendance_decide',
         'shift_id', p_shift_id,
         'outcome',  p_outcome,
         'level',    p_level,
         'auto',     true
       ));
  end if;

  return jsonb_build_object(
    'ok',           true,
    'decision',     p_decision,
    'auto_fired',   v_did_auto,
    'level',        p_level,
    'shift_status', case
                      when p_decision = 'approve' then v_status
                      when p_decision = 'vto'     then 'vto'
                      else v_shift.status::text
                    end
  );
end;
$$;
grant execute on function public.attendance_decide(uuid, text, text, text, boolean, text) to authenticated;


-- ── 3. attendance_approve_day · respect decisions when stamping ──────────
-- Previously the function recomputed final_outcome from check-in
-- state alone, so a row that the operator had Excused or marked VTO
-- earlier in the day still ended up on the permanent log as ncns /
-- tardy / absent. Now the day-stamp consults attendance_decisions
-- first and falls back to the time-based computation otherwise.
create or replace function public.attendance_approve_day(p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_set public.scheduling_settings;
  v_grace int;
  v_ncns int;
  v_count int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_set from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  v_grace := coalesce(v_set.tardy_grace_minutes,  10);
  v_ncns  := coalesce(v_set.ncns_after_minutes,   60);

  -- Stamp every checkin row for shifts on p_day with the final
  -- outcome. Missing checkin rows are created with the computed
  -- absence outcome so the permanent record reflects the absence.
  insert into public.driver_checkins (driver_id, dsp_id, shift_id, station_id,
                                       outcome, finalized, finalized_at, finalized_by, final_outcome)
  select s.driver_id, s.dsp_id, s.id, s.station_id,
         'ncns', true, now(), auth.uid(),
         case
           when ad.decision = 'deny' then 'excused'
           when ad.decision = 'vto'  then 'vto'
           when s.status::text = 'vto' then 'vto'
           when s.starts_at is not null
                and now() > s.starts_at + make_interval(mins => v_ncns)
             then 'ncns'
           when s.starts_at is not null
                and now() > s.starts_at + make_interval(mins => v_grace)
             then 'tardy'
           else 'absent'
         end
    from public.shifts s
    left join public.driver_checkins c on c.shift_id = s.id
    left join public.attendance_decisions ad on ad.shift_id = s.id
   where s.dsp_id = v_dsp
     and s.date = p_day
     and s.status in ('scheduled','completed','vto','no_show','late','called_off')
     and c.id is null;

  with upd as (
    update public.driver_checkins c
       set finalized    = true,
           finalized_at = coalesce(c.finalized_at, now()),
           finalized_by = coalesce(c.finalized_by, auth.uid()),
           final_outcome = coalesce(c.final_outcome,
             case
               when ad.decision = 'deny' then 'excused'
               when ad.decision = 'vto'  then 'vto'
               when c.checked_in_at is not null then 'present'
               when c.missed_reported_at is not null then 'excused'
               when (select s.starts_at from public.shifts s where s.id = c.shift_id) is not null
                    and now() > (select s.starts_at from public.shifts s where s.id = c.shift_id) + make_interval(mins => v_ncns)
                 then 'ncns'
               when (select s.starts_at from public.shifts s where s.id = c.shift_id) is not null
                    and now() > (select s.starts_at from public.shifts s where s.id = c.shift_id) + make_interval(mins => v_grace)
                 then 'tardy'
               else 'absent'
             end)
       from public.shifts s
       left join public.attendance_decisions ad on ad.shift_id = s.id
     where c.dsp_id = v_dsp
       and s.id = c.shift_id
       and s.dsp_id = v_dsp
       and s.date = p_day
       and c.finalized = false
     returning 1
  )
  select count(*) into v_count from upd;

  return jsonb_build_object('finalized_rows', v_count, 'day', p_day);
end;
$$;
grant execute on function public.attendance_approve_day(date) to authenticated;


-- ── 4. today_attendance · surface decision notes per row ────────────────
create or replace function public.today_attendance()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_set   public.scheduling_settings;
  v_grace int;
  v_ncns  int;
  v_now   timestamptz := now();
  v_today date := current_date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_set from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  v_grace := coalesce(v_set.tardy_grace_minutes,  10);
  v_ncns  := coalesce(v_set.ncns_after_minutes,   60);

  return jsonb_build_object(
    'as_of',       to_jsonb(v_now),
    'tardy_grace_minutes', v_grace,
    'ncns_after_minutes',  v_ncns,
    'rows', coalesce((
      select jsonb_agg(t order by
        case t->>'computed_outcome'
          when 'ncns'             then 1
          when 'tardy'            then 2
          when 'ready_to_checkin' then 3
          when 'waiting'          then 4
          when 'missed_reported'  then 5
          when 'checked_in'       then 6
          when 'checked_out'      then 7
          else 8
        end,
        t->>'starts_at',
        t->>'driver_name'
      ) from (
        select jsonb_build_object(
          'shift_id',          s.id,
          'driver_id',         d.id,
          'driver_name',       coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
          'station_code',      st.code,
          'starts_at',         to_jsonb(s.starts_at),
          'wave_index',        s.wave_index,
          'service_type_code', svc.code,
          'service_type_color',svc.color,
          'is_cushion',        s.is_cushion,
          'checked_in_at',     to_jsonb(c.checked_in_at),
          'checked_out_at',    to_jsonb(c.checked_out_at),
          'missed_reported_at',to_jsonb(c.missed_reported_at),
          'missed_reason',     c.missed_reason,
          'distance_meters',   c.distance_meters,
          'finalized',         coalesce(c.finalized, false),
          'final_outcome',     c.final_outcome,
          'decision',          ad.decision,
          'decision_notes',    ad.notes,
          'computed_outcome',
            case
              when c.checked_out_at is not null then 'checked_out'
              when c.checked_in_at  is not null then 'checked_in'
              when c.missed_reported_at is not null then 'missed_reported'
              when s.starts_at is not null
                   and v_now > s.starts_at + make_interval(mins => v_ncns)
                then 'ncns'
              when s.starts_at is not null
                   and v_now > s.starts_at + make_interval(mins => v_grace)
                then 'tardy'
              when s.starts_at is not null
                   and v_now >= s.starts_at - make_interval(mins => coalesce(v_set.checkin_lead_minutes, 15))
                then 'ready_to_checkin'
              else 'waiting'
            end
        ) as t
        from public.shifts s
        join public.drivers d on d.id = s.driver_id
        left join public.stations st on st.id = s.station_id
        left join public.service_types svc on svc.id = s.service_type_id
        left join public.driver_checkins c on c.shift_id = s.id
        left join public.attendance_decisions ad on ad.shift_id = s.id
        where s.dsp_id = v_dsp
          and s.date = v_today
          and s.status in ('scheduled','completed','vto','no_show','late','called_off')
      ) sub
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.today_attendance() to authenticated;


-- ── 5. attendance_history · include decision_notes + vto count ──────────
create or replace function public.attendance_history(
  p_from date default null,
  p_to   date default null,
  p_driver_id uuid default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_from date := coalesce(p_from, current_date - 30);
  v_to   date := coalesce(p_to,   current_date);
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'from', v_from,
    'to',   v_to,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date',           s.date,
        'driver_id',      d.id,
        'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code',   st.code,
        'final_outcome',  c.final_outcome,
        'finalized',      c.finalized,
        'checked_in_at',  to_jsonb(c.checked_in_at),
        'checked_out_at', to_jsonb(c.checked_out_at),
        'decision',       ad.decision,
        'decision_notes', ad.notes
      ) order by s.date desc, d.full_name)
        from public.driver_checkins c
        join public.shifts s   on s.id = c.shift_id
        join public.drivers d  on d.id = c.driver_id
        left join public.stations st on st.id = s.station_id
        left join public.attendance_decisions ad on ad.shift_id = s.id
       where c.dsp_id = v_dsp
         and c.finalized = true
         and s.date between v_from and v_to
         and (p_driver_id is null or c.driver_id = p_driver_id)
    ), '[]'::jsonb),
    'summary_by_driver', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id',   driver_id,
        'driver_name', driver_name,
        'present',     present_n,
        'tardy',       tardy_n,
        'ncns',        ncns_n,
        'absent',      absent_n,
        'excused',     excused_n,
        'vto',         vto_n,
        'total',       total_n
      ) order by driver_name)
        from (
          select d.id as driver_id,
                 coalesce(nullif(trim(d.preferred_name), ''), d.full_name) as driver_name,
                 sum(case when c.final_outcome = 'present' then 1 else 0 end) as present_n,
                 sum(case when c.final_outcome = 'tardy'   then 1 else 0 end) as tardy_n,
                 sum(case when c.final_outcome = 'ncns'    then 1 else 0 end) as ncns_n,
                 sum(case when c.final_outcome = 'absent'  then 1 else 0 end) as absent_n,
                 sum(case when c.final_outcome = 'excused' then 1 else 0 end) as excused_n,
                 sum(case when c.final_outcome = 'vto'     then 1 else 0 end) as vto_n,
                 count(*) as total_n
            from public.driver_checkins c
            join public.shifts s on s.id = c.shift_id
            join public.drivers d on d.id = c.driver_id
           where c.dsp_id = v_dsp and c.finalized = true
             and s.date between v_from and v_to
             and (p_driver_id is null or c.driver_id = p_driver_id)
           group by d.id, driver_name
        ) t
    ), '[]'::jsonb)
  );
end;
$$;
grant execute on function public.attendance_history(date, date, uuid) to authenticated;


-- ── 6. attendance_excused_list · drill-down for the Excused KPI card ────
-- Returns each excused-decision row in the window with the operator
-- notes attached, so the report screen can show "why" alongside
-- "who/when" without needing a separate query for notes.
create or replace function public.attendance_excused_list(
  p_from date default null,
  p_to   date default null
)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_from date := coalesce(p_from, current_date - 30);
  v_to   date := coalesce(p_to,   current_date);
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'shift_id',     s.id,
      'date',         s.date,
      'driver_id',    d.id,
      'driver_name',  coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
      'station_code', st.code,
      'outcome',      ad.outcome,
      'notes',        ad.notes,
      'decided_at',   to_jsonb(ad.created_at),
      'decided_by',   au.full_name
    ) order by s.date desc, ad.created_at desc)
      from public.attendance_decisions ad
      join public.shifts s   on s.id = ad.shift_id
      join public.drivers d  on d.id = ad.driver_id
      left join public.stations st on st.id = s.station_id
      left join public.app_users au on au.id = ad.decided_by
     where ad.dsp_id = v_dsp
       and ad.decision = 'deny'
       and s.date between v_from and v_to
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.attendance_excused_list(date, date) to authenticated;


notify pgrst, 'reload schema';
