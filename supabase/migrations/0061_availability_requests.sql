-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0061 · Availability becomes an approval workflow
--
-- Drivers no longer set drivers.metadata.availability directly. Instead:
--
--   1. Driver toggles a day in the PWA — that upserts a SINGLE pending
--      request row per driver (only one open at a time).
--   2. Owner reviews pending requests in the dispatcher's new
--      Drivers → Availability tab, approves or denies.
--   3. On approve, drivers.metadata.availability.days is updated (so
--      the existing auto-assigner keeps working unchanged), the request
--      is stamped with effective_from = today and effective_until =
--      today + 21 days, and the request stays as the row of record.
--   4. Driver's app surfaces the status (pending / approved through
--      <date> / denied) on next load.
--
-- All existing drivers.metadata.availability values are left in place
-- and continue to be the "live" set until a new approved request
-- overwrites them.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Table ──
create table if not exists public.driver_availability_requests (
  id              uuid primary key default gen_random_uuid(),
  driver_id       uuid not null references public.drivers(id) on delete cascade,
  dsp_id          uuid not null references public.dsps(id)    on delete cascade,
  days            text[] not null default '{}',
  status          text not null default 'pending'
                   check (status in ('pending','approved','denied')),
  decision_note   text,
  submitted_at    timestamptz not null default now(),
  decided_at      timestamptz,
  decided_by      uuid references auth.users(id),
  effective_from  date,
  effective_until date,
  created_at      timestamptz not null default now()
);
create index if not exists driver_avail_requests_driver_idx
  on public.driver_availability_requests(driver_id, submitted_at desc);
create index if not exists driver_avail_requests_pending_idx
  on public.driver_availability_requests(dsp_id, submitted_at desc)
  where status = 'pending';

-- Only one pending request per driver — toggling re-uses the row.
create unique index if not exists driver_avail_requests_one_pending
  on public.driver_availability_requests(driver_id)
  where status = 'pending';

alter table public.driver_availability_requests enable row level security;

drop policy if exists "avail_req_tenant_r" on public.driver_availability_requests;
create policy "avail_req_tenant_r"
  on public.driver_availability_requests for select
  using (dsp_id = private.current_dsp_id());

grant select on public.driver_availability_requests to authenticated;


