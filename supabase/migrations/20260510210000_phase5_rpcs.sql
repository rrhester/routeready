-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510210000 · Phase 5 RPCs
-- License policy upsert, manual reminder resend, mark renewed, submit
-- inspection, complete checklist run.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── set_license_policy: upsert per-DSP config ──────────────────────────

create or replace function public.set_license_policy(
  p_enabled          boolean default true,
  p_days_before      int[]   default array[30,14],
  p_template         text    default null,
  p_notify_owner     boolean default true,
  p_block_scheduling boolean default true
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'owner') then
    raise exception 'set_license_policy: owner only';
  end if;

  insert into public.license_policies
    (dsp_id, enabled, days_before, template, notify_owner, block_scheduling, updated_by)
  values
    (v_dsp, p_enabled, p_days_before,
     coalesce(p_template,
       'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). ' ||
       'Please renew ASAP and send a photo of your new license.'),
     p_notify_owner, p_block_scheduling, v_caller)
  on conflict (dsp_id) do update set
    enabled          = excluded.enabled,
    days_before      = excluded.days_before,
    template         = coalesce(excluded.template, public.license_policies.template),
    notify_owner     = excluded.notify_owner,
    block_scheduling = excluded.block_scheduling,
    updated_by       = excluded.updated_by,
    updated_at       = now();
end $$;

revoke execute on function public.set_license_policy(boolean, int[], text, boolean, boolean) from public, anon;
grant execute on function public.set_license_policy(boolean, int[], text, boolean, boolean) to authenticated;

-- ─── send_license_reminder: manual resend ──────────────────────────────

