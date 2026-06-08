-- ───────────────────────────────────────────────────────────────────────
-- 0370 · Native interview scheduling — Phase 2: booking page backend
--
--   • booking_load(token)            · branding + greeting for the page
--   • book_interview_slot(token,ts)  · books a slot into cal_events with a
--       concurrency-safe double-booking guard (advisory lock + overlap check),
--       re-validating lead time + availability server-side.
--
-- Inserting the cal_event (kind='interview') reuses everything downstream:
-- the Upcoming bookings list, and the Google Calendar sync trigger. Parallel
-- to Cal.com. Idempotent.
-- ───────────────────────────────────────────────────────────────────────

create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_cfg public.interview_config;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'already_booked', exists(
      select 1 from public.cal_events ce
      where ce.applicant_id = v_app.id and ce.kind = 'interview'
        and ce.status in ('scheduled','rescheduled')
    )
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;


create or replace function public.book_interview_slot(p_token text, p_slot_start timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_dsp uuid;
  v_cfg public.interview_config;
  v_end timestamptz;
  v_dow int;
  v_min int;
  v_event_id uuid;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  v_dsp := v_app.dsp_id;

  select * into v_cfg from public.interview_config where dsp_id = v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone := 'America/Chicago'; v_cfg.slot_minutes := 30;
    v_cfg.buffer_minutes := 0; v_cfg.min_lead_hours := 12; v_cfg.window_days := 21;
  end if;
  v_end := p_slot_start + make_interval(mins => v_cfg.slot_minutes);

  -- Lead-time re-check (don't trust the client).
  if p_slot_start < now() + make_interval(hours => v_cfg.min_lead_hours) then
    raise exception 'slot_too_soon';
  end if;

  -- The slot must fall inside an availability window for that weekday (DSP tz).
  v_dow := extract(dow  from (p_slot_start at time zone v_cfg.timezone))::int;
  v_min := (extract(hour from (p_slot_start at time zone v_cfg.timezone)) * 60
          + extract(minute from (p_slot_start at time zone v_cfg.timezone)))::int;
  if not exists (
    select 1 from public.interview_availability av
    where av.dsp_id = v_dsp and av.weekday = v_dow
      and v_min >= av.start_min and v_min + v_cfg.slot_minutes <= av.end_min
  ) then
    raise exception 'slot_unavailable';
  end if;

  -- Concurrency guard: serialize bookings for this exact (dsp, slot) so two
  -- applicants can't grab the same time. Then the overlap check is reliable.
  perform pg_advisory_xact_lock(hashtext(v_dsp::text), hashtext(p_slot_start::text));

  if exists (
    select 1 from public.cal_events ce
    where ce.dsp_id = v_dsp and ce.kind in ('interview','orientation')
      and ce.status in ('scheduled','rescheduled')
      and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at + make_interval(mins => v_cfg.slot_minutes)))
          && tstzrange(p_slot_start, v_end)
  ) then
    raise exception 'slot_taken';
  end if;

  insert into public.cal_events
    (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider)
  values
    (v_dsp, v_app.id, 'interview', 'scheduled', p_slot_start, v_end, v_cfg.timezone, v_cfg.location, 'routeready')
  returning id into v_event_id;

  update public.applicants set status = 'interview_booked', updated_at = now()
   where id = v_app.id
     and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');

  return jsonb_build_object('ok', true, 'event_id', v_event_id,
                            'starts_at', p_slot_start, 'ends_at', v_end);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz) to anon, authenticated;
