-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0438 · Checklist due / overdue reminders for drivers
--
-- A pg_cron sweep (every 15 min) that reminds a driver about an assigned
-- checklist that is due soon or already overdue and not yet submitted.
-- Reuses the proven driver-message → Web Push pipeline: inserting a
-- `driver_messages` row with sender_kind='dispatch' fires
-- trg_driver_messages_fire_push (0056) → send-driver-push edge function,
-- so the driver gets a push + an in-app record, deep-linked straight to
-- the checklist. Modeled on license_expiry_reminders_run (0359).
--
-- Dedupe: one reminder per (assignment, driver, period, kind) so
-- overlapping cron runs and a 15-min cadence can't spam. 'due_soon' fires
-- once inside the window before due; 'overdue' fires once after due.
--
-- Per-DSP opt-out: dsps.metadata.checklists.auto_reminders (default true).
-- Only assignments whose due time actually resolves (route_start /
-- shift_end / fixed time / due_at) are eligible — with no due time there's
-- nothing to be "due soon" or "overdue" against.
-- ─────────────────────────────────────────────────────────────────────────


-- ── Dedupe / audit log ────────────────────────────────────────────────
create table if not exists public.checklist_due_reminders (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  assignment_id uuid not null references public.checklist_assignments(id) on delete cascade,
  driver_id     uuid not null references public.drivers(id) on delete cascade,
  period_key    date not null,                       -- '0001-01-01' sentinel for one-time
  kind          text not null check (kind in ('due_soon','overdue')),
  sent_at       timestamptz not null default now()
);

do $$ begin
  alter table public.checklist_due_reminders
    add constraint checklist_due_reminders_unique
    unique (assignment_id, driver_id, period_key, kind);
exception when duplicate_object then null; end $$;

create index if not exists checklist_due_reminders_dsp_idx
  on public.checklist_due_reminders (dsp_id, sent_at desc);

-- Service-role / SECURITY DEFINER only.
alter table public.checklist_due_reminders enable row level security;


-- ── The sweep ─────────────────────────────────────────────────────────
-- p_soon_minutes: how far ahead of the due time a 'due_soon' nudge fires.
create or replace function public.checklist_due_reminders_run(p_soon_minutes int default 45)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count int := 0;
  v_rec   record;
  v_kind  text;
  v_tz    text;
  v_body  text;
  v_when  text;
begin
  for v_rec in
    select
      a.id                                              as assignment_id,
      a.dsp_id                                          as dsp_id,
      d.id                                              as driver_id,
      f.name                                            as checklist_name,
      private.clf_period_key(a, private.dsp_today(a.dsp_id))          as period_key,
      private.clf_due_for(a, d.id, private.dsp_today(a.dsp_id))       as due_at,
      coalesce(s.status, 'not_started')                 as sub_status
    from public.checklist_assignments a
    join public.checklist_forms f
      on f.id = a.template_id and f.status = 'active'
    join public.dsps ds on ds.id = a.dsp_id
    join public.drivers d
      on d.dsp_id = a.dsp_id and d.status in ('onboarding','active')
     and private.clf_assignment_applies(a, d, private.dsp_today(a.dsp_id))
    left join public.checklist_submissions s
      on s.assignment_id = a.id and s.driver_id = d.id
     and coalesce(s.period_key, '0001-01-01'::date)
         = coalesce(private.clf_period_key(a, private.dsp_today(a.dsp_id)), '0001-01-01'::date)
    where a.status = 'active'
      and private.clf_in_window(a, private.dsp_today(a.dsp_id))
      and coalesce((ds.metadata->'checklists'->>'auto_reminders')::boolean, true) = true
  loop
    -- Nothing to remind against without a resolved due time.
    if v_rec.due_at is null then continue; end if;
    -- Already done for this period.
    if v_rec.sub_status = 'submitted' then continue; end if;

    if v_rec.due_at < now() then
      v_kind := 'overdue';
    elsif v_rec.due_at <= now() + make_interval(mins => greatest(coalesce(p_soon_minutes, 45), 1)) then
      v_kind := 'due_soon';
    else
      continue;  -- not yet inside the reminder window
    end if;

    -- Claim the slot first so two overlapping runs can't both send.
    begin
      insert into public.checklist_due_reminders (dsp_id, assignment_id, driver_id, period_key, kind)
      values (v_rec.dsp_id, v_rec.assignment_id, v_rec.driver_id,
              coalesce(v_rec.period_key, '0001-01-01'::date), v_kind);
    exception when unique_violation then
      continue;
    end;

    select coalesce(timezone, 'UTC') into v_tz from public.dsps where id = v_rec.dsp_id;
    v_when := to_char(v_rec.due_at at time zone coalesce(v_tz, 'UTC'), 'FMHH12:MI AM');

    if v_kind = 'overdue' then
      v_body := format('Your checklist "%s" is overdue. Please complete it as soon as you can.',
                       coalesce(nullif(v_rec.checklist_name, ''), 'checklist'));
    else
      v_body := format('Reminder: your checklist "%s" is due at %s. Tap to complete it.',
                       coalesce(nullif(v_rec.checklist_name, ''), 'checklist'), v_when);
    end if;

    -- Dispatch message → Web Push, deep-linked to the fill-out screen.
    insert into public.driver_messages (driver_id, dsp_id, sender_kind, body, link_url)
    values (v_rec.driver_id, v_rec.dsp_id, 'dispatch', v_body,
            '/app/#/tasks/checklist?id=' || v_rec.assignment_id);

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

grant execute on function public.checklist_due_reminders_run(int) to service_role;


-- ── Schedule · every 15 minutes ───────────────────────────────────────
do $$ begin
  perform cron.unschedule('checklist-due-reminders');
exception when others then null; end $$;

select cron.schedule(
  'checklist-due-reminders',
  '*/15 * * * *',
  $cron$ select public.checklist_due_reminders_run(); $cron$
);