create or replace function public.send_license_reminder(
  p_driver_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_driver     public.drivers%rowtype;
  v_policy     public.license_policies%rowtype;
  v_days       int;
  v_message    text;
  v_first_name text;
  v_sms_id     uuid;
  v_reminder_id uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'send_license_reminder: ops only';
  end if;

  select * into v_driver from public.drivers
   where id = p_driver_id and dsp_id = v_dsp;
  if not found then
    raise exception 'send_license_reminder: driver % not in DSP %', p_driver_id, v_dsp;
  end if;
  if v_driver.license_expiry is null then
    raise exception 'send_license_reminder: no license_expiry on file for %', p_driver_id;
  end if;
  if v_driver.phone is null then
    raise exception 'send_license_reminder: no phone on file for %', p_driver_id;
  end if;

  select * into v_policy from public.license_policies where dsp_id = v_dsp;

  v_days := v_driver.license_expiry - current_date;
  v_first_name := split_part(v_driver.full_name, ' ', 1);
  v_message := coalesce(
    v_policy.template,
    'Hi {{name}} — your driver license expires in {{days}} days ({{date}}). Please renew ASAP.'
  );
  v_message := replace(v_message, '{{name}}', v_first_name);
  v_message := replace(v_message, '{{days}}', v_days::text);
  v_message := replace(v_message, '{{date}}', to_char(v_driver.license_expiry, 'Mon DD, YYYY'));

  -- Enqueue (will be sent by send-driver-sms when sms_enabled=true)
  v_sms_id := public.enqueue_sms(
    v_driver.phone, v_message, p_driver_id, null, 'license_reminder'
  );

  -- Log the reminder
  insert into public.license_reminders
    (dsp_id, driver_id, threshold_days, expiry_date, sms_message_id)
  values
    (v_dsp, p_driver_id, null, v_driver.license_expiry, v_sms_id)
  returning id into v_reminder_id;

  -- Append to HR file (auditable record of reminder)
  insert into public.hr_events
    (dsp_id, driver_id, event_type, severity, effective_date,
     reason_category, reason_detail, initiated_by)
  values
    (v_dsp, p_driver_id, 'license_reminder_sent', 'info', current_date,
     'license',
     'Manual license renewal reminder sent. Expires ' || to_char(v_driver.license_expiry, 'YYYY-MM-DD') || '.',
     auth.uid());

  return v_reminder_id;
end $$;

revoke execute on function public.send_license_reminder(uuid) from public, anon;
grant execute on function public.send_license_reminder(uuid) to authenticated;

-- ─── mark_license_renewed: bump expiry + reset reminder cycle ───────────

create or replace function public.mark_license_renewed(
  p_driver_id      uuid,
  p_new_expiry     date,
  p_license_number text default null,
  p_document_path  text default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'mark_license_renewed: ops only';
  end if;
  if p_new_expiry <= current_date then
    raise exception 'mark_license_renewed: new_expiry must be in the future';
  end if;

  update public.drivers
     set license_expiry = p_new_expiry,
         license_number = coalesce(p_license_number, license_number)
   where id = p_driver_id and dsp_id = v_dsp;

  if not found then
    raise exception 'mark_license_renewed: driver % not in DSP %', p_driver_id, v_dsp;
  end if;

  -- Log to HR file
  insert into public.hr_events
    (dsp_id, driver_id, event_type, severity, effective_date,
     reason_category, reason_detail, attached_files, initiated_by)
  values
    (v_dsp, p_driver_id, 'document_signed', 'info', current_date,
     'license',
     'License renewed. New expiry: ' || to_char(p_new_expiry, 'YYYY-MM-DD') || '.',
     case when p_document_path is null then null else array[p_document_path] end,
     auth.uid());

  -- Note: reminder log entries from prior expiry remain (audit history).
  -- The next cycle will compare against the new expiry_date.
end $$;

revoke execute on function public.mark_license_renewed(uuid, date, text, text) from public, anon;
grant execute on function public.mark_license_renewed(uuid, date, text, text) to authenticated;

-- ─── submit_form: inspection or other form submission ──────────────────

create or replace function public.submit_form(
  p_template_id uuid,
  p_responses   jsonb,
  p_driver_id   uuid    default null,
  p_vehicle_id  uuid    default null,
  p_shift_id    uuid    default null,
  p_files       text[]  default null,
  p_gps_lat     numeric default null,
  p_gps_lng     numeric default null,
  p_flagged     boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  v_role       text := private.current_role_claim();
  v_caller_drv uuid := private.current_driver_id();
  v_template   public.form_templates%rowtype;
  v_id         uuid;
begin
  if v_dsp is null then
    raise exception 'submit_form: not authenticated';
  end if;

  select * into v_template
    from public.form_templates
   where id = p_template_id and dsp_id = v_dsp and active = true;
  if not found then
    raise exception 'submit_form: template % not active in DSP %', p_template_id, v_dsp;
  end if;

  -- A driver submits their own; staff can submit on behalf of any driver
  if not (
    private.is_staff(v_dsp, 'dispatcher')
    or (v_role = 'driver' and (p_driver_id is null or p_driver_id = v_caller_drv))
  ) then
    raise exception 'submit_form: caller cannot submit on behalf of this driver';
  end if;

  insert into public.form_submissions
    (dsp_id, form_template_id, driver_id, vehicle_id, shift_id,
     responses, attached_files, gps_lat, gps_lng, flagged)
  values
    (v_dsp, p_template_id,
     coalesce(p_driver_id, v_caller_drv), p_vehicle_id, p_shift_id,
     p_responses, p_files, p_gps_lat, p_gps_lng, p_flagged)
  returning id into v_id;

  return v_id;
end $$;

revoke execute on function public.submit_form(uuid, jsonb, uuid, uuid, uuid, text[], numeric, numeric, boolean) from public, anon;
grant execute on function public.submit_form(uuid, jsonb, uuid, uuid, uuid, text[], numeric, numeric, boolean) to authenticated;

-- ─── complete_checklist_run ────────────────────────────────────────────

create or replace function public.complete_checklist_run(
  p_run_id    uuid,
  p_responses jsonb
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'complete_checklist_run: caller is not staff';
  end if;

  update public.checklist_runs
     set responses    = p_responses,
         completed_at = now(),
         completed_by = auth.uid()
   where id = p_run_id and dsp_id = v_dsp;

  if not found then
    raise exception 'complete_checklist_run: run % not in DSP %', p_run_id, v_dsp;
  end if;
end $$;

revoke execute on function public.complete_checklist_run(uuid, jsonb) from public, anon;
grant execute on function public.complete_checklist_run(uuid, jsonb) to authenticated;

-- ─── Auto-block-scheduling-on-expired-license trigger ───────────────────
-- When a shift is inserted or its driver_id is changed, check whether
-- that driver's license is expired AND the DSP policy says to block.
-- If so, raise.

create or replace function private.fn_block_expired_license_assign()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_expiry date;
  v_block  boolean;
begin
  if new.driver_id is null then return new; end if;
  if new.shift_date < current_date then return new; end if;  -- past shifts aren't blocked

  select license_expiry into v_expiry from public.drivers where id = new.driver_id;
  if v_expiry is null or v_expiry >= new.shift_date then
    return new;     -- no license on file (warn elsewhere) or not yet expired
  end if;

  select coalesce(block_scheduling, true) into v_block
    from public.license_policies where dsp_id = new.dsp_id;
  if not coalesce(v_block, true) then
    return new;     -- DSP has disabled the block
  end if;

  raise exception 'shifts: driver %''s license expired on %, cannot assign to shift on %',
    new.driver_id, v_expiry, new.shift_date
    using errcode = 'restrict_violation';
end $$;

create trigger trg_shifts_block_expired_license
  before insert or update of driver_id on public.shifts
  for each row execute function private.fn_block_expired_license_assign();

comment on function private.fn_block_expired_license_assign() is
  'Blocks shift assignment to a driver whose license is expired by the ' ||
  'shift date, when the DSP policy.block_scheduling = true. DOT compliance.';
