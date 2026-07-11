-- Migration 0451 · Notebooks  ──────────────────────────────────────────────
-- The RouteReady notebook system — a OneNote-class hierarchical note store.
--
--   Notebook ▸ Section Group ▸ Section ▸ Page ▸ Subpage
--
-- Every note lives inside this tree, DSP-scoped and staff-gated exactly like
-- onboarding_notes (migration 0191). Two things make it "OneNote for ops":
--
--  1. Object notebooks. A notebook may be bound to any RouteReady object
--     (driver, vehicle, route, station, schedule, incident, interview, task,
--     …) via (subject_type, subject_id). Opening that object surfaces its
--     notebook; notebook_ensure_for() lazily creates it on first use.
--
--  2. Cross references / backlinks. notebook_links records page → page and
--     page → object edges, so a page can show "linked from" (backlinks) and
--     a driver drawer can show every page that mentions that driver.
--
-- Soft-delete (deleted_at) powers a per-notebook Recycle Bin with restore.
-- A generated tsvector + GIN index gives instant full-text search over
-- title + body. Every RPC re-checks private.is_staff() and is authored
-- idempotently (create table if not exists / create or replace / drop policy
-- if exists) so re-running a partially-applied migration never fails.
-- ───────────────────────────────────────────────────────────────────────────

-- ── enums ──────────────────────────────────────────────────────────────────
do $$ begin
  create type public.notebook_kind as enum ('workspace', 'personal', 'object');
exception when duplicate_object then null; end $$;

