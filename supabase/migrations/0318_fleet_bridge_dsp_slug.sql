-- 0318_fleet_bridge_dsp_slug.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · scaled DSP slug + email-messages folder tie-in
--
-- Today's problem:
--   - public.dsps has no slug column. Both webhook-email-inbound and
--     send-email derive a slug from dsps.name at request time.
--   - Two DSPs whose names slugify to the same string collide silently
--     (whichever row comes first wins; the other DSP's vendor mail goes
--     to the wrong inbox).
--   - A DSP rename instantly breaks every in-flight reply thread.
--   - No reserved-word protection (a DSP named "Admin" could claim
--     admin@gorouteready.com).
--
-- This migration:
--   1. Adds dsps.slug with a unique (lower) index, format check, and
--      auto-assignment trigger.
--   2. Adds private.dsp_unique_slug(name) — collision-handled,
--      reserved-word-blocked.
--   3. Backfills slugs for every existing DSP.
--   4. Auto-seeds the five Fleet Bridge folders for every new DSP +
--      backfills all existing ones, so the inbound webhook never races
--      the dashboard's first open.
--   5. Drops the redundant fb_messages / fb_attachments tables — vendor
--      mail will reuse the existing public.email_messages pipeline.
--   6. Adds email_messages.folder_id pointing at fb_folders so Fleet
--      Bridge can filter "show me what's in Inbox / Sent / etc." while
--      legacy applicant-related messages (folder_id NULL) keep their
--      current behavior untouched.
--
-- Idempotent throughout.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;


-- ─── Reserved-slug checker ───────────────────────────────────────
create or replace function private.is_reserved_dsp_slug(p_slug text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select lower(coalesce(p_slug, '')) = any (array[
    'admin','administrator','root','system','api','www','mail',
    'support','help','info','contact','sales','hello','team',
    'no-reply','noreply','do-not-reply','donotreply','bounce','bounces',
    'postmaster','mailer-daemon','mailer','abuse','webmaster','security',
    'routeready','gorouteready','route-ready','go-route-ready',
    'test','test1','default','dsp','null','undefined','none',
    'invoice','billing','accounts','accounting','legal','hr'
  ]);
$$;
grant execute on function private.is_reserved_dsp_slug(text) to authenticated;


-- ─── dsps.slug column + format constraint + unique index ─────────
alter table public.dsps add column if not exists slug text;
create unique index if not exists dsps_slug_lower_uniq on public.dsps(lower(slug));


-- ─── Collision-handled, reserved-word-aware slug generator ───────
create or replace function private.dsp_unique_slug(p_name text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_base      text;
  v_candidate text;
  v_n         int := 0;
begin
  v_base := lower(coalesce(p_name, ''));
  -- Strip the common accented Latin characters so "café" → "cafe".
  v_base := translate(
    v_base,
    'àáâãäåèéêëìíîïòóôõöùúûüñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÑÇ',
    'aaaaaaeeeeiiiiooooouuuuncaaaaaaeeeeiiiiooooouuuunc'
  );
  v_base := regexp_replace(v_base, '[^a-z0-9]+', '-', 'g');
  v_base := regexp_replace(v_base, '^-+|-+$', '', 'g');
  v_base := substring(v_base, 1, 30);
  -- Strip a trailing dash that might have been left by the 30-char cut.
  v_base := regexp_replace(v_base, '-+$', '', 'g');
  if coalesce(v_base, '') = '' then
    v_base := 'dsp';
  end if;
  v_candidate := v_base;
  while private.is_reserved_dsp_slug(v_candidate)
        or exists (select 1 from public.dsps where lower(slug) = v_candidate) loop
    v_n := v_n + 1;
    v_candidate := v_base || '-' || v_n;
    if v_n > 1000 then
      raise exception 'dsp_unique_slug exhausted candidates for base %', v_base;
    end if;
  end loop;
  return v_candidate;
end $$;
grant execute on function private.dsp_unique_slug(text) to authenticated;


-- ─── Backfill existing DSPs ──────────────────────────────────────
update public.dsps
set slug = private.dsp_unique_slug(name)
where slug is null or trim(slug) = '';


-- ─── Lock the column in ──────────────────────────────────────────
alter table public.dsps alter column slug set not null;
do $$ begin
  alter table public.dsps add constraint dsps_slug_format
    check (slug ~ '^[a-z0-9][a-z0-9-]{0,29}$' and slug !~ '--');
exception when duplicate_object then null; end $$;


-- ─── Auto-assign trigger (slug on insert) ────────────────────────
create or replace function private.dsps_assign_slug_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.slug is null or trim(new.slug) = '' then
    new.slug := private.dsp_unique_slug(new.name);
  end if;
  return new;
end $$;
drop trigger if exists trg_dsps_assign_slug on public.dsps;
create trigger trg_dsps_assign_slug
  before insert on public.dsps
  for each row execute function private.dsps_assign_slug_trigger();


-- ─── Auto-seed Fleet Bridge folders (per-DSP, on insert) ─────────
create or replace function private.dsps_seed_fb_folders_trigger()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  insert into public.fb_folders(dsp_id, name, kind, position) values
    (new.id, 'Inbox',   'inbox',   1),
    (new.id, 'Drafts',  'drafts',  2),
    (new.id, 'Sent',    'sent',    3),
    (new.id, 'Archive', 'archive', 4),
    (new.id, 'Trash',   'trash',   5)
  on conflict do nothing;
  return null;
end $$;
drop trigger if exists trg_dsps_seed_fb_folders on public.dsps;
create trigger trg_dsps_seed_fb_folders
  after insert on public.dsps
  for each row execute function private.dsps_seed_fb_folders_trigger();

-- One-shot backfill for the DSPs that already exist.
insert into public.fb_folders(dsp_id, name, kind, position)
select d.id, k.name, k.kind, k.position
from public.dsps d
cross join (values
  ('Inbox',   'inbox',   1),
  ('Drafts',  'drafts',  2),
  ('Sent',    'sent',    3),
  ('Archive', 'archive', 4),
  ('Trash',   'trash',   5)
) as k(name, kind, position)
on conflict do nothing;


-- ─── Drop redundant Fleet Bridge tables ─────────────────────────
-- (fb_messages / fb_attachments were carved out in 0317 but Fleet
--  Bridge will reuse the existing public.email_messages pipeline.)
do $$ begin
  alter publication supabase_realtime drop table public.fb_messages;
exception when others then null; end $$;
drop table if exists public.fb_attachments cascade;
drop table if exists public.fb_messages    cascade;


-- ─── Tie email_messages into the Fleet Bridge folder model ──────
alter table public.email_messages
  add column if not exists folder_id uuid references public.fb_folders(id) on delete set null;
create index if not exists email_messages_folder_idx
  on public.email_messages(folder_id)
  where folder_id is not null;

-- Realtime for the dashboard's Fleet Bridge inbox subscriber.
do $$ begin
  alter publication supabase_realtime add table public.email_messages;
exception when duplicate_object then null; end $$;
