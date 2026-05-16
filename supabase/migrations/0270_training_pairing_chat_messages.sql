-- Migration 0270 · Post training-pairing notifications in the driver app
--
-- 0264's tg_training_pairing_notify queues outbound SMS only. We do
-- want SMS once Twilio creds are in place, but the driver app's chat
-- is the primary, always-on dispatch channel — every driver already
-- has the conversation pinned. This adds an in-app dispatch message to
-- both the trainee and the trainer when a pairing materializes, in
-- addition to the SMS queue insert (which 0264 already does and which
-- stays correct).
--
-- Idempotency: the trigger has always been guarded by the
-- proposed→materialized status edge, so it can't double-fire from a
-- normal activation. We still skip the chat insert if a dispatch
-- message with this exact body already exists for the driver, so a
-- repaired-and-reactivated pairing doesn't spam the chat twice.

create or replace function private.tg_training_pairing_notify()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_trainee public.drivers;
  v_trainer public.drivers;
  v_date_text text;
  v_start_text text;
  v_tz text;
  v_partner_shift public.shifts;
  v_trainee_body text;
  v_trainer_body text;
begin
  -- Only fire on the proposed → materialized edge.
  if NEW.status <> 'materialized' or OLD.status = 'materialized' then
    return NEW;
  end if;

  select * into v_trainee from public.drivers where id = NEW.trainee_id;
  select * into v_trainer from public.drivers where id = NEW.trainer_id;
  if v_trainee.id is null or v_trainer.id is null then
    return NEW;
  end if;

  select coalesce((d.metadata->>'timezone'), 'America/Chicago')
    into v_tz
    from public.dsps d where d.id = NEW.dsp_id;

  select * into v_partner_shift
    from public.shifts
   where driver_id  = NEW.trainer_id
     and dsp_id     = NEW.dsp_id
     and date       = NEW.ride_along_date
     and status     = 'scheduled'
     and shift_kind = 'regular'
   order by starts_at nulls last
   limit 1;

  v_date_text := to_char(NEW.ride_along_date, 'FMDay, FMMon DD');
  v_start_text := case
    when v_partner_shift.starts_at is not null
      then to_char(v_partner_shift.starts_at at time zone v_tz, 'FMHH12:MIam')
    else ''
  end;

  v_trainee_body := 'You''re riding along with ' || v_trainer.full_name
    || ' on ' || v_date_text
    || case when v_start_text <> '' then ' starting ' || v_start_text else '' end
    || case when v_partner_shift.route_code is not null then ' · route ' || v_partner_shift.route_code else '' end
    || '. Day 1 + 2 are station training before that.';

  if v_trainer.is_trainer then
    v_trainer_body := 'You''re training ' || v_trainee.full_name
      || ' on ' || v_date_text
      || '. They''ll join you for your route — same start time.';
  else
    v_trainer_body := v_trainee.full_name || ' will ride along with you on '
      || v_date_text || ' to learn the route. Same start time as your shift.';
  end if;

  -- ── In-app driver chat (primary channel) ────────────────────────
  -- Make sure both drivers have a conversation row so the new message
  -- has a thread to land in and the dispatch inbox sorts it up. Then
  -- post the dispatch-side message, guarded against duplicate inserts
  -- if the trigger somehow refires for the same pairing.
  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_trainee.id, v_trainee.dsp_id, now())
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at,
        dsp_id          = excluded.dsp_id;
  if not exists (
    select 1 from public.driver_messages
     where driver_id   = v_trainee.id
       and sender_kind = 'dispatch'
       and body        = v_trainee_body
  ) then
    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id, body)
    values
      (v_trainee.id, v_trainee.dsp_id, 'dispatch', null, v_trainee_body);
  end if;

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_trainer.id, v_trainer.dsp_id, now())
  on conflict (driver_id) do update
    set last_message_at = excluded.last_message_at,
        dsp_id          = excluded.dsp_id;
  if not exists (
    select 1 from public.driver_messages
     where driver_id   = v_trainer.id
       and sender_kind = 'dispatch'
       and body        = v_trainer_body
  ) then
    insert into public.driver_messages
      (driver_id, dsp_id, sender_kind, sender_user_id, body)
    values
      (v_trainer.id, v_trainer.dsp_id, 'dispatch', null, v_trainer_body);
  end if;

  -- ── SMS (secondary channel · only fires once Twilio is configured) ─
  if v_trainee.phone is not null then
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (NEW.dsp_id, v_trainee.applicant_id, 'outbound', 'queued', v_trainee.phone, v_trainee_body);
  end if;
  if v_trainer.phone is not null then
    insert into public.sms_messages
      (dsp_id, applicant_id, direction, status, to_phone, body)
    values
      (NEW.dsp_id, v_trainer.applicant_id, 'outbound', 'queued', v_trainer.phone, v_trainer_body);
  end if;

  return NEW;