-- ── notebooks ──────────────────────────────────────────────────────────────
create table if not exists public.notebooks (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  name          text not null default 'Untitled Notebook',
  color         text not null default '#2563eb',
  kind          public.notebook_kind not null default 'workspace',
  -- object binding (null for free-standing workspace/personal notebooks)
  subject_type  text,
  subject_id    text,
  owner_id      uuid references auth.users(id) on delete set null,
  position      double precision not null default 0,
  is_pinned     boolean not null default false,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- one object-notebook per (dsp, subject_type, subject_id)
create unique index if not exists notebooks_subject_uidx
  on public.notebooks (dsp_id, subject_type, subject_id)
  where subject_type is not null;
create index if not exists notebooks_dsp_idx
  on public.notebooks (dsp_id, deleted_at, position);

-- ── section groups ─────────────────────────────────────────────────────────
create table if not exists public.notebook_section_groups (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  notebook_id   uuid not null references public.notebooks(id) on delete cascade,
  name          text not null default 'New Group',
  color         text not null default '#64748b',
  position      double precision not null default 0,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists notebook_section_groups_nb_idx
  on public.notebook_section_groups (notebook_id, deleted_at, position);

-- ── sections ───────────────────────────────────────────────────────────────
create table if not exists public.notebook_sections (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  notebook_id   uuid not null references public.notebooks(id) on delete cascade,
  group_id      uuid references public.notebook_section_groups(id) on delete set null,
  name          text not null default 'New Section',
  color         text not null default '#2563eb',
  position      double precision not null default 0,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists notebook_sections_nb_idx
  on public.notebook_sections (notebook_id, deleted_at, position);

-- ── pages (and subpages via parent_page_id) ────────────────────────────────
create table if not exists public.notebook_pages (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  notebook_id    uuid not null references public.notebooks(id) on delete cascade,
  section_id     uuid not null references public.notebook_sections(id) on delete cascade,
  parent_page_id uuid references public.notebook_pages(id) on delete cascade,
  title          text not null default 'Untitled Page',
  content_html   text not null default '',
  content_text   text not null default '',   -- plaintext mirror, for search
  level          smallint not null default 0, -- 0 page, 1 subpage, 2 sub-subpage
  position       double precision not null default 0,
  tags           text[] not null default '{}',
  is_pinned      boolean not null default false,
  created_by     uuid references auth.users(id) on delete set null,
  updated_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  -- immutable → valid for a generated column
  search_tsv     tsvector generated always as (
                   setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                   setweight(to_tsvector('english', coalesce(content_text, '')), 'B')
                 ) stored
);
create index if not exists notebook_pages_section_idx
  on public.notebook_pages (section_id, deleted_at, position);
create index if not exists notebook_pages_parent_idx
  on public.notebook_pages (parent_page_id);
create index if not exists notebook_pages_search_idx
  on public.notebook_pages using gin (search_tsv);
create index if not exists notebook_pages_tags_idx
  on public.notebook_pages using gin (tags);

-- ── cross references / backlinks ────────────────────────────────────────────
create table if not exists public.notebook_links (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  source_page_id  uuid not null references public.notebook_pages(id) on delete cascade,
  target_page_id  uuid references public.notebook_pages(id) on delete cascade,
  target_type     text,   -- object cross-ref: 'driver' | 'vehicle' | 'route' | …
  target_id       text,
  label           text not null default '',
  created_at      timestamptz not null default now()
);
create index if not exists notebook_links_target_page_idx
  on public.notebook_links (target_page_id);
create index if not exists notebook_links_target_obj_idx
  on public.notebook_links (dsp_id, target_type, target_id);
create index if not exists notebook_links_source_idx
  on public.notebook_links (source_page_id);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Staff-only, DSP-scoped — identical shape to onboarding_notes (0191).
do $$
declare t text;
begin
  foreach t in array array[
    'notebooks', 'notebook_section_groups', 'notebook_sections',
    'notebook_pages', 'notebook_links'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists %I on public.%I;', t || '_rw', t);
    execute format(
      'create policy %I on public.%I for all '
      || 'using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), ''dispatcher'')) '
      || 'with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), ''dispatcher''));',
      t || '_rw', t);
  end loop;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- guard helper: raise unless caller is dispatcher+ for their own dsp
-- (inlined per-function below to keep each RPC self-contained/idempotent)

-- ── list every notebook for the dsp (the notebook picker) ───────────────────
create or replace function public.notebooks_list()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'name', n.name, 'color', n.color, 'kind', n.kind,
           'subject_type', n.subject_type, 'subject_id', n.subject_id,
           'is_pinned', n.is_pinned, 'position', n.position,
           'page_count', (select count(*) from public.notebook_pages p
                            where p.notebook_id = n.id and p.deleted_at is null)
         ) order by n.is_pinned desc, n.position, n.created_at), '[]'::jsonb)
    into v_out
    from public.notebooks n
   where n.dsp_id = v_dsp and n.deleted_at is null;
  return v_out;
end; $$;
grant execute on function public.notebooks_list() to authenticated;

-- ── full tree for one notebook: groups + sections + live pages ──────────────
create or replace function public.notebook_tree(p_notebook_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.notebooks where id = p_notebook_id and dsp_id = v_dsp) then
    raise exception 'notebook_not_found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'notebook', (select jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color,
                          'kind', n.kind, 'subject_type', n.subject_type, 'subject_id', n.subject_id)
                   from public.notebooks n where n.id = p_notebook_id),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name,
                          'color', g.color, 'position', g.position) order by g.position, g.created_at)
                   from public.notebook_section_groups g
                  where g.notebook_id = p_notebook_id and g.deleted_at is null), '[]'::jsonb),
    'sections', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name,
                          'color', s.color, 'group_id', s.group_id, 'position', s.position) order by s.position, s.created_at)
                   from public.notebook_sections s
                  where s.notebook_id = p_notebook_id and s.deleted_at is null), '[]'::jsonb),
    'pages', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'section_id', p.section_id,
                          'parent_page_id', p.parent_page_id, 'title', p.title, 'level', p.level,
                          'position', p.position, 'tags', p.tags, 'is_pinned', p.is_pinned,
                          'updated_at', p.updated_at) order by p.position, p.created_at)
                   from public.notebook_pages p
                  where p.notebook_id = p_notebook_id and p.deleted_at is null), '[]'::jsonb)
  ) into v_out;
  return v_out;
end; $$;
grant execute on function public.notebook_tree(uuid) to authenticated;

