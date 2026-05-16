-- Migration 0275 · Paid (PTO) vs unpaid time off
--
-- Drivers can now flag a time-off request as PTO (paid). The dispatcher
-- sees the same approve/deny flow, but approved requests carry through
-- the rest of the app with their PTO flag intact so:
--
--   * the schedule grid renders "PTO" vs "Time off" on the calendar
--     cell instead of a single ambiguous "PTO" chip
--   * the dispatcher Time-off review surfaces which requests will need
--     payroll/ADP entry
--   * a new dispatch_pto_report RPC powers a CSV-friendly payroll roll-up

alter table public.time_off_requests
  add column if not exists is_pto boolean not null default false;

create index if not exists time_off_dsp_pto_idx
  on public.time_off_requests (dsp_id, start_date)
  where is_pto = true and status = 'approved';


-- ── 1. driver_time_off_request · gain p_use_pto ────────────────────
create or replace function public.driver_time_off_request(
  p_token      text,
  p_start_date date,
  p_end_date   date,
  p_reason     text default null,
  p_use_pto    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv    public.drivers;
  v_reason text;
  v_id     uuid;
  v_overlap boolean;
begin
  v_drv := private.driver_validate_token(p_token);

  if p_start_date is null or p_end_date is null then
    raise exception 'time_off_dates_required';
  end if;
  if p_end_date < p_start_date then
    raise exception 'time_off_end_before_start';
  end if;
  if p_start_date < current_date then
    raise exception 'time_off_start_in_past';
  end if;

  select exists (
    select 1 from public.time_off_requests
     where driver_id = v_drv.id
       and status in ('pending', 'approved')
       and not (end_date < p_start_date or start_date > p_end_date)
  ) into v_overlap;
  if v_overlap then
    raise exception 'time_off_overlaps_existing';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');

  insert into public.time_off_requests
    (dsp_id, driver_id, start_date, end_date, reason, status, is_pto)
  values
    (v_drv.dsp_id, v_drv.id, p_start_date, p_end_date, v_reason, 'pending',
     coalesce(p_use_pto, false))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'pending', 'is_pto', coalesce(p_use_pto, false));
end;
$$;
grant execute on function public.driver_time_off_request(text, date, date, text, boolean) to anon, authenticated;


-- ── 2. driver_time_off_list · surface is_pto ───────────────────────
create or replace function public.driver_time_off_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             r.id,
      'start_date',     r.start_date,
      'end_date',       r.end_date,
      'reason',         r.reason,
      'status',         r.status,
      'is_pto',         r.is_pto,
      'decision_notes', r.decision_notes,
      'decided_at',     r.decided_at,
      'created_at',     r.created_at
    )
    order by r.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from public.time_off_requests r
  where r.driver_id = v_drv.id;

  return v_rows;
end;
$$;
grant execute on function public.driver_time_off_list(text) to anon, authenticated;


-- ── 3. dispatch_time_off_list · surface is_pto ─────────────────────
create or replace function public.dispatch_time_off_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             r.id,
      'driver_id',      r.driver_id,
      'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
      'station_code',   s.code,
      'start_date',     r.start_date,
      'end_date',       r.end_date,
      'reason',         r.reason,
      'status',         r.status,
      'is_pto',         r.is_pto,
      'decision_notes', r.decision_notes,
      'decided_at',     r.decided_at,
      'created_at',     r.created_at
    )
    order by
      case r.status when 'pending' then 0 else 1 end,
      case r.status when 'pending' then r.created_at end asc,
      r.decided_at desc nulls last,
      r.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from public.time_off_requests r
  join public.drivers           d on d.id = r.driver_id
  left join public.stations     s on s.id = d.station_id
  where r.dsp_id = v_dsp;

  return v_rows;
end;
$$;
grant execute on function public.dispatch_time_off_list() to authenticated;


-- ── 4. dispatch_time_off_decide · label chat by PTO vs time-off ────
create or replace function public.dispatch_time_off_decide(
  p_id      uuid,
  p_approve boolean,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_req        public.time_off_requests;
  v_notes      text := nullif(trim(coalesce(p_notes, '')), '');
  v_status     public.time_off_status;
  v_msg        text;
  v_range_lbl  text;
  v_kind_lbl   text;
begin
  if v_dsp is null then raise exception 'time_off_no_dsp_context'; end if;

  select * into v_req from public.time_off_requests
   where id = p_id and dsp_id = v_dsp;
  if v_req.id is null then
    raise exception 'time_off_not_found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'time_off_already_decided';
  end if;

  v_status   := case when p_approve then 'approved' else 'denied' end;
  v_kind_lbl := case when v_req.is_pto then 'PTO' else 'time-off' end;

  update public.time_off_requests
     set status         = v_status,
         decided_by     = auth.uid(),
         decided_at     = now(),
         decision_notes = v_notes
   where id = p_id;

  if v_req.start_date = v_req.end_date then
    v_range_lbl := to_char(v_req.start_date, 'Mon DD, YYYY');
  else
    v_range_lbl := to_char(v_req.start_date, 'Mon DD') || ' – ' ||
                   to_char(v_req.end_date,   'Mon DD, YYYY');
  end if;

  if p_approve then
    v_msg := 'Your ' || v_kind_lbl || ' request for ' || v_range_lbl || ' is approved.'
             || coalesce(' Note: ' || v_notes, '');
  else
    v_msg := 'Your ' || v_kind_lbl || ' request for ' || v_range_lbl || ' was not approved.'
             || coalesce(' Reason: ' || v_notes, '')
             || ' Submit a new request from the Time off page.';
  end if;

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (v_req.driver_id, v_dsp, 'dispatch', auth.uid(), v_msg);

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_req.driver_id, v_dsp, now())
  on conflict (driver_id) do update set last_message_at = now();

  return jsonb_build_object(
    'id',     p_id,
    'status', v_status,
    'is_pto', v_req.is_pto
  );
end;
$$;
grant execute on function public.dispatch_time_off_decide(uuid, boolean, text) to authenticated;


-- ── 5. dispatch_pto_report · CSV-friendly payroll roll-up ──────────
-- Returns one row per approved PTO request in the date range, joined
-- to the driver's full name + station so the operator can paste
-- straight into ADP / their payroll tool. days_count is end - start + 1
-- (calendar days within the requested window; the operator can adjust
-- for weekends downstream if needed).
create or replace function public.dispatch_pto_report(
  p_from date default (current_date - 30),
  p_to   date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then return '[]'::jsonb; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             r.id,
      'driver_id',      r.driver_id,
      'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
      'driver_email',   d.email,
      'station_code',   s.code,
      'start_date',     r.start_date,
      'end_date',       r.end_date,
      'days_count',     (r.end_date - r.start_date + 1),
      'reason',         r.reason,
      'decision_notes', r.decision_notes,
      'decided_at',     r.decided_at,
      'decided_by_name',u.full_name
    )
    order by r.start_date desc, d.full_name
  ), '[]'::jsonb)
  into v_rows
  from public.time_off_requests r
  join public.drivers   d on d.id = r.driver_id
  left join public.stations s on s.id = d.station_id
  left join public.app_users u on u.id = r.decided_by
  where r.dsp_id = v_dsp
    and r.status = 'approved'
    and r.is_pto = true
    and r.start_date <= p_to
    and r.end_date   >= p_from;

  return v_rows;
end;
$$;
grant execute on function public.dispatch_pto_report(date, date) to authenticated;


notify pgrst, 'reload schema';
