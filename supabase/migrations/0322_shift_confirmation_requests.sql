-- Migration 0322 · 5th-day pass · driver confirmation flow
--
-- Adds the infrastructure for the operator's "ask driver to confirm
-- a 5th-day shift before scheduling it" feature:
--
--   1. Extends the public.shift_source enum with 'fifth_day_pass' so
--      shifts created via this flow can be visually marked on the
--      schedule grid.
--
--   2. New table public.shift_confirmation_requests — holds a
--      pending shift offer from dispatcher → driver. When the
--      driver clicks Accept (within 3 days), the matching shifts
--      row is inserted by the same RPC. After expires_at the
--      request is treated as expired (lazy — no cron needed; every
--      driver_pending_shift_confirmations() call returns only
--      still-fresh rows and bumps any past-due to status='expired').
--
--   3. RPC create_shift_confirmation_request(p_payload) — dispatcher
--      side. Inserts a request row, optionally drops a driver_messages
--      heads-up so the driver sees the offer in their existing chat
--      thread.
--
--   4. RPC driver_pending_shift_confirmations(p_token) — driver side.
--      Returns the driver's still-pending requests; auto-expires
--      anything past expires_at.
--
--   5. RPC driver_respond_to_shift_confirmation(p_token, p_request_id,
--      p_decision) — driver side. Marks the request accepted or
--      declined; on accept, inserts the corresponding shifts row
--      with source='fifth_day_pass'.
--
-- Idempotent throughout (the operator runs migrations by hand in
-- the Supabase SQL editor; re-running this file should never fail).

-- ── 1. Extend shift_source enum ────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'shift_source'
       and e.enumlabel = 'fifth_day_pass'
  ) then
    alter type public.shift_source add value 'fifth_day_pass';
  end if;
end $$;

-- ── 2. shift_confirmation_requests table ───────────────────────
create table if not exists public.shift_confirmation_requests (
  id              uuid          primary key default gen_random_uuid(),
  dsp_id          uuid          not null references public.dsps(id) on delete cascade,
  driver_id       uuid          not null references public.drivers(id) on delete cascade,
  -- The proposed shift's full payload — stored as jsonb so it
  -- can be inserted verbatim into the shifts table on accept.
  -- Expected keys: date, station_id, route_code (optional),
  -- starts_at, ends_at, shift_kind (default 'regular').
  proposed_shift  jsonb         not null,
  status          text          not null default 'pending'
                                check (status in ('pending', 'accepted', 'declined', 'expired')),
  -- 3-day default expiry, operator can override at create time.
  expires_at      timestamptz   not null default (now() + interval '3 days'),
  created_at      timestamptz   not null default now(),
  decided_at      timestamptz,
  -- After acceptance, links to the shifts row that was created.
  created_shift_id uuid         references public.shifts(id) on delete set null,
  created_by      uuid          references auth.users(id) on delete set null
);

create index if not exists shift_confirmation_requests_driver_status_idx
  on public.shift_confirmation_requests (driver_id, status, expires_at);

create index if not exists shift_confirmation_requests_dsp_created_idx
  on public.shift_confirmation_requests (dsp_id, created_at desc);

alter table public.shift_confirmation_requests enable row level security;

-- Dispatcher: read + write within their DSP.
drop policy if exists shift_confirmation_requests_dispatch_rw on public.shift_confirmation_requests;
create policy shift_confirmation_requests_dispatch_rw
  on public.shift_confirmation_requests for all
  to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

-- Driver-side access goes through the token-validated RPCs below,
-- so no auth.users-scoped RLS for drivers (they aren't logged into
-- the dashboard's auth surface).

grant select, insert, update on public.shift_confirmation_requests to authenticated;

-- ── 3. dispatcher RPC · create_shift_confirmation_request ──────
create or replace function public.create_shift_confirmation_request(p_payload jsonb)
returns public.shift_confirmation_requests
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.shift_confirmation_requests;
  v_driver_id uuid;
  v_proposed jsonb;
  v_expires_at timestamptz;
  v_message_body text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_driver_id := nullif(p_payload->>'driver_id','')::uuid;
  v_proposed  := p_payload->'proposed_shift';
  if v_driver_id is null then
    raise exception 'driver_id is required';
  end if;
  if v_proposed is null or v_proposed = 'null'::jsonb then
    raise exception 'proposed_shift is required';
  end if;

  v_expires_at := coalesce(
    nullif(p_payload->>'expires_at','')::timestamptz,
    now() + interval '3 days'
  );

  insert into public.shift_confirmation_requests
    (dsp_id, driver_id, proposed_shift, expires_at, created_by)
  values
    (v_dsp, v_driver_id, v_proposed, v_expires_at, auth.uid())
  returning * into v_row;

  -- Drop a driver-facing message so the offer shows up in the
  -- driver's existing chat thread alongside the in-app confirm
  -- card. Skipped silently if no driver_conversations row exists
  -- yet (the message bus only delivers within an active thread).
  v_message_body := coalesce(
    nullif(p_payload->>'message_body',''),
    'You have a new shift offer — please confirm or decline in the app within 3 days.'
  );
  begin
    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id, body)
    values
      (v_driver_id, v_dsp, 'dispatch', auth.uid(), v_message_body);
  exception when others then null;
  end;

  return v_row;
