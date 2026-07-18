-- Migration 0514 · Notebook comments: an explicit edited_at ───────────────────
--
-- #86 ("edit your own comment, with an 'edited' tag") needs to distinguish a
-- body edit from a resolve/reopen — both of which already bump updated_at (0479),
-- so updated_at alone can't drive an honest "edited" tag. This adds a dedicated
-- edited_at column that ONLY notebook_comment_edit sets, and surfaces it in
-- notebook_comments_list. The edit RPC already existed in 0479; here we just
-- teach it (and the list) about edited_at.
--
-- Idempotent: add column if not exists + create or replace the two functions.
-- The frag degrades gracefully pre-migration (no edited_at → the tag simply
-- never shows), so shipping the UI ahead of this SQL is safe.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.notebook_comments
  add column if not exists edited_at timestamptz;

-- ── edit a comment's body (author only) — now stamps edited_at ───────────────
create or replace function public.notebook_comment_edit(p_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.notebook_comments;
begin
  select * into v_row from public.notebook_comments where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'comment_not_found' using errcode = 'P0002'; end if;
  perform private.notebook_require(private.notebook_of_page(v_row.page_id), true);
  if v_row.created_by is distinct from auth.uid() then raise exception 'forbidden' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_body, '')), '') is null then raise exception 'empty_comment' using errcode = '22023'; end if;
  update public.notebook_comments
     set body = trim(p_body), edited_at = now(), updated_at = now()
   where id = p_id returning * into v_row;
  return jsonb_build_object('id', v_row.id, 'body', v_row.body, 'edited_at', v_row.edited_at, 'updated_at', v_row.updated_at);
end; $$;
grant execute on function public.notebook_comment_edit(uuid, text) to authenticated;

-- ── list a page's comments — now returns edited_at ──────────────────────────
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

notify pgrst, 'reload schema';
