-- Migration 0479 · Notebook comments ────────────────────────────────────────
--
-- Adds threaded page comments with @mentions to Notebooks — the one true
-- collaboration gap the audit found (presence + backlinks existed, comments
-- did not). A comment belongs to a page; replies point at a parent comment;
-- an optional `anchor` string carries a block id / quoted selection for the
-- future selection-anchored comments (page-level comments leave it null).
--
-- Access rides entirely on the existing 0454 oracle — a comment is visible
-- when its page's notebook is visible, and writable when that notebook is
-- editable — so private notebooks never leak comments and viewers can read
-- but not post. Every RPC re-checks via private.notebook_require / _editable,
-- and edit/delete are further narrowed to the comment's author (or a notebook
-- owner). @mentions are validated against active staff of the caller's DSP.
--
-- Idempotent throughout (create table if not exists / create or replace /
-- drop policy if exists / exception-guarded publication add), like 0451-0454.
-- ───────────────────────────────────────────────────────────────────────────

-- ── table ────────────────────────────────────────────────────────────────────
create table if not exists public.notebook_comments (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  page_id      uuid not null references public.notebook_pages(id) on delete cascade,
  parent_id    uuid references public.notebook_comments(id) on delete cascade,
  anchor       text,                 -- optional block-id / quoted selection
  body         text not null default '',
  mentions     uuid[] not null default '{}',
  resolved_at  timestamptz,
  resolved_by  uuid references auth.users(id) on delete set null,
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists notebook_comments_page_idx
  on public.notebook_comments (page_id, created_at);
create index if not exists notebook_comments_parent_idx
  on public.notebook_comments (parent_id);

-- ── RLS: visible = page's notebook visible; write = editable ─────────────────
alter table public.notebook_comments enable row level security;
drop policy if exists notebook_comments_rw on public.notebook_comments;
create policy notebook_comments_rw on public.notebook_comments for all
  using (exists (select 1 from public.notebook_pages p
                  where p.id = page_id and private.notebook_visible(p.notebook_id)))
  with check (dsp_id = private.current_dsp_id()
              and exists (select 1 from public.notebook_pages p
                           where p.id = page_id and private.notebook_editable(p.notebook_id)));

-- ── realtime: stream comment changes to open dashboards ─────────────────────
do $$ begin
  alter publication supabase_realtime add table public.notebook_comments;
exception
  when duplicate_object then null;   -- already in the publication
  when undefined_object then null;   -- publication absent (bare local stack)
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- RPCs
-- ═══════════════════════════════════════════════════════════════════════════

-- helper: the notebook a page lives in (or null)
create or replace function private.notebook_of_page(p_page_id uuid)
returns uuid language sql security definer set search_path = '' as
$$ select notebook_id from public.notebook_pages
    where id = p_page_id and dsp_id = private.current_dsp_id() $$;

-- ── list a page's comments (threaded, with author + mention names) ──────────
create or replace function public.notebook_comments_list(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_nb uuid; v_out jsonb;
begin
  v_nb := private.notebook_of_page(p_page_id);
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, false);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'parent_id', c.parent_id, 'anchor', c.anchor, 'body', c.body,
           'created_at', c.created_at, 'updated_at', c.updated_at,
           'author', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'),
           'author_id', c.created_by,
           'is_mine', (c.created_by = v_uid),
           'resolved', (c.resolved_at is not null),
           'resolved_at', c.resolved_at,
           'resolved_by', rb_name.nm,
           'mentions', coalesce((
             select jsonb_agg(coalesce(nullif(trim(mu.full_name), ''), mu.email, 'teammate'))
               from public.app_users mu where mu.id = any(c.mentions)), '[]'::jsonb)
         ) order by c.created_at), '[]'::jsonb)
    into v_out
    from public.notebook_comments c
    left join public.app_users au on au.id = c.created_by
    left join lateral (
      select coalesce(nullif(trim(x.full_name), ''), x.email) as nm
        from public.app_users x where x.id = c.resolved_by
    ) rb_name on true
   where c.page_id = p_page_id and c.dsp_id = v_dsp;
  return v_out;
end; $$;
grant execute on function public.notebook_comments_list(uuid) to authenticated;

