-- Migration 0249 · Voice (Twilio click-to-call) call log.
--
-- One row per outbound or inbound call made through the dashboard
-- softphone.  Created when the browser asks for a token + starts
-- the Connect (status='initiated'), updated to 'in-progress' /
-- 'completed' / 'failed' as Twilio status callbacks land.
--
-- RLS:
--   - dispatchers/owners can see all calls in their DSP
--   - drivers can see only their own (call destination matches them)
--   - the service-role edge function bypasses RLS to insert/update.
--
-- Idempotent.

create table if not exists public.voice_calls (
  id                uuid          primary key default gen_random_uuid(),
  dsp_id            uuid          not null references public.dsps(id) on delete cascade,

  direction         text          not null check (direction in ('outbound', 'inbound')),
  status            text          not null default 'initiated'
                                  check (status in ('initiated','ringing','in-progress','completed','busy','no-answer','failed','canceled')),

  -- Operator who placed (or answered) the call.  Null on driver-initiated
  -- inbound calls that didn't reach an operator (e.g. went to voicemail).
  operator_user_id  uuid          references public.app_users(id) on delete set null,

  -- Driver who was called.  Resolved by phone-number match at dial time
  -- when possible; null if we dialed a number that doesn't match any
  -- driver record (legitimate use case for ad-hoc outreach).
  driver_id         uuid          references public.drivers(id) on delete set null,

  from_number       text          not null,
  to_number         text          not null,

  -- Twilio identifiers — populated by the TwiML/status callback once
  -- the call lifts off the local SDK and into the carrier network.
  twilio_call_sid   text          unique,
  twilio_parent_call_sid text,

  started_at        timestamptz   not null default now(),
  answered_at       timestamptz,
  ended_at          timestamptz,
  duration_seconds  integer,

  -- Soft notes operator can attach mid-call (callback request, etc.)
  note              text,

  created_at        timestamptz   not null default now(),
  updated_at        timestamptz   not null default now()
);

create index if not exists voice_calls_dsp_started_idx
  on public.voice_calls (dsp_id, started_at desc);
create index if not exists voice_calls_driver_started_idx
  on public.voice_calls (driver_id, started_at desc)
  where driver_id is not null;
create index if not exists voice_calls_operator_started_idx
  on public.voice_calls (operator_user_id, started_at desc)
  where operator_user_id is not null;

-- updated_at trigger
create or replace function public.tg_voice_calls_touch_updated()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists voice_calls_touch_updated on public.voice_calls;
create trigger voice_calls_touch_updated
  before update on public.voice_calls
  for each row execute function public.tg_voice_calls_touch_updated();

-- ── RLS ──────────────────────────────────────────────────────────
alter table public.voice_calls enable row level security;

drop policy if exists voice_calls_tenant_select on public.voice_calls;
create policy voice_calls_tenant_select
  on public.voice_calls for select
  to authenticated
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or operator_user_id = private.current_user_id()
    )
  );

drop policy if exists voice_calls_tenant_update_note on public.voice_calls;
create policy voice_calls_tenant_update_note
  on public.voice_calls for update
  to authenticated
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  )
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
  );

-- Inserts/most updates only via the service-role edge function, so
-- no INSERT policy for authenticated.  The note update policy above
-- lets dispatchers add post-call notes.

notify pgrst, 'reload schema';
