-- 0331_document_classification.sql
--
-- Phase 2 of the document scanner · Claude-powered classification +
-- structured extraction. The intake spine (table + bucket) was built
-- in 0330; this migration adds the columns the new
-- supabase/functions/document-classify edge function writes back
-- after sending a doc to Claude.
--
-- The classifier is general-purpose — Claude figures out the doc
-- type (vehicle_inspection_report, drivers_license, lease_agreement,
-- articles_of_organization, invoice, drug_test_result, …) and
-- extracts whatever structured fields are clearly stated. Phase 3
-- will use classified_type to route each doc into the right target
-- table (vans, drivers, vehicle_inspections, etc).
--
-- Idempotent.

-- ── New columns on document_intake ────────────────────────────────
-- classification_summary    · 1-2 sentence human-readable summary
-- classification_error      · last error message (null on success)
-- classification_model      · which Claude model returned the verdict
-- classification_prompt_version  · bumps if we tweak the prompt so
--                                  re-classify can detect staleness
-- classified_type_label     · human-readable label for the snake_case
--                              classified_type (e.g. "Vehicle Inspection Report")
alter table public.document_intake
  add column if not exists classification_summary        text,
  add column if not exists classification_error          text,
  add column if not exists classification_model          text,
  add column if not exists classification_prompt_version int not null default 1,
  add column if not exists classified_type_label         text;

-- Allow a new lifecycle state · 'classifying' so the UI can show a
-- spinner while Claude is thinking. We extend the existing CHECK
-- constraint by dropping + recreating it (postgres won't let us
-- ALTER ... ADD CHECK without a name we can reference).
do $$
declare
  c_name text;
begin
  select conname into c_name
  from pg_constraint
  where conrelid = 'public.document_intake'::regclass
    and contype  = 'c'
    and pg_get_constraintdef(oid) like '%status%pending%classified%';
  if c_name is not null then
    execute format('alter table public.document_intake drop constraint %I', c_name);
  end if;
end $$;

alter table public.document_intake
  add constraint document_intake_status_check
    check (status in ('pending', 'classifying', 'classified', 'filed', 'dismissed', 'error'));

create index if not exists idx_document_intake_status_pending
  on public.document_intake (created_at desc)
  where status in ('pending', 'classifying');


-- ── Backfill RPC · queue all stale pending docs ──────────────────
-- The dashboard's "Re-classify" button calls
-- document_intake_request_classify which flips status to 'classifying'
-- and lets the edge function pick it up. We use a SECURITY DEFINER
-- RPC instead of a raw UPDATE so the dashboard doesn't need to
-- consider the prompt-version bookkeeping itself.
create or replace function public.document_intake_request_classify(
  p_id uuid
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
     set status                = 'classifying',
         classification_error  = null,
         classified_at         = null
   where id     = p_id
     and dsp_id = v_dsp;
end;
$$;
grant execute on function public.document_intake_request_classify(uuid) to authenticated;


-- ── RPC · write back classifier result (called by the edge fn) ───
-- The edge function runs with the service-role key, but we route its
-- write through a SECURITY DEFINER RPC so any future column changes
-- or audit logging happen in one place rather than spread across two
-- runtimes. The RPC trusts its caller (service role only — there's
-- no grant to authenticated).
create or replace function private.document_intake_save_classification(
  p_id                  uuid,
  p_type                text,
  p_type_label          text,
  p_confidence          numeric,
  p_extracted_data      jsonb,
  p_summary             text,
  p_model               text,
  p_prompt_version      int
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_intake
     set status                        = 'classified',
         classified_type               = p_type,
         classified_type_label         = p_type_label,
         classification_score          = p_confidence,
         extracted_data                = p_extracted_data,
         classification_summary        = p_summary,
         classification_model          = p_model,
         classification_prompt_version = p_prompt_version,
         classification_error          = null,
         classified_at                 = now()
   where id = p_id;
end;
$$;

create or replace function private.document_intake_save_classification_error(
  p_id     uuid,
  p_error  text,
  p_model  text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.document_intake
     set status                = 'error',
         classification_error  = p_error,
         classification_model  = p_model
   where id = p_id;
end;
$$;


notify pgrst, 'reload schema';
