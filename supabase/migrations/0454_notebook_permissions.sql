-- Migration 0454 · Private & shared notebooks ────────────────────────────────
--
-- Until now every notebook was DSP-wide (any dispatcher+ could read and write
-- everything). This adds OneNote-style ownership:
--
--   · kind='workspace' / 'object'  → unchanged: every staff member, full access
--   · kind='personal'              → owner-only, unless explicitly shared
--   · notebook_members             → per-notebook shares: 'viewer' | 'editor'
--
-- One helper — private.notebook_role(notebook_id) → 'owner'|'editor'|'viewer'
-- |null — is the single source of truth. RLS policies AND every notebook RPC
-- route through it, so PostgREST reads, realtime streams, and the security-
-- definer RPC surface all agree. Search, backlinks, recycle, revisions and
-- object cross-refs are filtered too (no private titles leaking via search).
--
-- Existing notebooks keep working: they're all 'workspace' kind today, and
-- for those the role is 'editor' for every staff member (owner for creator).
--
-- Idempotent throughout, like 0451-0453.
-- ───────────────────────────────────────────────────────────────────────────

-- ── members ─────────────────────────────────────────────────────────────────
create table if not exists public.notebook_members (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  notebook_id  uuid not null references public.notebooks(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'editor' check (role in ('viewer', 'editor')),
  added_by     uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (notebook_id, user_id)
);
create index if not exists notebook_members_user_idx
  on public.notebook_members (user_id, dsp_id);

-- ── the visibility oracle ───────────────────────────────────────────────────
create or replace function private.notebook_role(p_notebook_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_dsp uuid := private.current_dsp_id(); v_nb record; v_role text;
begin
  if v_uid is null or v_dsp is null then return null; end if;
  select kind, owner_id, dsp_id into v_nb from public.notebooks where id = p_notebook_id;
  if v_nb.dsp_id is null or v_nb.dsp_id <> v_dsp then return null; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then return null; end if;
  if v_nb.owner_id = v_uid then return 'owner'; end if;
  if v_nb.kind <> 'personal' then return 'editor'; end if;   -- workspace/object: all staff
  select role into v_role from public.notebook_members
   where notebook_id = p_notebook_id and user_id = v_uid;
  return v_role;                                             -- 'viewer' | 'editor' | null
end; $$;

create or replace function private.notebook_visible(p_notebook_id uuid)
returns boolean language sql security definer set search_path = '' as
$$ select private.notebook_role(p_notebook_id) is not null $$;

create or replace function private.notebook_editable(p_notebook_id uuid)
returns boolean language sql security definer set search_path = '' as
$$ select coalesce(private.notebook_role(p_notebook_id) in ('owner', 'editor'), false) $$;

-- ── RLS: personal notebooks disappear for non-members ───────────────────────
-- (Also gates realtime: page events in a private notebook only reach people
-- who can see it.)
drop policy if exists notebooks_rw on public.notebooks;
create policy notebooks_rw on public.notebooks for all
  using (private.notebook_visible(id))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

do $$
declare t text;
begin
  foreach t in array array[
    'notebook_section_groups', 'notebook_sections', 'notebook_pages', 'notebook_links'
  ] loop
    execute format('drop policy if exists %I on public.%I;', t || '_rw', t);
    execute format(
      'create policy %I on public.%I for all '
      || 'using (private.notebook_visible(notebook_id)) '
      || 'with check (private.notebook_editable(notebook_id));',
      t || '_rw', t);
  end loop;
end $$;
-- links has no notebook_id column — scope it via its source page instead
drop policy if exists notebook_links_rw on public.notebook_links;
create policy notebook_links_rw on public.notebook_links for all
  using (exists (select 1 from public.notebook_pages p where p.id = source_page_id and private.notebook_visible(p.notebook_id)))
  with check (exists (select 1 from public.notebook_pages p where p.id = source_page_id and private.notebook_editable(p.notebook_id)));

drop policy if exists notebook_page_revisions_rw on public.notebook_page_revisions;
create policy notebook_page_revisions_rw on public.notebook_page_revisions for all
  using (exists (select 1 from public.notebook_pages p where p.id = page_id and private.notebook_visible(p.notebook_id)))
  with check (exists (select 1 from public.notebook_pages p where p.id = page_id and private.notebook_editable(p.notebook_id)));

alter table public.notebook_members enable row level security;
drop policy if exists notebook_members_rw on public.notebook_members;
create policy notebook_members_rw on public.notebook_members for all
  using (private.notebook_visible(notebook_id))
  with check (private.notebook_role(notebook_id) = 'owner');

-- ═══════════════════════════════════════════════════════════════════════════
-- RPC surface, re-issued with visibility/editability guards
-- ═══════════════════════════════════════════════════════════════════════════

-- helper: raise unless caller can see / edit the notebook
create or replace function private.notebook_require(p_notebook_id uuid, p_edit boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_edit then
    if not private.notebook_editable(p_notebook_id) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  elsif not private.notebook_visible(p_notebook_id) then
    raise exception 'notebook_not_found' using errcode = 'P0002';
  end if;
end; $$;

-- ── list: hide invisible personal notebooks, expose my_role + share count ───
create or replace function public.notebooks_list()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'name', n.name, 'color', n.color, 'kind', n.kind,
           'subject_type', n.subject_type, 'subject_id', n.subject_id,
           'is_pinned', n.is_pinned, 'position', n.position,
           'owner_id', n.owner_id,
           'my_role', private.notebook_role(n.id),
           'member_count', (select count(*) from public.notebook_members m where m.notebook_id = n.id),
           'page_count', (select count(*) from public.notebook_pages p
                            where p.notebook_id = n.id and p.deleted_at is null)
         ) order by n.is_pinned desc, n.position, n.created_at), '[]'::jsonb)
    into v_out
    from public.notebooks n
   where n.dsp_id = v_dsp and n.deleted_at is null
     and (n.kind <> 'personal' or n.owner_id = v_uid
          or exists (select 1 from public.notebook_members m where m.notebook_id = n.id and m.user_id = v_uid));
  return v_out;
