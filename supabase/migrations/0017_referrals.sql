-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0017 · Referrals program
--
-- Live referral wiring:
--
--   • dsps.metadata.referrals jsonb
--       { enabled, send_weeks_after_hire, payout_cents }
--     Replaces the static mockup settings panel.
--
--   • drivers.referral_token text (unique per DSP)
--     drivers.referral_sms_sent_at timestamptz
--     A per-driver token used in the public referral URL so we can
--     attribute the resulting applicant back to the driver who shared
--     the link.
--
--   • Public RPC: intake_referral(p_token, p_payload)
--     Anon-callable; verifies the token, calls intake_applicant with
--     referrer_driver_id baked in.
--
--   • Operator RPCs:
--       referral_settings_save(jsonb)
--       referral_leaderboard()  → top referrers + counts
--       referral_summary()      → KPIs
--       send_referral_link(driver_id?)  → manual single-driver send
--       send_referral_campaign()        → blast all active drivers
--
--   • Service-role RPC: dispatch_referral_invites_due()
--     Called by pg_cron daily. Sends to every driver hired exactly N
--     weeks ago who hasn't been sent yet (where N comes from settings).
-- ─────────────────────────────────────────────────────────────────────────

-- Per-driver referral token (per-tenant unique).
alter table public.drivers
  add column if not exists referral_token        text,
  add column if not exists referral_sms_sent_at  timestamptz;

create unique index if not exists drivers_referral_token_unique
  on public.drivers (dsp_id, referral_token)
  where referral_token is not null;


-- Default settings on the demo DSP.
update public.dsps
   set metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                       'referrals',
                       coalesce(metadata->'referrals', '{}'::jsonb)
                       || jsonb_build_object(
                            'enabled',                 false,
                            'send_weeks_after_hire',   4,
                            'payout_cents',            15000  -- $150
                          )
                     )
 where short_code = 'DEMO'
   and (metadata->'referrals') is null;


-- SMS template for the referral invite (idempotent upsert).
insert into public.message_templates (dsp_id, channel, key, name, body)
values
  ('00000000-0000-0000-0000-00000000d000', 'sms', 'driver.referral_invite',
   'Referral invite (driver)',
   'Hey {{first_name}} — refer a friend to RouteReady and earn a bonus when they get hired. Your link: {{link}}  Reply STOP to opt out.')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, updated_at = now();


-- ─── Helpers ─────────────────────────────────────────────────────────────

create or replace function private.driver_referral_link(p_driver public.drivers)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_base text;
begin
  select coalesce(metadata->>'public_base_url', 'https://gorouteready.com')
    into v_base
  from public.dsps where id = p_driver.dsp_id;
  return v_base || '/dashboard/refer.html?r=' || coalesce(p_driver.referral_token, '');
end;
$$;


