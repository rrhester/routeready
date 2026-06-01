-- 0350_coaching_push.sql
-- Push the driver whenever a coaching is added to their record.
--
-- Single source of truth: an AFTER INSERT trigger on public.coachings drops
-- a "from dispatch" chat notice (with a tap-to-review link) for any
-- driver-visible coaching — whether it was created manually, auto-fired
-- from attendance, or seeded. That driver_messages insert fires the
-- existing dispatch→driver Web Push trigger (0056/0057), so the driver gets
-- a push notification + a Messages entry + the Forms-tab badge.
--
-- The dashboard's manual-coaching code previously sent this chat DM itself;
-- that is now centralized here so every path notifies uniformly and a
-- manually-sent coaching doesn't double-notify.
--
-- Idempotent: create or replace + drop trigger if exists. The notify body
-- is wrapped in an exception block so a notification failure can never
-- block the coaching insert itself.

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
  -- Only notify on coachings the driver is allowed to see.
  if coalesce(new.driver_visible, false) is not true then
    return new;
  end if;

  begin
    -- Severity wording mirrors the dashboard composer.
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
      nullif(trim(coalesce(new.topic, '') || ' ' || v_sevword), ''),
      'New coaching'
    );

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
    -- Never block the coaching insert on a notification failure.
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
