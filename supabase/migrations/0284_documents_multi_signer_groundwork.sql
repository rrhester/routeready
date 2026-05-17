-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0284 · Documents · multi-signer (employer + driver) groundwork
--
-- Step 1 of the multi-signer build. Pure schema additions — no
-- behavior change yet:
--
--   1. Adds `awaiting_employer` to the document_envelope_status enum,
--      sitting between the driver-signed and the fully-signed states.
--   2. Adds employer-side audit columns to document_envelopes
--      (signing token, signature, signer identity, consent snapshot,
--      completion timestamp). Mirrors the i9_records.section2_* shape
--      so the audit trail is consistent across both surfaces.
--   3. Adds an `employer_field_values` jsonb so the employer-completed
--      text/checkbox/date fields can be stored separately from the
--      driver's `field_values`. Keeping them in two buckets makes the
--      role-keyed view trivial — and the PDF sealing worker can read
--      both maps without having to know which signer touched which key.
--
-- All new columns are nullable / default-empty. Existing single-signer
-- envelopes are unaffected. The next migrations (editor role-tag, then
-- driver-side flow handoff, then employer-sign RPC) light up the
-- functionality this scaffolding supports.
--
-- Idempotent — wraps each addition in IF NOT EXISTS / duplicate_object.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Enum value — Postgres lets us add but not drop in-place, and the
-- ADD VALUE is itself idempotent via the IF NOT EXISTS clause.
--
-- ⚠️ Postgres won't let a new enum value be referenced in the SAME
-- transaction it was added (see 55P04 "New enum values must be
-- committed before they can be used"). The Supabase SQL Editor runs
-- a whole script as one transaction, so when applying this manually
-- run THIS statement on its own first, then run the rest of the
-- migration as a second click. The split companion 0284a holds the
-- everything-else half so a clean re-bootstrap also works.
alter type public.document_envelope_status add value if not exists 'awaiting_employer' before 'signed';

-- 2. Envelope columns for the employer-side signing leg.
alter table public.document_envelopes
  add column if not exists employer_signing_token       text,
  add column if not exists employer_completed_at        timestamptz,
  add column if not exists employer_completed_by        uuid,
  add column if not exists employer_completed_by_name   text,
  add column if not exists employer_completed_by_title  text,
  add column if not exists employer_signature           jsonb,
  add column if not exists employer_consent_version     text,
  add column if not exists employer_consent_text        text,
  add column if not exists employer_field_values        jsonb not null default '{}'::jsonb;

-- FK + uniqueness only after the column exists. auth.users(id) is the
-- right anchor — the operator signs in their authenticated session, not
-- through the opaque-token PWA path the driver uses.
do $$ begin
  alter table public.document_envelopes
    add constraint document_envelopes_employer_completed_by_fkey
    foreign key (employer_completed_by) references auth.users(id) on delete set null;
exception when duplicate_object then null; end $$;

create unique index if not exists document_envelopes_employer_signing_token_idx
  on public.document_envelopes(employer_signing_token)
  where employer_signing_token is not null;

-- 3. Index to make the "documents awaiting my employer signature" queue
-- a cheap lookup on the dashboard. Partial — only open employer-side
-- rows, which keeps the index small for the common case (most envelopes
-- terminate in signed/declined/voided).
create index if not exists document_envelopes_awaiting_employer_idx
  on public.document_envelopes(dsp_id, sent_at desc)
  where status = 'awaiting_employer';

notify pgrst, 'reload schema';
