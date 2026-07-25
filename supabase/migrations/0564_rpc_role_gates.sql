-- ── 0564 · Role-gate SECURITY DEFINER RPCs that were tenant-only ───────────────
--
-- Closes launch-audit finding H-2. An authoritative sweep of the final schema
-- (688 SECURITY DEFINER functions in public) found 108 that scope to the
-- caller's tenant via private.current_dsp_id() but perform a privileged WRITE
-- with NO role check — so a low-privilege driver-role app_user (role='driver',
-- the only role below 'dispatcher') could call them: approve their own PTO,
-- dismiss a coaching record, ground a van, edit interview config, etc.
--
-- After excluding functions already protected by a role/admin/resource gate
-- (is_staff / is_platform_admin / notebook_require / driver token) and the
-- intentionally any-member self-service calls (push registration, activity
-- ping, poll vote, event log), 23 privileged staff functions remained
-- unguarded. This adds the standard staff gate to each:
--
--   if not private.is_staff(private.current_dsp_id(), 'dispatcher') then
--     raise exception 'forbidden' using errcode = '42501';
--   end if;
--
-- is_staff(dsp,'dispatcher') is true for dispatcher/ops/owner/platform_admin
-- and false ONLY for driver — so this excludes exactly the driver role and no
-- legitimate staff. The 21 plpgsql functions are re-issued verbatim from the
-- live definition with the guard as the first statement; the 2 LANGUAGE sql
-- functions (interview_override_remove / interview_session_remove) are
-- converted to plpgsql to carry the guard. create-or-replace preserves each
-- function's existing grants. Validated against the fully-migrated schema:
-- all 23 apply, a driver-role caller is refused, a dispatcher passes.
--
-- See docs/H2-RPC-AUTHZ-SWEEP.md for the full method + the deferred list.

CREATE OR REPLACE FUNCTION public.coaching_archive(p_id uuid, p_reason text)
 RETURNS coachings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_row  public.coachings;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.coachings
     set archived_at     = now(),
         archived_by     = v_user,
         archived_reason = p_reason,
         updated_at      = now()
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if not found then raise exception 'coaching not found' using errcode = '42704'; end if;
  return v_row;
end $function$
;


CREATE OR REPLACE FUNCTION public.coaching_resolve(p_id uuid)
 RETURNS coachings
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_row  public.coachings;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.coachings
     set resolved_at = now(),
         resolved_by = v_user,
         updated_at  = now()
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if not found then raise exception 'coaching not found' using errcode = '42704'; end if;
  return v_row;
end $function$
;


