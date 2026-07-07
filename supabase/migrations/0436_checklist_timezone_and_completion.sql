-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0436 · Checklist timezone correctness + completion fixes
--
-- Three correctness fixes, all idempotent (create or replace):
--
--   1. TIMEZONE. Every driver-checklist date decision (period keys,
--      visibility windows, due resolution, scheduled-today matching,
--      overdue) ran off raw current_date / now() = the server's UTC
--      clock, even though dsps.timezone exists (default America/New_York)
--      and the rest of the app already resolves "today" in DSP-local
--      time (see 0013/0014/0022). For any non-UTC DSP this meant daily
--      checklists rolled to a new empty period in the early evening,
--      "scheduled_today" stopped matching a driver's own shift after the
--      UTC date flipped, and a due_time of "17:00" was stored/compared as
--      17:00 UTC. We introduce private.dsp_today(dsp_id) and thread it
--      through every clf_* caller; clf_due_for now interprets a fixed
--      due_time in the DSP's timezone.
--
--   2. ALL-OPTIONAL CHECKLISTS COULD NEVER COMPLETE. The team-checklist
--      reconciler (0212) only auto-completed when
--      required_count > 0 AND all required done — so a checklist with no
--      required items was stuck 'active' forever, and there was no manual
--      complete. Reconcile now falls back to "every item done" when there
--      are no required items, and a new RPC lets a dispatcher force the
--      status.
--
--   3. MANUAL COMPLETE / REOPEN for team checklist instances
--      (checklist_instance_set_complete).
--
-- Bodies below are copied from the latest authoritative definitions
-- (0415/0416 for driver checklists, 0212 for the reconciler) with only
-- the timezone / completion lines changed. Driver read RPCs stay VOLATILE
-- per 0416 (they write a token last-used stamp; PostgREST runs
-- STABLE/IMMUTABLE RPCs read-only → SQLSTATE 25006).
-- ─────────────────────────────────────────────────────────────────────────


-- ── 0. Helper · "today" in a DSP's local timezone ─────────────────────
create or replace function private.dsp_today(p_dsp_id uuid)
returns date
language sql stable security definer set search_path = ''
as $$
  select (now() at time zone coalesce(
            (select timezone from public.dsps where id = p_dsp_id), 'UTC'))::date;
$$;


-- ── 1. clf_due_for · resolve fixed due_time in the DSP timezone ───────
create or replace function private.clf_due_for(
  a public.checklist_assignments,
  p_driver_id uuid,
  p_day date
) returns timestamptz
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_due  text := coalesce(a.repeat_rule->>'due', 'none');
  v_time text := nullif(a.repeat_rule->>'due_time', '');
  v_ts   timestamptz;
  v_tz   text;
begin
  if v_due = 'route_start' then
    select s.starts_at into v_ts from public.shifts s
     where s.driver_id = p_driver_id and s.date = p_day
       and s.status in ('scheduled','completed')
     order by s.starts_at nulls last limit 1;
    return v_ts;
  elsif v_due = 'shift_end' then
    select s.ends_at into v_ts from public.shifts s
     where s.driver_id = p_driver_id and s.date = p_day
       and s.status in ('scheduled','completed')
     order by s.starts_at nulls last limit 1;
    return v_ts;
  elsif v_due = 'time' and v_time is not null then
    -- Interpret the wall-clock due_time in the DSP's timezone, not the
    -- server's. (text)::timestamp yields a naive timestamp; AT TIME ZONE
    -- then reads it as local time in tz and returns a timestamptz.
    select coalesce(timezone, 'UTC') into v_tz from public.dsps where id = a.dsp_id;
    begin
      return (p_day::text || ' ' || v_time)::timestamp at time zone coalesce(v_tz, 'UTC');
    exception when others then return null;
    end;
  end if;
  return a.due_at;  -- 'none' → fixed due_at if the admin set one, else null
end;
$$;


