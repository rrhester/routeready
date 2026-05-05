-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0063 · Availability — lead time, blackouts, templates, KPIs
--
-- Five operator asks rolled into one migration:
--
-- 1. Approvals don't take effect immediately. The DSP sets a lead time
--    (days from approval until the new availability is live). Default 7.
--    drivers.metadata.availability.days is NO LONGER updated by approve;
--    the auto-assigner reads driver_effective_days_on(driver_id, date)
--    instead, which picks the latest approved request whose
--    effective_from <= date. Old metadata stays as the seed/fallback.
--
-- 2. Sortable queue → no schema change, frontend only.
--
-- 3. KPIs → availability_kpis() returns repeat-requester counts and
--    other operator-helpful numbers.
--
-- 4. Blackout dates → availability_blackouts table; driver_submit_avail
--    rejects any submission whose timestamp falls within a blackout.
--
-- 5. Auto-response templates → scheduling_settings holds DSP-level
--    approve/deny templates. {placeholders} are filled at decide time:
--      {days}, {effective_until}, {note}
--    Defaults match the hardcoded text from migration 0062.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Schedule-rule columns (lead time + templates) ──
alter table public.scheduling_settings
  add column if not exists availability_change_lead_days int  not null default 7,
  add column if not exists availability_approve_template text,
  add column if not exists availability_deny_template    text;


-- ── 2. Blackout-dates table ──
create table if not exists public.availability_blackouts (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  start_date  date not null,
  end_date    date not null,
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id),
  check (end_date >= start_date)
);
create index if not exists availability_blackouts_dsp_idx
  on public.availability_blackouts(dsp_id, start_date);

alter table public.availability_blackouts enable row level security;

drop policy if exists "blackouts_tenant_r" on public.availability_blackouts;
create policy "blackouts_tenant_r"
  on public.availability_blackouts for select
  using (dsp_id = private.current_dsp_id());

grant select on public.availability_blackouts to authenticated, anon;


-- ── 3. Helpers ──

-- Effective availability days for a driver on a specific date. Picks
-- the latest approved request where effective_from <= date AND
-- (effective_until is null OR effective_until >= date). Falls back to
-- drivers.metadata.availability.days when no approved request matches.
create or replace function public.driver_effective_days_on(
  p_driver_id uuid,
  p_date      date
)
returns text[]
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_days text[];
begin
  select r.days into v_days
    from public.driver_availability_requests r
   where r.driver_id      = p_driver_id
     and r.status         = 'approved'
     and r.effective_from is not null
     and r.effective_from <= p_date
     and (r.effective_until is null or r.effective_until >= p_date)
   order by r.effective_from desc
   limit 1;

  if v_days is not null then return v_days; end if;

  -- Fallback: legacy metadata.availability.days from before the
  -- approval workflow.
  select array(
    select jsonb_array_elements_text(d.metadata -> 'availability' -> 'days')
  ) into v_days
   from public.drivers d where d.id = p_driver_id;

  return coalesce(v_days, '{}'::text[]);
end;
$$;
grant execute on function public.driver_effective_days_on(uuid, date) to authenticated;


-- Batch version for the auto-assigner. Returns one row per
-- (driver_id, day_of_week, date) with whether the driver is available.
-- Easier for JS to consume than calling the singular helper N times.
create or replace function public.driver_effective_days_for_drivers(
  p_driver_ids uuid[],
  p_dates      date[]
)
returns table (driver_id uuid, on_date date, days text[])
language sql
stable
security definer
set search_path = ''
as $$
  select d.id, dt::date, public.driver_effective_days_on(d.id, dt::date)
    from public.drivers d
    cross join unnest(p_dates) dt
   where d.id = any(p_driver_ids);
$$;
grant execute on function public.driver_effective_days_for_drivers(uuid[], date[]) to authenticated;


