-- 0359_license_expiry_push.sql
-- Driver-license expiry push reminders.
--
-- A daily job finds active drivers whose driver's license is coming due
-- inside their DSP's reminder window (dsps.metadata.licenses.reminder_days,
-- only when dsps.metadata.licenses.auto_reminders is true) and sends them a
-- reminder. We reuse the proven driver-message -> push pipeline: inserting a
-- `driver_messages` row with sender_kind='dispatch' fires the existing
-- trg_driver_messages_fire_push trigger (0056), which calls the
-- send-driver-push edge function. So the driver gets a Web Push notification
-- and the reminder also lands in their app chat.
--
-- De-duplicated per (driver, license expiry date, threshold) so re-running
-- the job daily can't spam a driver: each reminder "band" fires at most once
-- per renewal cycle. Idempotent + re-runnable.

-- ── Dedupe / audit log ────────────────────────────────────────────────
create table if not exists public.driver_license_reminders (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id)    on delete cascade,
  driver_id      uuid not null references public.drivers(id) on delete cascade,
  dl_expires_on  date not null,
  threshold_days int  not null,
  sent_at        timestamptz not null default now()
);

do $$ begin
  alter table public.driver_license_reminders
    add constraint driver_license_reminders_unique
    unique (driver_id, dl_expires_on, threshold_days);
exception when duplicate_object then null; end $$;

create index if not exists driver_license_reminders_dsp_idx
  on public.driver_license_reminders (dsp_id, sent_at desc);

-- Service-role / SECURITY DEFINER only — no tenant policies needed.
alter table public.driver_license_reminders enable row level security;

-- ── The daily sweep ───────────────────────────────────────────────────
create or replace function public.license_expiry_reminders_run(p_date date default current_date)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_count int := 0;
  v_rec   record;
  v_thr   int;
  v_body  text;
begin
  for v_rec in
    select
      d.id            as driver_id,
      d.dsp_id        as dsp_id,
      d.dl_expires_on as dl_expires_on,
      coalesce(nullif(trim(d.preferred_name), ''),
               nullif(trim(d.first_name), ''),
               nullif(trim(d.full_name), ''),
               'there')                             as name,
      (d.dl_expires_on - p_date)                    as days_until,
      coalesce(ds.metadata->'licenses'->'reminder_days', '[30]'::jsonb) as reminder_days
    from public.drivers d
    join public.dsps ds on ds.id = d.dsp_id
    where d.status = 'active'
      and d.dl_expires_on is not null
      and (d.dl_expires_on - p_date) >= 0            -- upcoming (incl. today)
      and coalesce((ds.metadata->'licenses'->>'auto_reminders')::boolean, false) = true
  loop
    -- Applicable threshold = the smallest configured reminder day that is
    -- still >= days remaining. This gives each reminder day its own band
    -- (e.g. [30,14,3] → one send when crossing into 30, 14 and 3 days).
    select min(x::int) into v_thr
    from jsonb_array_elements_text(v_rec.reminder_days) t(x)
    where x ~ '^[0-9]+$'
      and x::int >= v_rec.days_until;

    if v_thr is null then
      continue;  -- still outside every configured window
    end if;

    -- Dedupe: at most one reminder per (driver, expiry, threshold) per cycle.
    if exists (
      select 1 from public.driver_license_reminders r
      where r.driver_id     = v_rec.driver_id
        and r.dl_expires_on = v_rec.dl_expires_on
        and r.threshold_days = v_thr
    ) then
      continue;
    end if;

    v_body := format(
      'Hi %s - your driver''s license expires %s (in %s day%s). Please renew soon and send dispatch a photo of your new license.',
      v_rec.name,
      to_char(v_rec.dl_expires_on, 'Mon FMDD, YYYY'),
      v_rec.days_until,
      case when v_rec.days_until = 1 then '' else 's' end
    );

    -- Insert a dispatch message → fires send-driver-push via the 0056 trigger.
    insert into public.driver_messages (driver_id, dsp_id, sender_kind, body)
    values (v_rec.driver_id, v_rec.dsp_id, 'dispatch', v_body);

    insert into public.driver_license_reminders (dsp_id, driver_id, dl_expires_on, threshold_days)
    values (v_rec.dsp_id, v_rec.driver_id, v_rec.dl_expires_on, v_thr)
    on conflict do nothing;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$fn$;

grant execute on function public.license_expiry_reminders_run(date) to service_role;

-- ── Schedule · daily at 13:00 UTC (matches recognition-autofire) ───────
do $$ begin
  perform cron.unschedule('license-expiry-reminders-daily');
exception when others then null; end $$;

select cron.schedule(
  'license-expiry-reminders-daily',
  '0 13 * * *',
  $cron$ select public.license_expiry_reminders_run(current_date); $cron$
);