-- ── 2. clf_write_submission · anchor the working day to the DSP tz ────
create or replace function private.clf_write_submission(
  p_drv public.drivers,
  p_assignment_id uuid,
  p_answers jsonb,
  p_submit boolean
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_a    public.checklist_assignments;
  v_tpl  public.checklist_forms;
  v_day  date := private.dsp_today(p_drv.dsp_id);
  v_pk   date;
  v_due  timestamptz;
  v_sub  public.checklist_submissions;
  v_item public.checklist_items;
  v_ans  jsonb;
  v_val  text;
  v_empty boolean;
  v_shift uuid;
begin
  select * into v_a from public.checklist_assignments
   where id = p_assignment_id and dsp_id = p_drv.dsp_id and status = 'active';
  if v_a.id is null then raise exception 'assignment_not_found' using errcode = 'P0001'; end if;

  select * into v_tpl from public.checklist_forms
   where id = v_a.template_id and status = 'active';
  if v_tpl.id is null then raise exception 'checklist_not_active' using errcode = 'P0001'; end if;

  if not private.clf_assignment_applies(v_a, p_drv, v_day) then
    raise exception 'not_assigned' using errcode = 'P0001';
  end if;

  v_pk  := private.clf_period_key(v_a, v_day);
  v_due := private.clf_due_for(v_a, p_drv.id, v_day);

  select * into v_sub from public.checklist_submissions
   where assignment_id = v_a.id and driver_id = p_drv.id
     and coalesce(period_key, '0001-01-01'::date) = coalesce(v_pk, '0001-01-01'::date)
   for update;

  if v_sub.id is not null and v_sub.status = 'submitted' then
    raise exception 'already_submitted' using errcode = 'P0001';
  end if;

  select s.id into v_shift from public.shifts s
   where s.driver_id = p_drv.id and s.date = v_day
     and s.status in ('scheduled','completed')
   order by s.starts_at nulls last limit 1;

  if v_sub.id is null then
    -- Race guard: two concurrent saves with no existing row would both
    -- try to insert the same (assignment, driver, period) and one would
    -- hit the unique index raw. Insert-or-skip, then re-select the winner.
    insert into public.checklist_submissions
      (assignment_id, template_id, dsp_id, driver_id, schedule_shift_id, period_key, due_at, status)
    values
      (v_a.id, v_tpl.id, v_a.dsp_id, p_drv.id, v_shift, v_pk, v_due,
       case when p_submit then 'submitted' else 'in_progress' end)
    on conflict (assignment_id, driver_id, coalesce(period_key, '0001-01-01'::date)) do nothing
    returning * into v_sub;

    if v_sub.id is null then
      select * into v_sub from public.checklist_submissions
       where assignment_id = v_a.id and driver_id = p_drv.id
         and coalesce(period_key, '0001-01-01'::date) = coalesce(v_pk, '0001-01-01'::date)
       for update;
      if v_sub.id is not null and v_sub.status = 'submitted' then
        raise exception 'already_submitted' using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- Required validation happens before any answer writes so a failed
  -- submit leaves the previous in-progress answers untouched.
  if p_submit then
    for v_item in
      select * from public.checklist_items
       where template_id = v_tpl.id and required
    loop
      v_ans := p_answers->(v_item.id::text);
      v_val := coalesce(v_ans->>'v', '');
      v_empty := v_ans is null or v_val = '' or lower(v_val) = 'false';
      if v_item.item_type = 'photo' then
        v_empty := v_ans is null or jsonb_array_length(coalesce(v_ans->'photos', '[]'::jsonb)) = 0;
      elsif v_item.item_type = 'note' or v_item.item_type in ('short_text','signature') then
        v_empty := v_ans is null or v_val = '';
      elsif v_item.item_type = 'number' then
        v_empty := v_ans is null or v_val = '';
      elsif v_item.item_type = 'yes_no' then
        v_empty := v_ans is null or lower(v_val) not in ('yes','no');
      end if;
      if v_empty then
        raise exception 'missing_required:%', coalesce(nullif(v_item.label,''), 'Untitled item') using errcode = 'P0001';
      end if;
    end loop;
  end if;

  -- Replace answers wholesale (simplest correct model for save+submit).
  delete from public.checklist_answers where submission_id = v_sub.id;
  for v_item in
    select * from public.checklist_items where template_id = v_tpl.id
  loop
    v_ans := p_answers->(v_item.id::text);
    if v_ans is null then continue; end if;
    v_val := v_ans->>'v';
    insert into public.checklist_answers
      (submission_id, item_id, dsp_id, value_text, value_bool, value_number, value_json, photo_urls, note, failed_flag)
    values (
      v_sub.id, v_item.id, v_a.dsp_id,
      case when v_item.item_type in ('short_text','note','signature','yes_no') then v_val end,
      case when v_item.item_type = 'checkbox' then lower(coalesce(v_val,'')) in ('true','1','yes') end,
      case when v_item.item_type = 'number' then
        (case when v_val ~ '^-?[0-9]+(\.[0-9]+)?$' then v_val::numeric end) end,
      case when v_ans ? 'json' then v_ans->'json' end,
      case when v_item.item_type = 'photo' then coalesce(v_ans->'photos', '[]'::jsonb) end,
      nullif(v_ans->>'note', ''),
      private.clf_answer_failed(v_item, v_ans)
    );
  end loop;

  update public.checklist_submissions
     set status       = case when p_submit then 'submitted' else
                          case when status = 'reopened' then 'reopened' else 'in_progress' end
                        end,
         submitted_at = case when p_submit then now() else submitted_at end,
         due_at       = coalesce(v_due, due_at)
   where id = v_sub.id
   returning * into v_sub;

  return jsonb_build_object(
    'id',           v_sub.id,
    'status',       v_sub.status,
    'submitted_at', v_sub.submitted_at,
    'failed_count', (select count(*)::int from public.checklist_answers
                      where submission_id = v_sub.id and failed_flag)
  );
end;
$$;


-- ── 3. driver_list_checklists · DSP-local today (stays VOLATILE) ──────
create or replace function public.driver_list_checklists(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_today date;
begin
  v_drv   := private.driver_validate_token(p_token);
  v_today := private.dsp_today(v_drv.dsp_id);
  return coalesce((
    select jsonb_agg(row_to_json(t)::jsonb order by
             case t.status when 'overdue' then 0 when 'in_progress' then 1
                           when 'not_started' then 2 else 3 end,
             t.due_at nulls last, t.name)
    from (
      select
        a.id  as assignment_id,
        f.id  as template_id,
        f.name, f.description,
        a.required,
        coalesce(a.repeat_rule->>'type', 'once') as repeat_type,
        (select count(*)::int from public.checklist_items i where i.template_id = f.id) as item_count,
        private.clf_due_for(a, v_drv.id, v_today) as due_at,
        s.submitted_at,
        case
          when s.status = 'submitted' then 'completed'
          when coalesce(s.status,'') in ('in_progress','reopened')
            or coalesce(s.status,'') = '' then
            case
              when private.clf_due_for(a, v_drv.id, v_today) is not null
               and private.clf_due_for(a, v_drv.id, v_today) < now() then 'overdue'
              when s.id is null then 'not_started'
              else 'in_progress'
            end
        end as status
      from public.checklist_assignments a
      join public.checklist_forms f on f.id = a.template_id and f.status = 'active'
      left join public.checklist_submissions s
        on s.assignment_id = a.id and s.driver_id = v_drv.id
       and coalesce(s.period_key, '0001-01-01'::date)
           = coalesce(private.clf_period_key(a, v_today), '0001-01-01'::date)
      where a.dsp_id = v_drv.dsp_id
        and a.status = 'active'
        and private.clf_assignment_applies(a, v_drv, v_today)
        and private.clf_in_window(a, v_today)
        -- keep completed one-time checklists around for 3 days, then drop
        and not coalesce(
              s.status = 'submitted'
              and coalesce(a.repeat_rule->>'type','once') in ('once','date')
              and s.submitted_at < now() - interval '3 days', false)
    ) t
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.driver_list_checklists(text) to anon, authenticated;


-- ── 4. driver_get_checklist · DSP-local today (stays VOLATILE) ────────
create or replace function public.driver_get_checklist(p_token text, p_assignment_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv   public.drivers;
  v_a     public.checklist_assignments;
  v_tpl   public.checklist_forms;
  v_sub   public.checklist_submissions;
  v_today date;
begin
  v_drv   := private.driver_validate_token(p_token);
  v_today := private.dsp_today(v_drv.dsp_id);
  select * into v_a from public.checklist_assignments
   where id = p_assignment_id and dsp_id = v_drv.dsp_id and status = 'active';
  if v_a.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  select * into v_tpl from public.checklist_forms where id = v_a.template_id and status = 'active';
  if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  if not private.clf_assignment_applies(v_a, v_drv, v_today) then
    raise exception 'checklist_not_found' using errcode = 'P0001';
  end if;

  select * into v_sub from public.checklist_submissions
   where assignment_id = v_a.id and driver_id = v_drv.id
     and coalesce(period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(v_a, v_today), '0001-01-01'::date);

  return jsonb_build_object(
    'assignment_id', v_a.id,
    'template_id',   v_tpl.id,
    'name',          v_tpl.name,
    'description',   v_tpl.description,
    'required',      v_a.required,
    'due_at',        private.clf_due_for(v_a, v_drv.id, v_today),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',          i.id,
        'label',       i.label,
        'helper_text', i.helper_text,
        'item_type',   i.item_type,
        'required',    i.required,
        'options',     i.options_json
      ) order by i.sort_order, i.created_at)
      from public.checklist_items i where i.template_id = v_tpl.id
    ), '[]'::jsonb),
    'submission', case when v_sub.id is null then null else jsonb_build_object(
      'id', v_sub.id, 'status', v_sub.status, 'submitted_at', v_sub.submitted_at,
      'reopened_at', v_sub.reopened_at
    ) end,
    'answers', coalesce((
      select jsonb_object_agg(a.item_id::text, jsonb_build_object(
        'v', case
               when a.value_bool is not null then to_jsonb(a.value_bool)
               when a.value_number is not null then to_jsonb(a.value_number)
               else to_jsonb(coalesce(a.value_text, ''))
             end,
        'photos', coalesce(a.photo_urls, '[]'::jsonb),
        'note', a.note,
        'failed', a.failed_flag
      ))
      from public.checklist_answers a where a.submission_id = v_sub.id
    ), '{}'::jsonb)
  );
end;
$$;
grant execute on function public.driver_get_checklist(text, uuid) to anon, authenticated;


-- ── 5. checklist_form_responses · DSP-local today for the roster ──────
create or replace function public.checklist_form_responses(p_template_id uuid, p_days int default 14)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_today date := private.dsp_today(private.current_dsp_id());
  v_subs  jsonb;
  v_today_roster jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',            s.id,
    'assignment_id', s.assignment_id,
    'driver_id',     s.driver_id,
    'driver_name',   d.full_name,
    'status',        s.status,
    'period_key',    s.period_key,
    'due_at',        s.due_at,
    'overdue',       (s.status in ('in_progress','reopened') and s.due_at is not null and s.due_at < now()),
    'started_at',    s.started_at,
    'submitted_at',  s.submitted_at,
    'reopened_at',   s.reopened_at,
    'failed_count',  (select count(*)::int from public.checklist_answers a where a.submission_id = s.id and a.failed_flag),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id',      a.item_id,
        'label',        i.label,
        'item_type',    i.item_type,
        'value_text',   a.value_text,
        'value_bool',   a.value_bool,
        'value_number', a.value_number,
        'photo_urls',   a.photo_urls,
        'note',         a.note,
        'failed_flag',  a.failed_flag
      ) order by i.sort_order)
      from public.checklist_answers a
      join public.checklist_items i on i.id = a.item_id
      where a.submission_id = s.id
    ), '[]'::jsonb)
  ) order by coalesce(s.submitted_at, s.started_at) desc), '[]'::jsonb)
    into v_subs
  from public.checklist_submissions s
  join public.drivers d on d.id = s.driver_id
  where s.template_id = p_template_id and s.dsp_id = v_dsp
    and s.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1));

  -- Today's expected roster across the template's active assignments.
  select coalesce(jsonb_agg(jsonb_build_object(
    'assignment_id', t.assignment_id,
    'scope',         t.scope,
    'driver_id',     t.driver_id,
    'driver_name',   t.driver_name,
    'due_at',        t.due_at,
    'status',        t.status,
    'overdue',       t.overdue
  ) order by t.driver_name), '[]'::jsonb)
    into v_today_roster
  from (
    select
      a.id as assignment_id,
      a.assignment_scope as scope,
      d.id as driver_id,
      d.full_name as driver_name,
      private.clf_due_for(a, d.id, v_today) as due_at,
      coalesce(s.status, 'not_started') as status,
      (coalesce(s.status, 'not_started') <> 'submitted'
        and private.clf_due_for(a, d.id, v_today) is not null
        and private.clf_due_for(a, d.id, v_today) < now()) as overdue
    from public.checklist_assignments a
    join public.drivers d
      on d.dsp_id = a.dsp_id and d.status in ('onboarding','active','leave')
     and private.clf_assignment_applies(a, d, v_today)
    left join public.checklist_submissions s
      on s.assignment_id = a.id and s.driver_id = d.id
     and coalesce(s.period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(a, v_today), '0001-01-01'::date)
    where a.template_id = p_template_id and a.dsp_id = v_dsp
      and a.status = 'active'
      and private.clf_in_window(a, v_today)
  ) t;

  return jsonb_build_object('submissions', v_subs, 'today', coalesce(v_today_roster, '[]'::jsonb));
