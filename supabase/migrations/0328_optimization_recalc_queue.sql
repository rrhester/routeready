-- 0328_optimization_recalc_queue.sql
--
-- Workforce Optimization Engine — Step 10: auto-recalc triggers.
--
-- Detects events that should prompt the operator to re-run Smart Fill
-- (driver called off, no-showed, etc.) and queues them in a Realtime-
-- watched table the dashboard subscribes to. When a queue row arrives
-- for the visible week, a banner appears with a one-click "Re-run
-- Smart Fill" action.
--
-- v1 covers shift-status changes (called_off / no_show). v2 adds
-- mid-week PTO approvals and van-repair transitions. v3 ships the
-- "auto-propose the diff" pass that runs a what-if solve in the
-- background and shows the proposed reassignment in the banner.
--
-- Idempotent.

-- ── 1. Queue table ────────────────────────────────────────────────
create table if not exists public.optimization_recalc_queue (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  week_start      date not null,
  trigger_kind    text not null
                    check (trigger_kind in
                      ('shift_called_off','shift_no_show','pto_added',
                       'driver_inactive','van_repair','manual')),
  shift_id        uuid,
  driver_id       uuid,
  van_id          uuid,
  payload         jsonb,                              -- shift-row snapshot or similar
  state           text not null default 'pending'
                    check (state in ('pending','dismissed','applied','expired')),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  resolved_by     uuid references auth.users(id),
  resolution_note text
);
create index if not exists idx_recalc_queue_dsp_week_pending
  on public.optimization_recalc_queue (dsp_id, week_start, created_at desc)
  where state = 'pending';

alter table public.optimization_recalc_queue enable row level security;
drop policy if exists recalc_queue_dsp_read on public.optimization_recalc_queue;
create policy recalc_queue_dsp_read on public.optimization_recalc_queue
  for select using (dsp_id = private.current_dsp_id());

-- All writes via security-definer triggers + RPCs below.


-- ── 2. Trigger: shifts.status → called_off / no_show ──────────────
-- Fires after the shift's status flips to a no-show state. Only
-- enqueues for shifts in the next 14 days — old/past shifts going
-- to called_off (e.g. backfill of historical attendance data) don't
-- need an operator banner.
create or replace function private.tg_shifts_enqueue_recalc()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind text;
begin
  if NEW.status = OLD.status then return NEW; end if;
  if NEW.status not in ('called_off','no_show') then return NEW; end if;
  if NEW.date < current_date or NEW.date > current_date + 14 then return NEW; end if;
  v_kind := case NEW.status
              when 'called_off' then 'shift_called_off'
              when 'no_show'    then 'shift_no_show'
            end;
  insert into public.optimization_recalc_queue (
    dsp_id, week_start, trigger_kind, shift_id, driver_id, payload
  ) values (
    NEW.dsp_id,
    -- Sunday-anchored week-start (matches the dashboard's
    -- startOfWeek). Postgres ISO week starts Monday; subtract 1 to
    -- get Sunday.
    NEW.date - extract(dow from NEW.date)::integer,
    v_kind,
    NEW.id,
    NEW.driver_id,
    jsonb_build_object(
      'shift_date', NEW.date,
      'old_status', OLD.status,
      'new_status', NEW.status,
      'route_code', NEW.route_code,
      'starts_at',  NEW.starts_at,
      'ends_at',    NEW.ends_at
    )
  );
  return NEW;
exception when others then
  -- Never fail the shift write because of an audit hiccup.
  return NEW;
end;
$$;

drop trigger if exists trg_shifts_enqueue_recalc on public.shifts;
create trigger trg_shifts_enqueue_recalc
  after update of status on public.shifts
  for each row execute function private.tg_shifts_enqueue_recalc();


-- ── 3. RPC · resolve_recalc_queue_row ──────────────────────────────
-- Operator dismisses / marks-applied a queue row from the banner.
create or replace function public.resolve_recalc_queue_row(
  p_id    uuid,
  p_state text,
  p_note  text default null
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_state not in ('dismissed','applied','expired') then
    raise exception 'invalid state: %', p_state;
  end if;
  update public.optimization_recalc_queue
     set state = p_state,
         resolved_at = now(),
         resolved_by = auth.uid(),
         resolution_note = p_note
   where id = p_id and dsp_id = v_dsp and state = 'pending';
end;
$$;
grant execute on function public.resolve_recalc_queue_row(uuid, text, text) to authenticated;


-- ── 4. RPC · pending_recalc_count ─────────────────────────────────
-- Cheap badge query the dashboard polls (in addition to the Realtime
-- subscription) so the count is fresh on page load.
create or replace function public.pending_recalc_count(
  p_week_start date default null
) returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
    from public.optimization_recalc_queue
   where dsp_id = private.current_dsp_id()
     and state = 'pending'
     and (p_week_start is null or week_start = p_week_start);
$$;
grant execute on function public.pending_recalc_count(date) to authenticated;


notify pgrst, 'reload schema';