-- ── get-or-create the object notebook for any RouteReady object ─────────────
create or replace function public.notebook_ensure_for(
  p_subject_type text, p_subject_id text, p_title text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb public.notebooks; v_sec public.notebook_sections;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_nb from public.notebooks
   where dsp_id = v_dsp and subject_type = p_subject_type and subject_id = p_subject_id
   limit 1;
  if v_nb.id is null then
    insert into public.notebooks (dsp_id, name, kind, subject_type, subject_id, created_by, owner_id, color)
    values (v_dsp, coalesce(nullif(trim(p_title), ''), initcap(p_subject_type) || ' notebook'),
            'object', p_subject_type, p_subject_id, auth.uid(), auth.uid(), '#2563eb')
    returning * into v_nb;
    insert into public.notebook_sections (dsp_id, notebook_id, name, color, position)
    values (v_dsp, v_nb.id, 'Notes', '#2563eb', 0) returning * into v_sec;
  elsif v_nb.deleted_at is not null then
    update public.notebooks set deleted_at = null, updated_at = now() where id = v_nb.id returning * into v_nb;
  end if;
  return jsonb_build_object('id', v_nb.id, 'name', v_nb.name, 'color', v_nb.color,
    'kind', v_nb.kind, 'subject_type', v_nb.subject_type, 'subject_id', v_nb.subject_id);
end; $$;
grant execute on function public.notebook_ensure_for(text, text, text) to authenticated;

-- ── create notebook / section group / section ───────────────────────────────
create or replace function public.notebook_create(p_name text default 'New Notebook', p_color text default '#2563eb')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb public.notebooks; v_pos double precision;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebooks where dsp_id = v_dsp;
  insert into public.notebooks (dsp_id, name, color, kind, created_by, owner_id, position)
  values (v_dsp, coalesce(nullif(trim(p_name), ''), 'New Notebook'), coalesce(p_color, '#2563eb'),
          'workspace', auth.uid(), auth.uid(), v_pos)
  returning * into v_nb;
  insert into public.notebook_sections (dsp_id, notebook_id, name, color, position)
  values (v_dsp, v_nb.id, 'New Section', coalesce(p_color, '#2563eb'), 0);
  return jsonb_build_object('id', v_nb.id, 'name', v_nb.name, 'color', v_nb.color, 'kind', v_nb.kind);
end; $$;
grant execute on function public.notebook_create(text, text) to authenticated;

create or replace function public.notebook_section_group_create(p_notebook_id uuid, p_name text default 'New Group')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_section_groups; v_pos double precision;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.notebooks where id = p_notebook_id and dsp_id = v_dsp) then
    raise exception 'notebook_not_found' using errcode = 'P0002'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebook_section_groups where notebook_id = p_notebook_id;
  insert into public.notebook_section_groups (dsp_id, notebook_id, name, position)
  values (v_dsp, p_notebook_id, coalesce(nullif(trim(p_name), ''), 'New Group'), v_pos)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'color', v_row.color);
end; $$;
grant execute on function public.notebook_section_group_create(uuid, text) to authenticated;

create or replace function public.notebook_section_create(
  p_notebook_id uuid, p_name text default 'New Section', p_group_id uuid default null, p_color text default '#2563eb')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_sections; v_pos double precision;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.notebooks where id = p_notebook_id and dsp_id = v_dsp) then
    raise exception 'notebook_not_found' using errcode = 'P0002'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebook_sections where notebook_id = p_notebook_id;
  insert into public.notebook_sections (dsp_id, notebook_id, group_id, name, color, position)
  values (v_dsp, p_notebook_id, p_group_id, coalesce(nullif(trim(p_name), ''), 'New Section'),
          coalesce(p_color, '#2563eb'), v_pos)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'color', v_row.color,
    'group_id', v_row.group_id, 'position', v_row.position);
end; $$;
grant execute on function public.notebook_section_create(uuid, text, uuid, text) to authenticated;