CREATE OR REPLACE FUNCTION public.dispatch_time_off_decide(p_id uuid, p_approve boolean, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_req        public.time_off_requests;
  v_notes      text := nullif(trim(coalesce(p_notes, '')), '');
  v_status     public.time_off_status;
  v_msg        text;
  v_range_lbl  text;
  v_kind_lbl   text;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
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
$function$
;


CREATE OR REPLACE FUNCTION public.fmcsa_record_save(p_legal_name text DEFAULT NULL::text, p_usdot text DEFAULT NULL::text, p_mc_number text DEFAULT NULL::text, p_expected_fleet_count integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_due date;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  -- Auto-recompute the next-due date when USDOT is present.
  v_due := public.fmcsa_biennial_due(p_usdot);

  insert into public.fmcsa_records (dsp_id, legal_name, usdot, mc_number,
                                    expected_fleet_count, mcs150_next_due_at, updated_at)
  values (v_dsp,
          nullif(btrim(p_legal_name), ''),
          nullif(btrim(p_usdot), ''),
          nullif(btrim(p_mc_number), ''),
          p_expected_fleet_count,
          v_due,
          now())
  on conflict (dsp_id) do update set
    legal_name           = coalesce(nullif(btrim(excluded.legal_name), ''),    public.fmcsa_records.legal_name),
    usdot                = coalesce(nullif(btrim(excluded.usdot), ''),         public.fmcsa_records.usdot),
    mc_number            = coalesce(nullif(btrim(excluded.mc_number), ''),     public.fmcsa_records.mc_number),
    expected_fleet_count = coalesce(excluded.expected_fleet_count,             public.fmcsa_records.expected_fleet_count),
    mcs150_next_due_at   = coalesce(excluded.mcs150_next_due_at,               public.fmcsa_records.mcs150_next_due_at),
    updated_at           = now();

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'fmcsa_record_updated',
          'FMCSA record saved · USDOT ' || coalesce(p_usdot, '(none)'),
          null, 'fmcsa', v_dsp);

  return public.fmcsa_record_get();
end $function$
;


CREATE OR REPLACE FUNCTION public.fmcsa_safer_record_observation(p_operating_status text DEFAULT NULL::text, p_cmv_count integer DEFAULT NULL::integer, p_non_cmv_count integer DEFAULT NULL::integer, p_fleet_total integer DEFAULT NULL::integer, p_mcs150_last_update date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  insert into public.fmcsa_records (dsp_id, public_operating_status, public_cmv_count,
                                    public_non_cmv_count, public_fleet_total,
                                    public_mcs150_last_update_at,
                                    safer_last_sync_at, last_checked_at, updated_at)
  values (v_dsp, p_operating_status, p_cmv_count, p_non_cmv_count, p_fleet_total,
          p_mcs150_last_update, now(), now(), now())
  on conflict (dsp_id) do update set
    public_operating_status     = coalesce(excluded.public_operating_status,     public.fmcsa_records.public_operating_status),
    public_cmv_count            = coalesce(excluded.public_cmv_count,            public.fmcsa_records.public_cmv_count),
    public_non_cmv_count        = coalesce(excluded.public_non_cmv_count,        public.fmcsa_records.public_non_cmv_count),
    public_fleet_total          = coalesce(excluded.public_fleet_total,          public.fmcsa_records.public_fleet_total),
    public_mcs150_last_update_at= coalesce(excluded.public_mcs150_last_update_at,public.fmcsa_records.public_mcs150_last_update_at),
    safer_last_sync_at          = now(),
    last_checked_at             = now(),
    updated_at                  = now();

  return public.fmcsa_record_get();
end $function$
;


CREATE OR REPLACE FUNCTION public.interview_availability_set(p_timezone text, p_slot_minutes integer, p_buffer_minutes integer, p_min_lead_hours integer, p_window_days integer, p_location text, p_windows jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); w jsonb;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config
    (dsp_id, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, updated_at)
  values (v_dsp, p_timezone, greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0),
          greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location, now())
  on conflict (dsp_id) do update set
    timezone=excluded.timezone, slot_minutes=excluded.slot_minutes, buffer_minutes=excluded.buffer_minutes,
    min_lead_hours=excluded.min_lead_hours, window_days=excluded.window_days, location=excluded.location, updated_at=now();
  delete from public.interview_availability where dsp_id = v_dsp;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_availability (dsp_id, weekday, start_min, end_min, capacity)
    values (v_dsp, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int,
            greatest(coalesce((w->>'capacity')::int, 1), 1));
  end loop;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_override_set(p_date date, p_is_closed boolean, p_windows jsonb DEFAULT '[]'::jsonb, p_note text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_date is null then raise exception 'date_required'; end if;
  insert into public.interview_date_overrides (dsp_id, override_date, is_closed, windows, note)
  values (v_dsp, p_date, coalesce(p_is_closed, true), coalesce(p_windows, '[]'::jsonb), p_note)
  on conflict (dsp_id, override_date) do update
    set is_closed = excluded.is_closed, windows = excluded.windows,
        note = excluded.note, updated_at = now()
  returning id into v_id;
  return v_id;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_reminders_config_set(p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config (dsp_id, reminder_config, updated_at)
  values (v_dsp, p_config, now())
  on conflict (dsp_id) do update set
    reminder_config = excluded.reminder_config, updated_at = now();
  return p_config;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_reminders_set(p_enabled boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_config (dsp_id, reminders_enabled, updated_at)
  values (v_dsp, coalesce(p_enabled, true), now())
  on conflict (dsp_id) do update set
    reminders_enabled = excluded.reminders_enabled, updated_at = now();
  return coalesce(p_enabled, true);
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_schedule_activate(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.interview_schedules where id=p_id and dsp_id=v_dsp) then raise exception 'schedule_not_found'; end if;
  update public.interview_schedules set is_active=(id=p_id) where dsp_id=v_dsp;
  perform private.iv_mirror_active(v_dsp);
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_schedule_delete(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); v_was_active boolean;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select is_active into v_was_active from public.interview_schedules where id=p_id and dsp_id=v_dsp;
  delete from public.interview_schedules where id=p_id and dsp_id=v_dsp;
  if coalesce(v_was_active,false) then
    update public.interview_schedules set is_active=true
      where id = (select id from public.interview_schedules where dsp_id=v_dsp order by sort_order, created_at limit 1);
    perform private.iv_mirror_active(v_dsp);
  end if;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_schedule_save(p_id uuid, p_name text, p_timezone text, p_slot_minutes integer, p_buffer_minutes integer, p_min_lead_hours integer, p_window_days integer, p_location text, p_windows jsonb, p_make_active boolean DEFAULT false, p_extra jsonb DEFAULT NULL::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid := p_id; w jsonb;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'no_dsp'; end if;
  if v_id is null then
    insert into public.interview_schedules
      (dsp_id, name, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, is_active, sort_order)
    values (v_dsp, coalesce(nullif(btrim(p_name),''),'Interview'), coalesce(p_timezone,'America/Chicago'),
            greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0), greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location,
            coalesce(p_make_active,false) or not exists (select 1 from public.interview_schedules where dsp_id=v_dsp),
            coalesce((select max(sort_order)+1 from public.interview_schedules where dsp_id=v_dsp), 0))
    returning id into v_id;
  else
    update public.interview_schedules set
      name=coalesce(nullif(btrim(p_name),''),name), timezone=coalesce(p_timezone,timezone),
      slot_minutes=greatest(p_slot_minutes,5), buffer_minutes=greatest(p_buffer_minutes,0),
      min_lead_hours=greatest(p_min_lead_hours,0), window_days=greatest(p_window_days,1), location=p_location, updated_at=now()
    where id=v_id and dsp_id=v_dsp;
    if not found then raise exception 'schedule_not_found'; end if;
  end if;
  if p_extra is not null then
    update public.interview_schedules set
      branding             = case when p_extra ? 'branding' then coalesce(p_extra->'branding', '{}'::jsonb) else branding end,
      arrival_notes        = case when p_extra ? 'arrival_notes' then nullif(btrim(p_extra->>'arrival_notes'), '') else arrival_notes end,
      intake_questions     = case when p_extra ? 'intake_questions' then coalesce(p_extra->'intake_questions', '[]'::jsonb) else intake_questions end,
      require_phone_verify = case when p_extra ? 'require_phone_verify' then coalesce((p_extra->>'require_phone_verify')::boolean, false) else require_phone_verify end,
      offer_public         = case when p_extra ? 'offer_public' then coalesce((p_extra->>'offer_public')::boolean, false) else offer_public end,
      max_per_day          = case when p_extra ? 'max_per_day' then nullif(coalesce((p_extra->>'max_per_day')::int, 0), 0) else max_per_day end,
      interviewer_pool     = case when p_extra ? 'interviewer_pool' then coalesce(p_extra->'interviewer_pool', '[]'::jsonb) else interviewer_pool end,
      min_cancel_hours     = case when p_extra ? 'min_cancel_hours' then greatest(coalesce((p_extra->>'min_cancel_hours')::int, 0), 0) else min_cancel_hours end,
      max_self_reschedules = case when p_extra ? 'max_self_reschedules' then greatest(coalesce((p_extra->>'max_self_reschedules')::int, 0), 0) else max_self_reschedules end,
      nudge_after_days     = case when p_extra ? 'nudge_after_days' then greatest(coalesce((p_extra->>'nudge_after_days')::int, 0), 0) else nudge_after_days end,
      require_captcha      = case when p_extra ? 'require_captcha' then coalesce((p_extra->>'require_captcha')::boolean, false) else require_captcha end
    where id=v_id and dsp_id=v_dsp;
  end if;
  delete from public.interview_schedule_windows where schedule_id=v_id;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_schedule_windows (schedule_id, weekday, start_min, end_min, capacity)
    values (v_id, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int, greatest(coalesce((w->>'capacity')::int,1),1));
  end loop;
  if coalesce(p_make_active,false) then
    update public.interview_schedules set is_active=(id=v_id) where dsp_id=v_dsp;
  end if;
  perform private.iv_mirror_active(v_dsp);
  return v_id;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_session_add(p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_capacity integer, p_location text, p_label text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'no_dsp'; end if;
  insert into public.interview_sessions (dsp_id, starts_at, ends_at, capacity, location, label)
  values (v_dsp, p_starts_at, p_ends_at, greatest(coalesce(p_capacity,20),1), p_location, p_label)
  returning id into v_id;
  return v_id;
end; $function$
;


CREATE OR REPLACE FUNCTION public.interview_session_update(p_id uuid, p_starts_at timestamp with time zone, p_ends_at timestamp with time zone, p_capacity integer, p_label text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_dsp uuid := private.current_dsp_id(); v_booked int;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then raise exception 'forbidden' using errcode='42501'; end if;
  if p_ends_at <= p_starts_at then raise exception 'end_before_start'; end if;
  -- Don't let capacity drop below the number already booked into the session.
  select count(*)::int into v_booked from public.cal_events
    where interview_session_id = p_id and status in ('scheduled','rescheduled');
  if p_capacity < greatest(v_booked, 1) then
    raise exception 'capacity_below_booked';
  end if;
  update public.interview_sessions
    set starts_at = p_starts_at, ends_at = p_ends_at,
        capacity = greatest(p_capacity, 1), label = p_label
    where id = p_id and dsp_id = v_dsp;
end; $function$
;


CREATE OR REPLACE FUNCTION public.repair_order_complete(p_id uuid, p_cost_cents integer DEFAULT NULL::integer)
 RETURNS repair_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.repair_orders set
    status       = 'completed',
    completed_at = coalesce(completed_at, now()),
    cost_cents   = coalesce(p_cost_cents, cost_cents),
    updated_at   = now()
  where id = p_id and dsp_id = v_dsp
  returning * into v_ro;
  if not found then
    raise exception 'ro_not_found' using errcode = '42704';
  end if;

  -- Flip the linked issue back to completed if its work_order matches.
  update public.vehicle_issues
     set status = 'completed',
         resolved_at = coalesce(resolved_at, now()),
         updated_at = now()
   where dsp_id = v_dsp
     and vehicle_id = v_ro.vehicle_id
     and work_order = v_ro.code
     and status <> 'completed';

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_completed',
          'Repair order ' || coalesce(v_ro.code, '(no code)') || ' completed',
          null, 'repair_order', v_ro.id);

  return v_ro;
end $function$
;


CREATE OR REPLACE FUNCTION public.repair_order_open_from_issue(p_issue_id uuid, p_vendor_id uuid DEFAULT NULL::uuid, p_summary text DEFAULT NULL::text)
 RETURNS repair_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_issue public.vehicle_issues;
  v_ro public.repair_orders;
  v_code text;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_issue from public.vehicle_issues
   where id = p_issue_id and dsp_id = v_dsp;
  if not found then
    raise exception 'issue_not_found' using errcode = '42704';
  end if;

  v_code := coalesce(public._next_ro_code(v_dsp), 'RO-' || to_char(now(),'YYYY') || '-0001');

  insert into public.repair_orders
    (dsp_id, vehicle_id, vendor_id, code, summary, status, opened_at, created_by)
  values (
    v_dsp,
    v_issue.vehicle_id,
    p_vendor_id,
    v_code,
    coalesce(nullif(btrim(p_summary), ''), v_issue.title),
    case when p_vendor_id is null then 'draft'::ro_status else 'scheduled'::ro_status end,
    now(),
    auth.uid()
  )
  returning * into v_ro;

  -- Link RO code into the issue + flip to in_repair.
  update public.vehicle_issues
     set status     = 'in_repair',
         work_order = v_ro.code,
         updated_at = now()
   where id = p_issue_id;

  -- Auto-ground the vehicle if it isn't already grounded; the
  -- _fleet_maintain_grounding_event trigger will open a grounding event.
  update public.vehicles
     set operational_status = 'grounded'
   where id = v_issue.vehicle_id
     and dsp_id = v_dsp
     and coalesce(operational_status,'operational') <> 'grounded';

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_opened',
          'Repair order ' || v_ro.code || ' opened',
          'Issue: ' || v_issue.title,
          'repair_order', v_ro.id);

  return v_ro;
end $function$
;


CREATE OR REPLACE FUNCTION public.repair_order_save(p_id uuid, p_vendor_id uuid DEFAULT NULL::uuid, p_status ro_status DEFAULT NULL::ro_status, p_summary text DEFAULT NULL::text, p_scheduled_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_eta_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_completed_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_cost_cents integer DEFAULT NULL::integer)
 RETURNS repair_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.repair_orders set
    vendor_id    = coalesce(p_vendor_id,    vendor_id),
    status       = coalesce(p_status,       status),
    summary      = coalesce(nullif(btrim(p_summary),''), summary),
    scheduled_at = coalesce(p_scheduled_at, scheduled_at),
    eta_at       = coalesce(p_eta_at,       eta_at),
    completed_at = coalesce(p_completed_at, completed_at),
    cost_cents   = coalesce(p_cost_cents,   cost_cents),
    updated_at   = now()
  where id = p_id and dsp_id = v_dsp
  returning * into v_ro;
  if not found then
    raise exception 'ro_not_found' using errcode = '42704';
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'ro_updated',
          'Repair order ' || coalesce(v_ro.code, '(no code)') || ' updated',
          'Status: ' || v_ro.status,
          'repair_order', v_ro.id);

  return v_ro;
end $function$
;


CREATE OR REPLACE FUNCTION public.vehicle_dvic_review_save(p_inspection_id uuid, p_disposition text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ins public.vehicle_inspections;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_dsp is null then return jsonb_build_object('error','no_dsp'); end if;
  if p_disposition not in ('clean','damage_filed','inconclusive') then
    return jsonb_build_object('error','bad_disposition');
  end if;

  update public.vehicle_inspections
     set reviewer_id          = auth.uid(),
         reviewed_at          = now(),
         reviewer_disposition = p_disposition,
         reviewer_notes       = nullif(btrim(p_notes), ''),
         updated_at           = now()
   where id = p_inspection_id and dsp_id = v_dsp
   returning * into v_ins;

  if not found then return jsonb_build_object('error','not_found'); end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (v_dsp, 'user', auth.uid(), 'dvic_review_logged',
          'DVIC review · ' || p_disposition,
          coalesce(p_notes, ''),
          'vehicle', v_ins.vehicle_id);

  return jsonb_build_object(
    'ok', true,
    'inspection_id', v_ins.id,
    'disposition',   v_ins.reviewer_disposition,
    'reviewed_at',   v_ins.reviewed_at
  );
end $function$
;


CREATE OR REPLACE FUNCTION public.vehicle_quick_set_ro_code(p_vehicle_id uuid, p_code text)
 RETURNS repair_orders
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_ro public.repair_orders;
  v_code text := nullif(btrim(p_code), '');
  v_vehicle public.vehicles;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if v_code is null then
    raise exception 'ro_code_required' using errcode = '22023';
  end if;

  select * into v_vehicle
    from public.vehicles
   where id = p_vehicle_id and dsp_id = v_dsp and archived_at is null;
  if not found then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;

  -- Try to update the vehicle's existing open RO first.
  update public.repair_orders set
    code = v_code, updated_at = now()
   where vehicle_id = p_vehicle_id
     and dsp_id = v_dsp
     and status not in ('completed','cancelled')
   returning * into v_ro;

  if not found then
    -- No open RO yet · create a draft with this code.
    insert into public.repair_orders
      (dsp_id, vehicle_id, code, summary, status, opened_at, created_by)
    values (
      v_dsp, p_vehicle_id, v_code,
      coalesce('RO ' || v_code, 'Repair'),
      'draft', now(), auth.uid()
    )
    returning * into v_ro;
  end if;

  -- Audit
  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(), 'ro_code_set',
    'RO code set to ' || v_code || ' for ' || coalesce(v_vehicle.nickname, v_vehicle.name, '(unnamed)'),
    null, 'repair_order', v_ro.id
  );

  return v_ro;
end;
$function$
;


-- vehicle_set_operational_status: gate main's CURRENT 5-param body (0539 fleet
-- grounding upgrade added p_expected_return_on). Drop the pre-fleet 4-param
-- overload so no ungated/stale signature survives.
drop function if exists public.vehicle_set_operational_status(uuid, text, text, text);
create or replace function public.vehicle_set_operational_status(
  p_id                 uuid,
  p_status             text,
  p_reason             text default null,
  p_category           text default null,
  p_expected_return_on date default null
) returns public.vehicles
language plpgsql security definer set search_path = public
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicles;
  v_cat text := nullif(btrim(p_category), '');
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_status, '') not in ('operational','grounded') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if v_cat is not null and v_cat not in ('warranty','preventive','body_damage','other') then
    raise exception 'bad_category' using errcode = '22023';
  end if;

  update public.vehicles
     set operational_status = p_status,
         updated_at         = now()
   where id = p_id and dsp_id = v_dsp
  returning * into v_row;

  if not found then
    raise exception 'vehicle_not_found' using errcode = '42704';
  end if;

  if p_status = 'grounded' then
    -- Stamp reason/category/expected-return onto the open grounding
    -- event (the 0228 trigger created/kept the row from the status
    -- change above).
    update public.vehicle_grounding_events
       set reason             = coalesce(nullif(btrim(p_reason), ''), reason),
           category           = coalesce(v_cat, category),
           expected_return_on = coalesce(p_expected_return_on, expected_return_on)
     where vehicle_id = p_id
       and ungrounded_at is null;
  elsif nullif(btrim(p_reason), '') is not null then
    -- Un-grounding with a note: stamp it on the event the trigger just
    -- closed (the latest closed event for this van).
    update public.vehicle_grounding_events
       set unground_note = nullif(btrim(p_reason), '')
     where id = (
       select id from public.vehicle_grounding_events
        where vehicle_id = p_id and ungrounded_at is not null
        order by ungrounded_at desc limit 1
     );
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, sub, object_type, object_id)
  values (
    v_dsp, 'user', auth.uid(),
    case when p_status = 'grounded' then 'vehicle_grounded' else 'vehicle_ungrounded' end,
    'Vehicle ' || coalesce(v_row.nickname, v_row.name, '(unnamed)') || ' set to ' || p_status,
    nullif(btrim(p_reason), ''),
    'vehicle', p_id
  );

  return v_row;
