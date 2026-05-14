-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0212 · Checklist Runner (Phase 3)
--
-- Brings the Workspaces → Checklists experience end-to-end. Templates
-- (migration 0211) get "launched" into checklist_instances, which a
-- driver / dispatcher works through item-by-item. Every check-off is
-- autosaved + attributed.
--
-- Design notes:
--   * Instance items snapshot the section + item labels at launch time
--     so editing or deleting a template doesn't reach back and mutate a
--     running checklist.
--   * Item completion is two-state (completed_at null vs not). Status
--     on the parent instance is 'active' | 'completed' | 'archived'.
--   * "completed" flips automatically the moment every required item
--     is checked. The dispatcher can also flip back to active by
--     unchecking a required item (lazy reconciliation).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ─────────────────────────────────────────────────────────

create table if not exists public.checklist_instances (
  id                uuid          primary key default gen_random_uuid(),
  dsp_id            uuid          not null references public.dsps(id) on delete cascade,
  template_id       uuid          references public.checklist_templates(id) on delete set null,
  name              text          not null,
  status            text          not null default 'active'
                    check (status in ('active','completed','archived')),
  assigned_user_id  uuid          references auth.users(id) on delete set null,
  due_at            timestamptz,
  started_at        timestamptz   not null default now(),
  completed_at      timestamptz,
  created_by        uuid          references auth.users(id) on delete set null,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);
create index if not exists checklist_instances_dsp_idx
  on public.checklist_instances (dsp_id, status, due_at);
create index if not exists checklist_instances_assigned_idx
  on public.checklist_instances (assigned_user_id) where status = 'active';

create table if not exists public.checklist_instance_items (
  id                uuid          primary key default gen_random_uuid(),
  instance_id       uuid          not null references public.checklist_instances(id) on delete cascade,
  dsp_id            uuid          not null references public.dsps(id) on delete cascade,
  template_item_id  uuid          references public.checklist_template_items(id) on delete set null,
  section_label     text,
  label             text          not null,
  instructions      text,
  required          boolean       not null default false,
  position          int           not null default 0,
  completed_at      timestamptz,
  completed_by      uuid          references auth.users(id) on delete set null,
  note              text,
  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);
create index if not exists checklist_instance_items_instance_idx
  on public.checklist_instance_items (instance_id, position);


-- ── 2. updated_at triggers ────────────────────────────────────────────

drop trigger if exists trg_checklist_instances_updated_at on public.checklist_instances;
create trigger trg_checklist_instances_updated_at
  before update on public.checklist_instances
  for each row execute function private.set_updated_at();

drop trigger if exists trg_checklist_instance_items_updated_at on public.checklist_instance_items;
create trigger trg_checklist_instance_items_updated_at
  before update on public.checklist_instance_items
  for each row execute function private.set_updated_at();


-- ── 3. RLS ────────────────────────────────────────────────────────────

alter table public.checklist_instances      enable row level security;
alter table public.checklist_instance_items enable row level security;

drop policy if exists "checklist_instances_rw" on public.checklist_instances;
create policy "checklist_instances_rw" on public.checklist_instances
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "checklist_instance_items_rw" on public.checklist_instance_items;
create policy "checklist_instance_items_rw" on public.checklist_instance_items
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.checklist_instances      to authenticated;
grant select, insert, update, delete on public.checklist_instance_items to authenticated;


