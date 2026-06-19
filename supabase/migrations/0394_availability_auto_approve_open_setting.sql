-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0394 · gate "expansion" auto-approval on a DSP setting
--
-- driver_submit_availability (0134) auto-approves an availability request when
-- it's an EXPANSION — no currently-available day is dropped and the earliest
-- start doesn't move later ("opening up"). That behaviour was hard-wired ON.
--
-- Dispatch now exposes a yes/no toggle (Requests → Settings → Automation:
-- "Auto-approve added availability"), stored at
-- dsps.metadata.request_features.auto_approve_open. This re-defines the submit
-- function to honour it: when the flag is explicitly false, expansions go to
-- the pending queue for review like reductions do. Absent / anything but
-- 'false' ⇒ ON, so existing DSPs keep today's auto-approve behaviour.
--
-- Everything else in the function is byte-for-byte 0134.
-- ─────────────────────────────────────────────────────────────────────────

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
  v_auto_open     boolean;
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

  -- DSP toggle: auto-approve "opening up" requests? Default ON (absent / not
  -- 'false'); only an explicit false sends expansions to dispatcher review.
  select coalesce(metadata -> 'request_features' ->> 'auto_approve_open', 'true') <> 'false'
    into v_auto_open
   from public.dsps where id = v_drv.dsp_id;
  v_auto_open := coalesce(v_auto_open, true);

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

  if v_is_expansion and v_auto_open then
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

  -- Reduction / start tightened / auto-approve OFF → dispatcher review.
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
