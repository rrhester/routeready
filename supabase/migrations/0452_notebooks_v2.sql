-- Migration 0452 · Notebooks v2 — collaboration safety + version history ────
--
-- Three upgrades that move Notebooks (0451) from "single-writer notes" to
-- "safe for a whole dispatch office":
--
--  1. Page version history. notebook_page_revisions snapshots a page's
--     previous state as it's edited (throttled to one snapshot per 5 minutes
--     of active editing, capped at the newest 100 per page), with list /
--     get / restore RPCs. Restore snapshots the pre-restore state first, so
--     a restore is itself undoable.
--
--  2. Optimistic-concurrency saves. notebook_page_save gains
--     p_base_updated_at: when the caller passes the updated_at it loaded and
--     ANOTHER user has saved since, the RPC raises 'stale_write' instead of
--     silently clobbering their edit. Same-user saves (two tabs, autosave
--     races) never conflict. Passing null keeps the old last-write-wins
--     behaviour (and is the explicit "Overwrite" escape hatch).
--
--  3. Live updates. notebook_pages joins the supabase_realtime publication so
--     open dashboards can refresh page lists / flag concurrent edits without
--     polling.
--
-- Idempotent throughout (create table if not exists / create or replace /
-- drop function if exists / exception-guarded do-blocks) so re-running a
-- partially applied migration never fails.
-- ───────────────────────────────────────────────────────────────────────────

-- ── page revisions ──────────────────────────────────────────────────────────
create table if not exists public.notebook_page_revisions (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  page_id       uuid not null references public.notebook_pages(id) on delete cascade,
  title         text not null default '',
  content_html  text not null default '',
  content_text  text not null default '',
  tags          text[] not null default '{}',
  saved_by      uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists notebook_page_revisions_page_idx
  on public.notebook_page_revisions (page_id, created_at desc);

alter table public.notebook_page_revisions enable row level security;
drop policy if exists notebook_page_revisions_rw on public.notebook_page_revisions;
create policy notebook_page_revisions_rw on public.notebook_page_revisions
  for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- ── snapshot helper: keep one revision per ~5 min of editing, newest 100 ────
create or replace function private.notebook_page_snapshot(p_page public.notebook_pages)
returns void language plpgsql security definer set search_path = '' as $$
declare v_last timestamptz;
begin
  select max(created_at) into v_last
    from public.notebook_page_revisions where page_id = p_page.id;
  if v_last is not null and v_last > now() - interval '5 minutes' then
    return; -- a recent snapshot already captures this editing session
  end if;
  insert into public.notebook_page_revisions
    (dsp_id, page_id, title, content_html, content_text, tags, saved_by)
  values
    (p_page.dsp_id, p_page.id, p_page.title, p_page.content_html,
     p_page.content_text, p_page.tags, p_page.updated_by);
  delete from public.notebook_page_revisions
   where page_id = p_page.id
     and id not in (
       select id from public.notebook_page_revisions
        where page_id = p_page.id
        order by created_at desc
        limit 100);
end; $$;

-- ── notebook_page_save v2: base-version check + revision snapshot ───────────
-- The 5-arg 0451 signature must go away (PostgREST would see two candidates
-- for the same named-args call and refuse with 300 Multiple Choices).
drop function if exists public.notebook_page_save(uuid, text, text, text, text[]);

create or replace function public.notebook_page_save(
  p_id uuid, p_title text default null, p_content_html text default null,
  p_content_text text default null, p_tags text[] default null,
  p_base_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_cur public.notebook_pages; v_row public.notebook_pages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_cur from public.notebook_pages
   where id = p_id and dsp_id = v_dsp and deleted_at is null
   for update;
  if v_cur.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;

  -- Optimistic concurrency: another USER saved after the version the caller
  -- loaded. Same-user writes (second tab, in-flight autosave) pass through.
  if p_base_updated_at is not null
     and v_cur.updated_at > p_base_updated_at
     and v_cur.updated_by is distinct from auth.uid() then
    raise exception 'stale_write' using errcode = 'P0004',
      detail = 'page was modified by another user',
      hint = coalesce(v_cur.updated_at::text, '');
  end if;

  -- Version history: snapshot the pre-save state when content is changing.
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
   where id = p_id and dsp_id = v_dsp and deleted_at is null
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'title', v_row.title, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_page_save(uuid, text, text, text, text[], timestamptz) to authenticated;

-- ── revisions: list / get / restore ─────────────────────────────────────────
create or replace function public.notebook_page_revisions_list(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
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
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object('id', r.id, 'page_id', r.page_id, 'title', r.title,
           'content_html', r.content_html, 'content_text', r.content_text,
           'tags', r.tags, 'created_at', r.created_at)
    into v_out
    from public.notebook_page_revisions r
   where r.id = p_id and r.dsp_id = v_dsp;
  if v_out is null then raise exception 'revision_not_found' using errcode = 'P0002'; end if;
  return v_out;
end; $$;
grant execute on function public.notebook_page_revision_get(uuid) to authenticated;

create or replace function public.notebook_page_revision_restore(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_rev public.notebook_page_revisions; v_cur public.notebook_pages; v_row public.notebook_pages;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_rev from public.notebook_page_revisions where id = p_id and dsp_id = v_dsp;
  if v_rev.id is null then raise exception 'revision_not_found' using errcode = 'P0002'; end if;
  select * into v_cur from public.notebook_pages
   where id = v_rev.page_id and dsp_id = v_dsp and deleted_at is null
   for update;
  if v_cur.id is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;

  -- make the restore itself undoable: force-snapshot the current state
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

-- ── realtime: stream notebook_pages changes to open dashboards ──────────────
do $$ begin
  alter publication supabase_realtime add table public.notebook_pages;
exception
  when duplicate_object then null;   -- already in the publication
  when undefined_object then null;   -- publication absent (bare local stack)
end $$;

notify pgrst, 'reload schema';
