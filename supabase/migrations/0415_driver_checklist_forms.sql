-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0415 · Driver Checklist Forms
--
-- Form-Builder-style checklists that DSP owners build in a large builder
-- modal, publish, and assign to drivers; assigned checklists surface in
-- the driver app's Forms (Tasks) hub as fill-out cards, exactly like
-- published forms do.
--
-- NAMING NOTE: `checklist_templates` already exists (migration 0211) and
-- backs the staff-facing Workspaces checklist feature (template →
-- sections → items, launched into checklist_instances). This feature is
-- a different domain — driver-facing checklists that behave like forms —
-- so its template table is `checklist_forms`. The child tables use the
-- requested names (`checklist_items`, `checklist_assignments`,
-- `checklist_submissions`, `checklist_answers`), which are all free.
--
-- Model:
--   checklist_forms        — the template (name, status draft/active/archived)
--   checklist_items        — flat ordered items (checkbox / yes_no / short_text
--                            / number / photo / signature / note)
--   checklist_assignments  — who gets it (scopes) + repeat/due rules
--   checklist_submissions  — one row per driver per assignment period
--   checklist_answers      — one row per item per submission
--
-- Access model mirrors forms (0080/0081/0142): staff use authenticated
-- RLS + staff RPCs; drivers hit SECURITY DEFINER RPCs as anon with the
-- driver session token (private.driver_validate_token).
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Tables ──────────────────────────────────────────────────────────

create table if not exists public.checklist_forms (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  name         text not null default 'Untitled checklist',
  description  text,
  category     text not null default 'Driver App Forms',
  status       text not null default 'draft' check (status in ('draft','active','archived')),
  version      int  not null default 1,
  reusable     boolean not null default true,
  settings     jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz,
  archived_at  timestamptz
);
create index if not exists clf_forms_dsp_idx    on public.checklist_forms (dsp_id, updated_at desc);
create index if not exists clf_forms_status_idx on public.checklist_forms (dsp_id, status);

