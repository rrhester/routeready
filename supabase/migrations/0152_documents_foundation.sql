-- Migration 0152 · Documents (e-signature) · audit-grade foundation
--
-- The bottom layer of a court-defensible e-signature flow: the data
-- model and the immutable, hash-chained audit log every later piece
-- (template upload, signing flow, PKCS#7 sealing, RFC 3161 timestamping,
-- verification URL) writes into.
--
-- The audit log is genuinely append-only:
--   • document_events has no INSERT/UPDATE/DELETE policy, so RLS denies
--     writes from any authenticated/anon role.
--   • UPDATE and DELETE are additionally blocked at the row level by a
--     trigger, so even a future RLS misconfiguration can't open a
--     tampering path without an auditable schema change.
--   • The only insert path is private.append_document_event — a
--     SECURITY DEFINER function that computes each event's SHA-256 hash
--     over (prev_event_hash || canonical JSON of the event), so any
--     single-row tampering or removal is detectable by re-walking the
--     chain.
--
-- Recipient identity is captured in two places: a FK to the driver row
-- (recipient_driver_id, for surfacing and joins) AND a snapshot
-- (recipient_email/name) so a later delete of the driver row doesn't
-- erase who signed. Same idea for the field layout (fields_snapshot on
-- the envelope), so a later edit of the template can't retroactively
-- change what a signer saw.

create extension if not exists pgcrypto;


-- ── Enums ────────────────────────────────────────────────────────────────

create type public.document_envelope_status as enum (
  'sent',      -- envelope created and delivered to the signer
  'viewed',    -- signer opened the document
  'signed',    -- signer completed all required fields + intent-to-sign
  'declined',  -- signer explicitly declined
  'voided',    -- sender voided before completion
  'expired'    -- envelope passed its expires_at without completion
);

create type public.document_event_kind as enum (
  'envelope_created',
  'sent',
  'viewed',
  'consent_accepted',
  'field_completed',
  'signed',
  'declined',
  'voided',
  'expired',
  'pdf_sealed',       -- PKCS#7 detached signature + RFC 3161 timestamp embedded
  'reminder_sent',
  'downloaded'
);


-- ── document_templates ──────────────────────────────────────────────────
-- A PDF + the field layout dispatchers reuse when sending envelopes.
-- source_hash is recorded so we can prove what was sent for any envelope
-- that referenced this template at send time.

create table public.document_templates (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  title       text not null,
  description text,
  source_path text not null,                      -- storage path in 'documents' bucket
  source_hash text not null,                      -- SHA-256 hex of the original PDF
  source_size int,
  -- [{ id, kind: 'signature'|'initials'|'date'|'text'|'checkbox',
  --    page, x, y, w, h, required, label, signer_role }]
  fields      jsonb not null default '[]'::jsonb,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz
);
create index document_templates_dsp_idx
  on public.document_templates (dsp_id)
  where archived_at is null;


-- ── document_envelopes ──────────────────────────────────────────────────
-- One row per (template × recipient) send. Independent lifecycle, its
-- own audit chain. The signing_token is the opaque secret the PWA flow
-- and the public verification URL key off of.

create table public.document_envelopes (
  id                   uuid primary key default gen_random_uuid(),
  dsp_id               uuid not null references public.dsps(id) on delete cascade,
  template_id          uuid not null references public.document_templates(id) on delete restrict,
  sender_user_id       uuid references auth.users(id) on delete set null,

  -- Recipient. FK to a driver for joins/surfacing; snapshotted name+email
  -- so an audit record stays meaningful if the driver row is deleted.
  recipient_driver_id  uuid references public.drivers(id) on delete set null,
  recipient_email      text not null,
  recipient_name       text not null,

  -- Document integrity. Hash at send proves what the signer was sent;
  -- hash at sign proves no swap between send and sign. Both stay
  -- forever on the envelope.
  doc_hash_at_send     text not null,
  doc_hash_at_sign     text,

  -- Final artifacts (storage paths in 'documents' bucket). Populated by
  -- the signing service after PKCS#7 sealing + RFC 3161 timestamping.
  signed_pdf_path      text,
  certificate_pdf_path text,                       -- Certificate of Completion

  -- Snapshot of the template's field layout at send time, so a later
  -- template edit can't retroactively change what this signer saw.
  fields_snapshot      jsonb not null default '[]'::jsonb,

  -- Opaque per-envelope signing token for the PWA flow + verification URL.
  signing_token        text not null unique default encode(gen_random_bytes(32), 'hex'),

  status               public.document_envelope_status not null default 'sent',
  decline_reason       text,
  void_reason          text,

  sent_at              timestamptz not null default now(),
  viewed_at            timestamptz,
  signed_at            timestamptz,
  declined_at          timestamptz,
  voided_at            timestamptz,
  expires_at           timestamptz
);
create index document_envelopes_dsp_recent_idx
  on public.document_envelopes (dsp_id, sent_at desc);
