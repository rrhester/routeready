-- Migration 0134 · Availability gains an earliest-start time + preferred days
--
-- Two new dimensions on a driver's availability:
--
--   • earliest_start (time) — the earliest time of day the driver can
--     begin a shift.  Drivers run up to ~10h blocks but can't all start
--     at the same hour.  Like the available-days set, this is part of
--     the availability *request*: changing it goes through dispatcher
--     approval.  It is auto-approved only when it LOOSENS — i.e. the new
--     time is the same/earlier (or cleared) AND no available day was
--     dropped — reusing the migration-0133 auto-approve path.
--
--   • preferred_days (text[]) — the days the driver would most like to
--     be scheduled.  A pure preference: editable any time, no approval,
--     stored on the driver.  Every preferred day MUST sit inside the
--     driver's currently approved availability; the app blocks adding
--     one that doesn't and tells the driver to request an availability
--     change first.  driver_set_preferred_days enforces the same rule
--     server-side.
--
-- Storage:
--   driver_availability_requests.earliest_start    — per-request column
--   drivers.metadata.availability.earliest_start   — "HH24:MI" string of
--                                                    the approved value
--   drivers.metadata.availability.preferred_days   — jsonb array

alter table public.driver_availability_requests
  add column if not exists earliest_start time;


-- ── driver_submit_availability — now carries earliest_start ─────────────
-- Old 2-arg signature is dropped (a defaulted 3rd param would otherwise
-- create an overload, leaving the stale function in place).
drop function if exists public.driver_submit_availability(text, text[]);

create or replace function public.driver_submit_availability(
  p_token          text,
  p_days           text[],
  p_earliest_start text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv           public.drivers;
  v_valid_keys    text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days          text[];
  v_id            uuid;
  v_blackout      public.availability_blackouts;
  v_current_days  text[];
  v_current_start time;
  v_new_start     time;
  v_days_super    boolean;
  v_start_super   boolean;
  v_is_expansion  boolean;
  v_eff_from      date := current_date;
  v_eff_until     date := current_date + 21;
  v_avail         jsonb;
  v_start_txt     text;
  v_pref          jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  -- Reject if today falls inside an active blackout window for this dsp.
  select * into v_blackout from public.availability_blackouts
   where dsp_id = v_drv.dsp_id and start_date <= current_date and end_date >= current_date
   order by start_date desc limit 1;
  if v_blackout.id is not null then
    raise exception 'availability_blackout: %', coalesce(v_blackout.reason, 'Submissions are paused right now')
      using errcode = 'P0001';
  end if;

  -- Normalize requested days: dedupe, valid keys only, Mon→Sun order.
  with d as (select unnest(coalesce(p_days, '{}'::text[])) k)
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;
  v_days := coalesce(v_days, '{}'::text[]);

  -- Parse requested earliest start ("H:MM" / "HH:MM"); anything else → null.
  if p_earliest_start is not null and p_earliest_start ~ '^[0-9]{1,2}:[0-9]{2}$' then
    begin v_new_start := p_earliest_start::time; exception when others then v_new_start := null; end;
  end if;
  v_start_txt := case when v_new_start is null then null else substr(v_new_start::text, 1, 5) end;

  -- Current approved state.
  v_current_days := public.driver_effective_days_on(v_drv.id, current_date);
  begin
    v_current_start := nullif(v_drv.metadata -> 'availability' ->> 'earliest_start', '')::time;
  exception when others then v_current_start := null; end;

  -- An "expansion" (auto-approvable): no available day dropped AND the
  -- earliest start did not move later (null = no constraint = loosest).
  v_days_super  := not exists (select 1 from unnest(v_current_days) c where c <> all(v_days));
  v_start_super := (v_new_start is null)
                or (v_current_start is not null and v_new_start <= v_current_start);
  v_is_expansion := v_days_super and v_start_super;

  if v_is_expansion then
    -- Fold any still-pending request into this approval…
    update public.driver_availability_requests
       set days            = v_days,
           earliest_start  = v_new_start,
           status          = 'approved',
           submitted_at    = now(),
           decided_at      = now(),
           decided_by      = null,
           decision_note   = 'Auto-approved · driver added availability',
           effective_from  = v_eff_from,
           effective_until = v_eff_until
     where driver_id = v_drv.id and status = 'pending'
     returning id into v_id;

    -- …otherwise record a fresh approved row.
    if v_id is null then
      insert into public.driver_availability_requests
        (driver_id, dsp_id, days, earliest_start, status, submitted_at,
         decided_at, decided_by, decision_note, effective_from, effective_until)
      values
        (v_drv.id, v_drv.dsp_id, v_days, v_new_start, 'approved', now(),
         now(), null, 'Auto-approved · driver added availability', v_eff_from, v_eff_until)
      returning id into v_id;
    end if;

    -- Mirror to live metadata (effective today). Prune preferred days to
    -- whatever is still available; set/clear earliest_start to match.
    v_pref := coalesce(v_drv.metadata -> 'availability' -> 'preferred_days', '[]'::jsonb);
    v_pref := coalesce((select jsonb_agg(p) from jsonb_array_elements_text(v_pref) p where p = any(v_days)), '[]'::jsonb);
    v_avail := coalesce(v_drv.metadata -> 'availability', '{}'::jsonb)
               || jsonb_build_object('days', to_jsonb(v_days), 'preferred_days', v_pref);
    if v_start_txt is null then v_avail := v_avail - 'earliest_start';
    else v_avail := v_avail || jsonb_build_object('earliest_start', v_start_txt); end if;
    update public.drivers
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('availability', v_avail)
     where id = v_drv.id;

    return jsonb_build_object('id', v_id, 'days', to_jsonb(v_days),
      'earliest_start', to_jsonb(v_start_txt), 'status', 'approved',
      'auto_approved', true, 'effective_from', to_jsonb(v_eff_from::text));
  end if;

  -- Reduction / start tightened → dispatcher review, as before.
  insert into public.driver_availability_requests
    (driver_id, dsp_id, days, earliest_start, status, submitted_at)
  values
    (v_drv.id, v_drv.dsp_id, v_days, v_new_start, 'pending', now())
  on conflict (driver_id) where status = 'pending'
  do update set days = excluded.days, earliest_start = excluded.earliest_start, submitted_at = now()
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'days', to_jsonb(v_days),
    'earliest_start', to_jsonb(v_start_txt), 'status', 'pending', 'auto_approved', false);
