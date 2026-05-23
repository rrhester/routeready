-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0211 · Checklist Builder (Phase 2)
--
-- The schema for reusable checklist templates. A template has sections,
-- a section has items. Each level supports inline editing, drag-to-
-- reorder, duplicate, archive — all wired up through the RPCs below.
--
-- Phase 3 (live runner with assignments + autosave completion tracking)
-- will add checklist_instances + checklist_instance_items in a follow-
-- up migration.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Tables ─────────────────────────────────────────────────────────

create table if not exists public.checklist_templates (
  id          uuid          primary key default gen_random_uuid(),
  dsp_id      uuid          not null references public.dsps(id) on delete cascade,
  name        text          not null,
  description text,
  icon        text,                                  -- optional icon/color key
  position    int           not null default 0,      -- order in the picker
  archived_at timestamptz,
  created_by  uuid          references auth.users(id) on delete set null,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);
create index if not exists checklist_templates_dsp_idx
  on public.checklist_templates (dsp_id, archived_at, position);

create table if not exists public.checklist_template_sections (
  id          uuid          primary key default gen_random_uuid(),
  template_id uuid          not null references public.checklist_templates(id) on delete cascade,
  dsp_id      uuid          not null references public.dsps(id) on delete cascade,  -- denormalized for RLS
  label       text          not null,
  description text,                                  -- optional section notes
  position    int           not null default 0,
  created_at  timestamptz   not null default now(),
  updated_at  timestamptz   not null default now()
);
create index if not exists checklist_sections_template_idx
  on public.checklist_template_sections (template_id, position);

create table if not exists public.checklist_template_items (
  id           uuid          primary key default gen_random_uuid(),
  section_id   uuid          not null references public.checklist_template_sections(id) on delete cascade,
  template_id  uuid          not null references public.checklist_templates(id) on delete cascade,  -- denormalized for query perf
  dsp_id       uuid          not null references public.dsps(id) on delete cascade,                  -- denormalized for RLS
  label        text          not null,
  instructions text,                                  -- longer-form notes / how-to
  required     boolean       not null default false,
  due_offset_hours int,                               -- when due relative to checklist start (null = none)
  default_assignee_role text,                         -- 'dispatcher' | 'driver' | null (overrides come at runner time)
  position     int           not null default 0,
  created_at   timestamptz   not null default now(),
  updated_at   timestamptz   not null default now()
);
create index if not exists checklist_items_section_idx
  on public.checklist_template_items (section_id, position);


-- ── 2. updated_at triggers ────────────────────────────────────────────
-- Idempotent: drop-if-exists before create so CI replays don't fail
-- with SQLSTATE 42710. See PR #1571 for full context.

drop trigger if exists trg_checklist_templates_updated_at on public.checklist_templates;
create trigger trg_checklist_templates_updated_at
  before update on public.checklist_templates
  for each row execute function private.set_updated_at();

drop trigger if exists trg_checklist_sections_updated_at on public.checklist_template_sections;
create trigger trg_checklist_sections_updated_at
  before update on public.checklist_template_sections
  for each row execute function private.set_updated_at();

drop trigger if exists trg_checklist_items_updated_at on public.checklist_template_items;
create trigger trg_checklist_items_updated_at
  before update on public.checklist_template_items
  for each row execute function private.set_updated_at();


-- ── 3. RLS — dispatcher+ on the DSP can read/write ────────────────────

alter table public.checklist_templates         enable row level security;
alter table public.checklist_template_sections enable row level security;
alter table public.checklist_template_items    enable row level security;

drop policy if exists "checklist_templates_rw" on public.checklist_templates;
create policy "checklist_templates_rw" on public.checklist_templates
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "checklist_sections_rw" on public.checklist_template_sections;
create policy "checklist_sections_rw" on public.checklist_template_sections
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

drop policy if exists "checklist_items_rw" on public.checklist_template_items;
create policy "checklist_items_rw" on public.checklist_template_items
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.checklist_templates         to authenticated;
grant select, insert, update, delete on public.checklist_template_sections to authenticated;
grant select, insert, update, delete on public.checklist_template_items    to authenticated;


-- ─────────────────────────────────────────────────────────────────────
--  RPCs — staff (dispatcher+) template CRUD
-- ─────────────────────────────────────────────────────────────────────

-- ── 4. list templates ────────────────────────────────────────────────
create or replace function public.checklist_template_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.archived_at nulls first, t.position, t.created_at), '[]'::jsonb)
    into v_out
  from (
    select
      tpl.id, tpl.name, tpl.description, tpl.icon, tpl.position,
      tpl.archived_at, tpl.created_at, tpl.updated_at,
      (select count(*) from public.checklist_template_sections s where s.template_id = tpl.id) as section_count,
      (select count(*) from public.checklist_template_items i where i.template_id = tpl.id) as item_count
    from public.checklist_templates tpl
    where tpl.dsp_id = v_dsp
  ) t;
  return v_out;
