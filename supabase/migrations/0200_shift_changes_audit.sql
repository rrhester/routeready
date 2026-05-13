-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0200 · shift_changes audit
--
-- Captures every meaningful edit to a row in public.shifts so HR /
-- payroll / post-mortems can answer "who moved Bob to Route 37 at
-- 2:15 PM and what was it before?". A single trigger on shifts diffs
-- driver_id, date, starts_at, ends_at, route_code, status and writes
-- one row per change event. INSERTs write a 'created' row; DELETEs
-- write a 'deleted' row.
--
-- Actor identity:
--   • Direct dashboard UPDATEs run as the dispatcher's JWT — auth.uid()
--     resolves and lands in actor_user_id.
--   • Driver-side flows (e.g. Cover-offer accept via driver_offer_respond)
--     go through a token; auth.uid() is null inside the trigger. The
--     calling RPC already writes its own row to shift_offers_audit with
--     actor_driver_id, so the full trail is reconstructable across both
--     tables. Where the trigger can't identify the actor it leaves
--     actor_user_id null rather than guessing.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.shift_changes (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  shift_id        uuid not null references public.shifts(id) on delete cascade,
  event           text not null check (event in (
                    'created', 'deleted',
                    'driver_assigned', 'driver_changed', 'driver_unassigned',
                    'time_changed', 'date_changed', 'route_changed',
                    'status_changed', 'updated'
                  )),
  actor_user_id   uuid references auth.users(id) on delete set null,
  before          jsonb,
  after           jsonb,
  at              timestamptz not null default now()
);

create index if not exists shift_changes_shift_idx on public.shift_changes (shift_id, at desc);
create index if not exists shift_changes_dsp_at_idx on public.shift_changes (dsp_id, at desc);

alter table public.shift_changes enable row level security;

drop policy if exists shift_changes_dsp_r on public.shift_changes;
create policy shift_changes_dsp_r on public.shift_changes for select
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select on public.shift_changes to authenticated;


-- ── Diff trigger ──────────────────────────────────────────────────────
create or replace function private.shift_changes_capture()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id, 'created', v_actor, null,
            jsonb_build_object(
              'driver_id', new.driver_id,
              'date',      new.date,
              'starts_at', new.starts_at,
              'ends_at',   new.ends_at,
              'route_code', new.route_code,
              'status',    new.status::text
            ));
    return new;
  elsif tg_op = 'DELETE' then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (old.dsp_id, old.id, 'deleted', v_actor,
            jsonb_build_object(
              'driver_id', old.driver_id,
              'date',      old.date,
              'starts_at', old.starts_at,
              'ends_at',   old.ends_at,
              'route_code', old.route_code,
              'status',    old.status::text
            ), null);
    return old;
  end if;

  -- UPDATE: emit one row per kind of meaningful change. Time changes
  -- are bundled (both starts_at and ends_at changing in a single
  -- save = one 'time_changed' row, not two). Driver changes split
  -- by transition direction so the audit UI reads naturally.
  if new.driver_id is distinct from old.driver_id then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id,
            case
              when old.driver_id is null and new.driver_id is not null then 'driver_assigned'
              when old.driver_id is not null and new.driver_id is null then 'driver_unassigned'
              else 'driver_changed'
            end,
            v_actor,
            jsonb_build_object('driver_id', old.driver_id),
            jsonb_build_object('driver_id', new.driver_id));
  end if;

  if (new.starts_at is distinct from old.starts_at)
     or (new.ends_at is distinct from old.ends_at) then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id, 'time_changed', v_actor,
            jsonb_build_object('starts_at', old.starts_at, 'ends_at', old.ends_at),
            jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at));
  end if;

  if new.date is distinct from old.date then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id, 'date_changed', v_actor,
            jsonb_build_object('date', old.date),
            jsonb_build_object('date', new.date));
  end if;

  if new.route_code is distinct from old.route_code then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id, 'route_changed', v_actor,
            jsonb_build_object('route_code', old.route_code),
            jsonb_build_object('route_code', new.route_code));
  end if;

  if new.status is distinct from old.status then
    insert into public.shift_changes (dsp_id, shift_id, event, actor_user_id, before, after)
    values (new.dsp_id, new.id, 'status_changed', v_actor,
            jsonb_build_object('status', old.status::text),
            jsonb_build_object('status', new.status::text));
  end if;

  return new;
end;
$$;

drop trigger if exists trg_shift_changes_capture on public.shifts;
create trigger trg_shift_changes_capture
  after insert or update or delete on public.shifts
  for each row execute function private.shift_changes_capture();


-- ── Read RPC: shift_history ───────────────────────────────────────────
-- Returns the most recent N changes for a shift, with actor name
-- resolved from app_users for display. Dispatcher-only.
create or replace function public.shift_history(p_shift_id uuid, p_limit int default 20)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.shifts s where s.id = p_shift_id and s.dsp_id = v_dsp
  ) then
    raise exception 'shift_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',         c.id,
    'event',      c.event,
    'before',     c.before,
    'after',      c.after,
    'at',         c.at,
    'actor_name', coalesce(nullif(trim(au.full_name), ''), au.email, null)
  ) order by c.at desc), '[]'::jsonb) into v_rows
  from public.shift_changes c
  left join public.app_users au on au.id = c.actor_user_id
  where c.shift_id = p_shift_id
  limit greatest(p_limit, 1);

  return jsonb_build_object('shift_id', p_shift_id, 'changes', v_rows);
end;
$$;
grant execute on function public.shift_history(uuid, int) to authenticated;


-- ── Realtime publication ──────────────────────────────────────────────
do $$
begin
  begin execute 'alter publication supabase_realtime add table public.shift_changes';
  exception when duplicate_object then null;
  end;
end $$;

notify pgrst, 'reload schema';
