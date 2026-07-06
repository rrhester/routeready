-- 0421_publish_notifies_drivers.sql
-- Publishing a week's schedule now actually tells the drivers.
--
-- Until now `set_schedule_finalized` only flipped the `finalized` boolean
-- on scheduling_settings. The Finalize button says "Push this week's
-- schedule to drivers" but nothing was pushed — drivers only discovered
-- their week by happening to poll driver_my_schedule.
--
-- This makes publish real: when a week transitions from not-finalized to
-- finalized, we insert one dispatch→driver chat message per driver who is
-- scheduled that week. That reuses the existing push path
-- (trg_driver_messages_fire_push → send-driver-push edge fn, migration
-- 0056) exactly like the time-off / availability decision flows already
-- do — so drivers get a real push notification and an in-app record with
-- zero new plumbing.
--
-- We only notify on the FALSE→TRUE transition so re-saving an
-- already-finalized week doesn't spam drivers. Un-finalizing (TRUE→FALSE)
-- never notifies.
--
-- Idempotent: create or replace.

create or replace function public.set_schedule_finalized(p_week_start date, p_finalized boolean)
returns public.scheduling_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp           uuid := private.current_dsp_id();
  v_row           public.scheduling_settings;
  v_eff           public.scheduling_settings;
  v_was_finalized boolean;
  v_notify        record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- If the row doesn't exist yet, materialize from inherited settings first.
  select * into v_row from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  if not found then
    v_was_finalized := false;
    v_eff := private.get_week_settings(v_dsp, p_week_start);
    insert into public.scheduling_settings
      (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week, waves, timezone, allow_availability_override, finalized)
    values
      (v_dsp, p_week_start, v_eff.default_block_hours, v_eff.cushion_pct, v_eff.max_days_per_week, v_eff.waves, v_eff.timezone, v_eff.allow_availability_override, coalesce(p_finalized, false))
    returning * into v_row;
  else
    v_was_finalized := coalesce(v_row.finalized, false);
    update public.scheduling_settings
       set finalized = coalesce(p_finalized, false), updated_at = now()
     where dsp_id = v_dsp and week_start = p_week_start
     returning * into v_row;
  end if;

  -- Notify drivers only on a real publish (not-finalized → finalized).
  if coalesce(p_finalized, false) and not v_was_finalized then
    for v_notify in
      select driver_id,
             string_agg(dow, ', ' order by d) as days
      from (
        select distinct s.driver_id,
               s.date               as d,
               to_char(s.date, 'Dy') as dow
        from public.shifts s
        where s.dsp_id    = v_dsp
          and s.driver_id is not null
          and s.date     >= p_week_start
          and s.date     <  p_week_start + 7
          and s.status    in ('scheduled', 'completed', 'late')
      ) x
      group by driver_id
    loop
      insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values (
        v_notify.driver_id,
        v_dsp,
        'dispatch',
        auth.uid(),
        '📅 Your schedule for the week of ' || to_char(p_week_start, 'Mon FMDD') ||
        ' is posted. You''re scheduled ' || v_notify.days ||
        '. Open RouteReady to see your times.'
      );
    end loop;
  end if;

  return v_row;
end;
$$;
grant execute on function public.set_schedule_finalized(date, boolean) to authenticated;

notify pgrst, 'reload schema';
