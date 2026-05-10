-- Auto-approve availability requests that only ADD days.
--
-- Background: every availability change a driver submits currently lands
-- in the dispatcher's pending queue, even when the driver is *widening*
-- their availability (e.g. Mon–Wed → Mon–Sun).  Opening up has no
-- coverage downside — there's nothing for a dispatcher to weigh — so
-- making them wait for a manual approval is pure friction.
--
-- New behavior in driver_submit_availability:
--   • If the requested day set is a SUPERSET of the driver's currently
--     effective days (no day removed), the request is approved on the
--     spot: status 'approved', effective_from = today, the live
--     drivers.metadata.availability.days is updated immediately, and any
--     still-pending request for that driver is resolved into this one.
--   • If the driver REMOVES at least one currently-available day, nothing
--     changes — it goes to the dispatcher as a pending request, exactly
--     as before.
--
-- Auto-approvals are recorded as normal approved rows (decided_by null,
-- a system decision_note) so they still show up in the dispatcher's
-- recently-decided list and in availability_request_history.

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
  v_drv          public.drivers;
  v_valid_keys   text[] := array['mon','tue','wed','thu','fri','sat','sun'];
  v_days         text[];
  v_id           uuid;
  v_blackout     public.availability_blackouts;
  v_current      text[];
  v_is_expansion boolean;
  v_eff_from     date := current_date;
  v_eff_until    date := current_date + 21;
  v_meta         jsonb;
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

  -- Normalize: dedupe, keep only valid keys, order Mon→Sun.
  with d as (select unnest(coalesce(p_days, '{}'::text[])) k)
  select array_agg(k order by array_position(v_valid_keys, k))
    into v_days
   from (select distinct k from d where k = any(v_valid_keys)) x;
  v_days := coalesce(v_days, '{}'::text[]);

  -- The driver's currently effective availability.
  v_current := public.driver_effective_days_on(v_drv.id, current_date);

  -- Expansion = every currently-available day is still present in the
  -- new set (nothing dropped).  Empty current set is trivially a subset.
  v_is_expansion := not exists (
    select 1 from unnest(v_current) c where c <> all(v_days)
  );

  if v_is_expansion then
    -- Resolve a still-pending request into this approval if one exists…
    update public.driver_availability_requests
       set days            = v_days,
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
        (driver_id, dsp_id, days, status, submitted_at,
         decided_at, decided_by, decision_note, effective_from, effective_until)
      values
        (v_drv.id, v_drv.dsp_id, v_days, 'approved', now(),
         now(), null, 'Auto-approved · driver added availability', v_eff_from, v_eff_until)
      returning id into v_id;
    end if;

    -- Mirror to live metadata so the driver record card and the PWA
    -- reflect the new days immediately (the change is effective today).
    v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
              || jsonb_build_object('availability', jsonb_build_object('days', to_jsonb(v_days)));
    update public.drivers set metadata = v_meta where id = v_drv.id;

    return jsonb_build_object(
      'id',             v_id,
      'days',           to_jsonb(v_days),
      'status',         'approved',
      'auto_approved',  true,
      'effective_from', to_jsonb(v_eff_from::text)
    );
  end if;

  -- Removing a currently-available day → dispatcher review, as before.
  insert into public.driver_availability_requests
    (driver_id, dsp_id, days, status, submitted_at)
  values
    (v_drv.id, v_drv.dsp_id, v_days, 'pending', now())
  on conflict (driver_id) where status = 'pending'
  do update set days = excluded.days, submitted_at = now()
  returning id into v_id;

  return jsonb_build_object(
    'id',            v_id,
    'days',          to_jsonb(v_days),
    'status',        'pending',
    'auto_approved', false
  );
end;
$$;
grant execute on function public.driver_submit_availability(text, text[]) to anon, authenticated;

notify pgrst, 'reload schema';