create table if not exists public.checklist_items (
  id             uuid primary key default gen_random_uuid(),
  template_id    uuid not null references public.checklist_forms(id) on delete cascade,
  dsp_id         uuid not null references public.dsps(id) on delete cascade,  -- denormalized for RLS
  label          text not null default '',
  helper_text    text,
  item_type      text not null default 'checkbox'
                 check (item_type in ('checkbox','yes_no','short_text','number','photo','signature','note')),
  required       boolean not null default false,
  options_json   jsonb not null default '{}'::jsonb,
  flag_rule_json jsonb not null default '{}'::jsonb,   -- e.g. {"flag_on":"no"} for yes_no
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists clf_items_template_idx on public.checklist_items (template_id, sort_order);

create table if not exists public.checklist_assignments (
  id               uuid primary key default gen_random_uuid(),
  template_id      uuid not null references public.checklist_forms(id) on delete cascade,
  dsp_id           uuid not null references public.dsps(id) on delete cascade,
  assigned_by      uuid references auth.users(id) on delete set null,
  assignment_scope text not null default 'driver'
                   check (assignment_scope in ('driver','all_active','scheduled_today','scheduled_date',
                                               'van','route_type','new_hires','trainers')),
  driver_id        uuid references public.drivers(id)  on delete cascade,   -- scope 'driver'
  route_date       date,                                                    -- scope 'scheduled_date'
  van_id           uuid references public.vehicles(id) on delete cascade,   -- scope 'van'
  route_type       text,                                                    -- scope 'route_type' (service_types.code)
  -- repeat_rule: { "type": "once"|"daily"|"weekly"|"date", "date": "YYYY-MM-DD",
  --               "due": "none"|"route_start"|"shift_end"|"time", "due_time": "HH:MM" }
  repeat_rule      jsonb,
  due_at           timestamptz,                                             -- fixed due for one-time assignments
  required         boolean not null default true,
  status           text not null default 'active' check (status in ('active','paused','archived')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists clf_assign_dsp_idx      on public.checklist_assignments (dsp_id, status);
create index if not exists clf_assign_template_idx on public.checklist_assignments (template_id, status);
create index if not exists clf_assign_driver_idx   on public.checklist_assignments (driver_id) where driver_id is not null;

create table if not exists public.checklist_submissions (
  id                uuid primary key default gen_random_uuid(),
  assignment_id     uuid not null references public.checklist_assignments(id) on delete cascade,
  template_id       uuid not null references public.checklist_forms(id) on delete cascade,
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  driver_id         uuid not null references public.drivers(id) on delete cascade,
  schedule_shift_id uuid references public.shifts(id) on delete set null,
  -- period_key groups repeating assignments: the day for 'daily', the week
  -- start for 'weekly', the target date for 'date'/'scheduled_date', null
  -- for one-time. One submission per (assignment, driver, period).
  period_key        date,
  status            text not null default 'in_progress'
                    check (status in ('in_progress','submitted','reopened')),
  due_at            timestamptz,                       -- resolved at save time, for admin overdue views
  started_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  reopened_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists clf_subm_period_uniq
  on public.checklist_submissions (assignment_id, driver_id, coalesce(period_key, '0001-01-01'::date));
create index if not exists clf_subm_dsp_idx      on public.checklist_submissions (dsp_id, created_at desc);
create index if not exists clf_subm_template_idx on public.checklist_submissions (template_id, created_at desc);
create index if not exists clf_subm_driver_idx   on public.checklist_submissions (driver_id, created_at desc);

create table if not exists public.checklist_answers (
  id            uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.checklist_submissions(id) on delete cascade,
  item_id       uuid not null references public.checklist_items(id) on delete cascade,
  dsp_id        uuid not null references public.dsps(id) on delete cascade,  -- denormalized for RLS
  value_text    text,
  value_bool    boolean,
  value_number  numeric,
  value_json    jsonb,
  photo_urls    jsonb,                                  -- array of storage paths (driver-documents bucket)
  note          text,
  failed_flag   boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (submission_id, item_id)
);
create index if not exists clf_answers_submission_idx on public.checklist_answers (submission_id);
create index if not exists clf_answers_failed_idx     on public.checklist_answers (dsp_id, failed_flag) where failed_flag;


-- ── 2. updated_at triggers ─────────────────────────────────────────────

drop trigger if exists trg_checklist_forms_updated_at on public.checklist_forms;
create trigger trg_checklist_forms_updated_at
  before update on public.checklist_forms
  for each row execute function private.set_updated_at();

drop trigger if exists trg_clf_items_updated_at on public.checklist_items;
create trigger trg_clf_items_updated_at
  before update on public.checklist_items
  for each row execute function private.set_updated_at();

drop trigger if exists trg_clf_assignments_updated_at on public.checklist_assignments;
create trigger trg_clf_assignments_updated_at
  before update on public.checklist_assignments
  for each row execute function private.set_updated_at();

drop trigger if exists trg_clf_submissions_updated_at on public.checklist_submissions;
create trigger trg_clf_submissions_updated_at
  before update on public.checklist_submissions
  for each row execute function private.set_updated_at();

drop trigger if exists trg_clf_answers_updated_at on public.checklist_answers;
create trigger trg_clf_answers_updated_at
  before update on public.checklist_answers
  for each row execute function private.set_updated_at();


-- ── 3. RLS — dispatcher+ staff read/write; drivers via RPCs only ──────

alter table public.checklist_forms       enable row level security;
alter table public.checklist_items       enable row level security;
alter table public.checklist_assignments enable row level security;
alter table public.checklist_submissions enable row level security;
alter table public.checklist_answers     enable row level security;

drop policy if exists "checklist_forms_rw" on public.checklist_forms;
create policy "checklist_forms_rw" on public.checklist_forms
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "clf_items_rw" on public.checklist_items;
create policy "clf_items_rw" on public.checklist_items
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "clf_assignments_rw" on public.checklist_assignments;
create policy "clf_assignments_rw" on public.checklist_assignments
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "clf_submissions_staff_r" on public.checklist_submissions;
create policy "clf_submissions_staff_r" on public.checklist_submissions
  for select to authenticated using (dsp_id = private.current_dsp_id());

drop policy if exists "clf_answers_staff_r" on public.checklist_answers;
create policy "clf_answers_staff_r" on public.checklist_answers
  for select to authenticated using (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.checklist_forms       to authenticated;
grant select, insert, update, delete on public.checklist_items       to authenticated;
grant select, insert, update, delete on public.checklist_assignments to authenticated;
grant select on public.checklist_submissions to authenticated;
grant select on public.checklist_answers     to authenticated;


-- ── 4. Private helpers — scope matching, period keys, due resolution ──

-- Does this assignment apply to this driver on this day?
create or replace function private.clf_assignment_applies(
  a public.checklist_assignments,
  d public.drivers,
  p_day date
) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
begin
  if a.dsp_id <> d.dsp_id then return false; end if;
  if a.assignment_scope = 'driver' then
    return a.driver_id = d.id;
  elsif a.assignment_scope = 'all_active' then
    return d.status = 'active';
  elsif a.assignment_scope = 'scheduled_today' then
    return exists (
      select 1 from public.shifts s
       where s.driver_id = d.id and s.date = p_day
         and s.status in ('scheduled','completed'));
  elsif a.assignment_scope = 'scheduled_date' then
    return a.route_date is not null and exists (
      select 1 from public.shifts s
       where s.driver_id = d.id and s.date = a.route_date
         and s.status in ('scheduled','completed'));
  elsif a.assignment_scope = 'van' then
    return exists (
      select 1 from public.vehicle_driver_assignments vda
       where vda.driver_id = d.id and vda.vehicle_id = a.van_id);
  elsif a.assignment_scope = 'route_type' then
    return exists (
      select 1 from public.shifts s
        join public.service_types st on st.id = s.service_type_id
       where s.driver_id = d.id and s.date = p_day
         and s.status in ('scheduled','completed')
         and lower(st.code) = lower(coalesce(a.route_type, '')));
  elsif a.assignment_scope = 'new_hires' then
    return d.status in ('onboarding','active') and d.hire_date >= p_day - 30;
  elsif a.assignment_scope = 'trainers' then
    return coalesce(d.tier, '') ilike '%train%'
        or lower(coalesce(d.metadata->>'trainer', d.metadata->>'is_trainer', '')) in ('true','1','yes');
  end if;
  return false;
end;
$$;

-- The submission period key for an assignment on a given day.
create or replace function private.clf_period_key(a public.checklist_assignments, p_day date)
returns date
language plpgsql stable security definer set search_path = ''
as $$
declare v_type text := coalesce(a.repeat_rule->>'type', 'once');
begin
  if v_type = 'daily'  then return p_day; end if;
  if v_type = 'weekly' then return date_trunc('week', p_day::timestamptz)::date; end if;
  if v_type = 'date'   then
    return coalesce(nullif(a.repeat_rule->>'date','')::date, a.route_date, p_day);
  end if;
  if a.assignment_scope = 'scheduled_date' then return a.route_date; end if;
  return null;  -- one-time
end;
$$;

-- Is the assignment inside its visibility window on p_day? (Repeating
-- assignments are always in-window; dated ones show from their date
-- through 7 days after so overdue work stays visible.)
create or replace function private.clf_in_window(a public.checklist_assignments, p_day date)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_type text := coalesce(a.repeat_rule->>'type', 'once');
  v_date date;
begin
  if v_type in ('daily','weekly') then return true; end if;
  if v_type = 'date' then
    v_date := coalesce(nullif(a.repeat_rule->>'date','')::date, a.route_date);
    if v_date is null then return true; end if;
    return p_day >= v_date and p_day <= v_date + 7;
  end if;
  if a.assignment_scope = 'scheduled_date' and a.route_date is not null then
    return p_day >= a.route_date and p_day <= a.route_date + 7;
  end if;
  return true;  -- one-time: visible until completed (list caps completed age)
end;
$$;

-- Resolve the due timestamp for a driver on a given day.
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
    begin
      return (p_day::text || ' ' || v_time)::timestamptz;
    exception when others then return null;
    end;
  end if;
  return a.due_at;  -- 'none' → fixed due_at if the admin set one, else null
end;
$$;

-- Compute an answer's failed flag from the item's flag rule.
create or replace function private.clf_answer_failed(
  i public.checklist_items,
  p_ans jsonb
) returns boolean
language plpgsql immutable security definer set search_path = ''
as $$
declare
  v_on  text := lower(coalesce(i.flag_rule_json->>'flag_on', ''));
  v_val text := lower(coalesce(p_ans->>'v', ''));
  v_num numeric;
begin
  if i.item_type = 'yes_no' and v_on in ('yes','no') then
    return v_val = v_on;
  elsif i.item_type = 'checkbox' and v_on = 'unchecked' then
    return v_val not in ('true','1','yes');
  elsif i.item_type = 'number' then
    begin v_num := nullif(p_ans->>'v','')::numeric; exception when others then v_num := null; end;
    if v_num is null then return false; end if;
    if nullif(i.flag_rule_json->>'min','') is not null and v_num < (i.flag_rule_json->>'min')::numeric then return true; end if;
    if nullif(i.flag_rule_json->>'max','') is not null and v_num > (i.flag_rule_json->>'max')::numeric then return true; end if;
  end if;
  return false;
end;
$$;

-- Shared writer for driver save/submit. Validates the assignment applies,
-- upserts the period submission, replaces answers, and (on submit)
-- enforces required items. p_answers: { "<item_id>": {"v": ..., "note": "...",
-- "photos": [...]}, ... }
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
  v_day  date := current_date;
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
    returning * into v_sub;
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


-- ── 5. Staff RPCs — builder CRUD ───────────────────────────────────────

-- One checklist with items + assignments (names resolved for the UI).
create or replace function public.checklist_form_get(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select to_jsonb(t) || jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(to_jsonb(i) order by i.sort_order, i.created_at)
        from public.checklist_items i where i.template_id = t.id
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(
        to_jsonb(a) || jsonb_build_object(
          'driver_name', (select d.full_name from public.drivers d where d.id = a.driver_id),
          'van_name',    (select v.name from public.vehicles v where v.id = a.van_id)
        ) order by a.created_at desc)
        from public.checklist_assignments a
       where a.template_id = t.id and a.status <> 'archived'
    ), '[]'::jsonb)
  ) into v_out
  from public.checklist_forms t
  where t.id = p_id and t.dsp_id = v_dsp;
  if v_out is null then raise exception 'checklist_not_found' using errcode = 'P0002'; end if;
  return v_out;
end;
$$;
grant execute on function public.checklist_form_get(uuid) to authenticated;


-- Upsert a checklist + replace its items in one call (Form-Builder-style
-- single save). p_payload: { name, description, category, reusable,
-- settings, items: [ { id?, label, helper_text, item_type, required,
-- options_json, flag_rule_json } ... ] } — items land in array order.
create or replace function public.checklist_form_upsert(p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl public.checklist_forms;
  v_item jsonb;
  v_idx int := 0;
  v_item_id uuid;
  v_keep uuid[] := '{}';
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  if p_id is null then
    insert into public.checklist_forms (dsp_id, name, description, category, reusable, settings, created_by)
    values (
      v_dsp,
      coalesce(nullif(trim(coalesce(p_payload->>'name','')), ''), 'Untitled checklist'),
      nullif(trim(coalesce(p_payload->>'description','')), ''),
      coalesce(nullif(trim(coalesce(p_payload->>'category','')), ''), 'Driver App Forms'),
      coalesce((p_payload->>'reusable')::boolean, true),
      coalesce(p_payload->'settings', '{}'::jsonb),
      auth.uid()
    ) returning * into v_tpl;
  else
    update public.checklist_forms
       set name        = coalesce(nullif(trim(coalesce(p_payload->>'name','')), ''), name),
           description = case when p_payload ? 'description' then nullif(trim(coalesce(p_payload->>'description','')), '') else description end,
           category    = coalesce(nullif(trim(coalesce(p_payload->>'category','')), ''), category),
           reusable    = coalesce((p_payload->>'reusable')::boolean, reusable),
           settings    = coalesce(p_payload->'settings', settings)
     where id = p_id and dsp_id = v_dsp
     returning * into v_tpl;
    if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0002'; end if;
  end if;

  if p_payload ? 'items' then
    for v_item in select * from jsonb_array_elements(coalesce(p_payload->'items', '[]'::jsonb))
    loop
      v_item_id := null;
      begin v_item_id := nullif(v_item->>'id','')::uuid; exception when others then v_item_id := null; end;

      if v_item_id is not null and exists (
        select 1 from public.checklist_items
         where id = v_item_id and template_id = v_tpl.id and dsp_id = v_dsp
      ) then
        update public.checklist_items
           set label          = coalesce(v_item->>'label', ''),
               helper_text    = nullif(trim(coalesce(v_item->>'helper_text','')), ''),
               item_type      = coalesce(nullif(v_item->>'item_type',''), item_type),
               required       = coalesce((v_item->>'required')::boolean, false),
               options_json   = coalesce(v_item->'options_json', '{}'::jsonb),
               flag_rule_json = coalesce(v_item->'flag_rule_json', '{}'::jsonb),
               sort_order     = v_idx
         where id = v_item_id;
      else
        insert into public.checklist_items
          (template_id, dsp_id, label, helper_text, item_type, required, options_json, flag_rule_json, sort_order)
        values (
          v_tpl.id, v_dsp,
          coalesce(v_item->>'label', ''),
          nullif(trim(coalesce(v_item->>'helper_text','')), ''),
          coalesce(nullif(v_item->>'item_type',''), 'checkbox'),
          coalesce((v_item->>'required')::boolean, false),
          coalesce(v_item->'options_json', '{}'::jsonb),
          coalesce(v_item->'flag_rule_json', '{}'::jsonb),
          v_idx
        ) returning id into v_item_id;
      end if;

      v_keep := v_keep || v_item_id;
      v_idx := v_idx + 1;
    end loop;

    delete from public.checklist_items
     where template_id = v_tpl.id and not (id = any(v_keep));
  end if;

  -- touch updated_at even when only items changed
  update public.checklist_forms set updated_at = now() where id = v_tpl.id returning * into v_tpl;

  return public.checklist_form_get(v_tpl.id);
end;
$$;
grant execute on function public.checklist_form_upsert(uuid, jsonb) to authenticated;


-- Sidebar list: every checklist with counts + a completion summary.
create or replace function public.checklist_form_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(row_to_json(t)::jsonb order by t.updated_at desc)
    from (
      select
        f.id, f.name, f.description, f.category, f.status, f.version, f.reusable,
        f.created_at, f.updated_at, f.published_at, f.archived_at,
        (select count(*)::int from public.checklist_items i where i.template_id = f.id) as item_count,
        (select count(*)::int from public.checklist_assignments a
          where a.template_id = f.id and a.status = 'active') as active_assignments,
        (select count(distinct s.driver_id)::int from public.checklist_submissions s
          where s.template_id = f.id and s.status = 'submitted'
            and s.submitted_at >= date_trunc('day', now())) as submitted_today,
        (select count(*)::int from public.checklist_submissions s
          where s.template_id = f.id and s.status in ('in_progress','reopened')) as in_progress_count,
        (select count(*)::int from public.checklist_submissions s
          where s.template_id = f.id and s.status in ('in_progress','reopened')
            and s.due_at is not null and s.due_at < now()) as overdue_count,
        (select count(*)::int from public.checklist_answers ans
           join public.checklist_submissions s on s.id = ans.submission_id
          where s.template_id = f.id and ans.failed_flag
            and s.created_at >= date_trunc('day', now())) as failed_today,
        (select max(s.submitted_at) from public.checklist_submissions s
          where s.template_id = f.id) as last_submission_at
      from public.checklist_forms f
      where f.dsp_id = v_dsp
    ) t
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.checklist_form_list() to authenticated;


-- Publish / unpublish / archive / restore.
create or replace function public.checklist_form_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl public.checklist_forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('draft','active','archived') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  update public.checklist_forms
     set status       = p_status,
         published_at = case when p_status = 'active' then now() else published_at end,
         version      = case when p_status = 'active' and published_at is not null then version + 1 else version end,
         archived_at  = case when p_status = 'archived' then now() else null end
   where id = p_id and dsp_id = v_dsp
   returning * into v_tpl;
  if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0002'; end if;
  return to_jsonb(v_tpl);
end;
$$;
grant execute on function public.checklist_form_set_status(uuid, text) to authenticated;


-- Deep-copy a checklist (items included) as a new draft.
create or replace function public.checklist_form_duplicate(p_id uuid, p_new_name text default null)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_src public.checklist_forms;
  v_new public.checklist_forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_src from public.checklist_forms where id = p_id and dsp_id = v_dsp;
  if v_src.id is null then raise exception 'checklist_not_found' using errcode = 'P0002'; end if;

  insert into public.checklist_forms (dsp_id, name, description, category, reusable, settings, created_by)
  values (v_dsp,
          coalesce(nullif(trim(coalesce(p_new_name,'')), ''), v_src.name || ' (copy)'),
          v_src.description, v_src.category, v_src.reusable, v_src.settings, auth.uid())
  returning * into v_new;

  insert into public.checklist_items
    (template_id, dsp_id, label, helper_text, item_type, required, options_json, flag_rule_json, sort_order)
  select v_new.id, v_dsp, label, helper_text, item_type, required, options_json, flag_rule_json, sort_order
    from public.checklist_items where template_id = v_src.id;

  return public.checklist_form_get(v_new.id);
end;
$$;
grant execute on function public.checklist_form_duplicate(uuid, text) to authenticated;


create or replace function public.checklist_form_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.checklist_forms where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_form_delete(uuid) to authenticated;


-- Create assignment(s). p_assignments: array of
-- { assignment_scope, driver_ids?, route_date?, van_id?, route_type?,
--   repeat_rule?, due_at?, required? }. Scope 'driver' + driver_ids fans
-- out to one row per driver.
create or replace function public.checklist_form_assign(p_template_id uuid, p_assignments jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl public.checklist_forms;
  v_a jsonb;
  v_scope text;
  v_driver uuid;
  v_created int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_tpl from public.checklist_forms where id = p_template_id and dsp_id = v_dsp;
  if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0002'; end if;

  for v_a in select * from jsonb_array_elements(coalesce(p_assignments, '[]'::jsonb))
  loop
    v_scope := coalesce(v_a->>'assignment_scope', 'driver');
    if v_scope = 'driver' then
      for v_driver in
        select d.id from public.drivers d
         where d.dsp_id = v_dsp
           and d.id in (select nullif(x,'')::uuid from jsonb_array_elements_text(coalesce(v_a->'driver_ids','[]'::jsonb)) x)
      loop
        insert into public.checklist_assignments
          (template_id, dsp_id, assigned_by, assignment_scope, driver_id, repeat_rule, due_at, required)
        values (p_template_id, v_dsp, auth.uid(), 'driver', v_driver,
                v_a->'repeat_rule',
                nullif(v_a->>'due_at','')::timestamptz,
                coalesce((v_a->>'required')::boolean, true));
        v_created := v_created + 1;
      end loop;
    else
      insert into public.checklist_assignments
        (template_id, dsp_id, assigned_by, assignment_scope, route_date, van_id, route_type, repeat_rule, due_at, required)
      values (p_template_id, v_dsp, auth.uid(), v_scope,
              nullif(v_a->>'route_date','')::date,
              nullif(v_a->>'van_id','')::uuid,
              nullif(v_a->>'route_type',''),
              v_a->'repeat_rule',
              nullif(v_a->>'due_at','')::timestamptz,
              coalesce((v_a->>'required')::boolean, true));
      v_created := v_created + 1;
    end if;
  end loop;

  return jsonb_build_object('created', v_created);
end;
$$;
grant execute on function public.checklist_form_assign(uuid, jsonb) to authenticated;


create or replace function public.checklist_assignment_set_status(p_id uuid, p_status text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active','paused','archived') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  update public.checklist_assignments set status = p_status where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_assignment_set_status(uuid, text) to authenticated;


-- Responses view for the admin: recent submissions with answers, plus
-- today's expected-roster resolution per active assignment (who should
-- fill it today and where they stand — including Not started/Overdue).
create or replace function public.checklist_form_responses(p_template_id uuid, p_days int default 14)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_subs jsonb;
  v_today jsonb;
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
    into v_today
  from (
    select
      a.id as assignment_id,
      a.assignment_scope as scope,
      d.id as driver_id,
      d.full_name as driver_name,
      private.clf_due_for(a, d.id, current_date) as due_at,
      coalesce(s.status, 'not_started') as status,
      (coalesce(s.status, 'not_started') <> 'submitted'
        and private.clf_due_for(a, d.id, current_date) is not null
        and private.clf_due_for(a, d.id, current_date) < now()) as overdue
    from public.checklist_assignments a
    join public.drivers d
      on d.dsp_id = a.dsp_id and d.status in ('onboarding','active','leave')
     and private.clf_assignment_applies(a, d, current_date)
    left join public.checklist_submissions s
      on s.assignment_id = a.id and s.driver_id = d.id
     and coalesce(s.period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(a, current_date), '0001-01-01'::date)
    where a.template_id = p_template_id and a.dsp_id = v_dsp
      and a.status = 'active'
      and private.clf_in_window(a, current_date)
  ) t;

  return jsonb_build_object('submissions', v_subs, 'today', coalesce(v_today, '[]'::jsonb));
end;
$$;
grant execute on function public.checklist_form_responses(uuid, int) to authenticated;


-- Reopen a submitted checklist so the driver can correct it.
create or replace function public.checklist_submission_reopen(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_submissions
     set status = 'reopened', reopened_at = now()
   where id = p_id and dsp_id = v_dsp and status = 'submitted';
end;
$$;
grant execute on function public.checklist_submission_reopen(uuid) to authenticated;


-- ── 6. Driver RPCs (anon + token, like driver_list_forms) ──────────────

create or replace function public.driver_list_checklists(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
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
        private.clf_due_for(a, v_drv.id, current_date) as due_at,
        s.submitted_at,
        case
          when s.status = 'submitted' then 'completed'
          when coalesce(s.status,'') in ('in_progress','reopened')
            or coalesce(s.status,'') = '' then
            case
              when private.clf_due_for(a, v_drv.id, current_date) is not null
               and private.clf_due_for(a, v_drv.id, current_date) < now() then 'overdue'
              when s.id is null then 'not_started'
              else 'in_progress'
            end
        end as status
      from public.checklist_assignments a
      join public.checklist_forms f on f.id = a.template_id and f.status = 'active'
      left join public.checklist_submissions s
        on s.assignment_id = a.id and s.driver_id = v_drv.id
       and coalesce(s.period_key, '0001-01-01'::date)
           = coalesce(private.clf_period_key(a, current_date), '0001-01-01'::date)
      where a.dsp_id = v_drv.dsp_id
        and a.status = 'active'
        and private.clf_assignment_applies(a, v_drv, current_date)
        and private.clf_in_window(a, current_date)
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


create or replace function public.driver_get_checklist(p_token text, p_assignment_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_a   public.checklist_assignments;
  v_tpl public.checklist_forms;
  v_sub public.checklist_submissions;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_a from public.checklist_assignments
   where id = p_assignment_id and dsp_id = v_drv.dsp_id and status = 'active';
  if v_a.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  select * into v_tpl from public.checklist_forms where id = v_a.template_id and status = 'active';
  if v_tpl.id is null then raise exception 'checklist_not_found' using errcode = 'P0001'; end if;
  if not private.clf_assignment_applies(v_a, v_drv, current_date) then
    raise exception 'checklist_not_found' using errcode = 'P0001';
  end if;

  select * into v_sub from public.checklist_submissions
   where assignment_id = v_a.id and driver_id = v_drv.id
     and coalesce(period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(v_a, current_date), '0001-01-01'::date);

  return jsonb_build_object(
    'assignment_id', v_a.id,
    'template_id',   v_tpl.id,
    'name',          v_tpl.name,
    'description',   v_tpl.description,
    'required',      v_a.required,
    'due_at',        private.clf_due_for(v_a, v_drv.id, current_date),
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


create or replace function public.driver_save_checklist(p_token text, p_assignment_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return private.clf_write_submission(v_drv, p_assignment_id, coalesce(p_answers, '{}'::jsonb), false);
end;
$$;
grant execute on function public.driver_save_checklist(text, uuid, jsonb) to anon, authenticated;


create or replace function public.driver_submit_checklist(p_token text, p_assignment_id uuid, p_answers jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);
  return private.clf_write_submission(v_drv, p_assignment_id, coalesce(p_answers, '{}'::jsonb), true);
end;
$$;
grant execute on function public.driver_submit_checklist(text, uuid, jsonb) to anon, authenticated;


notify pgrst, 'reload schema';
