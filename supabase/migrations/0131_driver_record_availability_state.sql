-- Surface the latest decided availability request on driver_record so
-- the dashboard's driver-record card can show an "approved change,
-- effective <date>" note instead of looking stale.
--
-- Background: migration 0098's availability_request_decide only
-- mirrors the approved days into drivers.metadata.availability.days
-- when lead_days <= 0.  With the default 7-day lead, an approved
-- change isn't visible on the card (which reads from metadata) until
-- the effective date.  The operator approves, then sees no change,
-- and assumes the system is broken.  This adds the decided-request
-- payload to driver_record so the UI can show:
--   "Approved change · Mon Tue Wed · effective May 17 – Jun 7"
--
-- Pure additive change to the RPC's return shape; no behavior change.

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

  -- A still-pending request (driver submitted, awaiting decision).
  select jsonb_build_object(
           'id',           r.id,
           'days',         to_jsonb(r.days),
           'submitted_at', to_jsonb(r.submitted_at)
         )
    into v_avail_pending
  from public.driver_availability_requests r
  where r.driver_id = p_id and r.dsp_id = v_dsp and r.status = 'pending'
  order by r.submitted_at desc
  limit 1;

  -- The most recent DECIDED request — so the card can show whether
  -- the live metadata reflects an approved change yet, or there's an
  -- approved-but-not-yet-effective change queued.
  select jsonb_build_object(
           'id',              r.id,
           'status',          r.status,
           'days',            to_jsonb(r.days),
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
    'driver',              v_drv,
    'coachings',           v_coachings,
    'documents',           v_docs,
    'availability_pending', v_avail_pending,   -- null if none
    'availability_latest',  v_avail_latest     -- null if no decided request ever
  );
end;
$$;
grant execute on function public.driver_record(uuid) to authenticated;


-- ── Also: add `days` to last_decision in driver_get_availability ──────
-- The driver PWA shows a "request approved, effective <date>" banner;
-- it needs the approved DAYS to display them.  0098's version of this
-- function didn't include them.  This re-creates it (verbatim from
-- 0098) plus the one extra field.
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

  select coalesce(lead_days, 7) into v_lead
    from public.availability_settings
   where dsp_id = v_drv.dsp_id;
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
      'days',            to_jsonb(v_last_decided.days),       -- NEW
      'decided_at',      to_jsonb(v_last_decided.decided_at),
      'decision_note',   v_last_decided.decision_note,
      'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
      'effective_until', to_jsonb((v_last_decided.effective_until)::text)
    ) end
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;

notify pgrst, 'reload schema';
