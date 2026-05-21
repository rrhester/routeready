-- Driver 5th-day overtime opt-in.
--
-- Drivers can flag — from the app's availability page — whether they
-- would be willing to work a 5th day when coverage is short. The
-- dashboard's driver availability card carries the same toggle. Stored
-- on drivers.metadata.availability.fifth_day_ok (boolean), so no schema
-- column is needed. The schedule page's coverage drill-down lists
-- everyone who has opted in alongside its overtime recommendation.

-- ── driver_set_fifth_day_ok — the driver toggles their own opt-in ──────
-- Modeled on driver_set_preferred_days: a free preference, no approval
-- workflow. Merges into metadata.availability without disturbing days /
-- preferred_days / earliest_start.
create or replace function public.driver_set_fifth_day_ok(p_token text, p_ok boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  v_drv := private.driver_validate_token(p_token);

  update public.drivers
     set metadata = coalesce(metadata, '{}'::jsonb)
                    || jsonb_build_object('availability',
                         coalesce(metadata -> 'availability', '{}'::jsonb)
                         || jsonb_build_object('fifth_day_ok', coalesce(p_ok, false)))
   where id = v_drv.id;

  return jsonb_build_object('fifth_day_ok', coalesce(p_ok, false));
end;
$$;
grant execute on function public.driver_set_fifth_day_ok(text, boolean) to anon, authenticated;


-- ── driver_get_availability — also surface fifth_day_ok ────────────────
-- Body identical to migration 0134 except it reads + returns the new
-- fifth_day_ok flag.
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
  v_fifth        boolean;
  v_pending      public.driver_availability_requests;
  v_last_decided public.driver_availability_requests;
  v_blackout     public.availability_blackouts;
  v_lead         int;
begin
  v_drv := private.driver_validate_token(p_token);

  v_active_days := coalesce(v_drv.metadata -> 'availability' -> 'days', '[]'::jsonb);
  v_earliest    := nullif(v_drv.metadata -> 'availability' ->> 'earliest_start', '');
  v_preferred   := coalesce(v_drv.metadata -> 'availability' -> 'preferred_days', '[]'::jsonb);
  v_fifth       := coalesce((v_drv.metadata -> 'availability' ->> 'fifth_day_ok')::boolean, false);

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
    'fifth_day_ok',    to_jsonb(v_fifth),
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


notify pgrst, 'reload schema';