end;
$$;
grant execute on function public.driver_submit_availability(text, text[], text) to anon, authenticated;


-- ── driver_set_preferred_days — freely editable, but ⊆ approved days ────
create or replace function public.driver_set_preferred_days(p_token text, p_days text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv        public.drivers;
  v_valid_keys text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days       text[];
  v_approved   text[];
  v_bad        text;
  v_label      jsonb := jsonb_build_object('mon','Monday','tue','Tuesday','wed','Wednesday',
                                           'thu','Thursday','fri','Friday','sat','Saturday','sun','Sunday');
begin
  v_drv := private.driver_validate_token(p_token);

  with d as (select unnest(coalesce(p_days, '{}'::text[])) k)
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days from (select distinct k from d where k = any(v_valid_keys)) x;
  v_days := coalesce(v_days, '{}'::text[]);

  select array(select jsonb_array_elements_text(coalesce(v_drv.metadata -> 'availability' -> 'days', '[]'::jsonb)))
    into v_approved;

  select d into v_bad from unnest(v_days) d where d <> all(coalesce(v_approved, '{}'::text[])) limit 1;
  if v_bad is not null then
    raise exception 'preferred_day_unavailable: % is not in your approved availability. Request an availability change to add it.',
      coalesce(v_label ->> v_bad, v_bad) using errcode = 'P0001';
  end if;

  update public.drivers
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('availability',
                         coalesce(metadata -> 'availability', '{}'::jsonb)
                         || jsonb_build_object('preferred_days', to_jsonb(v_days)))
   where id = v_drv.id;

  return jsonb_build_object('preferred_days', to_jsonb(v_days));
end;
$$;
grant execute on function public.driver_set_preferred_days(text, text[]) to anon, authenticated;


-- ── driver_get_availability — surface earliest_start + preferred_days ───
create or replace function public.driver_get_availability(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv          public.drivers;
  v_active_days  jsonb;
  v_earliest     text;
  v_preferred    jsonb;
  v_pending      public.driver_availability_requests;
  v_last_decided public.driver_availability_requests;
  v_blackout     public.availability_blackouts;
  v_lead         int;
begin
  v_drv := private.driver_validate_token(p_token);

  v_active_days := coalesce(v_drv.metadata -> 'availability' -> 'days', '[]'::jsonb);
  v_earliest    := nullif(v_drv.metadata -> 'availability' ->> 'earliest_start', '');
  v_preferred   := coalesce(v_drv.metadata -> 'availability' -> 'preferred_days', '[]'::jsonb);

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

  select coalesce(lead_days, 7) into v_lead
    from public.availability_settings where dsp_id = v_drv.dsp_id;
  if v_lead is null then v_lead := 7; end if;

  return jsonb_build_object(
    'days',            v_active_days,
    'earliest_start',  to_jsonb(v_earliest),
    'preferred_days',  v_preferred,
    'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
    'effective_until', to_jsonb((v_last_decided.effective_until)::text),
    'lead_days',       v_lead,
    'blackout', case when v_blackout.id is null then null else jsonb_build_object(
      'reason',     v_blackout.reason,
      'start_date', to_jsonb((v_blackout.start_date)::text),
      'end_date',   to_jsonb((v_blackout.end_date)::text)
    ) end,
    'pending', case when v_pending.id is null then null else jsonb_build_object(
      'days',           to_jsonb(v_pending.days),
      'earliest_start', to_jsonb(case when v_pending.earliest_start is null then null else substr(v_pending.earliest_start::text, 1, 5) end),
      'submitted_at',   to_jsonb(v_pending.submitted_at)
    ) end,
    'last_decision', case when v_last_decided.id is null then null else jsonb_build_object(
      'status',          v_last_decided.status,
      'days',            to_jsonb(v_last_decided.days),
      'earliest_start',  to_jsonb(case when v_last_decided.earliest_start is null then null else substr(v_last_decided.earliest_start::text, 1, 5) end),
      'decided_at',      to_jsonb(v_last_decided.decided_at),
      'decision_note',   v_last_decided.decision_note,
      'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
      'effective_until', to_jsonb((v_last_decided.effective_until)::text)
    ) end
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;


-- ── availability_request_decide — mirror earliest_start on approval ─────
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
  v_avail      jsonb;
  v_pref       jsonb;
  v_lead_days  int;
  v_eff_from   date;
  v_eff_until  date;
  v_msg_body   text;
  v_dlabel     text;
  v_clean_note text;
  v_template   text;
  v_settings   public.availability_settings;
  v_start_txt  text;
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

  select string_agg(initcap(d), ', ' order by array_position(
    array['mon','tue','wed','thu','fri','sat','sun'], d
  )) into v_dlabel from unnest(v_req.days) d;
  if v_dlabel is null or v_dlabel = '' then v_dlabel := '(no days)'; end if;

  v_start_txt := case when v_req.earliest_start is null then null else substr(v_req.earliest_start::text, 1, 5) end;

  select * into v_settings from public.availability_settings where dsp_id = v_dsp;
  v_lead_days := coalesce(v_settings.lead_days, 7);

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

    if v_lead_days <= 0 then
      select * into v_drv from public.drivers where id = v_req.driver_id;
      v_pref := coalesce(v_drv.metadata -> 'availability' -> 'preferred_days', '[]'::jsonb);
      v_pref := coalesce((select jsonb_agg(p) from jsonb_array_elements_text(v_pref) p where p = any(v_req.days)), '[]'::jsonb);
      v_avail := coalesce(v_drv.metadata -> 'availability', '{}'::jsonb)
                 || jsonb_build_object('days', to_jsonb(v_req.days), 'preferred_days', v_pref);
      if v_start_txt is null then v_avail := v_avail - 'earliest_start';
      else v_avail := v_avail || jsonb_build_object('earliest_start', v_start_txt); end if;
      update public.drivers
         set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('availability', v_avail)
       where id = v_req.driver_id;
    end if;

    v_template := coalesce(
      v_settings.approve_template,
      'Your availability request has been approved: {days}. Effective from {effective_from} through {effective_until}.{note}'
    );
    v_msg_body := replace(v_template, '{days}',            v_dlabel);
    v_msg_body := replace(v_msg_body, '{effective_from}',  to_char(v_eff_from,  'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{effective_until}', to_char(v_eff_until, 'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{note}',            coalesce(' Note: ' || v_clean_note, ''));
    if v_req.earliest_start is not null then
      v_msg_body := v_msg_body || ' Earliest start: ' || to_char((date '2000-01-01' + v_req.earliest_start), 'FMHH12:MI AM') || '.';
    end if;
  else
    update public.driver_availability_requests
       set status        = 'denied',
           decided_at    = now(),
           decided_by    = auth.uid(),
           decision_note = v_clean_note
     where id = p_request_id;

    v_template := coalesce(
      v_settings.deny_template,
      'Your availability request was not approved.{note} Submit a new request from the Availability page.'
    );
    v_msg_body := replace(v_template, '{days}', v_dlabel);
    v_msg_body := replace(v_msg_body, '{note}', coalesce(' Reason: ' || v_clean_note, ''));
  end if;

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


-- ── availability_request_list — include earliest_start (req + current) ──
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
    select jsonb_agg(t order by
      (case when t->>'status' = 'pending' then 0 else 1 end),
      (t->>'submitted_at') asc
    ) from (
      select jsonb_build_object(
        'id',              r.id,
        'driver_id',       r.driver_id,
        'driver_name',     coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
        'station_code',    s.code,
        'days',            to_jsonb(r.days),
        'current_days',    coalesce(d.metadata -> 'availability' -> 'days', '[]'::jsonb),
        'earliest_start',         to_jsonb(case when r.earliest_start is null then null else substr(r.earliest_start::text, 1, 5) end),
        'current_earliest_start', d.metadata -> 'availability' -> 'earliest_start',
        'preferred_days',  coalesce(d.metadata -> 'availability' -> 'preferred_days', '[]'::jsonb),
        'status',          r.status,
        'submitted_at',    r.submitted_at,
        'decided_at',      r.decided_at,
        'decision_note',   r.decision_note,
        'effective_from',  to_jsonb((r.effective_from)::text),
        'effective_until', to_jsonb((r.effective_until)::text),
        'request_count',   (
          select count(*)::int from public.driver_availability_requests rc where rc.driver_id = r.driver_id
        ),
        'prev_submitted_at', (
          select rp.submitted_at from public.driver_availability_requests rp
           where rp.driver_id = r.driver_id and rp.submitted_at < r.submitted_at
           order by rp.submitted_at desc limit 1
        ),
        'last_decided_at', (
          select rd.decided_at from public.driver_availability_requests rd
           where rd.driver_id = r.driver_id and rd.id <> r.id and rd.decided_at is not null
           order by rd.decided_at desc limit 1
        )
      ) as t
      from public.driver_availability_requests r
      join public.drivers d on d.id = r.driver_id
      left join public.stations s on s.id = d.station_id
      where r.dsp_id = v_dsp
        and (r.status = 'pending' or r.decided_at > now() - interval '60 days')
    ) sub
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_request_list() to authenticated;


-- ── availability_request_history — include earliest_start ──────────────
create or replace function public.availability_request_history(p_driver_id uuid)
returns jsonb
language plpgsql
stable
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
    select jsonb_agg(jsonb_build_object(
      'id',              r.id,
      'days',            to_jsonb(r.days),
      'earliest_start',  to_jsonb(case when r.earliest_start is null then null else substr(r.earliest_start::text, 1, 5) end),
      'status',          r.status,
      'submitted_at',    r.submitted_at,
      'decided_at',      r.decided_at,
      'decision_note',   r.decision_note,
      'effective_from',  to_jsonb((r.effective_from)::text),
      'effective_until', to_jsonb((r.effective_until)::text)
    ) order by r.submitted_at desc)
    from public.driver_availability_requests r
    where r.driver_id = p_driver_id and r.dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.availability_request_history(uuid) to authenticated;


-- ── driver_record — add earliest_start to the availability sub-objects ─
create or replace function public.driver_record(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv jsonb;
  v_coachings jsonb;
  v_docs jsonb;
  v_avail_pending jsonb;
  v_avail_latest  jsonb;
begin
  select to_jsonb(d) into v_drv
  from public.drivers d
  where d.id = p_id and d.dsp_id = v_dsp;
  if v_drv is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.occurred_at desc), '[]'::jsonb)
    into v_coachings
  from public.coachings c
  where c.driver_id = p_id and c.dsp_id = v_dsp;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
    into v_docs
  from public.driver_documents x
  where x.driver_id = p_id and x.dsp_id = v_dsp;

  select jsonb_build_object(
           'id',             r.id,
           'days',           to_jsonb(r.days),
           'earliest_start', to_jsonb(case when r.earliest_start is null then null else substr(r.earliest_start::text, 1, 5) end),
           'submitted_at',   to_jsonb(r.submitted_at)
         )
    into v_avail_pending
  from public.driver_availability_requests r
  where r.driver_id = p_id and r.dsp_id = v_dsp and r.status = 'pending'
  order by r.submitted_at desc
  limit 1;

  select jsonb_build_object(
           'id',              r.id,
           'status',          r.status,
           'days',            to_jsonb(r.days),
           'earliest_start',  to_jsonb(case when r.earliest_start is null then null else substr(r.earliest_start::text, 1, 5) end),
           'decided_at',      to_jsonb(r.decided_at),
           'decision_note',   r.decision_note,
           'effective_from',  to_jsonb((r.effective_from)::text),
           'effective_until', to_jsonb((r.effective_until)::text)
         )
    into v_avail_latest
  from public.driver_availability_requests r
  where r.driver_id = p_id and r.dsp_id = v_dsp and r.status in ('approved','denied')
  order by r.decided_at desc nulls last
  limit 1;

  return jsonb_build_object(
    'driver',               v_drv,
    'coachings',            v_coachings,
    'documents',            v_docs,
    'availability_pending', v_avail_pending,
    'availability_latest',  v_avail_latest
  );
end;
$$;
grant execute on function public.driver_record(uuid) to authenticated;

notify pgrst, 'reload schema';
