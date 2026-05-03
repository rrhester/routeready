-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0037 · referral_leaderboard fix + scheduling_settings.finalized
--
-- 1. The leaderboard left-joined applicants and used `having count(*) > 0`,
--    which is always true because the join still produces a row when no
--    applicants match. Switch to `count(a.id)` so only drivers with at
--    least one actual referral are returned.
--
-- 2. Add `finalized` boolean to scheduling_settings so a week can be
--    locked from accidental edits once it's been pushed to drivers.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function public.referral_leaderboard()
returns table (
  driver_id    uuid,
  full_name    text,
  hired_count  bigint,
  active_count bigint,
  link         text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_base text;
begin
  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base from public.dsps where id = v_dsp;

  return query
  select
    d.id,
    d.full_name,
    count(a.id) filter (where a.status = 'hired')::bigint,
    count(a.id) filter (where a.status not in ('hired','rejected','no_show','not_hired','auto_declined'))::bigint,
    case when d.referral_token is not null
      then v_base || '/dashboard/refer.html?r=' || d.referral_token
      else null
    end
  from public.drivers d
  left join public.applicants a
    on a.referrer_driver_id = d.id and a.dsp_id = v_dsp
  where d.dsp_id = v_dsp
  group by d.id, d.full_name, d.referral_token
  having count(a.id) > 0
  order by hired_count desc, active_count desc
  limit 25;
end;
$$;
grant execute on function public.referral_leaderboard() to authenticated;


alter table public.scheduling_settings
  add column if not exists finalized boolean not null default false;


create or replace function public.scheduling_settings_for_week(p_week_start date)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_exact public.scheduling_settings;
  v_eff   public.scheduling_settings;
  v_inherited boolean;
begin
  v_eff := private.get_week_settings(v_dsp, p_week_start);
  select * into v_exact from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  v_inherited := not found;
  return jsonb_build_object(
    'week_start',                   v_eff.week_start,
    'default_block_hours',          v_eff.default_block_hours,
    'cushion_pct',                  v_eff.cushion_pct,
    'max_days_per_week',            v_eff.max_days_per_week,
    'waves',                        v_eff.waves,
    'timezone',                     v_eff.timezone,
    'allow_availability_override',  v_eff.allow_availability_override,
    'finalized',                    coalesce(v_exact.finalized, false),
    'is_inherited',                 v_inherited
  );
end;
$$;
grant execute on function public.scheduling_settings_for_week(date) to authenticated;


create or replace function public.set_schedule_finalized(p_week_start date, p_finalized boolean)
returns public.scheduling_settings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.scheduling_settings;
  v_eff public.scheduling_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- If the row doesn't exist yet, materialize from inherited settings first.
  select * into v_row from public.scheduling_settings
   where dsp_id = v_dsp and week_start = p_week_start;
  if not found then
    v_eff := private.get_week_settings(v_dsp, p_week_start);
    insert into public.scheduling_settings
      (dsp_id, week_start, default_block_hours, cushion_pct, max_days_per_week, waves, timezone, allow_availability_override, finalized)
    values
      (v_dsp, p_week_start, v_eff.default_block_hours, v_eff.cushion_pct, v_eff.max_days_per_week, v_eff.waves, v_eff.timezone, v_eff.allow_availability_override, coalesce(p_finalized, false))
    returning * into v_row;
  else
    update public.scheduling_settings
       set finalized = coalesce(p_finalized, false), updated_at = now()
     where dsp_id = v_dsp and week_start = p_week_start
     returning * into v_row;
  end if;
  return v_row;
end;
$$;
grant execute on function public.set_schedule_finalized(date, boolean) to authenticated;