end;
$$;

grant execute on function public.create_shift_confirmation_request(jsonb) to authenticated;

-- ── 4. driver RPC · driver_pending_shift_confirmations ─────────
create or replace function public.driver_pending_shift_confirmations(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Lazy expiry: bump any past-due rows so the driver never sees
  -- stale offers. Cheap because of the (driver_id, status,
  -- expires_at) index.
  update public.shift_confirmation_requests
     set status = 'expired'
   where driver_id = v_drv.id
     and status = 'pending'
     and expires_at <= now();

  select coalesce(jsonb_agg(jsonb_build_object(
      'id',             r.id,
      'proposed_shift', r.proposed_shift,
      'expires_at',     r.expires_at,
      'created_at',     r.created_at
    ) order by r.created_at desc), '[]'::jsonb)
    into v_rows
  from public.shift_confirmation_requests r
  where r.driver_id = v_drv.id
    and r.status = 'pending';

  return jsonb_build_object('requests', v_rows);
end;
$$;

grant execute on function public.driver_pending_shift_confirmations(text) to anon, authenticated;

-- ── 5. driver RPC · driver_respond_to_shift_confirmation ──────
create or replace function public.driver_respond_to_shift_confirmation(
  p_token text,
  p_request_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_req public.shift_confirmation_requests;
  v_shift public.shifts;
  v_payload jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  if p_decision not in ('accept','decline') then
    raise exception 'decision must be accept or decline';
  end if;

  select * into v_req
    from public.shift_confirmation_requests
   where id = p_request_id
     and driver_id = v_drv.id
   for update;

  if v_req.id is null then
    raise exception 'request not found' using errcode = 'P0002';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'request already %', v_req.status using errcode = 'P0001';
  end if;
  if v_req.expires_at <= now() then
    update public.shift_confirmation_requests
       set status = 'expired', decided_at = now()
     where id = v_req.id;
    raise exception 'request expired' using errcode = 'P0001';
  end if;

  if p_decision = 'decline' then
    update public.shift_confirmation_requests
       set status = 'declined', decided_at = now()
     where id = v_req.id;
    return jsonb_build_object('status','declined','request_id', v_req.id);
  end if;

  -- Accept: create the shifts row from the proposed_shift jsonb.
  v_payload := v_req.proposed_shift;
  insert into public.shifts
    (dsp_id, station_id, driver_id, date, starts_at, ends_at, route_code,
     status, source, shift_kind, created_by)
  values
    (v_req.dsp_id,
     (v_payload->>'station_id')::uuid,
     v_drv.id,
     (v_payload->>'date')::date,
     nullif(v_payload->>'starts_at','')::timestamptz,
     nullif(v_payload->>'ends_at','')::timestamptz,
     v_payload->>'route_code',
     'scheduled',
     'fifth_day_pass',
     coalesce((v_payload->>'shift_kind')::public.shift_kind, 'regular'),
     null) -- driver-initiated; no auth.uid()
  returning * into v_shift;

  update public.shift_confirmation_requests
     set status = 'accepted',
         decided_at = now(),
         created_shift_id = v_shift.id
   where id = v_req.id;

  return jsonb_build_object(
    'status','accepted',
    'request_id', v_req.id,
    'shift_id', v_shift.id
  );
end;
$$;

grant execute on function public.driver_respond_to_shift_confirmation(text, uuid, text) to anon, authenticated;

-- ── 6. schedule_grid · surface `source` so the chip can mark
--      shifts that were created via the 5th-day pass. Adds one
--      key to the per-shift jsonb; everything else is unchanged
--      from migration 0269.
create or replace function public.schedule_grid(p_start date, p_weeks int default 3)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_end date := p_start + (p_weeks * 7 - 1);
  v_grid jsonb;
  v_shifts jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb)
    into v_grid
  from public.okami_grid(p_start, p_weeks) g;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', sh.id, 'date', sh.date, 'station_id', sh.station_id,
    'driver_id', sh.driver_id, 'driver_name', d.full_name,
    'route_code', sh.route_code, 'status', sh.status,
    'starts_at', sh.starts_at, 'ends_at', sh.ends_at,
    'block_hours', sh.block_hours, 'is_cushion', sh.is_cushion,
    'wave_index', sh.wave_index,
    'service_type_id',    sh.service_type_id,
    'service_type_code',  st.code,
    'service_type_label', st.label,
    'service_type_color', st.color,
    'shift_kind',         sh.shift_kind,
    'source',             sh.source,
    'trainer_driver_id',  sh.trainer_driver_id,
    'trainer_name',       tr.full_name,
    'notes', sh.notes
  ) order by sh.date, sh.station_id, sh.wave_index, sh.starts_at), '[]'::jsonb)
    into v_shifts
  from public.shifts sh
  left join public.drivers d  on d.id  = sh.driver_id
  left join public.drivers tr on tr.id = sh.trainer_driver_id
  left join public.service_types st on st.id = sh.service_type_id
  where sh.dsp_id = v_dsp
    and sh.date between p_start and v_end;

  return jsonb_build_object('coverage', v_grid, 'shifts', v_shifts,
                            'start', p_start, 'weeks', p_weeks);
end;
$$;

grant execute on function public.schedule_grid(date, int) to authenticated;


notify pgrst, 'reload schema';
