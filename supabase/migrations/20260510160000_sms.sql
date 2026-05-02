-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510160000 · sms_messages + sms_opt_outs
-- Inbound and outbound SMS. Outbound is enqueued by RPCs; the actual
-- Twilio send is performed by the send-applicant-sms / send-driver-sms
-- Edge Functions which read this table for queued rows.
-- Inbound is written by the webhook-twilio Edge Function on receipt.
--
-- Opt-out enforcement: an outbound row inserted for a phone in
-- sms_opt_outs is rejected by trigger.
-- ─────────────────────────────────────────────────────────────────────────

create table public.sms_messages (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  driver_id    uuid        references public.drivers(id) on delete set null,
  applicant_id uuid        references public.applicants(id) on delete set null,
  direction    text        not null check (direction in ('outbound','inbound')),
  to_phone     text        not null,
  from_phone   text        not null,
  body         text        not null,
  twilio_sid   text,
  status       text        not null default 'queued'
               check (status in ('queued','sent','delivered','failed','undelivered','opted_out')),
  error_code   text,
  delivered_at timestamptz,
  related_kind text,                                      -- 'screening','interview_confirm','license_reminder','coaching','suspension_notice','referral'
  related_id   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid        references public.app_users(id),

  -- An outbound row should reference EXACTLY ONE party (driver xor applicant)
  constraint sms_outbound_party_xor check (
    direction <> 'outbound'
    or (driver_id is null) <> (applicant_id is null)
  )
);

create index sms_messages_driver_idx
  on public.sms_messages (dsp_id, driver_id, created_at desc)
  where driver_id is not null;
create index sms_messages_applicant_idx
  on public.sms_messages (dsp_id, applicant_id, created_at desc)
  where applicant_id is not null;
create index sms_messages_twilio_sid_idx
  on public.sms_messages (twilio_sid) where twilio_sid is not null;
create index sms_messages_dsp_status_idx
  on public.sms_messages (dsp_id, status, created_at)
  where status in ('queued','failed');

create trigger trg_sms_messages_updated_at
  before update on public.sms_messages
  for each row execute function moddatetime(updated_at);

comment on table public.sms_messages is
  'All SMS in and out. Outbound rows are enqueued (status=queued) by ' ||
  'RPCs; an Edge Function picks them up and calls Twilio. Inbound rows ' ||
  'are written by webhook-twilio on receipt. Read-only from frontend.';

alter table public.sms_messages enable row level security;

-- Read: staff in DSP, OR the driver themselves (own thread)
create policy "sms_messages_tenant_select"
  on public.sms_messages for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert / update / delete: service role only. Frontend never writes here
-- directly — it calls enqueue_sms / send_driver_sms RPCs that do the
-- write inside security_definer functions.
revoke all on public.sms_messages from public, anon, authenticated;
grant select on public.sms_messages to authenticated;

-- ─── SMS opt-outs ────────────────────────────────────────────────────────

create table public.sms_opt_outs (
  id           uuid        primary key default gen_random_uuid(),
  dsp_id       uuid        not null references public.dsps(id) on delete cascade,
  phone        text        not null,
  opted_out_at timestamptz not null default now(),
  reason       text,                                              -- 'STOP','HELP','manual','complaint'

  constraint sms_opt_outs_unique unique (dsp_id, phone)
);

create index sms_opt_outs_phone_idx on public.sms_opt_outs (phone);

comment on table public.sms_opt_outs is
  'Phone numbers that have opted out of SMS for this DSP. Enforced ' ||
  'by trigger on sms_messages outbound inserts. Required for TCPA compliance.';

alter table public.sms_opt_outs enable row level security;

create policy "sms_opt_outs_staff_select"
  on public.sms_opt_outs for select
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

create policy "sms_opt_outs_ops_insert"
  on public.sms_opt_outs for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

create policy "sms_opt_outs_owner_delete"
  on public.sms_opt_outs for delete
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'owner')
  );

grant select, insert, delete on public.sms_opt_outs to authenticated;