-- ── 2. driver_get_availability — surface pending + active to the app ──
create or replace function public.driver_get_availability(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_active_days jsonb;
  v_pending public.driver_availability_requests;
  v_last_decided public.driver_availability_requests;
begin
  v_drv := private.driver_validate_token(p_token);

  v_active_days := coalesce(
    v_drv.metadata -> 'availability' -> 'days',
    '[]'::jsonb
  );

  select * into v_pending
    from public.driver_availability_requests
   where driver_id = v_drv.id and status = 'pending'
   order by submitted_at desc
   limit 1;

  select * into v_last_decided
    from public.driver_availability_requests
   where driver_id = v_drv.id and status in ('approved','denied')
   order by decided_at desc nulls last
   limit 1;

  return jsonb_build_object(
    'days',    v_active_days,                                         -- live availability the dispatcher uses
    'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
    'effective_until', to_jsonb((v_last_decided.effective_until)::text),
    'pending', case when v_pending.id is null then null else jsonb_build_object(
      'days',         to_jsonb(v_pending.days),
      'submitted_at', to_jsonb(v_pending.submitted_at)
    ) end,
    'last_decision', case when v_last_decided.id is null then null else jsonb_build_object(
      'status',          v_last_decided.status,
      'decided_at',      to_jsonb(v_last_decided.decided_at),
      'decision_note',   v_last_decided.decision_note,
      'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
      'effective_until', to_jsonb((v_last_decided.effective_until)::text)
    ) end
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;


-- ── 3. driver_submit_availability — upsert the pending request ──
-- The driver app calls this every time a toggle is flipped. If a
-- pending row already exists, its days are replaced; otherwise a new
-- one is created. Approved/denied history is never modified.
create or replace function public.driver_submit_availability(
  p_token text,
  p_days  text[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_valid_keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days       text[];
  v_id         uuid;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Filter to canonical day keys, dedupe, preserve canonical order.
  with d as (
    select unnest(coalesce(p_days, '{}'::text[])) k
  )
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;

  v_days := coalesce(v_days, '{}'::text[]);

  -- Upsert pending row.
  insert into public.driver_availability_requests
    (driver_id, dsp_id, days, status, submitted_at)
  values
    (v_drv.id, v_drv.dsp_id, v_days, 'pending', now())
  on conflict (driver_id) where status = 'pending'
  do update set days = excluded.days, submitted_at = now()
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'days', to_jsonb(v_days));
end;
$$;
grant execute on function public.driver_submit_availability(text, text[]) to anon, authenticated;


-- ── 4. availability_request_list — owner queue ──
-- Returns pending requests for the current dsp, joined with driver
-- name + station so the dashboard can render the queue without a
-- second round-trip.
create or replace function public.availability_request_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by t->>'submitted_at' asc) from (
      select jsonb_build_object(
        'id',           r.id,
        'driver_id',    r.driver_id,
        'driver_name',  coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code', s.code,
        'days',         to_jsonb(r.days),
        'current_days', coalesce(d.metadata -> 'availability' -> 'days', '[]'::jsonb),
        'submitted_at', r.submitted_at
      ) as t
      from public.driver_availability_requests r
      join public.drivers d on d.id = r.driver_id
      left join public.stations s on s.id = d.station_id
      where r.dsp_id = v_dsp and r.status = 'pending'
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_request_list() to authenticated;


-- ── 5. availability_request_decide — approve or deny ──
-- Approving stamps the row, fixes the 21-day effective window, and
-- updates drivers.metadata.availability.days so existing scheduling
-- code keeps working without changes. Denying just records the note.
create or replace function public.availability_request_decide(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_req public.driver_availability_requests;
  v_drv public.drivers;
  v_meta jsonb;
  v_eff_from date;
  v_eff_until date;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req
    from public.driver_availability_requests
   where id = p_request_id and dsp_id = v_dsp
   for update;
  if v_req.id is null then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request_already_decided' using errcode = 'P0001';
  end if;

  if p_approve then
    v_eff_from  := current_date;
    v_eff_until := current_date + 21;

    update public.driver_availability_requests
       set status          = 'approved',
           decided_at      = now(),
           decided_by      = auth.uid(),
           decision_note   = nullif(trim(coalesce(p_note, '')), ''),
           effective_from  = v_eff_from,
           effective_until = v_eff_until
     where id = p_request_id;

    -- Sync the live availability that the auto-assigner reads.
    select * into v_drv from public.drivers where id = v_req.driver_id;
    v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
              || jsonb_build_object(
                'availability',
                jsonb_build_object('days', to_jsonb(v_req.days))
              );
    update public.drivers set metadata = v_meta where id = v_req.driver_id;
  else
    update public.driver_availability_requests
       set status        = 'denied',
           decided_at    = now(),
           decided_by    = auth.uid(),
           decision_note = nullif(trim(coalesce(p_note, '')), '')
     where id = p_request_id;
  end if;

  return jsonb_build_object(
    'id',     p_request_id,
    'status', case when p_approve then 'approved' else 'denied' end,
    'effective_from',  case when p_approve then to_jsonb(v_eff_from::text)  else 'null'::jsonb end,
    'effective_until', case when p_approve then to_jsonb(v_eff_until::text) else 'null'::jsonb end
  );
end;
$$;
grant execute on function public.availability_request_decide(uuid, boolean, text) to authenticated;


-- ── 6. Drop the old direct-write RPC from 0060 ──
-- The driver app now goes through driver_submit_availability instead.
drop function if exists public.driver_set_availability(text, text[]);


notify pgrst, 'reload schema';