end;
$$;


-- Backfill: post the chat messages for any pairings that already
-- materialized but never got a chat (the SMS rows are already there;
-- the chat-message guard above prevents double-posting on re-run).
do $$
declare
  rec record;
  v_dsp_tz text;
  v_partner record;
  v_date_text text;
  v_start_text text;
  v_trainee_body text;
  v_trainer_body text;
begin
  for rec in
    select tp.*, t.full_name as trainee_name, r.full_name as trainer_name,
           r.is_trainer
      from public.training_pairings tp
      join public.drivers t on t.id = tp.trainee_id
      join public.drivers r on r.id = tp.trainer_id
     where tp.status = 'materialized'
  loop
    select coalesce((d.metadata->>'timezone'), 'America/Chicago')
      into v_dsp_tz
      from public.dsps d where d.id = rec.dsp_id;

    select starts_at, route_code into v_partner
      from public.shifts
     where driver_id  = rec.trainer_id
       and dsp_id     = rec.dsp_id
       and date       = rec.ride_along_date
       and shift_kind = 'regular'
     order by starts_at nulls last
     limit 1;

    v_date_text := to_char(rec.ride_along_date, 'FMDay, FMMon DD');
    v_start_text := case
      when v_partner.starts_at is not null
        then to_char(v_partner.starts_at at time zone v_dsp_tz, 'FMHH12:MIam')
      else ''
    end;

    v_trainee_body := 'You''re riding along with ' || rec.trainer_name
      || ' on ' || v_date_text
      || case when v_start_text <> '' then ' starting ' || v_start_text else '' end
      || case when v_partner.route_code is not null then ' · route ' || v_partner.route_code else '' end
      || '. Day 1 + 2 are station training before that.';

    if rec.is_trainer then
      v_trainer_body := 'You''re training ' || rec.trainee_name
        || ' on ' || v_date_text
        || '. They''ll join you for your route — same start time.';
    else
      v_trainer_body := rec.trainee_name || ' will ride along with you on '
        || v_date_text || ' to learn the route. Same start time as your shift.';
    end if;

    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
    values (rec.trainee_id, rec.dsp_id, now())
    on conflict (driver_id) do update
      set last_message_at = excluded.last_message_at,
          dsp_id          = excluded.dsp_id;
    if not exists (
      select 1 from public.driver_messages
       where driver_id = rec.trainee_id
         and sender_kind = 'dispatch'
         and body = v_trainee_body
    ) then
      insert into public.driver_messages
        (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values
        (rec.trainee_id, rec.dsp_id, 'dispatch', null, v_trainee_body);
    end if;

    insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
    values (rec.trainer_id, rec.dsp_id, now())
    on conflict (driver_id) do update
      set last_message_at = excluded.last_message_at,
          dsp_id          = excluded.dsp_id;
    if not exists (
      select 1 from public.driver_messages
       where driver_id = rec.trainer_id
         and sender_kind = 'dispatch'
         and body = v_trainer_body
    ) then
      insert into public.driver_messages
        (driver_id, dsp_id, sender_kind, sender_user_id, body)
      values
        (rec.trainer_id, rec.dsp_id, 'dispatch', null, v_trainer_body);
    end if;
  end loop;
end $$;


notify pgrst, 'reload schema';