-- ── 4. Helper · reconcile status from item completion ─────────────────
-- Called from every item toggle. If every required item is checked,
-- flip the parent instance to 'completed' (and stamp completed_at). If
-- a required item is later unchecked, drop back to 'active'. Manually-
-- archived instances are left alone.
create or replace function private.checklist_instance_reconcile(p_instance_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_total_required int;
  v_done_required  int;
  v_cur_status     text;
begin
  select status into v_cur_status from public.checklist_instances where id = p_instance_id;
  if v_cur_status is null or v_cur_status = 'archived' then return; end if;

  select count(*) filter (where required),
         count(*) filter (where required and completed_at is not null)
    into v_total_required, v_done_required
  from public.checklist_instance_items where instance_id = p_instance_id;

  if v_total_required > 0 and v_done_required = v_total_required then
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


-- ── 5. RPC · launch (snapshot template → instance) ────────────────────
create or replace function public.checklist_instance_launch(
  p_template_id uuid,
  p_name text default null,
  p_assigned_user_id uuid default null,
  p_due_at timestamptz default null
) returns public.checklist_instances
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl public.checklist_templates;
  v_inst public.checklist_instances;
  v_pos int := 0;
  v_section record;
  v_item record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_tpl from public.checklist_templates where id = p_template_id and dsp_id = v_dsp;
  if v_tpl.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;

  insert into public.checklist_instances (dsp_id, template_id, name, assigned_user_id, due_at, created_by)
    values (v_dsp, v_tpl.id,
            coalesce(nullif(trim(coalesce(p_name, '')), ''), v_tpl.name),
            p_assigned_user_id, p_due_at, auth.uid())
    returning * into v_inst;

  -- Snapshot the template's sections + items, preserving order
  for v_section in
    select id, label, position from public.checklist_template_sections
    where template_id = v_tpl.id order by position, created_at
  loop
    for v_item in
      select id, label, instructions, required, position
      from public.checklist_template_items
      where section_id = v_section.id order by position, created_at
    loop
      insert into public.checklist_instance_items
        (instance_id, dsp_id, template_item_id, section_label, label, instructions, required, position)
      values
        (v_inst.id, v_dsp, v_item.id, v_section.label, v_item.label, v_item.instructions, v_item.required, v_pos);
      v_pos := v_pos + 1;
    end loop;
  end loop;

  return v_inst;
end;
$$;
grant execute on function public.checklist_instance_launch(uuid, text, uuid, timestamptz) to authenticated;


-- ── 6. RPC · list instances (with filters + search) ──────────────────
create or replace function public.checklist_instance_list(
  p_status text default null,            -- 'active' | 'completed' | 'archived' | null=all-non-archived
  p_assigned_to_me_only boolean default false,
  p_search text default null,
  p_limit int default 50,
  p_offset int default 0
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_q   text := nullif(trim(coalesce(p_search, '')), '');
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(c)::jsonb order by c.due_at nulls last, c.started_at desc), '[]'::jsonb) into v_out
  from (
    select
      i.id, i.template_id, i.name, i.status, i.assigned_user_id,
      i.due_at, i.started_at, i.completed_at, i.created_at, i.updated_at,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id) as item_count,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id and it.completed_at is not null) as completed_count,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id and it.required) as required_count,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id and it.required and it.completed_at is not null) as required_completed_count,
      au.email as assigned_email
    from public.checklist_instances i
    left join auth.users au on au.id = i.assigned_user_id
    where i.dsp_id = v_dsp
      and (p_status is not null and i.status = p_status
           or p_status is null and i.status in ('active','completed'))
      and (not p_assigned_to_me_only or i.assigned_user_id = v_uid)
      and (v_q is null or i.name ilike '%' || v_q || '%')
    order by
      case when i.status = 'active' then 0 else 1 end,
      i.due_at nulls last,
      i.started_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0))
  ) c;
  return v_out;
end;
$$;
grant execute on function public.checklist_instance_list(text, boolean, text, int, int) to authenticated;