end $$;
grant execute on function public.vehicle_set_operational_status(uuid, text, text, text, date) to authenticated;


CREATE OR REPLACE FUNCTION public.vendor_save(p_id uuid DEFAULT NULL::uuid, p_name text DEFAULT NULL::text, p_kind text DEFAULT 'repair'::text, p_contact_phone text DEFAULT NULL::text, p_contact_email text DEFAULT NULL::text)
 RETURNS vendors
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dsp uuid := private.current_dsp_id();
  v_v public.vendors;
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;
  if p_id is null then
    insert into public.vendors (dsp_id, name, kind, contact_phone, contact_email)
    values (v_dsp, btrim(p_name), coalesce(p_kind,'repair'), p_contact_phone, p_contact_email)
    returning * into v_v;
  else
    update public.vendors set
      name          = coalesce(nullif(btrim(p_name),''), name),
      kind          = coalesce(p_kind, kind),
      contact_phone = coalesce(p_contact_phone, contact_phone),
      contact_email = coalesce(p_contact_email, contact_email),
      updated_at    = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_v;
    if not found then
      raise exception 'vendor_not_found' using errcode = '42704';
    end if;
  end if;
  return v_v;
end $function$
;



-- The two former LANGUAGE sql functions, converted to plpgsql to carry the guard.
create or replace function public.interview_override_remove(p_date date)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.interview_date_overrides
   where dsp_id = private.current_dsp_id() and override_date = p_date;
end $function$;

create or replace function public.interview_session_remove(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $function$
begin
  if not private.is_staff(private.current_dsp_id(), 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.interview_sessions where id = p_id and dsp_id = private.current_dsp_id();
end $function$;

notify pgrst, 'reload schema';