-- ── 4. Reshape availability_request_decide to honor lead-time and templates ──
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
  v_dsp        uuid := private.current_dsp_id();
  v_req        public.driver_availability_requests;
  v_drv        public.drivers;
  v_meta       jsonb;
  v_lead_days  int;
  v_eff_from   date;
  v_eff_until  date;
  v_msg_body   text;
  v_dlabel     text;
  v_clean_note text;
  v_template   text;
  v_settings   public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req
    from public.driver_availability_requests
   where id = p_request_id and dsp_id = v_dsp
   for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then raise exception 'request_already_decided' using errcode = 'P0001'; end if;

  v_clean_note := nullif(trim(coalesce(p_note, '')), '');

  -- Pretty day list: "Mon, Tue, Wed".
  select string_agg(initcap(d), ', ' order by array_position(
    array['mon','tue','wed','thu','fri','sat','sun'], d
  )) into v_dlabel from unnest(v_req.days) d;
  if v_dlabel is null or v_dlabel = '' then v_dlabel := '(no days)'; end if;

  -- DSP-level scheduling settings (week_start IS NULL = the dsp default).
  select * into v_settings from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  v_lead_days := coalesce(v_settings.availability_change_lead_days, 7);

  if p_approve then
    v_eff_from  := current_date + v_lead_days;
    v_eff_until := v_eff_from + 21;

    update public.driver_availability_requests
       set status          = 'approved',
           decided_at      = now(),
           decided_by      = auth.uid(),
           decision_note   = v_clean_note,
           effective_from  = v_eff_from,
           effective_until = v_eff_until
     where id = p_request_id;

    -- Only mirror to drivers.metadata if the change is effective TODAY
    -- (lead_days = 0). Future-dated approvals don't touch the live
    -- availability — the auto-assigner reads
    -- driver_effective_days_on(driver_id, shift_date) and picks up the
    -- new request automatically once shift_date >= effective_from.
    if v_lead_days <= 0 then
      select * into v_drv from public.drivers where id = v_req.driver_id;
      v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'availability', jsonb_build_object('days', to_jsonb(v_req.days))
                );
      update public.drivers set metadata = v_meta where id = v_req.driver_id;
    end if;

    v_template := coalesce(
      v_settings.availability_approve_template,
      'Your availability request has been approved: {days}. Effective from {effective_from} through {effective_until}.{note}'
    );
    v_msg_body := replace(v_template, '{days}',            v_dlabel);
    v_msg_body := replace(v_msg_body, '{effective_from}',  to_char(v_eff_from,  'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{effective_until}', to_char(v_eff_until, 'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{note}',            coalesce(' Note: ' || v_clean_note, ''));
  else
    update public.driver_availability_requests
       set status        = 'denied',
           decided_at    = now(),
           decided_by    = auth.uid(),
           decision_note = v_clean_note
     where id = p_request_id;

    v_template := coalesce(
      v_settings.availability_deny_template,
      'Your availability request was not approved.{note} Submit a new request from the Availability page.'
    );
    v_msg_body := replace(v_template, '{days}', v_dlabel);
    v_msg_body := replace(v_msg_body, '{note}', coalesce(' Reason: ' || v_clean_note, ''));
  end if;

  -- Drop a chat message so the existing push pipeline notifies the driver.
  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (v_req.driver_id, v_dsp, 'dispatch', auth.uid(), v_msg_body);

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_req.driver_id, v_dsp, now())
  on conflict (driver_id) do update set last_message_at = now();

  return jsonb_build_object(
    'id',     p_request_id,
    'status', case when p_approve then 'approved' else 'denied' end,
    'effective_from',  case when p_approve then to_jsonb(v_eff_from::text)  else 'null'::jsonb end,
    'effective_until', case when p_approve then to_jsonb(v_eff_until::text) else 'null'::jsonb end
  );
end;
$$;
grant execute on function public.availability_request_decide(uuid, boolean, text) to authenticated;


-- ── 5. Reshape driver_submit_availability to enforce blackouts ──
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
  v_drv        public.drivers;
  v_valid_keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days       text[];
  v_id         uuid;
  v_blackout   public.availability_blackouts;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Reject if today falls inside an active blackout window for this dsp.
  select * into v_blackout from public.availability_blackouts
   where dsp_id     = v_drv.dsp_id
     and start_date <= current_date
     and end_date   >= current_date
   order by start_date desc
   limit 1;
  if v_blackout.id is not null then
    raise exception 'availability_blackout: %', coalesce(v_blackout.reason, 'Submissions are paused right now')
      using errcode = 'P0001';
  end if;

  with d as (select unnest(coalesce(p_days, '{}'::text[])) k)
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;
  v_days := coalesce(v_days, '{}'::text[]);

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


-- ── 6. Surface lead time + blackouts to the driver app for friendlier UI ──
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
  v_blackout public.availability_blackouts;
  v_lead int;
begin
  v_drv := private.driver_validate_token(p_token);

  v_active_days := coalesce(v_drv.metadata -> 'availability' -> 'days', '[]'::jsonb);

  select * into v_pending
    from public.driver_availability_requests
   where driver_id = v_drv.id and status = 'pending'
   order by submitted_at desc limit 1;

  select * into v_last_decided
    from public.driver_availability_requests
   where driver_id = v_drv.id and status in ('approved','denied')
   order by decided_at desc nulls last limit 1;

  select * into v_blackout from public.availability_blackouts
   where dsp_id = v_drv.dsp_id
     and start_date <= current_date and end_date >= current_date
   order by start_date desc limit 1;

  select coalesce(availability_change_lead_days, 7) into v_lead
    from public.scheduling_settings
   where dsp_id = v_drv.dsp_id and week_start is null;
  if v_lead is null then v_lead := 7; end if;

  return jsonb_build_object(
    'days',    v_active_days,
    'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
    'effective_until', to_jsonb((v_last_decided.effective_until)::text),
    'lead_days', v_lead,
    'blackout', case when v_blackout.id is null then null else jsonb_build_object(
      'reason',     v_blackout.reason,
      'start_date', to_jsonb((v_blackout.start_date)::text),
      'end_date',   to_jsonb((v_blackout.end_date)::text)
    ) end,
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


-- ── 7. KPIs for the dispatcher ──
create or replace function public.availability_kpis()
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

  return jsonb_build_object(
    'pending_count', (
      select count(*) from public.driver_availability_requests
       where dsp_id = v_dsp and status = 'pending'
    ),
    'approved_30d', (
      select count(*) from public.driver_availability_requests
       where dsp_id = v_dsp and status = 'approved'
         and decided_at > now() - interval '30 days'
    ),
    'denied_30d', (
      select count(*) from public.driver_availability_requests
       where dsp_id = v_dsp and status = 'denied'
         and decided_at > now() - interval '30 days'
    ),
    'avg_decision_hours_30d', (
      select round(avg(extract(epoch from (decided_at - submitted_at)) / 3600)::numeric, 1)
        from public.driver_availability_requests
       where dsp_id = v_dsp and decided_at is not null
         and decided_at > now() - interval '30 days'
    ),
    -- Drivers with 2+ requests in the last 30 days. Surfaces flip-floppers
    -- the operator might want to talk to.
    'repeat_requesters_30d', coalesce((
      select jsonb_agg(jsonb_build_object(
        'driver_id', driver_id,
        'driver_name', name,
        'count', cnt
      ) order by cnt desc) from (
        select r.driver_id,
               coalesce(nullif(trim(d.preferred_name), ''), d.full_name) as name,
               count(*) as cnt
          from public.driver_availability_requests r
          join public.drivers d on d.id = r.driver_id
         where r.dsp_id = v_dsp
           and r.submitted_at > now() - interval '30 days'
         group by r.driver_id, name
         having count(*) >= 2
      ) t
    ), '[]'::jsonb),
    -- Day-of-week heatmap of approved requests this period: which days
    -- are most often added, which most often dropped vs the prior set.
    'day_demand_30d', coalesce((
      select jsonb_object_agg(d, n) from (
        select d, count(*) as n from (
          select unnest(r.days) as d from public.driver_availability_requests r
           where r.dsp_id = v_dsp and r.status = 'approved'
             and r.decided_at > now() - interval '30 days'
        ) x group by d
      ) y
    ), '{}'::jsonb)
  );
end;
$$;
grant execute on function public.availability_kpis() to authenticated;


-- ── 8. Blackout management RPCs (dispatcher-only) ──
create or replace function public.availability_blackout_list()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',         id,
      'start_date', to_jsonb(start_date::text),
      'end_date',   to_jsonb(end_date::text),
      'reason',     reason
    ) order by start_date desc)
      from public.availability_blackouts
     where dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_blackout_list() to authenticated;