-- ── 7. RPC · get one instance with all items (nested) ────────────────
create or replace function public.checklist_instance_get(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select to_jsonb(i) ||
         jsonb_build_object(
           'assigned_email', (select email from auth.users where id = i.assigned_user_id),
           'items', coalesce((
             select jsonb_agg(
               to_jsonb(it) || jsonb_build_object(
                 'completed_by_email', (select email from auth.users where id = it.completed_by)
               )
               order by it.position, it.created_at
             )
             from public.checklist_instance_items it
             where it.instance_id = i.id
           ), '[]'::jsonb)
         )
    into v_out
  from public.checklist_instances i
  where i.dsp_id = v_dsp and i.id = p_id;
  if v_out is null then raise exception 'instance_not_found' using errcode = 'P0002'; end if;
  return v_out;
end;
$$;
grant execute on function public.checklist_instance_get(uuid) to authenticated;


-- ── 8. RPC · update instance (name / assignee / due) ─────────────────
create or replace function public.checklist_instance_update(
  p_id uuid,
  p_name text default null,
  p_assigned_user_id uuid default null,
  p_due_at timestamptz default null,
  p_clear_assignee boolean default false,
  p_clear_due boolean default false
) returns public.checklist_instances
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_i public.checklist_instances;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_instances
     set name             = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         assigned_user_id = case when p_clear_assignee then null
                                 when p_assigned_user_id is null then assigned_user_id
                                 else p_assigned_user_id end,
         due_at           = case when p_clear_due then null
                                 when p_due_at is null then due_at
                                 else p_due_at end
   where id = p_id and dsp_id = v_dsp
   returning * into v_i;
  if v_i.id is null then raise exception 'instance_not_found' using errcode = 'P0002'; end if;
  return v_i;
end;
$$;
grant execute on function public.checklist_instance_update(uuid, text, uuid, timestamptz, boolean, boolean) to authenticated;


-- ── 9. RPC · toggle an item complete/incomplete ──────────────────────
create or replace function public.checklist_instance_item_toggle(
  p_item_id uuid,
  p_completed boolean default null,
  p_note text default null
) returns public.checklist_instance_items
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_it  public.checklist_instance_items;
  v_target boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_it from public.checklist_instance_items where id = p_item_id and dsp_id = v_dsp;
  if v_it.id is null then raise exception 'item_not_found' using errcode = 'P0002'; end if;

  v_target := coalesce(p_completed, v_it.completed_at is null);

  update public.checklist_instance_items
     set completed_at = case when v_target then now() else null end,
         completed_by = case when v_target then v_uid else null end,
         note         = case when p_note is null then note else nullif(trim(p_note), '') end
   where id = p_item_id
   returning * into v_it;

  perform private.checklist_instance_reconcile(v_it.instance_id);
  return v_it;
end;
$$;
grant execute on function public.checklist_instance_item_toggle(uuid, boolean, text) to authenticated;


-- ── 10. RPC · archive / unarchive an instance ────────────────────────
create or replace function public.checklist_instance_archive(p_id uuid, p_archived boolean default true)
returns public.checklist_instances
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_i public.checklist_instances;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_instances
     set status = case when p_archived then 'archived'
                       else (case when completed_at is not null then 'completed' else 'active' end) end
   where id = p_id and dsp_id = v_dsp
   returning * into v_i;
  if v_i.id is null then raise exception 'instance_not_found' using errcode = 'P0002'; end if;
  return v_i;
end;
$$;
grant execute on function public.checklist_instance_archive(uuid, boolean) to authenticated;


-- ── 11. RPC · Today's status rollup ──────────────────────────────────
-- Powers the Today's Status sub-tab. Buckets every active instance into
-- overdue / due_today / in_progress + returns simple counters.
create or replace function public.checklist_instance_today_summary()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_today_end timestamptz;
  v_buckets jsonb;
  v_totals jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_today_end := date_trunc('day', now()) + interval '1 day';

  with active as (
    select
      i.id, i.name, i.assigned_user_id, i.due_at, i.started_at,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id) as item_count,
      (select count(*) from public.checklist_instance_items it where it.instance_id = i.id and it.completed_at is not null) as completed_count,
      au.email as assigned_email,
      case
        when i.due_at is not null and i.due_at < now() then 'overdue'
        when i.due_at is not null and i.due_at < v_today_end then 'due_today'
        else 'in_progress'
      end as bucket
    from public.checklist_instances i
    left join auth.users au on au.id = i.assigned_user_id
    where i.dsp_id = v_dsp and i.status = 'active'
  )
  select
    jsonb_build_object(
      'overdue',     coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.due_at) filter (where a.bucket = 'overdue'),    '[]'::jsonb),
      'due_today',   coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.due_at) filter (where a.bucket = 'due_today'),  '[]'::jsonb),
      'in_progress', coalesce(jsonb_agg(row_to_json(a)::jsonb order by a.started_at desc) filter (where a.bucket = 'in_progress'), '[]'::jsonb)
    ),
    jsonb_build_object(
      'active',    count(*),
      'overdue',   count(*) filter (where bucket = 'overdue'),
      'due_today', count(*) filter (where bucket = 'due_today')
    )
  into v_buckets, v_totals
  from active a;

  return jsonb_build_object('buckets', v_buckets, 'totals', v_totals, 'generated_at', now());
end;
$$;
grant execute on function public.checklist_instance_today_summary() to authenticated;


-- ── 12. RPC · list dispatcher team members for the assignee picker ───
create or replace function public.checklist_team_members()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'email', au.email, 'role', u.role)
                            order by au.email), '[]'::jsonb)
    into v_out
  from public.app_users u
  left join auth.users au on au.id = u.id
  where u.dsp_id = v_dsp and u.active = true;
  return v_out;
end;
$$;
grant execute on function public.checklist_team_members() to authenticated;


notify pgrst, 'reload schema';
