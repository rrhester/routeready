-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510150000 · referral_payouts
-- Multi-milestone referral payouts. When a referrer-attributed applicant
-- is hired, four payout rows are created (hire / 30d / 60d / 90d) at
-- preset amounts. As the new driver hits each tenure milestone, a job
-- (or manual mark) flips paid_at on the matching row.
-- ─────────────────────────────────────────────────────────────────────────

create table public.referral_payouts (
  id            uuid        primary key default gen_random_uuid(),
  dsp_id        uuid        not null references public.dsps(id) on delete cascade,
  applicant_id  uuid        not null references public.applicants(id) on delete cascade,
  driver_id     uuid        not null references public.drivers(id) on delete cascade, -- the referrer
  milestone     text        not null
                check (milestone in ('hire','tenure_30','tenure_60','tenure_90')),
  amount_cents  int         not null check (amount_cents >= 0),
  due_at        date        not null,
  paid_at       date,
  paid_via      text,                                             -- 'gusto','adp','check','manual',...
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint referral_payouts_unique unique (applicant_id, milestone)
);

create index referral_payouts_dsp_due_idx
  on public.referral_payouts (dsp_id, due_at)
  where paid_at is null;

create index referral_payouts_referrer_idx
  on public.referral_payouts (driver_id);

create index referral_payouts_applicant_idx
  on public.referral_payouts (applicant_id);

create trigger trg_referral_payouts_updated_at
  before update on public.referral_payouts
  for each row execute function moddatetime(updated_at);

comment on table public.referral_payouts is
  'Per-applicant × milestone payout schedule. Created on applicant hire ' ||
  '(if referrer attributed). Marked paid via mark_referral_paid RPC or ' ||
  'a future payroll integration.';

alter table public.referral_payouts enable row level security;

-- Read: ops sees all DSP payouts; the referrer driver sees their own
create policy "referral_payouts_select"
  on public.referral_payouts for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'ops')
      or driver_id = private.current_driver_id()
    )
  );

-- Insert / update / delete: ops only
create policy "referral_payouts_ops_write"
  on public.referral_payouts for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.referral_payouts to authenticated;