-- ── add a comment (or reply) ────────────────────────────────────────────────
create or replace function public.notebook_comment_add(
  p_page_id uuid, p_body text, p_parent_id uuid default null,
  p_anchor text default null, p_mentions uuid[] default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_nb uuid; v_row public.notebook_comments; v_ment uuid[];
begin
  v_nb := private.notebook_of_page(p_page_id);
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, true);
  if nullif(trim(coalesce(p_body, '')), '') is null then raise exception 'empty_comment' using errcode = '22023'; end if;
  -- a reply must target a comment on the same page
  if p_parent_id is not null and not exists (
      select 1 from public.notebook_comments where id = p_parent_id and page_id = p_page_id and dsp_id = v_dsp) then
    raise exception 'bad_parent' using errcode = '22023';
  end if;
  -- keep only real, active staff of this dsp as mentions
  select coalesce(array_agg(distinct u.id), '{}')
    into v_ment
    from unnest(coalesce(p_mentions, '{}')) as m(id)
    join public.app_users u on u.id = m.id and u.dsp_id = v_dsp and u.active;
  insert into public.notebook_comments (dsp_id, page_id, parent_id, anchor, body, mentions, created_by)
  values (v_dsp, p_page_id, p_parent_id, nullif(trim(coalesce(p_anchor, '')), ''),
          trim(p_body), v_ment, auth.uid())
  returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'page_id', v_row.page_id, 'parent_id', v_row.parent_id,
    'body', v_row.body, 'created_at', v_row.created_at);
end; $$;
grant execute on function public.notebook_comment_add(uuid, text, uuid, text, uuid[]) to authenticated;

-- ── edit a comment's body (author only) ─────────────────────────────────────
create or replace function public.notebook_comment_edit(p_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_comments;
begin
  select * into v_row from public.notebook_comments where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'comment_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(private.notebook_of_page(v_row.page_id), true);
  if v_row.created_by is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_body, '')), '') is null then raise exception 'empty_comment' using errcode = '22023'; end if;
  update public.notebook_comments set body = trim(p_body), updated_at = now()
   where id = p_id returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'body', v_row.body, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_comment_edit(uuid, text) to authenticated;

-- ── resolve / reopen a comment (any editor) ─────────────────────────────────
create or replace function public.notebook_comment_resolve(p_id uuid, p_resolved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_comments;
begin
  select * into v_row from public.notebook_comments where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'comment_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(private.notebook_of_page(v_row.page_id), true);
  update public.notebook_comments
     set resolved_at = case when coalesce(p_resolved, false) then now() else null end,
         resolved_by = case when coalesce(p_resolved, false) then auth.uid() else null end,
         updated_at  = now()
   where id = p_id;
end; $$;
grant execute on function public.notebook_comment_resolve(uuid, boolean) to authenticated;

-- ── delete a comment (author, or a notebook owner) ──────────────────────────
create or replace function public.notebook_comment_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_comments; v_nb uuid;
begin
  select * into v_row from public.notebook_comments where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'comment_not_found' using errcode = 'P0002'; end if;
  v_nb := private.notebook_of_page(v_row.page_id);
  perform private.notebook_require(v_nb, true);
  if v_row.created_by is distinct from auth.uid() and private.notebook_role(v_nb) <> 'owner' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.notebook_comments where id = p_id;  -- cascades to replies
end; $$;
grant execute on function public.notebook_comment_delete(uuid) to authenticated;

-- ── open-comment counts for a set of pages (rail/list badges) ───────────────
create or replace function public.notebook_comment_counts(p_page_ids uuid[])
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_object_agg(t.page_id, t.n), '{}'::jsonb) into v_out
    from (
      select c.page_id, count(*) filter (where c.resolved_at is null) as n
        from public.notebook_comments c
        join public.notebook_pages p on p.id = c.page_id
       where c.dsp_id = v_dsp and c.page_id = any(coalesce(p_page_ids, '{}'))
         and private.notebook_visible(p.notebook_id)
       group by c.page_id
    ) t;
  return v_out;
end; $$;
grant execute on function public.notebook_comment_counts(uuid[]) to authenticated;

notify pgrst, 'reload schema';