end;
$$;
grant execute on function public.checklist_form_responses(uuid, int) to authenticated;


-- ── 6. checklist_instance_reconcile · complete all-optional lists ─────
-- Complete when every REQUIRED item is checked. If the checklist has no
-- required items at all, fall back to "every item checked" so an
-- all-optional list can still finish (previously it was stuck 'active'
-- forever). An empty checklist never auto-completes. Manually-archived
-- instances are always left alone.
create or replace function private.checklist_instance_reconcile(p_instance_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_total_required int;
  v_done_required  int;
  v_total_items    int;
  v_done_items     int;
  v_cur_status     text;
  v_complete       boolean;
begin
  select status into v_cur_status from public.checklist_instances where id = p_instance_id;
  if v_cur_status is null or v_cur_status = 'archived' then return; end if;

  select count(*) filter (where required),
         count(*) filter (where required and completed_at is not null),
         count(*),
         count(*) filter (where completed_at is not null)
    into v_total_required, v_done_required, v_total_items, v_done_items
  from public.checklist_instance_items where instance_id = p_instance_id;

  if v_total_required > 0 then
    v_complete := v_done_required = v_total_required;
  else
    v_complete := v_total_items > 0 and v_done_items = v_total_items;
  end if;

  if v_complete then
    update public.checklist_instances
       set status = 'completed', completed_at = coalesce(completed_at, now())
     where id = p_instance_id and status <> 'archived';
  else
    update public.checklist_instances
       set status = 'active', completed_at = null
     where id = p_instance_id and status = 'completed';
  end if;
end;
$$;


-- ── 7. checklist_instance_set_complete · manual complete / reopen ─────
create or replace function public.checklist_instance_set_complete(p_id uuid, p_complete boolean default true)
returns public.checklist_instances
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_i public.checklist_instances;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_instances
     set status       = case when p_complete then 'completed' else 'active' end,
         completed_at = case when p_complete then coalesce(completed_at, now()) else null end
   where id = p_id and dsp_id = v_dsp and status <> 'archived'
   returning * into v_i;
  if v_i.id is null then raise exception 'instance_not_found' using errcode = 'P0002'; end if;
  return v_i;
end;
$$;
grant execute on function public.checklist_instance_set_complete(uuid, boolean) to authenticated;


notify pgrst, 'reload schema';
