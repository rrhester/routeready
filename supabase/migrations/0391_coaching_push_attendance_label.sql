-- 0391_coaching_push_attendance_label.sql
-- Attendance coachings read "-Attendance" everywhere (dashboard chips, the
-- Report, the composer dropdown, the driver app, the signed record). This
-- carries that same distinction into the Web Push notification the driver
-- gets the moment a coaching lands.
--
-- Behavior: when new.topic = 'attendance', the spoken severity word in the
-- push body is prefixed with "attendance", so the driver reads
--   "New attendance written warning from {DSP}: {headline}."
-- instead of the topic-blind
--   "New written warning from {DSP}: {headline}."
-- Non-attendance topics are unchanged.
--
-- The prefix is applied AFTER the headline fallback is built, because that
-- fallback already concatenates the topic ("attendance written warning") —
-- prefixing v_sevword first would double it ("attendance attendance ...").
--
-- Everything else is identical to 0356. Idempotent: create or replace +
-- drop trigger if exists.

create or replace function private.fire_coaching_push()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_level    text;
  v_sevword  text;
  v_headline text;
  v_dspname  text;
  v_base     text;
  v_token    text;
  v_link     text;
  v_body     text;
begin
  if coalesce(new.driver_visible, false) is not true then
    return new;
  end if;

  begin
    v_level := lower(coalesce(new.metadata->>'level', new.severity::text, ''));
    v_sevword := case
      when v_level in ('verbal', 'verbal_attendance')  then 'coaching note'
      when v_level in ('written', 'written_attendance') then 'written warning'
      when v_level in ('final', 'final_attendance')     then 'final written warning'
      when v_level = 'termination'                      then 'termination notice'
      else 'coaching'
    end;

    select coalesce(nullif(d.name, ''), 'Dispatch'),
           coalesce(nullif(d.metadata->>'public_base_url', ''), 'https://gorouteready.com')
      into v_dspname, v_base
    from public.dsps d
    where d.id = new.dsp_id;
    v_dspname := coalesce(v_dspname, 'Dispatch');
    v_base    := coalesce(v_base, 'https://gorouteready.com');

    v_headline := coalesce(
      nullif(trim(new.summary), ''),
      -- new.topic is the coaching_topic enum — cast to text before
      -- concatenating, or COALESCE coerces '' into the enum and errors.
      nullif(trim(coalesce(new.topic::text, '') || ' ' || v_sevword), ''),
      'New coaching'
    );

    -- Attendance-topic coachings read "attendance <severity>" in the push,
    -- mirroring the dashboard/driver "-Attendance" labels (e.g.
    -- "Written-Attendance"). Applied after the headline fallback above so the
    -- topic word there isn't doubled.
    if new.topic::text = 'attendance' then
      v_sevword := 'attendance ' || v_sevword;
    end if;

    select nullif(dr.coaching_view_token::text, '')
      into v_token
    from public.drivers dr
    where dr.id = new.driver_id;
    if v_token is not null then
      v_link := rtrim(v_base, '/') || '/c/' || v_token;
    end if;

    v_body := 'New ' || v_sevword || ' from ' || v_dspname || ': ' || v_headline || '.'
      || case
           when v_link is not null then E'\n\nReview and sign here: ' || v_link
           else '  Reach out to dispatch to review and sign.'
         end;

    insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values (new.driver_id, new.dsp_id, 'dispatch', auth.uid(), v_body);

    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
      values (new.driver_id, new.dsp_id, now())
      on conflict (driver_id) do update set last_message_at = excluded.last_message_at;
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists trg_coachings_fire_push on public.coachings;
create trigger trg_coachings_fire_push
  after insert on public.coachings
  for each row execute function private.fire_coaching_push();

notify pgrst, 'reload schema';
