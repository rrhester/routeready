-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510040000 · audit_log
-- Append-only audit log of state changes on sensitive tables. Used for
-- compliance, debugging, and the HR file's chain-of-custody story.
-- Triggers attached here cover Phase 1 tables (dsps, stations, app_users,
-- drivers). Later phases attach triggers to their own tables.
-- ─────────────────────────────────────────────────────────────────────────

create table public.audit_log (
  id           bigserial   primary key,
  dsp_id       uuid        references public.dsps(id) on delete set null,
  actor_id     uuid        references public.app_users(id),
  action       text        not null,         -- '<op>:<table>'  e.g. 'UPDATE:drivers'
  table_name   text        not null,
  record_id    uuid,
  before_state jsonb,
  after_state  jsonb,
  metadata     jsonb,                        -- IP, UA, request id, etc.
  created_at   timestamptz not null default now()
);

create index audit_log_dsp_idx       on public.audit_log (dsp_id, created_at desc);
create index audit_log_record_idx    on public.audit_log (table_name, record_id);
create index audit_log_actor_idx     on public.audit_log (actor_id, created_at desc);

comment on table public.audit_log is
  'Append-only history of state changes on sensitive tables. Required ' ||
  'for HR file integrity, compliance audits, and unemployment defense.';

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- Audit log is readable by staff for their own DSP. NO insert / update /
-- delete from end users — only triggers (security definer) and service
-- role can write. Never edited.

alter table public.audit_log enable row level security;

create policy "audit_log_staff_select"
  on public.audit_log for select
  using (
    dsp_id is not null
    and dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'ops')
  );

-- No INSERT / UPDATE / DELETE policies → triggers (security definer) and
-- service role bypass; nobody else can touch this table.

revoke all on public.audit_log from public, anon, authenticated;
grant select on public.audit_log to authenticated;

-- ─── The trigger function ────────────────────────────────────────────────

create or replace function private.fn_audit_log()
returns trigger
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid;
  v_id  uuid;
begin
  -- Each table that uses this trigger has a dsp_id column. We pull it
  -- from NEW (insert/update) or OLD (delete).
  v_dsp := coalesce(
    case when tg_op = 'DELETE' then null else (to_jsonb(new) ->> 'dsp_id')::uuid end,
    case when tg_op = 'INSERT' then null else (to_jsonb(old) ->> 'dsp_id')::uuid end
  );

  v_id  := coalesce(
    case when tg_op = 'DELETE' then null else (to_jsonb(new) ->> 'id')::uuid end,
    case when tg_op = 'INSERT' then null else (to_jsonb(old) ->> 'id')::uuid end
  );

  insert into public.audit_log
    (dsp_id, actor_id, action, table_name, record_id, before_state, after_state, metadata)
  values
    (v_dsp,
     auth.uid(),
     tg_op || ':' || tg_table_name,
     tg_table_name,
     v_id,
     case when tg_op = 'INSERT' then null else to_jsonb(old) end,
     case when tg_op = 'DELETE' then null else to_jsonb(new) end,
     jsonb_build_object(
       'jwt_role', private.current_role_claim(),
       'when',     now()
     ));

  return coalesce(new, old);
end;
$$;

comment on function private.fn_audit_log() is
  'Trigger function: writes a row to audit_log on every INSERT/UPDATE/DELETE.';

-- ─── Attach to Phase 1 tables ────────────────────────────────────────────

create trigger trg_audit_dsps
  after insert or update or delete on public.dsps
  for each row execute function private.fn_audit_log();

create trigger trg_audit_stations
  after insert or update or delete on public.stations
  for each row execute function private.fn_audit_log();

create trigger trg_audit_app_users
  after insert or update or delete on public.app_users
  for each row execute function private.fn_audit_log();

create trigger trg_audit_drivers
  after insert or update or delete on public.drivers
  for each row execute function private.fn_audit_log();

-- Future migrations should add triggers for:
--   hr_events (insert-only — but we still want the audit_log row)
--   suspensions, attendance_events, coaching_events
--   shifts, time_off_requests, swap_requests
--   invoices, disputes