create or replace function public.availability_blackout_upsert(
  p_id         uuid,
  p_start_date date,
  p_end_date   date,
  p_reason     text
)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_id  uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_end_date < p_start_date then
    raise exception 'end_before_start' using errcode = 'P0001';
  end if;

  if p_id is null then
    insert into public.availability_blackouts (dsp_id, start_date, end_date, reason, created_by)
    values (v_dsp, p_start_date, p_end_date, nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
    returning id into v_id;
  else
    update public.availability_blackouts
       set start_date = p_start_date,
           end_date   = p_end_date,
           reason     = nullif(trim(coalesce(p_reason, '')), '')
     where id = p_id and dsp_id = v_dsp
     returning id into v_id;
    if v_id is null then raise exception 'blackout_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_id;
end;
$$;
grant execute on function public.availability_blackout_upsert(uuid, date, date, text) to authenticated;

create or replace function public.availability_blackout_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.availability_blackouts where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.availability_blackout_delete(uuid) to authenticated;


-- ── 9. Settings RPC for the new lead-time + templates fields ──
create or replace function public.availability_settings_get()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_s public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_s from public.scheduling_settings
   where dsp_id = v_dsp and week_start is null;
  return jsonb_build_object(
    'lead_days',         coalesce(v_s.availability_change_lead_days, 7),
    'approve_template',  coalesce(v_s.availability_approve_template,
      'Your availability request has been approved: {days}. Effective from {effective_from} through {effective_until}.{note}'),
    'deny_template',     coalesce(v_s.availability_deny_template,
      'Your availability request was not approved.{note} Submit a new request from the Availability page.')
  );
end;
$$;
grant execute on function public.availability_settings_get() to authenticated;

create or replace function public.availability_settings_set(
  p_lead_days        int,
  p_approve_template text,
  p_deny_template    text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.scheduling_settings
    (dsp_id, week_start, availability_change_lead_days,
     availability_approve_template, availability_deny_template)
  values
    (v_dsp, null, greatest(0, least(60, coalesce(p_lead_days, 7))),
     nullif(trim(coalesce(p_approve_template, '')), ''),
     nullif(trim(coalesce(p_deny_template, '')), ''))
  on conflict (dsp_id, week_start) do update set
    availability_change_lead_days = excluded.availability_change_lead_days,
    availability_approve_template = excluded.availability_approve_template,
    availability_deny_template    = excluded.availability_deny_template,
    updated_at = now();
end;
$$;
grant execute on function public.availability_settings_set(int, text, text) to authenticated;


notify pgrst, 'reload schema';