create index document_envelopes_recipient_idx
  on public.document_envelopes (recipient_driver_id, status);
create index document_envelopes_open_idx
  on public.document_envelopes (dsp_id, status)
  where status in ('sent','viewed');


-- ── document_events ─────────────────────────────────────────────────────
-- Immutable, hash-chained audit log. INSERT-only via
-- private.append_document_event (SECURITY DEFINER); UPDATE/DELETE
-- blocked by both RLS (no policy) and a row-level trigger.

create table public.document_events (
  id              bigint generated always as identity primary key,
  envelope_id     uuid not null references public.document_envelopes(id) on delete cascade,
  kind            public.document_event_kind not null,

  -- Who. dispatcher/operator (auth user), driver (session-token user),
  -- system (deterministic event), or external (email-only signer).
  actor_kind      text not null check (actor_kind in ('dispatcher','driver','system','external')),
  actor_user_id   uuid references auth.users(id)   on delete set null,
  actor_driver_id uuid references public.drivers(id) on delete set null,
  actor_email     text,
  actor_name      text,

  ip              inet,
  user_agent      text,
  event_data      jsonb not null default '{}'::jsonb,

  -- Hash chain. event_hash = sha256(prev_event_hash || canonical JSON
  -- of the event). Genesis events use 64 hex zeros for prev_event_hash.
  -- Re-walking the chain detects any single-row tampering or removal
  -- (the hash of the *next* event references this one's hash, so a
  -- silent mutation breaks every event after it).
  prev_event_hash text not null,
  event_hash      text not null,

  created_at      timestamptz not null default now()
);
create index document_events_envelope_idx
  on public.document_events (envelope_id, id);


-- ── append_document_event · the only legitimate write path ──────────────

create or replace function private.append_document_event(
  p_envelope_id     uuid,
  p_kind            public.document_event_kind,
  p_actor_kind      text,
  p_actor_user_id   uuid    default null,
  p_actor_driver_id uuid    default null,
  p_actor_email     text    default null,
  p_actor_name      text    default null,
  p_ip              inet    default null,
  p_user_agent      text    default null,
  p_event_data      jsonb   default '{}'::jsonb
) returns public.document_events
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prev text;
  v_payload jsonb;
  v_hash text;
  v_row public.document_events;
begin
  -- Last event's hash on this envelope, or the genesis 0×256-bit hash.
  select event_hash into v_prev
    from public.document_events
   where envelope_id = p_envelope_id
   order by id desc
   limit 1;
  if v_prev is null then
    v_prev := repeat('0', 64);
  end if;

  -- Canonical JSON of the event we're about to record. jsonb's text
  -- representation in Postgres is deterministic for a given jsonb value
  -- (keys sorted, whitespace normalized), so this hashes consistently.
  v_payload := jsonb_build_object(
    'envelope_id',     p_envelope_id,
    'kind',            p_kind,
    'actor_kind',      p_actor_kind,
    'actor_user_id',   p_actor_user_id,
    'actor_driver_id', p_actor_driver_id,
    'actor_email',     p_actor_email,
    'actor_name',      p_actor_name,
    'ip',              p_ip::text,
    'user_agent',      p_user_agent,
    'event_data',      coalesce(p_event_data, '{}'::jsonb),
    'at',              to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );

  v_hash := encode(digest(v_prev || v_payload::text, 'sha256'), 'hex');

  insert into public.document_events
    (envelope_id, kind, actor_kind, actor_user_id, actor_driver_id,
     actor_email, actor_name, ip, user_agent, event_data,
     prev_event_hash, event_hash)
  values
    (p_envelope_id, p_kind, p_actor_kind, p_actor_user_id, p_actor_driver_id,
     p_actor_email, p_actor_name, p_ip, p_user_agent, coalesce(p_event_data, '{}'::jsonb),
     v_prev, v_hash)
  returning * into v_row;

  return v_row;