end;
$$;
grant execute on function public.checklist_template_list() to authenticated;


-- ── 5. get a single template (with sections + items, nested) ─────────
create or replace function public.checklist_template_get(p_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select to_jsonb(tpl) ||
         jsonb_build_object(
           'sections', coalesce((
             select jsonb_agg(
               to_jsonb(s) || jsonb_build_object(
                 'items', coalesce((
                   select jsonb_agg(to_jsonb(i) order by i.position, i.created_at)
                   from public.checklist_template_items i
                   where i.section_id = s.id
                 ), '[]'::jsonb)
               )
               order by s.position, s.created_at
             )
             from public.checklist_template_sections s
             where s.template_id = tpl.id
           ), '[]'::jsonb)
         )
    into v_tpl
  from public.checklist_templates tpl
  where tpl.dsp_id = v_dsp and tpl.id = p_id;
  if v_tpl is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return v_tpl;
end;
$$;
grant execute on function public.checklist_template_get(uuid) to authenticated;


-- ── 6. create a new template (blank by default) ──────────────────────
create or replace function public.checklist_template_create(p_name text default null, p_description text default null)
returns public.checklist_templates
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_pos int;
  v_t   public.checklist_templates;
  v_name text := nullif(trim(coalesce(p_name, '')), '');
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(max(position), -1) + 1 into v_pos from public.checklist_templates where dsp_id = v_dsp;
  insert into public.checklist_templates (dsp_id, name, description, position, created_by)
    values (v_dsp, coalesce(v_name, 'Untitled checklist'), nullif(trim(coalesce(p_description, '')), ''), v_pos, auth.uid())
    returning * into v_t;
  return v_t;
end;
$$;
grant execute on function public.checklist_template_create(text, text) to authenticated;


-- ── 7. patch metadata (name / description / icon) ────────────────────
create or replace function public.checklist_template_update(
  p_id uuid,
  p_name text default null,
  p_description text default null,
  p_icon text default null
) returns public.checklist_templates
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_t public.checklist_templates;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_templates
     set name        = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
         description = case when p_description is null then description else nullif(trim(p_description), '') end,
         icon        = case when p_icon        is null then icon        else nullif(trim(p_icon),        '') end
   where id = p_id and dsp_id = v_dsp
   returning * into v_t;
  if v_t.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return v_t;
end;
$$;
grant execute on function public.checklist_template_update(uuid, text, text, text) to authenticated;


-- ── 8. archive / unarchive ───────────────────────────────────────────
create or replace function public.checklist_template_archive(p_id uuid, p_archived boolean default true)
returns public.checklist_templates
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_t public.checklist_templates;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_templates
     set archived_at = case when p_archived then now() else null end
   where id = p_id and dsp_id = v_dsp
   returning * into v_t;
  if v_t.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  return v_t;
end;
$$;
grant execute on function public.checklist_template_archive(uuid, boolean) to authenticated;


-- ── 9. duplicate (deep copy template + sections + items) ─────────────
create or replace function public.checklist_template_duplicate(p_id uuid, p_new_name text default null)
returns public.checklist_templates
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_src public.checklist_templates;
  v_new public.checklist_templates;
  v_pos int;
  v_section public.checklist_template_sections;
  v_new_section_id uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_src from public.checklist_templates where id = p_id and dsp_id = v_dsp;
  if v_src.id is null then raise exception 'template_not_found' using errcode = 'P0002'; end if;

  select coalesce(max(position), -1) + 1 into v_pos from public.checklist_templates where dsp_id = v_dsp;

  insert into public.checklist_templates (dsp_id, name, description, icon, position, created_by)
    values (v_dsp,
            coalesce(nullif(trim(coalesce(p_new_name, '')), ''), v_src.name || ' (copy)'),
            v_src.description, v_src.icon, v_pos, auth.uid())
    returning * into v_new;

  -- Copy sections, then their items
  for v_section in
    select * from public.checklist_template_sections where template_id = p_id order by position, created_at
  loop
    insert into public.checklist_template_sections (template_id, dsp_id, label, description, position)
      values (v_new.id, v_dsp, v_section.label, v_section.description, v_section.position)
      returning id into v_new_section_id;

    insert into public.checklist_template_items
      (section_id, template_id, dsp_id, label, instructions, required, due_offset_hours, default_assignee_role, position)
    select
      v_new_section_id, v_new.id, v_dsp, label, instructions, required, due_offset_hours, default_assignee_role, position
    from public.checklist_template_items where section_id = v_section.id;
  end loop;

  return v_new;
end;
$$;
grant execute on function public.checklist_template_duplicate(uuid, text) to authenticated;


-- ── 10. section · create ─────────────────────────────────────────────
create or replace function public.checklist_section_create(
  p_template_id uuid,
  p_label text default null,
  p_position int default null
) returns public.checklist_template_sections
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_s public.checklist_template_sections;
  v_pos int := p_position;
  v_owned boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select exists(select 1 from public.checklist_templates where id = p_template_id and dsp_id = v_dsp) into v_owned;
  if not v_owned then raise exception 'template_not_found' using errcode = 'P0002'; end if;

  if v_pos is null then
    select coalesce(max(position), -1) + 1 into v_pos from public.checklist_template_sections where template_id = p_template_id;
  end if;

  insert into public.checklist_template_sections (template_id, dsp_id, label, position)
    values (p_template_id, v_dsp, coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Section'), v_pos)
    returning * into v_s;
  return v_s;
end;
$$;
grant execute on function public.checklist_section_create(uuid, text, int) to authenticated;


-- ── 11. section · update (label / description) ───────────────────────
create or replace function public.checklist_section_update(
  p_id uuid,
  p_label text default null,
  p_description text default null
) returns public.checklist_template_sections
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_s public.checklist_template_sections;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_template_sections
     set label       = coalesce(nullif(trim(coalesce(p_label, '')), ''), label),
         description = case when p_description is null then description else nullif(trim(p_description), '') end
   where id = p_id and dsp_id = v_dsp
   returning * into v_s;
  if v_s.id is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;
  return v_s;
end;
$$;
grant execute on function public.checklist_section_update(uuid, text, text) to authenticated;


-- ── 12. section · delete ─────────────────────────────────────────────
create or replace function public.checklist_section_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.checklist_template_sections where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_section_delete(uuid) to authenticated;


-- ── 13. section · reorder ────────────────────────────────────────────
create or replace function public.checklist_sections_reorder(p_template_id uuid, p_section_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_owned boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select exists(select 1 from public.checklist_templates where id = p_template_id and dsp_id = v_dsp) into v_owned;
  if not v_owned then raise exception 'template_not_found' using errcode = 'P0002'; end if;
  update public.checklist_template_sections s
     set position = arr.idx - 1
    from unnest(p_section_ids) with ordinality as arr(id, idx)
   where s.id = arr.id and s.template_id = p_template_id and s.dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_sections_reorder(uuid, uuid[]) to authenticated;


-- ── 14. item · create ────────────────────────────────────────────────
create or replace function public.checklist_item_create(
  p_section_id uuid,
  p_label text default null,
  p_position int default null
) returns public.checklist_template_items
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_section public.checklist_template_sections;
  v_pos int := p_position;
  v_i public.checklist_template_items;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_section from public.checklist_template_sections where id = p_section_id and dsp_id = v_dsp;
  if v_section.id is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;

  if v_pos is null then
    select coalesce(max(position), -1) + 1 into v_pos from public.checklist_template_items where section_id = p_section_id;
  end if;

  insert into public.checklist_template_items (section_id, template_id, dsp_id, label, position)
    values (p_section_id, v_section.template_id, v_dsp, coalesce(nullif(trim(coalesce(p_label, '')), ''), 'Item'), v_pos)
    returning * into v_i;
  return v_i;
end;
$$;
grant execute on function public.checklist_item_create(uuid, text, int) to authenticated;


-- ── 15. item · update (any subset of fields) ─────────────────────────
create or replace function public.checklist_item_update(
  p_id uuid,
  p_label text default null,
  p_instructions text default null,
  p_required boolean default null,
  p_due_offset_hours int default null,
  p_default_assignee_role text default null
) returns public.checklist_template_items
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_i public.checklist_template_items;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_template_items
     set label                 = coalesce(nullif(trim(coalesce(p_label, '')), ''), label),
         instructions          = case when p_instructions          is null then instructions          else nullif(trim(p_instructions), '') end,
         required              = coalesce(p_required, required),
         due_offset_hours      = case when p_due_offset_hours      is null then due_offset_hours      else p_due_offset_hours end,
         default_assignee_role = case when p_default_assignee_role is null then default_assignee_role else nullif(trim(p_default_assignee_role), '') end
   where id = p_id and dsp_id = v_dsp
   returning * into v_i;
  if v_i.id is null then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  return v_i;
end;
$$;
grant execute on function public.checklist_item_update(uuid, text, text, boolean, int, text) to authenticated;


-- ── 16. item · delete ────────────────────────────────────────────────
create or replace function public.checklist_item_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.checklist_template_items where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_item_delete(uuid) to authenticated;


-- ── 17. item · reorder within a section ──────────────────────────────
create or replace function public.checklist_items_reorder(p_section_id uuid, p_item_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_owned boolean;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select exists(select 1 from public.checklist_template_sections where id = p_section_id and dsp_id = v_dsp) into v_owned;
  if not v_owned then raise exception 'section_not_found' using errcode = 'P0002'; end if;
  update public.checklist_template_items i
     set position = arr.idx - 1
    from unnest(p_item_ids) with ordinality as arr(id, idx)
   where i.id = arr.id and i.section_id = p_section_id and i.dsp_id = v_dsp;
end;
$$;
grant execute on function public.checklist_items_reorder(uuid, uuid[]) to authenticated;


notify pgrst, 'reload schema';
