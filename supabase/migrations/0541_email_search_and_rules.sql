-- 0541_email_search_and_rules.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · search & filters batch G (Email review EM#67/72)
--
--   1. email_search(...) — server-side all-mail search (EM#67). The
--      client's toolbar search only covers the ~200 loaded rows of the
--      active folder; this RPC sweeps the whole DSP's mail (subject,
--      body text, addresses, sender name) with the client's parsed
--      operators (from:/to:/has:attachment/before:/after:) as params.
--      Drafts are excluded (they open into the composer, not the
--      preview). ILIKE over a DSP's mail volume is fine unindexed;
--      revisit with pg_trgm only if a tenant ever grows past ~100k rows.
--   2. email_rules — auto-filing rules (EM#72): sender / domain /
--      subject-contains → folder, applied by webhook-email-inbound at
--      insert time (first match by age wins). RLS: tenant read/write.
--
-- Column re-asserts up top: the search function references cc_emails /
-- from_name / has_attachments, which arrived in 0535/0536 — re-adding
-- them here keeps this migration applicable even if the chain was
-- skipped (the same guard pattern as 0496/0509). status is compared as
-- ::text so a pre-0537 enum (no 'draft' value) can't error.
--
-- Graceful pre-migration: the client probes both surfaces and falls
-- back (folder-only search / "needs migration 0541" toast).
--
-- Idempotent.
-- ════════════════════════════════════════════════════════════════════

set search_path = public, pg_temp;

alter table public.email_messages add column if not exists cc_emails text[];
alter table public.email_messages add column if not exists from_name text;
alter table public.email_messages add column if not exists has_attachments boolean not null default false;

-- ─── 1 · email_search ────────────────────────────────────────────
create or replace function public.email_search(
  p_query text default null,
  p_from  text default null,
  p_to    text default null,
  p_has_attachment boolean default null,
  p_before timestamptz default null,
  p_after  timestamptz default null,
  p_limit  int default 100
) returns setof public.email_messages
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
  select m.*
    from public.email_messages m
   where m.dsp_id = v_dsp
     and m.status::text is distinct from 'draft'
     and (p_query is null or p_query = ''
          or m.subject    ilike '%' || p_query || '%'
          or m.body_text  ilike '%' || p_query || '%'
          or m.from_email ilike '%' || p_query || '%'
          or m.to_email   ilike '%' || p_query || '%'
          or coalesce(m.from_name, '') ilike '%' || p_query || '%')
     and (p_from is null
          or m.from_email ilike '%' || p_from || '%'
          or coalesce(m.from_name, '') ilike '%' || p_from || '%')
     and (p_to is null
          or m.to_email ilike '%' || p_to || '%'
          or exists (select 1 from unnest(coalesce(m.cc_emails, '{}'::text[])) c
                      where c ilike '%' || p_to || '%'))
     and (p_has_attachment is not true or m.has_attachments = true)
     and (p_before is null or m.created_at < p_before)
     and (p_after  is null or m.created_at >= p_after)
   order by m.created_at desc
   limit least(greatest(coalesce(p_limit, 100), 1), 200);
end $$;

grant execute on function public.email_search(text, text, text, boolean, timestamptz, timestamptz, int) to authenticated;

-- ─── 2 · email_rules ─────────────────────────────────────────────
create table if not exists public.email_rules (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  match_kind  text not null check (match_kind in ('sender','domain','subject')),
  pattern     text not null check (char_length(pattern) between 1 and 200),
  folder_id   uuid not null references public.fb_folders(id) on delete cascade,
  created_by  uuid,
  created_at  timestamptz not null default now()
);
create index if not exists email_rules_dsp_idx on public.email_rules(dsp_id);
create unique index if not exists email_rules_uniq
  on public.email_rules(dsp_id, match_kind, lower(pattern));

alter table public.email_rules enable row level security;
drop policy if exists email_rules_select on public.email_rules;
create policy email_rules_select on public.email_rules for select
  using (dsp_id = private.current_dsp_id());
drop policy if exists email_rules_insert on public.email_rules;
create policy email_rules_insert on public.email_rules for insert
  with check (dsp_id = private.current_dsp_id());
drop policy if exists email_rules_delete on public.email_rules;
create policy email_rules_delete on public.email_rules for delete
  using (dsp_id = private.current_dsp_id());
