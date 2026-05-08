-- 0087_driver_attendance_overview_blocks.sql
--
-- Driver-side attendance overview now reads from the new
-- block-shaped policy.  Returns the driver's current ladder rung
-- (instead of the legacy "warning / action" status), the actual
-- ladder the operator built (variable rung count, custom
-- thresholds, per-rung delivery + auto-fire), and per-event point
-- values so the driver app can show "each callout is worth 2
-- points" and "you're 1 point away from Final."
--
-- The legacy response shape is preserved on the `standing.status`
-- / `policy.threshold_*` fields for callers that haven't updated
-- yet, but the new fields (`standing.severity`, `standing.points`,
-- `policy.ladder`, `policy.events`) are the canonical surface.

create or replace function public.driver_attendance_overview(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv      public.drivers;
  v_dsp      public.dsps;
  v_meta     jsonb;
  v_pol      jsonb;
  v_blocks   jsonb;
  b          jsonb;
  v_decay    int    := 90;
  v_enabled  bool   := true;
  v_auto     bool   := false;
  v_ncns     bool   := false;
  v_first30  bool   := false;
  v_first30d int    := 30;
  v_pts_callout numeric := 0;
  v_pts_noshow  numeric := 0;
  v_pts_late    numeric := 0;
  v_count_callout bool := false;
  v_count_noshow  bool := false;
  v_count_late    bool := false;
  v_ladder   jsonb := '[]'::jsonb;
  v_events_out jsonb := '[]'::jsonb;
  v_since    date;
  v_tardies  int := 0;
  v_callouts int := 0;
  v_noshows  int := 0;
  v_points   numeric := 0;
  v_in_first30 bool := false;
  v_status   text;
  v_severity text := null;
  v_current_threshold numeric := null;
  v_next_severity text := null;
  v_next_threshold numeric := null;
  v_points_to_next numeric := 0;
begin
  v_drv  := private.driver_validate_token(p_token);
  select * into v_dsp from public.dsps where id = v_drv.dsp_id;
  v_meta := coalesce(v_dsp.metadata, '{}'::jsonb);
  v_pol  := coalesce(v_meta -> 'attendance' -> 'policy', '{}'::jsonb);

  v_enabled := coalesce((v_pol ->> 'policy_enabled')::bool, true);
  v_auto    := coalesce((v_pol ->> 'auto_coaching')::bool, false);

  -- Walk blocks to extract window / events / ladder / escalations.
  v_blocks := coalesce(v_pol -> 'blocks', '[]'::jsonb);
  for b in select * from jsonb_array_elements(v_blocks) loop
    if (b ->> 'type') = 'window' then
      v_decay := coalesce((b ->> 'days')::int, 90);
    elsif (b ->> 'type') = 'event' then
      if (b ->> 'kind') = 'callout' then
        v_pts_callout   := coalesce((b ->> 'points')::numeric, 0);
        v_count_callout := v_pts_callout > 0;
      elsif (b ->> 'kind') = 'no_show' then
        v_pts_noshow    := coalesce((b ->> 'points')::numeric, 0);
        v_count_noshow  := v_pts_noshow > 0;
      elsif (b ->> 'kind') = 'late' then
        v_pts_late      := coalesce((b ->> 'points')::numeric, 0);
        v_count_late    := v_pts_late > 0;
      end if;
    elsif (b ->> 'type') = 'ladder_rung' then
      v_ladder := v_ladder || jsonb_build_array(jsonb_build_object(
        'severity',  b ->> 'severity',
        'threshold', coalesce((b ->> 'threshold')::numeric, 0),
        'delivery',  coalesce(b ->> 'delivery', 'ack'),
        'auto_fire', coalesce((b ->> 'auto_fire')::bool, false)
      ));
    elsif (b ->> 'type') = 'auto_escalation' then
      if (b ->> 'kind') = 'ncns_terminates' then
        v_ncns := true;
      elsif (b ->> 'kind') = 'first_30_strict' then
        v_first30  := true;
        v_first30d := coalesce((b ->> 'days')::int, 30);
      end if;
    end if;
  end loop;

  -- Sort the ladder ascending by threshold so "highest rung at or
  -- below points" is just a linear walk.
  select coalesce(jsonb_agg(value order by (value ->> 'threshold')::numeric), '[]'::jsonb)
    into v_ladder
  from jsonb_array_elements(v_ladder);

  -- Defensive fallback: if blocks were missing (pre-0086 tenant)
  -- synthesize from legacy fields so the screen still renders.
  if jsonb_array_length(v_blocks) = 0 then
    v_decay         := coalesce((v_pol ->> 'decay_days')::int, 90);
    v_count_late    := coalesce((v_pol ->> 'count_tardy')::bool, false);
    v_count_callout := coalesce((v_pol ->> 'count_callout')::bool, true);
    v_count_noshow  := coalesce((v_pol ->> 'count_noshow')::bool, true);
    v_pts_callout   := case when v_count_callout then 1 else 0 end;
    v_pts_noshow    := case when v_count_noshow  then 1 else 0 end;
    v_pts_late      := case when v_count_late    then 1 else 0 end;
    v_first30       := coalesce((v_pol ->> 'first_30_strict')::bool, false);
    v_first30d      := coalesce((v_pol ->> 'first_30_window_days')::int, 30);
    v_ncns          := coalesce((v_pol ->> 'ncns_terminates')::bool, false);
    -- Synthetic 4-rung ladder using legacy thresholds.
    v_ladder := jsonb_build_array(
      jsonb_build_object('severity','verbal',      'threshold', coalesce((v_pol ->> 'threshold_warn')::numeric, 3), 'delivery','ack',          'auto_fire', false),
      jsonb_build_object('severity','written',     'threshold', coalesce((v_pol ->> 'threshold_warn')::numeric, 3) + 1, 'delivery','ack_and_sign', 'auto_fire', false),
      jsonb_build_object('severity','final',       'threshold', coalesce((v_pol ->> 'threshold_warn')::numeric, 3) + 2, 'delivery','ack_and_sign', 'auto_fire', false),
      jsonb_build_object('severity','termination', 'threshold', coalesce((v_pol ->> 'threshold_warn')::numeric, 3) + 3, 'delivery','ack_and_sign', 'auto_fire', false)
    );
  end if;

  v_since := current_date - v_decay;

  -- Pull event counts in the window.
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

  v_points := (v_callouts * v_pts_callout) + (v_noshows * v_pts_noshow) + (v_tardies * v_pts_late);

  -- Find the current rung (highest threshold ≤ points) and the next
  -- one above it (for the "X more points to next" forecast).
  for b in select * from jsonb_array_elements(v_ladder) loop
    if v_points >= (b ->> 'threshold')::numeric then
      v_severity          := b ->> 'severity';
      v_current_threshold := (b ->> 'threshold')::numeric;
    elsif v_next_severity is null then
      v_next_severity  := b ->> 'severity';
      v_next_threshold := (b ->> 'threshold')::numeric;
      v_points_to_next := v_next_threshold - v_points;
    end if;
  end loop;

  -- First-30-days override.
  if v_drv.hire_date is not null
     and v_first30
     and (current_date - v_drv.hire_date) <= v_first30d then
    v_in_first30 := true;
  end if;

  if not v_enabled then
    v_status := 'disabled';
  elsif v_in_first30 and (v_callouts + v_noshows) > 0 then
    v_status := 'action';
  elsif v_severity = 'termination' or v_severity = 'final' then
    v_status := 'action';
  elsif v_severity is not null then
    v_status := 'warning';
  else
    v_status := 'good';
  end if;

  -- Build events_out for the driver app to render "each X is worth Y".
  if v_count_callout or v_pts_callout > 0 then
    v_events_out := v_events_out || jsonb_build_array(jsonb_build_object('kind','callout','points', v_pts_callout));
  end if;
  if v_count_noshow or v_pts_noshow > 0 then
    v_events_out := v_events_out || jsonb_build_array(jsonb_build_object('kind','no_show','points', v_pts_noshow));
  end if;
  if v_count_late or v_pts_late > 0 then
    v_events_out := v_events_out || jsonb_build_array(jsonb_build_object('kind','late','points', v_pts_late));
  end if;

  return jsonb_build_object(
    'standing', jsonb_build_object(
      'status',           v_status,
      'severity',         v_severity,
      'points',           v_points,
      'next_severity',    v_next_severity,
      'next_threshold',   v_next_threshold,
      'points_to_next',   v_points_to_next,
      'occurrences',      v_callouts + v_noshows + v_tardies,
      'tardies',          v_tardies,
      'callouts',         v_callouts,
      'noshows',          v_noshows,
      'in_first_30_days', v_in_first30
    ),
    'policy', jsonb_build_object(
      'enabled',              v_enabled,
      'auto_coaching',        v_auto,
      'decay_days',           v_decay,
      'events',               v_events_out,
      'ladder',               v_ladder,
      'ncns_terminates',      v_ncns,
      'first_30_strict',      v_first30,
      'first_30_window_days', v_first30d
    )
  );
end;
$$;
grant execute on function public.driver_attendance_overview(text) to anon, authenticated;

notify pgrst, 'reload schema';
