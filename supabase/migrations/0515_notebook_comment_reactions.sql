-- Migration 0515 · Notebook comments: emoji reactions ────────────────────────
--
-- #85 ("emoji reactions on comments"). A reaction is (comment, user, emoji),
-- unique per triple so a user's each-emoji toggle is idempotent. Access rides
-- the same 0454 visibility oracle as comments themselves — visible when the
-- comment's page's notebook is visible, writable when it's editable. The list
-- RPC (re-created here to also keep 0479's fields + 0514's edited_at) now
-- returns a per-emoji {emoji, count, mine} aggregate per comment.
--
-- Idempotent throughout. The frag degrades gracefully pre-migration: no
-- reactions array → no pills, and the react button no-ops with a toast.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.notebook_comment_reactions (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  comment_id  uuid not null references public.notebook_comments(id) on delete cascade,
  user_id     uuid references auth.users(id) on delete set null,
  emoji       text not null,
  created_at  timestamptz not null default now(),
  unique (comment_id, user_id, emoji)
);
create index if not exists notebook_comment_reactions_cmt_idx
  on public.notebook_comment_reactions (comment_id);

alter table public.notebook_comment_reactions enable row level security;
drop policy if exists notebook_comment_reactions_rw on public.notebook_comment_reactions;
create policy notebook_comment_reactions_rw on public.notebook_comment_reactions for all
  using (exists (select 1 from public.notebook_comments c
                   join public.notebook_pages p on p.id = c.page_id
                  where c.id = comment_id and private.notebook_visible(p.notebook_id)))
  with check (dsp_id = private.current_dsp_id()
              and exists (select 1 from public.notebook_comments c
                            join public.notebook_pages p on p.id = c.page_id
                           where c.id = comment_id and private.notebook_editable(p.notebook_id)));

do $$ begin
  alter publication supabase_realtime add table public.notebook_comment_reactions;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── toggle a reaction (add if absent, remove if present; p_on forces it) ─────
create or replace function public.notebook_comment_react(
  p_comment_id uuid, p_emoji text, p_on boolean default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_page uuid; v_exists boolean;
        v_emoji text := left(trim(coalesce(p_emoji, '')), 16);
begin
  if v_emoji = '' then raise exception 'empty_emoji' using errcode = '22023'; end if;
  select page_id into v_page from public.notebook_comments where id = p_comment_id and dsp_id = v_dsp;
  if v_page is null then raise exception 'comment_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(private.notebook_of_page(v_page), true);
  select exists(select 1 from public.notebook_comment_reactions
                 where comment_id = p_comment_id and user_id = auth.uid() and emoji = v_emoji) into v_exists;
  if coalesce(p_on, not v_exists) then
    insert into public.notebook_comment_reactions (dsp_id, comment_id, user_id, emoji)
    values (v_dsp, p_comment_id, auth.uid(), v_emoji) on conflict do nothing;
  else
    delete from public.notebook_comment_reactions
     where comment_id = p_comment_id and user_id = auth.uid() and emoji = v_emoji;
  end if;
end; $$;
grant execute on function public.notebook_comment_react(uuid, text, boolean) to authenticated;

-- ── list a page's comments — now returns reactions (plus 0514's edited_at) ──
create or replace function public.notebook_comments_list(p_page_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_nb uuid; v_out jsonb;
begin
  v_nb := private.notebook_of_page(p_page_id);
  if v_nb is null then raise exception 'page_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(v_nb, false);
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'parent_id', c.parent_id, 'anchor', c.anchor, 'body', c.body,
           'created_at', c.created_at, 'updated_at', c.updated_at, 'edited_at', c.edited_at,
           'author', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'),
           'author_id', c.created_by,
           'is_mine', (c.created_by = v_uid),
           'resolved', (c.resolved_at is not null),
           'resolved_at', c.resolved_at,
           'resolved_by', rb_name.nm,
           'mentions', coalesce((
             select jsonb_agg(coalesce(nullif(trim(mu.full_name), ''), mu.email, 'teammate'))
               from public.app_users mu where mu.id = any(c.mentions)), '[]'::jsonb),
           'reactions', coalesce((
             select jsonb_agg(jsonb_build_object('emoji', x.emoji, 'count', x.n, 'mine', x.mine)
                              order by x.n desc, x.emoji)
               from (select emoji, count(*) as n, bool_or(user_id = v_uid) as mine
                       from public.notebook_comment_reactions
                      where comment_id = c.id group by emoji) x), '[]'::jsonb)
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

notify pgrst, 'reload schema';