end;
$$;


-- ── document_events: belt-and-suspenders append-only enforcement ────────
-- RLS already denies UPDATE/DELETE for all roles (no policy exists for
-- those operations on this table). The trigger blocks even superuser
-- ad-hoc UPDATE/DELETE — to tamper, you must first drop the trigger,
-- and a DROP TRIGGER is itself an auditable DDL event.

create or replace function private.document_events_no_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'document_events is append-only (% blocked)', tg_op
    using errcode = '42501';
end;
$$;

create trigger document_events_no_update
  before update on public.document_events
  for each row execute function private.document_events_no_change();

create trigger document_events_no_delete
  before delete on public.document_events
  for each row execute function private.document_events_no_change();


-- ── verify_envelope_chain · re-walk and detect tampering ────────────────
-- Returns one row per envelope event with a computed_event_hash and a
-- boolean `ok`. Any false ok means the on-disk hash diverges from what
-- the chain would produce — i.e. tampering or unexpected mutation.

create or replace function public.verify_envelope_chain(p_envelope_id uuid)
returns table (
  id              bigint,
  kind            public.document_event_kind,
  stored_hash     text,
  computed_hash   text,
  ok              boolean,
  created_at      timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_prev text := repeat('0', 64);
  v_row public.document_events;
  v_payload jsonb;
  v_computed text;
begin
  -- Caller must be in this envelope's DSP (or platform admin).
  if not exists (
    select 1 from public.document_envelopes e
     where e.id = p_envelope_id and e.dsp_id = private.current_dsp_id()
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for v_row in
    select * from public.document_events
     where envelope_id = p_envelope_id
     order by document_events.id
  loop
    v_payload := jsonb_build_object(
      'envelope_id',     v_row.envelope_id,
      'kind',            v_row.kind,
      'actor_kind',      v_row.actor_kind,
      'actor_user_id',   v_row.actor_user_id,
      'actor_driver_id', v_row.actor_driver_id,
      'actor_email',     v_row.actor_email,
      'actor_name',      v_row.actor_name,
      'ip',              v_row.ip::text,
      'user_agent',      v_row.user_agent,
      'event_data',      v_row.event_data,
      'at',              to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
    );
    v_computed := encode(digest(v_prev || v_payload::text, 'sha256'), 'hex');
    id            := v_row.id;
    kind          := v_row.kind;
    stored_hash   := v_row.event_hash;
    computed_hash := v_computed;
    ok            := (v_computed = v_row.event_hash and v_row.prev_event_hash = v_prev);
    created_at    := v_row.created_at;
    return next;
    v_prev := v_row.event_hash;
  end loop;
end;
$$;
grant execute on function public.verify_envelope_chain(uuid) to authenticated;


-- ── RLS ─────────────────────────────────────────────────────────────────

alter table public.document_templates enable row level security;
alter table public.document_envelopes enable row level security;
alter table public.document_events    enable row level security;

-- Templates: staff in the DSP can read; dispatcher+ can write.
create policy "doc_templates_select" on public.document_templates for select
  using (dsp_id = private.current_dsp_id());
create policy "doc_templates_write" on public.document_templates for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

-- Envelopes: same.
create policy "doc_envelopes_select" on public.document_envelopes for select
  using (dsp_id = private.current_dsp_id());
create policy "doc_envelopes_write" on public.document_envelopes for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

-- Events: SELECT-only for staff in the envelope's DSP. No INSERT/UPDATE/
-- DELETE policy exists, so RLS denies all writes from authed/anon roles;
-- inserts happen exclusively via private.append_document_event.
create policy "doc_events_select" on public.document_events for select
  using (
    exists (
      select 1 from public.document_envelopes e
       where e.id = document_events.envelope_id
         and e.dsp_id = private.current_dsp_id()
    )
  );


-- ── Storage bucket for templates + signed PDFs ──────────────────────────
-- Private bucket. Templates live under <dsp_id>/templates/<template_id>.pdf;
-- signed artifacts under <dsp_id>/signed/<envelope_id>.pdf and
-- <dsp_id>/certificates/<envelope_id>.pdf. Storage RLS policies come in
-- the next slice (upload/sign endpoints), once we know the access patterns.

insert into storage.buckets (id, name, public)
  values ('documents', 'documents', false)
  on conflict (id) do nothing;


notify pgrst, 'reload schema';
