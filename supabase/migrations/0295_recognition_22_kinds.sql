-- Migration 0295 · Recognition · 22 themed celebration kinds
--
-- Adds 22 new MANUAL-send celebration kinds to recognition_send's
-- kind whitelist (and a small batch of new animation values for them):
--
--   Baby (3):
--     baby_boy, baby_girl, baby_expecting
--
--   Holidays (17):
--     holiday_new_years_day, holiday_mlk_day, holiday_valentines_day,
--     holiday_presidents_day, holiday_st_patricks_day, holiday_easter,
--     holiday_mothers_day, holiday_memorial_day, holiday_juneteenth,
--     holiday_fathers_day, holiday_independence_day, holiday_labor_day,
--     holiday_indigenous_peoples_day, holiday_halloween,
--     holiday_veterans_day, holiday_thanksgiving, holiday_christmas
--
-- These join the existing five kinds — birthday, work_anniversary,
-- safety_milestone, welcome_to_team, custom — for a total of 27.
--
-- No automation / auto-fire yet; dispatchers send manually from the
-- dashboard.  Per-kind theming (badge, gradient, palette, defaults)
-- lives on the driver app and dashboard sides — this migration only
-- updates the server-side whitelists and per-kind CTA / default-title
-- table so the RPCs accept the new kinds.
--
-- Also widens the animation whitelist with eight new symbolic values
-- (flag, flower, gift, egg, tree, leaf, star, pumpkin) used by the
-- new themes.  The driver app maps unknown animation values to a
-- sensible confetti fallback, so this is non-breaking.
--
-- Idempotent: CREATE OR REPLACE on both functions, no DDL on tables.


