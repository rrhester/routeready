-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0252 · Time-off request workflow
--
-- The time_off_requests table + status enum already exist (0025). This
-- migration adds the workflow RPCs that the driver PWA and dispatcher
-- dashboard need to actually use it:
--
--   Driver (token-validated, mirrors driver_chat_* and the new
--                            driver_team_roster from 0250 / 0251):
--     driver_time_off_request  — submit a new request
--     driver_time_off_list     — view my requests
--     driver_time_off_cancel   — cancel one of mine that's still pending
--
--   Dispatcher (session-auth, RLS-scoped on dsp_id):
--     dispatch_time_off_list   — pending + decided in one call
--     dispatch_time_off_decide — approve or deny, posts a dispatch chat
--                                 message so the driver gets the
--                                 existing push pipeline (trg_driver_
--                                 messages_fire_push) and sees the
--                                 decision in their thread
--
-- Approved time off is already honored by:
--   * private.driver_can_take_shift (0201) — server-side gate for
--     driver self-pickup of open shifts
--   * _checkAssignViolations in dashboard live.js — client-side warning
--     when a dispatcher tries to assign someone to a shift on an
--     approved-off day (with override capability)
-- so we do NOT add a new hard server-side block; the existing warn-on-
-- assign behavior continues to be the source of truth. This RPC pack is
-- pure workflow.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. driver_time_off_request · driver creates a pending request ──
create or replace function public.driver_time_off_request(
  p_token      text,
  p_start_date date,
  p_end_date   date,
  p_reason     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv    public.drivers;
  v_reason text;
  v_id     uuid;
  v_overlap boolean;
begin
  v_drv := private.driver_validate_token(p_token);

  if p_start_date is null or p_end_date is null then
    raise exception 'time_off_dates_required';
  end if;
  if p_end_date < p_start_date then
    raise exception 'time_off_end_before_start';
  end if;
  if p_start_date < current_date then
    raise exception 'time_off_start_in_past';
  end if;

  -- Block if the driver already has a pending or approved request
  -- whose window overlaps the new one. Cancelled/denied don't block.
  select exists (
    select 1 from public.time_off_requests
     where driver_id = v_drv.id
       and status in ('pending', 'approved')
       and not (end_date < p_start_date or start_date > p_end_date)
  ) into v_overlap;
  if v_overlap then
    raise exception 'time_off_overlaps_existing';
  end if;

  v_reason := nullif(trim(coalesce(p_reason, '')), '');

  insert into public.time_off_requests
    (dsp_id, driver_id, start_date, end_date, reason, status)
  values
    (v_drv.dsp_id, v_drv.id, p_start_date, p_end_date, v_reason, 'pending')
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'status', 'pending');
end;
$$;
grant execute on function public.driver_time_off_request(text, date, date, text) to anon, authenticated;


-- ── 2. driver_time_off_list · driver views their own requests ──
create or replace function public.driver_time_off_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_rows jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             r.id,
      'start_date',     r.start_date,
      'end_date',       r.end_date,
      'reason',         r.reason,
      'status',         r.status,
      'decision_notes', r.decision_notes,
      'decided_at',     r.decided_at,
      'created_at',     r.created_at
    )
    order by r.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from public.time_off_requests r
  where r.driver_id = v_drv.id;

  return v_rows;
end;
$$;
grant execute on function public.driver_time_off_list(text) to anon, authenticated;