-- ── create a page (or subpage) ──────────────────────────────────────────────
create or replace function public.notebook_page_create(
  p_section_id uuid, p_title text default 'Untitled Page',
  p_parent_page_id uuid default null, p_level smallint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_row public.notebook_pages; v_pos double precision;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select notebook_id into v_nb from public.notebook_sections where id = p_section_id and dsp_id = v_dsp;
  if v_nb is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebook_pages where section_id = p_section_id;
  insert into public.notebook_pages (dsp_id, notebook_id, section_id, parent_page_id, title, level, position, created_by, updated_by)
  values (v_dsp, v_nb, p_section_id, p_parent_page_id, coalesce(nullif(trim(p_title), ''), 'Untitled Page'),
          greatest(0, least(2, coalesce(p_level, 0))), v_pos, auth.uid(), auth.uid())
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'section_id', v_row.section_id, 'notebook_id', v_row.notebook_id,
    'parent_page_id', v_row.parent_page_id, 'title', v_row.title, 'level', v_row.level,
    'position', v_row.position, 'content_html', v_row.content_html, 'tags', v_row.tags,
    'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_page_create(uuid, text, uuid, smallint) to authenticated;

-- ── fetch one page (open) ───────────────────────────────────────────────────
create or replace function public.notebook_page_get(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object('id', p.id, 'notebook_id', p.notebook_id, 'section_id', p.section_id,
           'parent_page_id', p.parent_page_id, 'title', p.title, 'content_html', p.content_html,
           'level', p.level, 'tags', p.tags, 'is_pinned', p.is_pinned,
           'created_at', p.created_at, 'updated_at', p.updated_at,
           'author', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'))
    into v_out
    from public.notebook_pages p
    left join public.app_users au on au.id = p.updated_by
   where p.id = p_id and p.dsp_id = v_dsp and p.deleted_at is null;
  if v_out is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  return v_out;
end; $$;
grant execute on function public.notebook_page_get(uuid) to authenticated;

-- ── autosave a page (title + rich body + plaintext + tags) ──────────────────
create or replace function public.notebook_page_save(
  p_id uuid, p_title text default null, p_content_html text default null,
  p_content_text text default null, p_tags text[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_pages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.notebook_pages
     set title        = coalesce(nullif(trim(p_title), ''), title),
         content_html = coalesce(p_content_html, content_html),
         content_text = coalesce(p_content_text, content_text),
         tags         = coalesce(p_tags, tags),
         updated_by   = auth.uid(),
         updated_at   = now()
   where id = p_id and dsp_id = v_dsp and deleted_at is null
  returning * into v_row;
  if v_row.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('id', v_row.id, 'title', v_row.title, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_page_save(uuid, text, text, text, text[]) to authenticated;

-- ── rename / recolor any tree node ──────────────────────────────────────────
create or replace function public.notebook_item_rename(p_kind text, p_id uuid, p_name text, p_color text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'notebook' then
    update public.notebooks set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color), updated_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'group' then
    update public.notebook_section_groups set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color) where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color) where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'page' then
    update public.notebook_pages set title = coalesce(nullif(trim(p_name), ''), title),
      updated_at = now() where id = p_id and dsp_id = v_dsp;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
end; $$;
grant execute on function public.notebook_item_rename(text, uuid, text, text) to authenticated;

-- ── move a page between sections / re-parent / re-order ─────────────────────
create or replace function public.notebook_page_move(
  p_id uuid, p_section_id uuid default null, p_parent_page_id uuid default null,
  p_level smallint default null, p_position double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_section_id is not null then
    select notebook_id into v_nb from public.notebook_sections where id = p_section_id and dsp_id = v_dsp;
    if v_nb is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;
  end if;
  update public.notebook_pages
     set section_id     = coalesce(p_section_id, section_id),
         notebook_id    = coalesce(v_nb, notebook_id),
         parent_page_id = case when p_parent_page_id = p_id then parent_page_id else p_parent_page_id end,
         level          = coalesce(p_level, level),
         position       = coalesce(p_position, position),
         updated_at     = now()
   where id = p_id and dsp_id = v_dsp;
end; $$;
grant execute on function public.notebook_page_move(uuid, uuid, uuid, smallint, double precision) to authenticated;

-- ── pin / unpin a page ──────────────────────────────────────────────────────
create or replace function public.notebook_page_pin(p_id uuid, p_pinned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.notebook_pages set is_pinned = coalesce(p_pinned, false), updated_at = now()
   where id = p_id and dsp_id = v_dsp;
end; $$;
grant execute on function public.notebook_page_pin(uuid, boolean) to authenticated;

-- ── duplicate a page (title, body, tags; children not copied) ───────────────
create or replace function public.notebook_page_duplicate(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_src public.notebook_pages; v_new public.notebook_pages; v_pos double precision;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_src from public.notebook_pages where id = p_id and dsp_id = v_dsp and deleted_at is null;
  if v_src.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebook_pages where section_id = v_src.section_id;
  insert into public.notebook_pages (dsp_id, notebook_id, section_id, parent_page_id, title,
    content_html, content_text, level, position, tags, created_by, updated_by)
  values (v_dsp, v_src.notebook_id, v_src.section_id, v_src.parent_page_id, v_src.title || ' (copy)',
    v_src.content_html, v_src.content_text, v_src.level, v_pos, v_src.tags, auth.uid(), auth.uid())
  returning * into v_new;
  return jsonb_build_object('id', v_new.id, 'title', v_new.title, 'section_id', v_new.section_id,
    'parent_page_id', v_new.parent_page_id, 'level', v_new.level, 'position', v_new.position);
end; $$;
grant execute on function public.notebook_page_duplicate(uuid) to authenticated;

-- ── soft-delete (→ Recycle Bin) ─────────────────────────────────────────────
create or replace function public.notebook_item_delete(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'notebook' then
    update public.notebooks set deleted_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'group' then
    update public.notebook_section_groups set deleted_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set deleted_at = now() where id = p_id and dsp_id = v_dsp;
    update public.notebook_pages set deleted_at = now() where section_id = p_id and dsp_id = v_dsp and deleted_at is null;
  elsif p_kind = 'page' then
    update public.notebook_pages set deleted_at = now()
      where (id = p_id or parent_page_id = p_id) and dsp_id = v_dsp;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
end; $$;
grant execute on function public.notebook_item_delete(text, uuid) to authenticated;

-- ── recycle bin listing (deleted pages for a notebook) ──────────────────────
create or replace function public.notebook_recycle_list(p_notebook_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'section_id', p.section_id,
           'deleted_at', p.deleted_at) order by p.deleted_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_pages p
   where p.notebook_id = p_notebook_id and p.dsp_id = v_dsp and p.deleted_at is not null;
  return v_out;
end; $$;
grant execute on function public.notebook_recycle_list(uuid) to authenticated;

-- ── restore from recycle bin ────────────────────────────────────────────────
create or replace function public.notebook_item_restore(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'page' then
    update public.notebook_pages set deleted_at = null, updated_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set deleted_at = null where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'notebook' then
    update public.notebooks set deleted_at = null, updated_at = now() where id = p_id and dsp_id = v_dsp;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
end; $$;
grant execute on function public.notebook_item_restore(text, uuid) to authenticated;

-- ── set the outbound links for a page (replace-all) ─────────────────────────
create or replace function public.notebook_links_set(p_source_page_id uuid, p_links jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_link jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.notebook_pages where id = p_source_page_id and dsp_id = v_dsp) then
    raise exception 'page_not_found' using errcode = 'P0002'; end if;
  delete from public.notebook_links where source_page_id = p_source_page_id and dsp_id = v_dsp;
  if p_links is not null then
    for v_link in select * from jsonb_array_elements(p_links) loop
      insert into public.notebook_links (dsp_id, source_page_id, target_page_id, target_type, target_id, label)
      values (v_dsp, p_source_page_id,
              nullif(v_link->>'target_page_id', '')::uuid,
              v_link->>'target_type', v_link->>'target_id', coalesce(v_link->>'label', ''));
    end loop;
  end if;
end; $$;
grant execute on function public.notebook_links_set(uuid, jsonb) to authenticated;

-- ── backlinks: which pages link to this page ────────────────────────────────
create or replace function public.notebook_page_backlinks(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('page_id', src.id, 'title', src.title,
           'section_id', src.section_id, 'notebook_id', src.notebook_id) order by src.updated_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_links l
    join public.notebook_pages src on src.id = l.source_page_id and src.deleted_at is null
   where l.target_page_id = p_page_id and l.dsp_id = v_dsp;
  return v_out;
end; $$;
grant execute on function public.notebook_page_backlinks(uuid) to authenticated;

-- ── object cross-refs: which pages mention this object ──────────────────────
create or replace function public.notebook_pages_for_object(p_target_type text, p_target_id text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(distinct jsonb_build_object('page_id', src.id, 'title', src.title,
           'notebook_id', src.notebook_id, 'section_id', src.section_id)), '[]'::jsonb)
    into v_out
    from public.notebook_links l
    join public.notebook_pages src on src.id = l.source_page_id and src.deleted_at is null
   where l.dsp_id = v_dsp and l.target_type = p_target_type and l.target_id = p_target_id;
  return v_out;
end; $$;
grant execute on function public.notebook_pages_for_object(text, text) to authenticated;

-- ── full-text search across all live pages ──────────────────────────────────
create or replace function public.notebook_search(
  p_query text, p_notebook_id uuid default null, p_tag text default null, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb; v_q tsquery;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_q := websearch_to_tsquery('english', coalesce(p_query, ''));
  select coalesce(jsonb_agg(to_jsonb(t) order by t.rank desc), '[]'::jsonb) into v_out
  from (
    select p.id, p.notebook_id, p.section_id, p.title, p.tags,
           n.name as notebook_name, s.name as section_name,
           ts_headline('english', p.content_text, v_q,
             'MaxFragments=1,MinWords=6,MaxWords=18,StartSel=<mark>,StopSel=</mark>') as snippet,
           case when trim(coalesce(p_query, '')) = '' then 0
                else ts_rank(p.search_tsv, v_q) end as rank
      from public.notebook_pages p
      join public.notebooks n on n.id = p.notebook_id
      join public.notebook_sections s on s.id = p.section_id
     where p.dsp_id = v_dsp and p.deleted_at is null
       and (p_notebook_id is null or p.notebook_id = p_notebook_id)
       and (p_tag is null or p_tag = any(p.tags))
       and (trim(coalesce(p_query, '')) = '' or p.search_tsv @@ v_q)
     order by rank desc, p.updated_at desc
     limit greatest(1, least(200, coalesce(p_limit, 50)))
  ) t;
  return v_out;
end; $$;
grant execute on function public.notebook_search(text, uuid, text, int) to authenticated;

notify pgrst, 'reload schema';