end; $$;
grant execute on function public.notebooks_list() to authenticated;

-- ── tree: visible only; carries my_role so the client can go read-only ──────
create or replace function public.notebook_tree(p_notebook_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_out jsonb;
begin
  perform private.notebook_require(p_notebook_id, false);
  select jsonb_build_object(
    'notebook', (select jsonb_build_object('id', n.id, 'name', n.name, 'color', n.color,
                          'kind', n.kind, 'subject_type', n.subject_type, 'subject_id', n.subject_id,
                          'my_role', private.notebook_role(n.id))
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

-- ── create: now takes a kind ('workspace' | 'personal') ─────────────────────
drop function if exists public.notebook_create(text, text);
create or replace function public.notebook_create(
  p_name text default 'New Notebook', p_color text default '#2563eb', p_kind text default 'workspace')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb public.notebooks; v_pos double precision;
        v_kind public.notebook_kind := case when p_kind = 'personal' then 'personal' else 'workspace' end::public.notebook_kind;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(max(position), 0) + 1 into v_pos from public.notebooks where dsp_id = v_dsp;
  insert into public.notebooks (dsp_id, name, color, kind, created_by, owner_id, position)
  values (v_dsp, coalesce(nullif(trim(p_name), ''), 'New Notebook'), coalesce(p_color, '#2563eb'),
          v_kind, auth.uid(), auth.uid(), v_pos)
  returning * into v_nb;
  insert into public.notebook_sections (dsp_id, notebook_id, name, color, position)
  values (v_dsp, v_nb.id, case when v_kind = 'personal' then 'My Notes' else 'New Section' end,
          coalesce(p_color, '#2563eb'), 0);
  return jsonb_build_object('id', v_nb.id, 'name', v_nb.name, 'color', v_nb.color, 'kind', v_nb.kind,
    'my_role', 'owner');
end; $$;
grant execute on function public.notebook_create(text, text, text) to authenticated;

-- ── structure/create/edit RPCs: require editable ────────────────────────────
create or replace function public.notebook_section_group_create(p_notebook_id uuid, p_name text default 'New Group')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_section_groups; v_pos double precision;
begin
  perform private.notebook_require(p_notebook_id, true);
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
  perform private.notebook_require(p_notebook_id, true);
  select coalesce(max(position), 0) + 1 into v_pos from public.notebook_sections where notebook_id = p_notebook_id;
  insert into public.notebook_sections (dsp_id, notebook_id, group_id, name, color, position)
  values (v_dsp, p_notebook_id, p_group_id, coalesce(nullif(trim(p_name), ''), 'New Section'),
          coalesce(p_color, '#2563eb'), v_pos)
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'name', v_row.name, 'color', v_row.color,
    'group_id', v_row.group_id, 'position', v_row.position);
end; $$;
grant execute on function public.notebook_section_create(uuid, text, uuid, text) to authenticated;

create or replace function public.notebook_page_create(
  p_section_id uuid, p_title text default 'Untitled Page',
  p_parent_page_id uuid default null, p_level smallint default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_row public.notebook_pages; v_pos double precision;
begin
  select notebook_id into v_nb from public.notebook_sections where id = p_section_id and dsp_id = v_dsp;
  if v_nb is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
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

-- ── page read: visible; carries my_role ─────────────────────────────────────
create or replace function public.notebook_page_get(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  select jsonb_build_object('id', p.id, 'notebook_id', p.notebook_id, 'section_id', p.section_id,
           'parent_page_id', p.parent_page_id, 'title', p.title, 'content_html', p.content_html,
           'level', p.level, 'tags', p.tags, 'is_pinned', p.is_pinned,
           'created_at', p.created_at, 'updated_at', p.updated_at,
           'my_role', private.notebook_role(p.notebook_id),
           'author', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'))
    into v_out
    from public.notebook_pages p
    left join public.app_users au on au.id = p.updated_by
   where p.id = p_id and p.dsp_id = v_dsp and p.deleted_at is null
     and private.notebook_visible(p.notebook_id);
  if v_out is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  return v_out;
end; $$;
grant execute on function public.notebook_page_get(uuid) to authenticated;

-- ── page save: editable + optimistic concurrency (0452 semantics kept) ──────
create or replace function public.notebook_page_save(
  p_id uuid, p_title text default null, p_content_html text default null,
  p_content_text text default null, p_tags text[] default null,
  p_base_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_cur public.notebook_pages; v_row public.notebook_pages;
begin
  select * into v_cur from public.notebook_pages
   where id = p_id and dsp_id = v_dsp and deleted_at is null
   for update;
  if v_cur.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_cur.notebook_id, true);

  if p_base_updated_at is not null
     and v_cur.updated_at > p_base_updated_at
     and v_cur.updated_by is distinct from auth.uid() then
    raise exception 'stale_write' using errcode = 'P0004',
      detail = 'page was modified by another user',
      hint = coalesce(v_cur.updated_at::text, '');
  end if;

  if (p_content_html is not null and p_content_html is distinct from v_cur.content_html)
     or (p_title is not null and nullif(trim(p_title), '') is distinct from v_cur.title) then
    perform private.notebook_page_snapshot(v_cur);
  end if;

  update public.notebook_pages
     set title        = coalesce(nullif(trim(p_title), ''), title),
         content_html = coalesce(p_content_html, content_html),
         content_text = coalesce(p_content_text, content_text),
         tags         = coalesce(p_tags, tags),
         updated_by   = auth.uid(),
         updated_at   = now()
   where id = p_id
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'title', v_row.title, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_page_save(uuid, text, text, text, text[], timestamptz) to authenticated;

-- ── rename / move / pin / duplicate / delete / restore: editable ────────────
create or replace function public.notebook_item_rename(p_kind text, p_id uuid, p_name text, p_color text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid;
begin
  if p_kind = 'notebook' then v_nb := p_id;
  elsif p_kind = 'group' then select notebook_id into v_nb from public.notebook_section_groups where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then select notebook_id into v_nb from public.notebook_sections where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'page' then select notebook_id into v_nb from public.notebook_pages where id = p_id and dsp_id = v_dsp;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_nb is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
  if p_kind = 'notebook' then
    update public.notebooks set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color), updated_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'group' then
    update public.notebook_section_groups set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color) where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set name = coalesce(nullif(trim(p_name), ''), name),
      color = coalesce(p_color, color) where id = p_id and dsp_id = v_dsp;
  else
    update public.notebook_pages set title = coalesce(nullif(trim(p_name), ''), title),
      updated_at = now() where id = p_id and dsp_id = v_dsp;
  end if;
end; $$;
grant execute on function public.notebook_item_rename(text, uuid, text, text) to authenticated;

create or replace function public.notebook_page_move(
  p_id uuid, p_section_id uuid default null, p_parent_page_id uuid default null,
  p_level smallint default null, p_position double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_cur uuid;
begin
  select notebook_id into v_cur from public.notebook_pages where id = p_id and dsp_id = v_dsp;
  if v_cur is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_cur, true);
  if p_section_id is not null then
    select notebook_id into v_nb from public.notebook_sections where id = p_section_id and dsp_id = v_dsp;
    if v_nb is null then raise exception 'section_not_found' using errcode = 'P0002'; end if;
    if v_nb <> v_cur then perform private.notebook_require(v_nb, true); end if;
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

create or replace function public.notebook_page_pin(p_id uuid, p_pinned boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid;
begin
  select notebook_id into v_nb from public.notebook_pages where id = p_id and dsp_id = v_dsp;
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
  update public.notebook_pages set is_pinned = coalesce(p_pinned, false), updated_at = now()
   where id = p_id and dsp_id = v_dsp;
end; $$;
grant execute on function public.notebook_page_pin(uuid, boolean) to authenticated;

create or replace function public.notebook_page_duplicate(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_src public.notebook_pages; v_new public.notebook_pages; v_pos double precision;
begin
  select * into v_src from public.notebook_pages where id = p_id and dsp_id = v_dsp and deleted_at is null;
  if v_src.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_src.notebook_id, true);
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

create or replace function public.notebook_item_delete(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_role text;
begin
  if p_kind = 'notebook' then
    v_role := private.notebook_role(p_id);
    -- personal notebooks can only be deleted by their owner
    if v_role is null or (v_role <> 'owner' and exists (
         select 1 from public.notebooks where id = p_id and kind = 'personal')) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    if v_role not in ('owner', 'editor') then raise exception 'forbidden' using errcode = '42501'; end if;
    update public.notebooks set deleted_at = now() where id = p_id and dsp_id = v_dsp;
    return;
  end if;
  if p_kind = 'group' then select notebook_id into v_nb from public.notebook_section_groups where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then select notebook_id into v_nb from public.notebook_sections where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'page' then select notebook_id into v_nb from public.notebook_pages where id = p_id and dsp_id = v_dsp;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_nb is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
  if p_kind = 'group' then
    update public.notebook_section_groups set deleted_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set deleted_at = now() where id = p_id and dsp_id = v_dsp;
    update public.notebook_pages set deleted_at = now() where section_id = p_id and dsp_id = v_dsp and deleted_at is null;
  else
    update public.notebook_pages set deleted_at = now()
      where (id = p_id or parent_page_id = p_id) and dsp_id = v_dsp;
  end if;
end; $$;
grant execute on function public.notebook_item_delete(text, uuid) to authenticated;

create or replace function public.notebook_recycle_list(p_notebook_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  perform private.notebook_require(p_notebook_id, false);
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'title', p.title, 'section_id', p.section_id,
           'deleted_at', p.deleted_at) order by p.deleted_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_pages p
   where p.notebook_id = p_notebook_id and p.dsp_id = v_dsp and p.deleted_at is not null;
  return v_out;
end; $$;
grant execute on function public.notebook_recycle_list(uuid) to authenticated;

create or replace function public.notebook_item_restore(p_kind text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid;
begin
  if p_kind = 'page' then select notebook_id into v_nb from public.notebook_pages where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then select notebook_id into v_nb from public.notebook_sections where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'notebook' then v_nb := p_id;
  else raise exception 'bad_kind' using errcode = '22023'; end if;
  if v_nb is null then raise exception 'not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
  if p_kind = 'page' then
    update public.notebook_pages set deleted_at = null, updated_at = now() where id = p_id and dsp_id = v_dsp;
  elsif p_kind = 'section' then
    update public.notebook_sections set deleted_at = null where id = p_id and dsp_id = v_dsp;
  else
    update public.notebooks set deleted_at = null, updated_at = now() where id = p_id and dsp_id = v_dsp;
  end if;
end; $$;
grant execute on function public.notebook_item_restore(text, uuid) to authenticated;

-- ── links / backlinks / object refs: visibility-filtered ────────────────────
create or replace function public.notebook_links_set(p_source_page_id uuid, p_links jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_link jsonb;
begin
  select notebook_id into v_nb from public.notebook_pages where id = p_source_page_id and dsp_id = v_dsp;
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
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
   where l.target_page_id = p_page_id and l.dsp_id = v_dsp
     and private.notebook_visible(src.notebook_id);
  return v_out;
end; $$;
grant execute on function public.notebook_page_backlinks(uuid) to authenticated;

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
   where l.dsp_id = v_dsp and l.target_type = p_target_type and l.target_id = p_target_id
     and private.notebook_visible(src.notebook_id);
  return v_out;
end; $$;
grant execute on function public.notebook_pages_for_object(text, text) to authenticated;

-- ── search: private pages never leak into results ───────────────────────────
create or replace function public.notebook_search(
  p_query text, p_notebook_id uuid default null, p_tag text default null, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_out jsonb; v_q tsquery;
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
       and (n.kind <> 'personal' or n.owner_id = v_uid
            or exists (select 1 from public.notebook_members m where m.notebook_id = n.id and m.user_id = v_uid))
       and (p_notebook_id is null or p.notebook_id = p_notebook_id)
       and (p_tag is null or p_tag = any(p.tags))
       and (trim(coalesce(p_query, '')) = '' or p.search_tsv @@ v_q)
     order by rank desc, p.updated_at desc
     limit greatest(1, least(200, coalesce(p_limit, 50)))
  ) t;
  return v_out;
end; $$;
grant execute on function public.notebook_search(text, uuid, text, int) to authenticated;

-- ── revisions (0452): route through visibility ──────────────────────────────
create or replace function public.notebook_page_revisions_list(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_out jsonb;
begin
  select notebook_id into v_nb from public.notebook_pages where id = p_page_id and dsp_id = v_dsp;
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, false);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', r.id, 'title', r.title, 'created_at', r.created_at,
           'author', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'),
           'chars', length(r.content_text)
         ) order by r.created_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_page_revisions r
    left join public.app_users au on au.id = r.saved_by
   where r.page_id = p_page_id and r.dsp_id = v_dsp;
  return v_out;
end; $$;
grant execute on function public.notebook_page_revisions_list(uuid) to authenticated;

create or replace function public.notebook_page_revision_get(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  select jsonb_build_object('id', r.id, 'page_id', r.page_id, 'title', r.title,
           'content_html', r.content_html, 'content_text', r.content_text,
           'tags', r.tags, 'created_at', r.created_at)
    into v_out
    from public.notebook_page_revisions r
    join public.notebook_pages p on p.id = r.page_id
   where r.id = p_id and r.dsp_id = v_dsp
     and private.notebook_visible(p.notebook_id);
  if v_out is null then raise exception 'revision_not_found' using errcode = 'P0002'; end if;
  return v_out;
end; $$;
grant execute on function public.notebook_page_revision_get(uuid) to authenticated;

create or replace function public.notebook_page_revision_restore(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_rev public.notebook_page_revisions; v_cur public.notebook_pages; v_row public.notebook_pages;
begin
  select * into v_rev from public.notebook_page_revisions where id = p_id and dsp_id = v_dsp;
  if v_rev.id is null then raise exception 'revision_not_found' using errcode = 'P0002'; end if;
  select * into v_cur from public.notebook_pages
   where id = v_rev.page_id and dsp_id = v_dsp and deleted_at is null
   for update;
  if v_cur.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_cur.notebook_id, true);

  insert into public.notebook_page_revisions
    (dsp_id, page_id, title, content_html, content_text, tags, saved_by)
  values
    (v_cur.dsp_id, v_cur.id, v_cur.title, v_cur.content_html,
     v_cur.content_text, v_cur.tags, v_cur.updated_by);

  update public.notebook_pages
     set title        = v_rev.title,
         content_html = v_rev.content_html,
         content_text = v_rev.content_text,
         tags         = v_rev.tags,
         updated_by   = auth.uid(),
         updated_at   = now()
   where id = v_cur.id
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'title', v_row.title,
    'content_html', v_row.content_html, 'tags', v_row.tags, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_page_revision_restore(uuid) to authenticated;

-- ── sharing ─────────────────────────────────────────────────────────────────
-- who can I share with? (active staff in my dsp, minus me)
create or replace function public.notebook_share_candidates()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', au.id,
           'name', coalesce(nullif(trim(au.full_name), ''), au.email),
           'email', au.email, 'role', au.role
         ) order by coalesce(nullif(trim(au.full_name), ''), au.email)), '[]'::jsonb)
    into v_out
    from public.app_users au
   where au.dsp_id = v_dsp and au.active and au.id <> auth.uid()
     and private.is_staff(v_dsp, 'dispatcher');
  return v_out;
end; $$;
grant execute on function public.notebook_share_candidates() to authenticated;

create or replace function public.notebook_share_list(p_notebook_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  perform private.notebook_require(p_notebook_id, false);
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', m.user_id, 'role', m.role,
           'name', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate')
         ) order by m.created_at), '[]'::jsonb)
    into v_out
    from public.notebook_members m
    left join public.app_users au on au.id = m.user_id
   where m.notebook_id = p_notebook_id and m.dsp_id = v_dsp;
  return v_out;
end; $$;
grant execute on function public.notebook_share_list(uuid) to authenticated;

-- replace-all membership; owner only
create or replace function public.notebook_share_set(p_notebook_id uuid, p_members jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_m jsonb; v_uid uuid; v_role text;
begin
  if private.notebook_role(p_notebook_id) <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.notebook_members where notebook_id = p_notebook_id and dsp_id = v_dsp;
  if p_members is not null then
    for v_m in select * from jsonb_array_elements(p_members) loop
      v_uid := nullif(v_m->>'user_id', '')::uuid;
      v_role := case when v_m->>'role' = 'viewer' then 'viewer' else 'editor' end;
      if v_uid is not null and v_uid <> auth.uid()
         and exists (select 1 from public.app_users au where au.id = v_uid and au.dsp_id = v_dsp and au.active) then
        insert into public.notebook_members (dsp_id, notebook_id, user_id, role, added_by)
        values (v_dsp, p_notebook_id, v_uid, v_role, auth.uid())
        on conflict (notebook_id, user_id) do update set role = excluded.role;
      end if;
    end loop;
  end if;
  return public.notebook_share_list(p_notebook_id);
end; $$;
grant execute on function public.notebook_share_set(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
