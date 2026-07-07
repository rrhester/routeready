-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0440 · Immutable audit snapshots for driver checklist answers
--
-- Compliance records must not change or vanish when an admin edits a
-- published checklist. Two integrity holes today:
--
--   1. checklist_answers.item_id was ON DELETE CASCADE, and
--      checklist_form_upsert hard-deletes any item you remove — so editing
--      a live checklist to drop an item permanently deleted that item's
--      answers from every historical submission.
--   2. Answers never snapshotted the item text; checklist_form_responses
--      joined the *live* checklist_items row, so relabeling an item
--      silently rewrote what past submissions appeared to say.
--
-- Fix: snapshot item_label + item_type onto each answer at write time, keep
-- the answer when its item is deleted (FK → SET NULL, item_id nullable),
-- and read the snapshot (falling back to the live item) in the responses
-- view via a LEFT join. The team-checklist system (0212) already snapshots
-- labels at launch, so this is driver-forms only.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Snapshot columns + backfill ────────────────────────────────────
alter table public.checklist_answers add column if not exists item_label text;
alter table public.checklist_answers add column if not exists item_type  text;

update public.checklist_answers a
   set item_label = coalesce(a.item_label, i.label),
       item_type  = coalesce(a.item_type,  i.item_type)
  from public.checklist_items i
 where i.id = a.item_id
   and (a.item_label is null or a.item_type is null);


-- ── 2. Deleting an item keeps its answers (link nulls, snapshot stays) ─
do $$ begin
  alter table public.checklist_answers drop constraint checklist_answers_item_id_fkey;
exception when undefined_object then null; end $$;

alter table public.checklist_answers alter column item_id drop not null;

alter table public.checklist_answers
  add constraint checklist_answers_item_id_fkey
  foreign key (item_id) references public.checklist_items(id) on delete set null;


-- ── 3. Writer snapshots label/type (0437 body + snapshot columns) ─────
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

  delete from public.checklist_answers where submission_id = v_sub.id;
  for v_item in
    select * from public.checklist_items where template_id = v_tpl.id
  loop
    v_ans := p_answers->(v_item.id::text);
    if v_ans is null then continue; end if;
    v_val := v_ans->>'v';
    insert into public.checklist_answers
      (submission_id, item_id, dsp_id, item_label, item_type, value_text, value_bool, value_number, value_json, photo_urls, note, failed_flag)
    values (
      v_sub.id, v_item.id, v_a.dsp_id,
      nullif(v_item.label, ''), v_item.item_type,
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
         due_at       = coalesce(v_due, due_at),
         failed_count = (select count(*)::int from public.checklist_answers
                          where submission_id = v_sub.id and failed_flag)
   where id = v_sub.id
   returning * into v_sub;

  return jsonb_build_object(
    'id',           v_sub.id,
    'status',       v_sub.status,
    'submitted_at', v_sub.submitted_at,
    'failed_count', v_sub.failed_count
  );
end;
$$;


-- ── 4. Responses read the snapshot (0436 body + snapshot + LEFT join) ─
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
        'label',        coalesce(a.item_label, i.label),
        'item_type',    coalesce(a.item_type,  i.item_type),
        'value_text',   a.value_text,
        'value_bool',   a.value_bool,
        'value_number', a.value_number,
        'photo_urls',   a.photo_urls,
        'note',         a.note,
        'failed_flag',  a.failed_flag
      ) order by coalesce(i.sort_order, 2147483647), a.created_at)
      from public.checklist_answers a
      left join public.checklist_items i on i.id = a.item_id
      where a.submission_id = s.id
    ), '[]'::jsonb)
  ) order by coalesce(s.submitted_at, s.started_at) desc), '[]'::jsonb)
    into v_subs
  from public.checklist_submissions s
  join public.drivers d on d.id = s.driver_id
  where s.template_id = p_template_id and s.dsp_id = v_dsp
    and s.created_at >= now() - make_interval(days => greatest(coalesce(p_days, 14), 1));

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


notify pgrst, 'reload schema';