-- ── 1. recognition_send · accepts the 27-kind whitelist ──────────────
create or replace function public.recognition_send(
  p_driver_id    uuid,
  p_kind         text default 'custom',
  p_title        text default null,
  p_message      text default null,
  p_animation    text default 'confetti',
  p_occasion_on  date default null,
  p_scheduled_for date default null,
  p_years        int  default null,
  p_milestone_key text default null,
  p_metadata     jsonb default '{}'::jsonb
) returns public.driver_recognitions
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_row   public.driver_recognitions;
  v_title text;
  v_kind  text := coalesce(nullif(trim(p_kind), ''), 'custom');
  v_anim  text := coalesce(nullif(trim(p_animation), ''), 'confetti');
  v_today date := current_date;
  v_status text;
  v_sent_at timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_driver_id is null then
    raise exception 'driver_required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.drivers where id = p_driver_id and dsp_id = v_dsp) then
    raise exception 'driver_not_found' using errcode = 'P0002';
  end if;
  if v_kind not in (
    -- Existing five
    'birthday','work_anniversary','safety_milestone','welcome_to_team','custom',
    -- Baby (3)
    'baby_boy','baby_girl','baby_expecting',
    -- Holidays (17)
    'holiday_new_years_day','holiday_mlk_day','holiday_valentines_day',
    'holiday_presidents_day','holiday_st_patricks_day','holiday_easter',
    'holiday_mothers_day','holiday_memorial_day','holiday_juneteenth',
    'holiday_fathers_day','holiday_independence_day','holiday_labor_day',
    'holiday_indigenous_peoples_day','holiday_halloween',
    'holiday_veterans_day','holiday_thanksgiving','holiday_christmas'
  ) then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if v_anim not in (
    -- Existing animations
    'confetti','fireworks','balloons','cake','trophy','hearts','sparkle','welcome','custom',
    -- New symbolic values used by the 22 themed kinds
    'flag','flower','gift','egg','tree','leaf','star','pumpkin'
  ) then
    raise exception 'bad_animation' using errcode = '22023';
  end if;

  v_title := nullif(trim(coalesce(p_title, '')), '');
  if v_title is null then
    v_title := case v_kind
      when 'birthday'         then 'Happy birthday!'
      when 'work_anniversary' then case when p_years is null then 'Happy work anniversary!'
                                       else p_years || '-year anniversary' end
      when 'safety_milestone' then 'Safety milestone'
      when 'welcome_to_team'  then 'Welcome to the Team'
      -- Baby
      when 'baby_boy'         then 'It''s a Boy!'
      when 'baby_girl'        then 'It''s a Girl!'
      when 'baby_expecting'   then 'Congratulations!'
      -- Holidays
      when 'holiday_new_years_day'       then 'Happy New Year!'
      when 'holiday_mlk_day'             then 'Honoring Dr. King'
      when 'holiday_valentines_day'      then 'Happy Valentine''s Day!'
      when 'holiday_presidents_day'      then 'Happy Presidents'' Day'
      when 'holiday_st_patricks_day'     then 'Happy St. Patrick''s Day!'
      when 'holiday_easter'              then 'Happy Easter!'
      when 'holiday_mothers_day'         then 'Happy Mother''s Day!'
      when 'holiday_memorial_day'        then 'Memorial Day'
      when 'holiday_juneteenth'          then 'Happy Juneteenth!'
      when 'holiday_fathers_day'         then 'Happy Father''s Day!'
      when 'holiday_independence_day'    then 'Happy 4th of July!'
      when 'holiday_labor_day'           then 'Happy Labor Day!'
      when 'holiday_indigenous_peoples_day' then 'Indigenous Peoples'' Day'
      when 'holiday_halloween'           then 'Happy Halloween!'
      when 'holiday_veterans_day'        then 'Thank You, Veterans'
      when 'holiday_thanksgiving'        then 'Happy Thanksgiving!'
      when 'holiday_christmas'           then 'Merry Christmas!'
      else 'A note from your team'
    end;
  end if;

  if p_scheduled_for is null or p_scheduled_for <= v_today then
    v_status  := 'sent';
    v_sent_at := now();
  else
    v_status  := 'scheduled';
    v_sent_at := null;
  end if;

  insert into public.driver_recognitions (
    dsp_id, driver_id, kind, title, message, animation,
    occasion_on, scheduled_for, sent_at, status, years, milestone_key,
    metadata, created_by
  ) values (
    v_dsp, p_driver_id, v_kind, v_title, nullif(trim(p_message), ''),
    v_anim,
    coalesce(p_occasion_on, p_scheduled_for, v_today),
    p_scheduled_for, v_sent_at, v_status, p_years,
    nullif(trim(p_milestone_key), ''),
    coalesce(p_metadata, '{}'::jsonb),
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$$;
grant execute on function public.recognition_send(uuid, text, text, text, text, date, date, int, text, jsonb) to authenticated;


-- ── 2. driver_recognitions_pending · per-kind CTA defaults ──────────
-- Same shape as 0292 but extended with sensible CTA labels for each
-- of the 22 new kinds.  Unknown kinds still fall back to "Continue".
create or replace function public.driver_recognitions_pending(p_token text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.driver_recognitions;
  v_cta text;
  v_footer text;
begin
  -- Matches 0294: no STABLE marker (driver_validate_token writes to
  -- driver_sessions), and gate on v_drv.id rather than role so token
  -- validity is the sole condition.
  v_drv := private.driver_validate_token(p_token);
  if v_drv.id is null then return null; end if;

  select * into v_row
  from public.driver_recognitions
  where driver_id = v_drv.id
    and status = 'sent'
    and sent_at is not null
    and dismissed_at is null
  order by sent_at asc
  limit 1;

  if v_row.id is null then return null; end if;

  v_cta := coalesce(
    nullif(trim(v_row.metadata->>'cta_label'), ''),
    case v_row.kind
      when 'welcome_to_team'  then 'Start my day'
      when 'birthday'         then 'Thanks!'
      when 'work_anniversary' then 'Thanks!'
      when 'safety_milestone' then 'Keep it up'
      -- Baby
      when 'baby_boy'         then 'Thank you!'
      when 'baby_girl'        then 'Thank you!'
      when 'baby_expecting'   then 'Thank you!'
      -- Holidays
      when 'holiday_new_years_day'       then 'Cheers!'
      when 'holiday_mlk_day'             then 'Continue'
      when 'holiday_valentines_day'      then 'Thanks!'
      when 'holiday_presidents_day'      then 'Continue'
      when 'holiday_st_patricks_day'     then 'Sláinte!'
      when 'holiday_easter'              then 'Thanks!'
      when 'holiday_mothers_day'         then 'Thanks!'
      when 'holiday_memorial_day'        then 'Continue'
      when 'holiday_juneteenth'          then 'Continue'
      when 'holiday_fathers_day'         then 'Thanks!'
      when 'holiday_independence_day'    then 'Happy 4th!'
      when 'holiday_labor_day'           then 'Thanks!'
      when 'holiday_indigenous_peoples_day' then 'Continue'
      when 'holiday_halloween'           then 'Boo!'
      when 'holiday_veterans_day'        then 'Thank you'
      when 'holiday_thanksgiving'        then 'Thanks!'
      when 'holiday_christmas'           then 'Merry Christmas!'
      else 'Continue'
    end
  );
  v_footer := coalesce(
    nullif(trim(v_row.metadata->>'footer'), ''),
    'Sent by your team'
  );

  return jsonb_build_object(
    'id',          v_row.id,
    'kind',        v_row.kind,
    'title',       v_row.title,
    'message',     v_row.message,
    'animation',   v_row.animation,
    'cta_label',   v_cta,
    'footer',      v_footer,
    'years',       v_row.years,
    'metadata',    v_row.metadata,
    'sent_at',     v_row.sent_at,
    'delivered_at',v_row.delivered_at
  );
end;
$$;
grant execute on function public.driver_recognitions_pending(text) to anon, authenticated;


notify pgrst, 'reload schema';
