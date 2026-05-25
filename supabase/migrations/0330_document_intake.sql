-- 0330_document_intake.sql
--
-- Phase 1 of the document scanner · capture every PDF / image /
-- spreadsheet that arrives as an email attachment (or gets manually
-- uploaded by the operator) into a single intake table. Phase 2 will
-- add Claude-powered classification + structured extraction; Phase 3
-- will file the extracted data into the right target tables (vans,
-- drivers, vehicle_inspections, etc).
--
-- This migration ships the intake spine only:
--   • storage bucket `document-intake` (DSP-scoped via path prefix)
--   • table `document_intake` with the lifecycle columns the later
--     phases will fill in (status, classified_type, extracted_data,
--     filed_to_table, filed_to_id, retention_until, …)
--
-- Idempotent.

-- ── Storage bucket ─────────────────────────────────────────────────
-- 100 MB per file is plenty for any scanned VIR / DOT card / lease
-- attachment we'll realistically see. Bucket stays private — the
-- dashboard mints signed URLs on demand.
insert into storage.buckets (id, name, public, file_size_limit)
values ('document-intake', 'document-intake', false, 104857600)
on conflict (id) do nothing;


-- ── Table ──────────────────────────────────────────────────────────
create table if not exists public.document_intake (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,

  -- ── Where it came from ──
  -- 'email'         · captured by webhook-email-inbound from an
  --                   inbound mail's attachments[]
  -- 'manual_upload' · operator dropped a file onto the intake UI
  source                text not null
                          check (source in ('email', 'manual_upload')),
  -- Email provenance (null for manual_upload)
  email_message_id      uuid references public.email_messages(id) on delete set null,
  sender_email          text,
  sender_name           text,
  -- Manual-upload provenance (null for email)
  uploaded_by           uuid references auth.users(id) on delete set null,

  -- ── The file ──
  storage_path          text not null,    -- key inside `document-intake` bucket
  file_name             text not null,
  file_size_bytes       bigint,
  mime_type             text,

  -- ── Lifecycle ──
  -- 'pending'    · just captured; no AI work done yet
  -- 'classified' · Phase 2 has labeled the doc type + extracted fields,
  --                awaiting operator review
  -- 'filed'      · operator confirmed; extracted data committed to a
  --                target row (filed_to_table/filed_to_id) and the
  --                document_intake row points at where it landed
  -- 'dismissed'  · operator marked it irrelevant; no further action
  status                text not null default 'pending'
                          check (status in
                            ('pending', 'classified', 'filed', 'dismissed')),

  -- ── Phase 2 fields (classification) ──
  classified_type       text,             -- e.g. 'vehicle_inspection_report'
  classification_score  numeric(4,3),     -- model confidence, 0.000–1.000
  extracted_data        jsonb,            -- per-doc-type structured payload
  classified_at         timestamptz,

  -- ── Phase 3 fields (filing) ──
  filed_at              timestamptz,
  filed_to_table        text,             -- e.g. 'vehicle_inspections'
  filed_to_id           uuid,             -- pk of the row this filed into
  filed_by              uuid references auth.users(id) on delete set null,

  -- ── Dismissal ──
  dismissed_at          timestamptz,
  dismissed_by          uuid references auth.users(id) on delete set null,
  dismissed_reason      text,

  -- ── Retention ──
  -- Filed docs are kept forever (evidence). Raw email attachments that
  -- get filed elsewhere age out — a nightly job will null storage_path
  -- + delete the bucket object once retention_until is reached.
  retention_until       date,             -- null = keep forever

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists idx_document_intake_dsp_status
  on public.document_intake (dsp_id, status, created_at desc);
create index if not exists idx_document_intake_email_msg
  on public.document_intake (email_message_id);
create index if not exists idx_document_intake_filed
  on public.document_intake (filed_to_table, filed_to_id)
  where filed_at is not null;
create index if not exists idx_document_intake_retention
  on public.document_intake (retention_until)
  where retention_until is not null and storage_path is not null;


-- ── RLS on the table ──────────────────────────────────────────────
alter table public.document_intake enable row level security;

drop policy if exists document_intake_dsp_read on public.document_intake;
create policy document_intake_dsp_read on public.document_intake
  for select using (dsp_id = private.current_dsp_id());

drop policy if exists document_intake_dsp_insert on public.document_intake;
create policy document_intake_dsp_insert on public.document_intake
  for insert with check (dsp_id = private.current_dsp_id());

drop policy if exists document_intake_dsp_update on public.document_intake;
create policy document_intake_dsp_update on public.document_intake
  for update using (dsp_id = private.current_dsp_id())
  with check  (dsp_id = private.current_dsp_id());


-- ── Storage RLS · dsp-scoped via path prefix ──────────────────────
-- Every object lives under `<dsp_id>/...` so we can scope reads and
-- inserts by the first path segment. The bucket itself stays private;
-- the dashboard mints signed URLs whenever it needs to render a doc.
drop policy if exists "document-intake dsp read" on storage.objects;
create policy "document-intake dsp read" on storage.objects
  for select using (
    bucket_id = 'document-intake'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );

drop policy if exists "document-intake dsp insert" on storage.objects;
create policy "document-intake dsp insert" on storage.objects
  for insert with check (
    bucket_id = 'document-intake'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );

drop policy if exists "document-intake dsp delete" on storage.objects;
create policy "document-intake dsp delete" on storage.objects
  for delete using (
    bucket_id = 'document-intake'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );


-- ── updated_at trigger ────────────────────────────────────────────
create or replace function public.document_intake_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$ begin
  create trigger trg_document_intake_touch
    before update on public.document_intake
    for each row execute function public.document_intake_touch_updated_at();
exception when duplicate_object then null; end $$;


-- ── RPC · dismiss_document_intake ─────────────────────────────────
-- Convenience for the dashboard's "Dismiss" action so the JS doesn't
-- have to know about the lifecycle columns. Records who dismissed it
-- and when, plus an optional reason.
create or replace function public.dismiss_document_intake(
  p_id      uuid,
  p_reason  text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.document_intake
     set status           = 'dismissed',
         dismissed_at     = now(),
         dismissed_by     = auth.uid(),
         dismissed_reason = p_reason
   where id     = p_id
     and dsp_id = v_dsp;
end;
$$;
grant execute on function public.dismiss_document_intake(uuid, text) to authenticated;


-- The dashboard mints signed Storage URLs directly via the JS SDK
-- (supabase.storage.from('document-intake').createSignedUrl(path, ttl))
-- so no SQL helper is needed for that side.


notify pgrst, 'reload schema';