create or replace function private.upsert_driver_referral_token(p_driver_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_existing text;
begin
  select referral_token into v_existing from public.drivers where id = p_driver_id;
  if v_existing is not null then
    return v_existing;
  end if;
  v_token := replace(gen_random_uuid()::text, '-', '');
  update public.drivers set referral_token = v_token where id = p_driver_id;
  return v_token;
end;
$$;


-- ─── Public · intake_referral ────────────────────────────────────────────

create or replace function public.intake_referral(p_token text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv  public.drivers;
  v_app  public.applicants;
  v_full text := coalesce(p_payload->>'full_name',
                          trim(coalesce(p_payload->>'first_name','') || ' ' || coalesce(p_payload->>'last_name','')));
begin
  select * into v_drv from public.drivers where referral_token = p_token limit 1;
  if v_drv.id is null then raise exception 'invalid_referral_token'; end if;

  if v_full is null or v_full = '' then raise exception 'full_name_required'; end if;
  if (p_payload->>'phone') is null and (p_payload->>'email') is null then
    raise exception 'contact_required';
  end if;

  -- Reuse intake_applicant for dedup + insert. Pass dsp short_code by
  -- looking it up from the driver's dsp.
  declare
    v_short text;
    v_meta_payload jsonb := p_payload
      || jsonb_build_object('source', 'referral')
      || jsonb_build_object('dsp_short_code', '');
  begin
    select short_code into v_short from public.dsps where id = v_drv.dsp_id;
    v_meta_payload := jsonb_set(v_meta_payload, '{dsp_short_code}', to_jsonb(v_short));
    v_app := public.intake_applicant(v_meta_payload);
  end;

  -- Stamp the referrer.
  update public.applicants
     set referrer_driver_id = v_drv.id
   where id = v_app.id and referrer_driver_id is null;

  return jsonb_build_object(
    'applicant_id', v_app.id,
    'referrer',     jsonb_build_object('id', v_drv.id, 'full_name', v_drv.full_name)
  );
end;
$$;
grant execute on function public.intake_referral(text, jsonb) to anon, authenticated;


-- For the public landing page: look up referrer's name by token (no PII).
create or replace function public.referrer_lookup(p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case when d.id is not null
    then jsonb_build_object('full_name', d.full_name, 'first_name', d.first_name)
    else jsonb_build_object('error', 'invalid_or_expired_token')
  end
  from (select 1) one
  left join public.drivers d on d.referral_token = p_token
  limit 1;
$$;
grant execute on function public.referrer_lookup(text) to anon, authenticated;


-- ─── Operator-facing RPCs ───────────────────────────────────────────────

create or replace function public.referral_summary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with my as (select private.current_dsp_id() as dsp_id),
       d   as (select * from public.dsps where id = (select dsp_id from my)),
       a_active as (
         select count(*)::int as n from public.applicants
         where dsp_id = (select dsp_id from my)
           and referrer_driver_id is not null
           and status not in ('hired','rejected','no_show','not_hired','auto_declined')
       ),
       a_hired as (
         select count(*)::int as n from public.applicants
         where dsp_id = (select dsp_id from my)
           and referrer_driver_id is not null
           and status = 'hired'
       )
  select jsonb_build_object(
    'active',    (select n from a_active),
    'hired',     (select n from a_hired),
    'enabled',   coalesce((d.metadata->'referrals'->>'enabled')::boolean, false),
    'weeks',     coalesce((d.metadata->'referrals'->>'send_weeks_after_hire')::int, 4),
    'payout_cents', coalesce((d.metadata->'referrals'->>'payout_cents')::int, 0)
  )
  from d;
$$;
grant execute on function public.referral_summary() to authenticated;


create or replace function public.referral_leaderboard()
returns table (
  driver_id    uuid,
  full_name    text,
  hired_count  bigint,
  active_count bigint,
  link         text
)
language plpgsql
stable
security definer
set search_path = ''
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
    count(*) filter (where a.status = 'hired')::bigint,
    count(*) filter (where a.status not in ('hired','rejected','no_show','not_hired','auto_declined'))::bigint,
    case when d.referral_token is not null
      then v_base || '/dashboard/refer.html?r=' || d.referral_token
      else null
    end
  from public.drivers d
  left join public.applicants a
    on a.referrer_driver_id = d.id and a.dsp_id = v_dsp
  where d.dsp_id = v_dsp
  group by d.id, d.full_name, d.referral_token
  having count(*) > 0
  order by hired_count desc, active_count desc
  limit 25;
end;
$$;
grant execute on function public.referral_leaderboard() to authenticated;


create or replace function public.referral_settings_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_new jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  update public.dsps
     set metadata = jsonb_set(
       coalesce(metadata, '{}'::jsonb),
       '{referrals}',
       coalesce(metadata->'referrals', '{}'::jsonb)
       || jsonb_build_object(
            'enabled',               coalesce((p_payload->>'enabled')::boolean, false),
            'send_weeks_after_hire', coalesce((p_payload->>'weeks')::int, 4),
            'payout_cents',          coalesce((p_payload->>'payout_cents')::int, 0)
          ),
       true
     )
   where id = v_dsp
   returning metadata->'referrals' into v_new;

  return v_new;
end;
$$;
grant execute on function public.referral_settings_save(jsonb) to authenticated;


create or replace function public.send_referral_link(p_driver_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_token text;
  v_link  text;
  v_msg   record;
  v_sms_id uuid;
  v_email_id uuid;
  v_channel text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found'; end if;
  if v_drv.phone is null and v_drv.email is null then
    raise exception 'driver_has_no_contact';
  end if;

  v_token := private.upsert_driver_referral_token(v_drv.id);
  v_drv.referral_token := v_token;
  v_link  := private.driver_referral_link(v_drv);

  if v_drv.phone is not null then
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'driver.referral_invite',
      jsonb_build_object('first_name', coalesce(v_drv.first_name, v_drv.full_name), 'link', v_link)
    );
    insert into public.sms_messages (dsp_id, direction, status, to_phone, body)
    values (v_dsp, 'outbound', 'queued', v_drv.phone, v_msg.body)
    returning id into v_sms_id;
    v_channel := 'sms';
  else
    select * into v_msg from private.render_template(
      v_dsp, 'sms', 'driver.referral_invite',
      jsonb_build_object('first_name', coalesce(v_drv.first_name, v_drv.full_name), 'link', v_link)
    );
    insert into public.email_messages
      (dsp_id, direction, status, to_email, subject, body_text)
    values
      (v_dsp, 'outbound', 'queued', v_drv.email, 'Refer a friend to RouteReady', v_msg.body)
    returning id into v_email_id;
    v_channel := 'email';
  end if;

  update public.drivers
     set referral_sms_sent_at = now()
   where id = v_drv.id;

  return jsonb_build_object('channel', v_channel, 'driver_id', v_drv.id, 'link', v_link);
end;
$$;
grant execute on function public.send_referral_link(uuid) to authenticated;


create or replace function public.send_referral_campaign()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_count int := 0;
  r record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  for r in
    select id from public.drivers
     where dsp_id = v_dsp
       and status in ('active','onboarding')
       and (phone is not null or email is not null)
  loop
    perform public.send_referral_link(r.id);
    v_count := v_count + 1;
  end loop;

  return jsonb_build_object('sent', v_count);
end;
$$;
grant execute on function public.send_referral_campaign() to authenticated;


-- ─── Cron · auto-invite drivers N weeks after hire ──────────────────────

create or replace function public.dispatch_referral_invites_due()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
  v_sent int := 0;
begin
  for r in
    select d.id, d.dsp_id
      from public.drivers d
      join public.dsps dsps on dsps.id = d.dsp_id
     where d.referral_sms_sent_at is null
       and (dsps.metadata->'referrals'->>'enabled')::boolean is true
       and d.hire_date <= current_date
                          - make_interval(weeks => coalesce((dsps.metadata->'referrals'->>'send_weeks_after_hire')::int, 4))
       and (d.phone is not null or d.email is not null)
  loop
    -- Inline the send (we can't call the staff-gated version because no
    -- session). Reuse the same body.
    declare
      v_drv public.drivers;
      v_token text;
      v_link text;
      v_msg record;
    begin
      select * into v_drv from public.drivers where id = r.id;
      v_token := private.upsert_driver_referral_token(v_drv.id);
      v_drv.referral_token := v_token;
      v_link := private.driver_referral_link(v_drv);

      select * into v_msg from private.render_template(
        v_drv.dsp_id, 'sms', 'driver.referral_invite',
        jsonb_build_object('first_name', coalesce(v_drv.first_name, v_drv.full_name), 'link', v_link)
      );

      if v_drv.phone is not null then
        insert into public.sms_messages (dsp_id, direction, status, to_phone, body)
        values (v_drv.dsp_id, 'outbound', 'queued', v_drv.phone, v_msg.body);
      else
        insert into public.email_messages
          (dsp_id, direction, status, to_email, subject, body_text)
        values
          (v_drv.dsp_id, 'outbound', 'queued', v_drv.email, 'Refer a friend to RouteReady', v_msg.body);
      end if;

      update public.drivers set referral_sms_sent_at = now() where id = v_drv.id;
      v_sent := v_sent + 1;
    end;
  end loop;

  return v_sent;
end;
$$;
-- Service-role only — no grant.


-- Daily at 13:00 UTC (~9 AM ET / 6 AM PT) — well outside quiet hours
-- in any US zone. Idempotent reschedule.
do $$
begin
  perform cron.unschedule('dispatch-referral-invites-daily');
exception when others then
  -- doesn't exist yet; that's fine
  null;
end $$;

select cron.schedule(
  'dispatch-referral-invites-daily',
  '0 13 * * *',
  $$select public.dispatch_referral_invites_due();$$
);
