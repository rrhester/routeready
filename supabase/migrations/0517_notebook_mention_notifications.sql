-- Migration 0517 · Notebook @mention notifications ───────────────────────────
--
-- #84 ("@mention sends a notification and marks the thread unread for them").
-- Comments already store validated mentions[] (0479); this records a per-user
-- notification row when someone is @mentioned, so each mentioned teammate gets
-- an unread badge + inbox that deep-links to the page. Read state is per row
-- (read_at). notebook_comment_add is re-created to fan mentions out into this
-- table (skipping self-mentions).
--
-- Access: a user sees only their own notifications. Idempotent throughout; the
-- frag degrades gracefully (missing RPCs → the @ inbox just stays empty).
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.notebook_mention_notifications (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  comment_id    uuid not null references public.notebook_comments(id) on delete cascade,
  page_id       uuid not null references public.notebook_pages(id) on delete cascade,
  notebook_id   uuid references public.notebooks(id) on delete cascade,
  mentioned_by  uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  read_at       timestamptz
);
create index if not exists notebook_mention_notif_user_idx
  on public.notebook_mention_notifications (user_id, read_at, created_at desc);

alter table public.notebook_mention_notifications enable row level security;
drop policy if exists notebook_mention_notif_rw on public.notebook_mention_notifications;
create policy notebook_mention_notif_rw on public.notebook_mention_notifications for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid() or dsp_id = private.current_dsp_id());

do $$ begin
  alter publication supabase_realtime add table public.notebook_mention_notifications;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ── add a comment (or reply) — now fans @mentions out to notifications ───────
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
  if p_parent_id is not null and not exists (
      select 1 from public.notebook_comments where id = p_parent_id and page_id = p_page_id and dsp_id = v_dsp) then
    raise exception 'bad_parent' using errcode = '22023';
  end if;
  select coalesce(array_agg(distinct u.id), '{}')
    into v_ment
    from unnest(coalesce(p_mentions, '{}')) as m(id)
    join public.app_users u on u.id = m.id and u.dsp_id = v_dsp and u.active;
  insert into public.notebook_comments (dsp_id, page_id, parent_id, anchor, body, mentions, created_by)
  values (v_dsp, p_page_id, p_parent_id, nullif(trim(coalesce(p_anchor, '')), ''),
          trim(p_body), v_ment, auth.uid())
  returning * into v_row;
  -- #84 one notification per mentioned teammate (never notify yourself)
  insert into public.notebook_mention_notifications (dsp_id, user_id, comment_id, page_id, notebook_id, mentioned_by)
  select v_dsp, m, v_row.id, p_page_id, v_nb, auth.uid()
    from unnest(v_ment) as m
   where m is distinct from auth.uid();
  return jsonb_build_object('id', v_row.id, 'page_id', v_row.page_id, 'parent_id', v_row.parent_id,
    'body', v_row.body, 'created_at', v_row.created_at);
end; $$;
grant execute on function public.notebook_comment_add(uuid, text, uuid, text, uuid[]) to authenticated;

-- ── my unread @mentions (newest first) ──────────────────────────────────────
create or replace function public.notebook_mentions_unread()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := auth.uid(); v_out jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', n.id, 'page_id', n.page_id, 'notebook_id', n.notebook_id,
           'page_title', coalesce(nullif(trim(p.title), ''), 'Untitled Page'),
           'by', coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'),
           'snippet', left(regexp_replace(coalesce(c.body, ''), '\s+', ' ', 'g'), 120),
           'created_at', n.created_at) order by n.created_at desc), '[]'::jsonb)
    into v_out
    from public.notebook_mention_notifications n
    join public.notebook_pages p on p.id = n.page_id
    left join public.notebook_comments c on c.id = n.comment_id
    left join public.app_users au on au.id = n.mentioned_by
   where n.user_id = v_uid and n.read_at is null
     and p.deleted_at is null and private.notebook_visible(p.notebook_id);
  return v_out;
end; $$;
grant execute on function public.notebook_mentions_unread() to authenticated;

-- ── mark one / all of my mentions read ──────────────────────────────────────
create or replace function public.notebook_mention_read(p_id uuid)
returns void language sql security definer set search_path = '' as $$
  update public.notebook_mention_notifications set read_at = now()
   where user_id = auth.uid() and (p_id is null or id = p_id) and read_at is null;
$$;
grant execute on function public.notebook_mention_read(uuid) to authenticated;

notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0517_notebook_mention_notifications.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
