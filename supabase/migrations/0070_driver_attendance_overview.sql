-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0070 · Driver attendance overview
--
-- Powers the driver-PWA Tasks → Attendance screen.  Returns:
--   1. The driver's current standing — occurrences in the policy decay
--      window, status (Good standing / Warning / Action), and whether
--      they're inside the first-30-days strict window.
--   2. The DSP's full attendance policy (occurrence-based, with the new
--      master enabled/disabled flag, count-this-event toggles, NCNS-
--      terminates flag, progressive-coaching flag, thresholds, decay).
--
-- Driver-side scoring deliberately mirrors the dispatcher dashboard's
-- math so what a driver sees here can never disagree with what the
-- dispatcher sees on the Today's Plan daily tool.
-- ─────────────────────────────────────────────────────────────────────────


create or replace function public.driver_attendance_overview(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv    public.drivers;
  v_dsp    public.dsps;
  v_meta   jsonb;
  v_pol    jsonb;
  v_decay  int;
  v_warn   numeric;
  v_action numeric;
  v_count_tardy   bool;
  v_count_callout bool;
  v_count_noshow  bool;
  v_enabled       bool;
  v_first30       bool;
  v_first30_days  int;
  v_since         date;
  v_tardies       int := 0;
  v_callouts      int := 0;
  v_noshows       int := 0;
  v_occ           numeric;
  v_in_first30    bool := false;
  v_status        text;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_dsp from public.dsps where id = v_drv.dsp_id;
  v_meta := coalesce(v_dsp.metadata, '{}'::jsonb);
  v_pol  := coalesce(v_meta -> 'attendance' -> 'policy', '{}'::jsonb);

  -- Defaults match _ATT_DEFAULT_POLICY in dashboard/live.js so the two
  -- views can never drift even when the operator has never opened the
  -- Policy tab.
  v_enabled       := coalesce((v_pol ->> 'policy_enabled')::bool, true);
  v_decay         := coalesce((v_pol ->> 'decay_days')::int, 90);
  v_warn          := coalesce((v_pol ->> 'threshold_warn')::numeric, 3);
  v_action        := coalesce((v_pol ->> 'threshold_action')::numeric, 6);
  v_count_tardy   := coalesce((v_pol ->> 'count_tardy')::bool, false);
  v_count_callout := coalesce((v_pol ->> 'count_callout')::bool, true);
  v_count_noshow  := coalesce((v_pol ->> 'count_noshow')::bool, true);
  v_first30       := coalesce((v_pol ->> 'first_30_strict')::bool, false);
  v_first30_days  := coalesce((v_pol ->> 'first_30_window_days')::int, 30);
  v_since         := current_date - v_decay;

  if v_enabled then
    select
      count(*) filter (where status = 'late')                       as t,
      count(*) filter (where status = 'called_off')                 as c,
      count(*) filter (where status = 'no_show')                    as n
      into v_tardies, v_callouts, v_noshows
      from public.shifts
     where dsp_id    = v_drv.dsp_id
       and driver_id = v_drv.id
       and date     >= v_since;
  end if;

  v_occ :=
      (case when v_count_tardy   then v_tardies  else 0 end)
    + (case when v_count_callout then v_callouts else 0 end)
    + (case when v_count_noshow  then v_noshows  else 0 end);

  if v_drv.hire_date is not null
     and v_first30
     and (current_date - v_drv.hire_date) <= v_first30_days then
    v_in_first30 := true;
  end if;

  if not v_enabled then
    v_status := 'disabled';
  elsif v_in_first30 and (v_callouts + v_noshows) > 0 then
    v_status := 'action';
  elsif v_occ >= v_action then
    v_status := 'action';
  elsif v_occ >= v_warn then
    v_status := 'warning';
  else
    v_status := 'good';
  end if;

  return jsonb_build_object(
    'standing', jsonb_build_object(
      'status',           v_status,
      'occurrences',      v_occ,
      'tardies',          v_tardies,
      'callouts',         v_callouts,
      'noshows',          v_noshows,
      'in_first_30_days', v_in_first30
    ),
    'policy', jsonb_build_object(
      'enabled',              v_enabled,
      'decay_days',           v_decay,
      'threshold_warn',       v_warn,
      'threshold_action',     v_action,
      'count_tardy',          v_count_tardy,
      'count_callout',        v_count_callout,
      'count_noshow',         v_count_noshow,
      'progressive_coaching', coalesce((v_pol ->> 'progressive_coaching')::bool, true),
      'ncns_terminates',      coalesce((v_pol ->> 'ncns_terminates')::bool, false),
      'first_30_strict',      v_first30,
      'first_30_window_days', v_first30_days
    )
  );
end;
$$;
grant execute on function public.driver_attendance_overview(text) to anon, authenticated;


notify pgrst, 'reload schema';