-- ── 3. driver_time_off_cancel · driver cancels their own pending row ──
create or replace function public.driver_time_off_cancel(
  p_token text,
  p_id    uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_req public.time_off_requests;
begin
  v_drv := private.driver_validate_token(p_token);

  select * into v_req from public.time_off_requests
   where id = p_id and driver_id = v_drv.id;
  if v_req.id is null then
    raise exception 'time_off_not_found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'time_off_not_cancellable';
  end if;

  update public.time_off_requests
     set status = 'cancelled'
   where id = p_id;

  return jsonb_build_object('id', p_id, 'status', 'cancelled');
end;
$$;
grant execute on function public.driver_time_off_cancel(text, uuid) to anon, authenticated;


-- ── 4. dispatch_time_off_list · DSP-side roster of requests ──
-- Returns pending first (oldest-submitted leading), then decided
-- (most recent decision first), with driver display name baked in so
-- the dashboard doesn't need a second roundtrip.
create or replace function public.dispatch_time_off_list()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id',             r.id,
      'driver_id',      r.driver_id,
      'driver_name',    coalesce(nullif(trim(d.preferred_name), ''), d.full_name),
      'station_code',   s.code,
      'start_date',     r.start_date,
      'end_date',       r.end_date,
      'reason',         r.reason,
      'status',         r.status,
      'decision_notes', r.decision_notes,
      'decided_at',     r.decided_at,
      'created_at',     r.created_at
    )
    order by
      case r.status when 'pending' then 0 else 1 end,
      case r.status when 'pending' then r.created_at end asc,
      r.decided_at desc nulls last,
      r.created_at desc
  ), '[]'::jsonb)
  into v_rows
  from public.time_off_requests r
  join public.drivers           d on d.id = r.driver_id
  left join public.stations     s on s.id = d.station_id
  where r.dsp_id = v_dsp;

  return v_rows;
end;
$$;
grant execute on function public.dispatch_time_off_list() to authenticated;


-- ── 5. dispatch_time_off_decide · approve or deny, post chat message ──
create or replace function public.dispatch_time_off_decide(
  p_id      uuid,
  p_approve boolean,
  p_notes   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_req        public.time_off_requests;
  v_notes      text := nullif(trim(coalesce(p_notes, '')), '');
  v_status     public.time_off_status;
  v_msg        text;
  v_range_lbl  text;
begin
  if v_dsp is null then raise exception 'time_off_no_dsp_context'; end if;

  select * into v_req from public.time_off_requests
   where id = p_id and dsp_id = v_dsp;
  if v_req.id is null then
    raise exception 'time_off_not_found';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'time_off_already_decided';
  end if;

  v_status := case when p_approve then 'approved' else 'denied' end;

  update public.time_off_requests
     set status         = v_status,
         decided_by     = auth.uid(),
         decided_at     = now(),
         decision_notes = v_notes
   where id = p_id;

  -- Driver-facing message body — same formatting style as the
  -- availability_request_decide pattern (0062). A single-day request
  -- reads "May 20"; a range reads "May 20 – May 23".
  if v_req.start_date = v_req.end_date then
    v_range_lbl := to_char(v_req.start_date, 'Mon DD, YYYY');
  else
    v_range_lbl := to_char(v_req.start_date, 'Mon DD') || ' – ' ||
                   to_char(v_req.end_date,   'Mon DD, YYYY');
  end if;

  if p_approve then
    v_msg := 'Your time-off request for ' || v_range_lbl || ' is approved.'
             || coalesce(' Note: ' || v_notes, '');
  else
    v_msg := 'Your time-off request for ' || v_range_lbl || ' was not approved.'
             || coalesce(' Reason: ' || v_notes, '')
             || ' Submit a new request from the Time off page.';
  end if;

  -- Drop a dispatch→driver chat message so the existing push pipeline
  -- (trg_driver_messages_fire_push) notifies the driver and the
  -- decision shows up in their Chat history. Mirrors the
  -- availability_request_decide flow from 0062.
  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (v_req.driver_id, v_dsp, 'dispatch', auth.uid(), v_msg);

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_req.driver_id, v_dsp, now())
  on conflict (driver_id) do update set last_message_at = now();

  return jsonb_build_object(
    'id',     p_id,
    'status', v_status
  );
end;
$$;
grant execute on function public.dispatch_time_off_decide(uuid, boolean, text) to authenticated;


notify pgrst, 'reload schema';
