-- ─────────────────────────────────────────────────────────────────────────
-- 0498 · Reliability & safety (calendar 100-list #83–#89)
--
--  • #83 cal_event_audit: per-event history (created / time / status /
--    details / candidate confirmations), written by trigger, read via a
--    staff-gated RPC for the reading pane's History view.
--  • #85 Booking idempotency: double-submitting the SAME slot returns the
--    original booking instead of erroring 'already_booked'.
--  • #86 Rate limiting on the public booking RPC (per-applicant, in SQL)
--    + config-gated Cloudflare Turnstile CAPTCHA: the booking-captcha
--    edge function verifies the widget token and mints a short-lived
--    HMAC proof book_interview_slot checks when the governing schedule
--    sets require_captcha. Without TURNSTILE_* config, nothing changes.
--  • #87 calendar_schema_version(): one probe the dashboard can call to
--    tell the operator which calendar migrations are missing, replacing
--    scattered per-feature fallback toasts.
--  • #88 Google drift reconciliation: daily cron fires the
--    google-calendar-reconcile edge function (config-gated by the same
--    sync token) which re-pushes events that drifted or vanished on the
--    Google side — RouteReady stays the source of truth.
--  • #89 Booking-link control: staff RPCs to read and to REGENERATE an
--    applicant's booking link (kills a leaked/forwarded link instantly).
--
-- Idempotent.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 0 · schema-version probe (#87) ───────────────────────────────────────

create or replace function public.calendar_schema_version()
returns int language sql stable as $$ select 498; $$;
grant execute on function public.calendar_schema_version() to authenticated;

-- ── 1 · per-event audit trail (#83) ──────────────────────────────────────

create table if not exists public.cal_event_audit (
  id           bigint generated always as identity primary key,
  cal_event_id uuid not null references public.cal_events(id) on delete cascade,
  dsp_id       uuid not null,
  at           timestamptz not null default now(),
  actor        uuid,                     -- auth.uid(); null for candidate/system paths
  action       text not null,
  detail       jsonb
);
create index if not exists cal_event_audit_event_idx on public.cal_event_audit (cal_event_id, at desc);
alter table public.cal_event_audit enable row level security;
-- No policies: read through the staff-gated RPC below only.

create or replace function private.audit_cal_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_action text := null;
  v_detail jsonb := '{}'::jsonb;
begin
  if tg_op = 'INSERT' then
    v_action := 'created';
    v_detail := jsonb_build_object('status', new.status, 'starts_at', new.starts_at, 'kind', new.kind);
  else
    if old.starts_at is distinct from new.starts_at or old.ends_at is distinct from new.ends_at then
      v_action := 'time_changed';
      v_detail := v_detail || jsonb_build_object(
        'from', jsonb_build_object('starts_at', old.starts_at, 'ends_at', old.ends_at),
        'to',   jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at));
    end if;
    if old.status is distinct from new.status then
      v_action := coalesce(v_action, 'status_changed');
      v_detail := v_detail || jsonb_build_object('status_from', old.status, 'status_to', new.status);
    end if;
    if old.location is distinct from new.location
       or old.meeting_url is distinct from new.meeting_url
       or (old.metadata->>'title') is distinct from (new.metadata->>'title') then
      v_action := coalesce(v_action, 'details_changed');
    end if;
    if (old.metadata->>'confirmed_at') is distinct from (new.metadata->>'confirmed_at')
       and new.metadata->>'confirmed_at' is not null then
      v_action := coalesce(v_action, 'candidate_confirmed');
    end if;
    if (old.metadata->'running_late') is distinct from (new.metadata->'running_late')
       and new.metadata->'running_late' is not null then
      v_action := coalesce(v_action, 'running_late');
    end if;
    -- Sync-status churn and other untracked writes stay out of the trail.
    if v_action is null then return new; end if;
  end if;

  begin
    insert into public.cal_event_audit (cal_event_id, dsp_id, actor, action, detail)
    values (new.id, new.dsp_id, auth.uid(), v_action, nullif(v_detail, '{}'::jsonb));
  exception when others then
    null;   -- auditing must never block the write it observes
  end;
  return new;
end; $$;

drop trigger if exists trg_cal_events_audit on public.cal_events;
create trigger trg_cal_events_audit
  after insert or update on public.cal_events
  for each row execute function private.audit_cal_events();

create or replace function public.calendar_event_audit(p_event_id uuid)
returns table (at timestamptz, actor_name text, action text, detail jsonb)
language sql stable security definer set search_path = '' as $$
  select a.at,
         coalesce(u.full_name, u.email,
                  case when a.actor is null then 'Candidate / system' else 'Staff' end),
         a.action, a.detail
  from public.cal_event_audit a
  join public.cal_events ce on ce.id = a.cal_event_id
  left join public.app_users u on u.id = a.actor
  where a.cal_event_id = p_event_id
    and ce.dsp_id = private.current_dsp_id()
    and private.is_staff(ce.dsp_id, 'dispatcher')
  order by a.at desc
  limit 100;
$$;
grant execute on function public.calendar_event_audit(uuid) to authenticated;

-- ── 2 · booking rate limit (#86a) ────────────────────────────────────────

create table if not exists public.booking_rate_events (
  applicant_id uuid not null,
  action       text not null,
  at           timestamptz not null default now()
);
create index if not exists booking_rate_events_idx on public.booking_rate_events (applicant_id, action, at);
alter table public.booking_rate_events enable row level security;

-- Sliding-window counter: true = allowed (and the attempt is recorded).
create or replace function private.booking_rate_ok(
  p_applicant uuid, p_action text, p_max int, p_window interval)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  delete from public.booking_rate_events
    where applicant_id = p_applicant and action = p_action and at < now() - p_window;
  select count(*) into v_n from public.booking_rate_events
    where applicant_id = p_applicant and action = p_action;
  if v_n >= p_max then return false; end if;
  insert into public.booking_rate_events (applicant_id, action) values (p_applicant, p_action);
  return true;
end; $$;

-- ── 3 · config-gated CAPTCHA (#86b) ──────────────────────────────────────

alter table public.interview_schedules add column if not exists require_captcha boolean not null default false;

-- Self-provisioned signing key shared by SQL and the booking-captcha edge
-- function (which reads it via captcha_mint, service-role only).
insert into private.integration_settings (key, value)
values ('captcha_signing_key', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (key) do nothing;

-- proof = '<unix-exp>.<hex hmac-sha256(applicant || "." || exp, key)>'
create or replace function private.captcha_ok(p_applicant uuid, p_proof text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_secret text; v_exp bigint; v_calc text;
begin
  select value into v_secret from private.integration_settings where key = 'captcha_signing_key';
  if v_secret is null then return true; end if;   -- unprovisioned ⇒ gate off
  if p_proof is null or p_proof !~ '^[0-9]{10,12}\.[0-9a-f]{64}$' then return false; end if;
  v_exp := split_part(p_proof, '.', 1)::bigint;
  if to_timestamp(v_exp) < now() then return false; end if;
  v_calc := encode(extensions.hmac(
    (p_applicant::text || '.' || v_exp::text)::bytea, v_secret::bytea, 'sha256'), 'hex');
  return v_calc = split_part(p_proof, '.', 2);
exception when others then
  return false;
end; $$;

-- Minted ONLY by the booking-captcha edge function after it verified the
-- Turnstile token with Cloudflare. Service-role only.
create or replace function public.captcha_mint(p_token text)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants;
  v_secret text;
  v_exp bigint := extract(epoch from now() + interval '10 minutes')::bigint;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode = 'P0002'; end if;
  select value into v_secret from private.integration_settings where key = 'captcha_signing_key';
  if v_secret is null then raise exception 'not_configured'; end if;
  return v_exp::text || '.' || encode(extensions.hmac(
    (v_app.id::text || '.' || v_exp::text)::bytea, v_secret::bytea, 'sha256'), 'hex');
end; $$;
revoke execute on function public.captcha_mint(text) from public, anon, authenticated;
grant execute on function public.captcha_mint(text) to service_role;

-- Editor writes require_captcha through p_extra (0495 body + the new key).
create or replace function public.interview_schedule_save(
  p_id uuid, p_name text, p_timezone text, p_slot_minutes int, p_buffer_minutes int,
  p_min_lead_hours int, p_window_days int, p_location text, p_windows jsonb, p_make_active boolean default false,
  p_extra jsonb default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_dsp uuid := private.current_dsp_id(); v_id uuid := p_id; w jsonb;
begin
  if v_dsp is null then raise exception 'no_dsp'; end if;
  if v_id is null then
    insert into public.interview_schedules
      (dsp_id, name, timezone, slot_minutes, buffer_minutes, min_lead_hours, window_days, location, is_active, sort_order)
    values (v_dsp, coalesce(nullif(btrim(p_name),''),'Interview'), coalesce(p_timezone,'America/Chicago'),
            greatest(p_slot_minutes,5), greatest(p_buffer_minutes,0), greatest(p_min_lead_hours,0), greatest(p_window_days,1), p_location,
            coalesce(p_make_active,false) or not exists (select 1 from public.interview_schedules where dsp_id=v_dsp),
            coalesce((select max(sort_order)+1 from public.interview_schedules where dsp_id=v_dsp), 0))
    returning id into v_id;
  else
    update public.interview_schedules set
      name=coalesce(nullif(btrim(p_name),''),name), timezone=coalesce(p_timezone,timezone),
      slot_minutes=greatest(p_slot_minutes,5), buffer_minutes=greatest(p_buffer_minutes,0),
      min_lead_hours=greatest(p_min_lead_hours,0), window_days=greatest(p_window_days,1), location=p_location, updated_at=now()
    where id=v_id and dsp_id=v_dsp;
    if not found then raise exception 'schedule_not_found'; end if;
  end if;
  if p_extra is not null then
    update public.interview_schedules set
      branding             = case when p_extra ? 'branding' then coalesce(p_extra->'branding', '{}'::jsonb) else branding end,
      arrival_notes        = case when p_extra ? 'arrival_notes' then nullif(btrim(p_extra->>'arrival_notes'), '') else arrival_notes end,
      intake_questions     = case when p_extra ? 'intake_questions' then coalesce(p_extra->'intake_questions', '[]'::jsonb) else intake_questions end,
      require_phone_verify = case when p_extra ? 'require_phone_verify' then coalesce((p_extra->>'require_phone_verify')::boolean, false) else require_phone_verify end,
      offer_public         = case when p_extra ? 'offer_public' then coalesce((p_extra->>'offer_public')::boolean, false) else offer_public end,
      max_per_day          = case when p_extra ? 'max_per_day' then nullif(coalesce((p_extra->>'max_per_day')::int, 0), 0) else max_per_day end,
      interviewer_pool     = case when p_extra ? 'interviewer_pool' then coalesce(p_extra->'interviewer_pool', '[]'::jsonb) else interviewer_pool end,
      min_cancel_hours     = case when p_extra ? 'min_cancel_hours' then greatest(coalesce((p_extra->>'min_cancel_hours')::int, 0), 0) else min_cancel_hours end,
      max_self_reschedules = case when p_extra ? 'max_self_reschedules' then greatest(coalesce((p_extra->>'max_self_reschedules')::int, 0), 0) else max_self_reschedules end,
      nudge_after_days     = case when p_extra ? 'nudge_after_days' then greatest(coalesce((p_extra->>'nudge_after_days')::int, 0), 0) else nudge_after_days end,
      require_captcha      = case when p_extra ? 'require_captcha' then coalesce((p_extra->>'require_captcha')::boolean, false) else require_captcha end
    where id=v_id and dsp_id=v_dsp;
  end if;
  delete from public.interview_schedule_windows where schedule_id=v_id;
  for w in select * from jsonb_array_elements(coalesce(p_windows,'[]'::jsonb)) loop
    insert into public.interview_schedule_windows (schedule_id, weekday, start_min, end_min, capacity)
    values (v_id, (w->>'weekday')::int, (w->>'start_min')::int, (w->>'end_min')::int, greatest(coalesce((w->>'capacity')::int,1),1));
  end loop;
  if coalesce(p_make_active,false) then
    update public.interview_schedules set is_active=(id=v_id) where dsp_id=v_dsp;
  end if;
  perform private.iv_mirror_active(v_dsp);
  return v_id;
end; $$;
grant execute on function public.interview_schedule_save(uuid,text,text,int,int,int,int,text,jsonb,boolean,jsonb) to authenticated;

-- booking_load: 0497 body + captcha surface (per-option require_captcha and
-- the Turnstile site key when any offered schedule needs it).
create or replace function public.booking_load(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_app    public.applicants;
  v_dsp    public.dsps;
  v_cfg    public.interview_config;
  v_sched  public.interview_schedules;
  v_booked public.cal_events;
  v_sitekey text;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  select * into v_dsp from public.dsps where id = v_app.dsp_id;
  select * into v_cfg from public.interview_config where dsp_id = v_app.dsp_id;
  select * into v_sched from public.interview_schedules
    where dsp_id = v_app.dsp_id and is_active limit 1;
  select * into v_booked from public.cal_events ce
    where ce.applicant_id = v_app.id and ce.kind = 'interview'
      and ce.status in ('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  if exists (select 1 from public.interview_schedules s
              where s.dsp_id = v_app.dsp_id and (s.is_active or s.offer_public)
                and coalesce(s.require_captcha, false)) then
    select value into v_sitekey from private.integration_settings where key = 'turnstile_site_key';
  end if;
  return jsonb_build_object(
    'dsp', jsonb_build_object('name', v_dsp.name, 'short_code', v_dsp.short_code),
    'applicant', jsonb_build_object('first_name', v_app.first_name, 'full_name', v_app.full_name),
    'timezone', coalesce(v_cfg.timezone, v_dsp.timezone, 'America/Chicago'),
    'slot_minutes', coalesce(v_cfg.slot_minutes, 30),
    'schedule_name', v_sched.name,
    'branding', coalesce(v_sched.branding, '{}'::jsonb),
    'arrival_notes', v_sched.arrival_notes,
    'intake_questions', coalesce(v_sched.intake_questions, '[]'::jsonb),
    'require_phone_verify', coalesce(v_sched.require_phone_verify, false),
    'phone_hint', case when v_app.phone is not null
                       then right(regexp_replace(v_app.phone, '\D', '', 'g'), 2) end,
    'captcha_sitekey', v_sitekey,
    'options', (select coalesce(jsonb_agg(jsonb_build_object(
                    'id', s2.id, 'name', s2.name, 'slot_minutes', s2.slot_minutes,
                    'is_active', s2.is_active,
                    'arrival_notes', s2.arrival_notes,
                    'intake_questions', coalesce(s2.intake_questions, '[]'::jsonb),
                    'require_phone_verify', coalesce(s2.require_phone_verify, false),
                    'require_captcha', coalesce(s2.require_captcha, false)
                  ) order by s2.is_active desc, s2.sort_order), '[]'::jsonb)
                 from public.interview_schedules s2
                 where s2.dsp_id = v_app.dsp_id and (s2.is_active or s2.offer_public)),
    'already_booked', v_booked.id is not null,
    'booking', case when v_booked.id is null then null else jsonb_build_object(
      'starts_at', v_booked.starts_at,
      'ends_at', v_booked.ends_at,
      'meeting_url', v_booked.meeting_url,
      'location', v_booked.location,
      'running_late', v_booked.metadata->'running_late',
      'confirmed', (v_booked.metadata->>'confirmed_at') is not null
    ) end
  );
end; $$;
grant execute on function public.booking_load(text) to anon, authenticated;

-- ── 4 · book_interview_slot: idempotency + rate limit + captcha ──────────
-- 0494 body with three additions, flagged inline. Everything else — grid
-- alignment, overrides, busy-block, pooled capacity, day cap, round-robin,
-- SMS verify, reschedule limit — is byte-identical.

drop function if exists public.book_interview_slot(text, timestamptz, uuid, uuid, jsonb, text);
create or replace function public.book_interview_slot(
  p_token text, p_slot_start timestamptz, p_session_id uuid default null,
  p_schedule_id uuid default null, p_answers jsonb default null, p_verify_code text default null,
  p_captcha text default null
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_app public.applicants; v_dsp uuid; v_cfg public.interview_config;
  v_end timestamptz; v_dow int; v_min int; v_start_min int; v_event_id uuid;
  v_sess public.interview_sessions; v_cap int; v_booked int;
  v_ldate date; v_ovr public.interview_date_overrides; v_win jsonb;
  v_sched public.interview_schedules; v_gov public.interview_schedules;
  v_vc public.booking_phone_codes;
  v_maxday int; v_daycount int;
  v_pick jsonb; v_meta_add jsonb := '{}'::jsonb;
  v_existing public.cal_events;
begin
  v_app := private.applicant_for_token('booking', p_token);
  if v_app.id is null then raise exception 'invalid_or_expired_token' using errcode='P0002'; end if;
  v_dsp := v_app.dsp_id;

  -- Rate limit (#86): 20 booking attempts per applicant per hour.
  if not private.booking_rate_ok(v_app.id, 'book', 20, interval '1 hour') then
    raise exception 'rate_limited';
  end if;

  select * into v_cfg from public.interview_config where dsp_id=v_dsp;
  if v_cfg.dsp_id is null then
    v_cfg.timezone:='America/Chicago'; v_cfg.slot_minutes:=30; v_cfg.buffer_minutes:=0;
    v_cfg.min_lead_hours:=12; v_cfg.window_days:=21;
  end if;
  if p_schedule_id is not null then
    select * into v_sched from public.interview_schedules s
      where s.id = p_schedule_id and s.dsp_id = v_dsp and (s.is_active or s.offer_public);
    if v_sched.id is null then raise exception 'slot_unavailable'; end if;
    v_cfg.timezone       := coalesce(v_sched.timezone, v_cfg.timezone);
    v_cfg.slot_minutes   := coalesce(v_sched.slot_minutes, v_cfg.slot_minutes);
    v_cfg.buffer_minutes := coalesce(v_sched.buffer_minutes, v_cfg.buffer_minutes);
    v_cfg.min_lead_hours := coalesce(v_sched.min_lead_hours, v_cfg.min_lead_hours);
    v_cfg.location       := coalesce(v_sched.location, v_cfg.location);
  end if;

  if v_app.status in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed') then
    raise exception 'not_eligible';
  end if;

  -- Idempotency (#85): a double-submit of the SAME slot (network retry,
  -- double tap) returns the original booking instead of 'already_booked'.
  select * into v_existing from public.cal_events ce
    where ce.dsp_id=v_dsp and ce.applicant_id=v_app.id and ce.kind='interview'
      and ce.status in('scheduled','rescheduled')
    order by ce.starts_at asc limit 1;
  if v_existing.id is not null then
    if (p_session_id is not null and v_existing.interview_session_id = p_session_id)
       or (p_session_id is null and p_slot_start is not null and v_existing.starts_at = p_slot_start) then
      return jsonb_build_object('ok', true, 'event_id', v_existing.id, 'idempotent', true);
    end if;
    raise exception 'already_booked';
  end if;

  -- Governing schedule: explicit choice, else the active one.
  select * into v_gov from public.interview_schedules s
    where s.dsp_id = v_dsp
      and ((p_schedule_id is not null and s.id = p_schedule_id)
        or (p_schedule_id is null and s.is_active))
    limit 1;

  -- CAPTCHA (#86): only when the governing schedule demands it AND the
  -- signing key is provisioned; the proof is minted by booking-captcha
  -- after a successful Turnstile verification.
  if v_gov.id is not null and coalesce(v_gov.require_captcha, false) then
    if not private.captcha_ok(v_app.id, p_captcha) then
      raise exception 'captcha_required';
    end if;
  end if;

  -- Self-reschedule limit (0494): after N candidate cancels, rebooking goes
  -- through a human.
  if v_gov.id is not null and coalesce(v_gov.max_self_reschedules, 0) > 0
     and coalesce((v_app.metadata->>'self_cancel_count')::int, 0) >= v_gov.max_self_reschedules then
    raise exception 'reschedule_limit';
  end if;

  -- SMS verification (0493).
  if v_gov.id is not null and coalesce(v_gov.require_phone_verify, false) then
    select * into v_vc from public.booking_phone_codes where applicant_id = v_app.id;
    if p_verify_code is null or v_vc.applicant_id is null
       or v_vc.expires_at < now() or v_vc.attempts >= 5 then
      raise exception 'verify_required';
    end if;
    if v_vc.code <> regexp_replace(p_verify_code, '\D', '', 'g') then
      update public.booking_phone_codes set attempts = attempts + 1 where applicant_id = v_app.id;
      raise exception 'verify_bad_code';
    end if;
    delete from public.booking_phone_codes where applicant_id = v_app.id;
  end if;

  if p_session_id is not null then
    select * into v_sess from public.interview_sessions where id=p_session_id and dsp_id=v_dsp and active;
    if v_sess.id is null then raise exception 'slot_unavailable'; end if;
    if v_sess.starts_at < now() + make_interval(hours=>v_cfg.min_lead_hours) then raise exception 'slot_too_soon'; end if;
    perform pg_advisory_xact_lock(hashtext('gcal_session'), hashtext(v_sess.id::text));
    select count(*)::int into v_booked from public.cal_events ce
      where ce.interview_session_id=v_sess.id and ce.status in('scheduled','rescheduled');
    if v_booked >= v_sess.capacity then raise exception 'slot_taken'; end if;
    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider, interview_session_id)
    values
      (v_dsp, v_app.id, 'interview', 'scheduled', v_sess.starts_at, v_sess.ends_at, v_cfg.timezone,
       coalesce(v_sess.location, v_cfg.location), 'routeready', v_sess.id)
    returning id into v_event_id;
  else
    v_end := p_slot_start + make_interval(mins=>v_cfg.slot_minutes);
    if p_slot_start < now() + make_interval(hours=>v_cfg.min_lead_hours) then raise exception 'slot_too_soon'; end if;
    v_dow := extract(dow  from (p_slot_start at time zone v_cfg.timezone))::int;
    v_min := (extract(hour from (p_slot_start at time zone v_cfg.timezone))*60
            + extract(minute from (p_slot_start at time zone v_cfg.timezone)))::int;
    v_ldate := (p_slot_start at time zone v_cfg.timezone)::date;

    select * into v_ovr from public.interview_date_overrides
      where dsp_id=v_dsp and override_date=v_ldate;
    if v_ovr.id is not null then
      if v_ovr.is_closed then raise exception 'slot_unavailable'; end if;
      v_cap := null; v_start_min := null;
      for v_win in select * from jsonb_array_elements(coalesce(v_ovr.windows,'[]'::jsonb)) loop
        if v_min >= (v_win->>'start_min')::int and v_min + v_cfg.slot_minutes <= (v_win->>'end_min')::int then
          v_cap := coalesce((v_win->>'capacity')::int, 1);
          v_start_min := (v_win->>'start_min')::int;
          exit;
        end if;
      end loop;
    else
      select w.capacity, w.start_min into v_cap, v_start_min from (
        select av.weekday, av.start_min, av.end_min, av.capacity
          from public.interview_availability av
         where p_schedule_id is null and av.dsp_id = v_dsp
        union all
        select sw.weekday, sw.start_min, sw.end_min, sw.capacity
          from public.interview_schedule_windows sw
         where p_schedule_id is not null and sw.schedule_id = p_schedule_id
      ) w
      where w.weekday=v_dow and v_min>=w.start_min and v_min+v_cfg.slot_minutes<=w.end_min
      order by w.capacity desc limit 1;
    end if;

    if v_cap is null then raise exception 'slot_unavailable'; end if;
    if ((v_min - v_start_min) % greatest(v_cfg.slot_minutes + coalesce(v_cfg.buffer_minutes, 0), 1)) <> 0 then
      raise exception 'slot_unavailable';
    end if;
    perform pg_advisory_xact_lock(hashtext(v_dsp::text), hashtext(p_slot_start::text));
    if exists (select 1 from public.cal_events busy
      where busy.dsp_id=v_dsp and busy.status in('scheduled','rescheduled')
        and busy.kind not in ('interview','orientation')
        and coalesce((busy.metadata->>'is_task')::boolean, false) = false
        and tstzrange(busy.starts_at, coalesce(busy.ends_at, busy.starts_at + make_interval(mins=>v_cfg.slot_minutes)))
            && tstzrange(p_slot_start, v_end)) then
      raise exception 'slot_taken';
    end if;
    select count(*)::int into v_booked from public.cal_events ce
      where ce.dsp_id=v_dsp and ce.kind in('interview','orientation') and ce.status in('scheduled','rescheduled')
        and ce.interview_session_id is null
        and tstzrange(ce.starts_at, coalesce(ce.ends_at, ce.starts_at+make_interval(mins=>v_cfg.slot_minutes)))
            && tstzrange(p_slot_start, v_end);
    if v_booked >= v_cap then raise exception 'slot_taken'; end if;

    -- Daily cap (0494): counted under the same advisory lock as capacity.
    v_maxday := nullif(coalesce(v_gov.max_per_day, 0), 0);
    if v_maxday is not null then
      select count(*)::int into v_daycount from public.cal_events ce
        where ce.dsp_id=v_dsp and ce.kind in('interview','orientation')
          and ce.status in('scheduled','rescheduled')
          and ((ce.starts_at at time zone v_cfg.timezone))::date = v_ldate;
      if v_daycount >= v_maxday then raise exception 'day_full'; end if;
    end if;

    insert into public.cal_events
      (dsp_id, applicant_id, kind, status, starts_at, ends_at, timezone, location, provider)
    values
      (v_dsp, v_app.id, 'interview', 'scheduled', p_slot_start, v_end, v_cfg.timezone, v_cfg.location, 'routeready')
    returning id into v_event_id;
  end if;

  -- Round-robin interviewer (0494): least-loaded pool member this week; the
  -- shape matches the operator's manual "Assign interviewer".
  if v_gov.id is not null and jsonb_typeof(coalesce(v_gov.interviewer_pool, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(v_gov.interviewer_pool, '[]'::jsonb)) > 0 then
    select elem into v_pick
    from jsonb_array_elements(v_gov.interviewer_pool) elem
    where coalesce(elem->>'id', '') <> ''
    order by (select count(*) from public.cal_events ce
              where ce.dsp_id = v_dsp and ce.kind = 'interview'
                and ce.status in ('scheduled','rescheduled')
                and ce.metadata->'interviewer'->>'id' = elem->>'id'
                and ce.starts_at >= date_trunc('week', coalesce(p_slot_start, now()))
                and ce.starts_at <  date_trunc('week', coalesce(p_slot_start, now())) + interval '7 days') asc,
             random()
    limit 1;
    if v_pick is not null then
      v_meta_add := v_meta_add || jsonb_build_object('interviewer',
        jsonb_build_object('id', v_pick->>'id', 'name', coalesce(v_pick->>'name', 'Interviewer')));
    end if;
  end if;

  if p_answers is not null and jsonb_typeof(p_answers) = 'object' and pg_column_size(p_answers) <= 8192 then
    v_meta_add := v_meta_add || jsonb_build_object('intake_answers', p_answers);
  end if;
  if v_sched.id is not null then
    v_meta_add := v_meta_add || jsonb_build_object('schedule_id', v_sched.id, 'schedule_name', v_sched.name);
  end if;
  if v_event_id is not null and v_meta_add <> '{}'::jsonb then
    update public.cal_events
       set metadata = coalesce(metadata, '{}'::jsonb) || v_meta_add
     where id = v_event_id;
  end if;

  update public.applicants set status='interview_booked', updated_at=now()
    where id=v_app.id and status not in ('hired','rejected','no_show','not_hired','auto_declined','interview_completed');
  return jsonb_build_object('ok', true, 'event_id', v_event_id);
end; $$;
grant execute on function public.book_interview_slot(text, timestamptz, uuid, uuid, jsonb, text, text) to anon, authenticated;

-- ── 5 · booking-link control (#89) ───────────────────────────────────────
-- Reading the link already exists: booking_link_get(p_id) from 0401 returns
-- {token, link} without rotating anything. This adds the REGENERATE side —
-- same shape, but the old token dies (leaked/forwarded links stop working).

drop function if exists public.booking_link_reset(uuid);
create or replace function public.booking_link_reset(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp   uuid := private.current_dsp_id();
  v_token text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not exists (select 1 from public.applicants a where a.id = p_id and a.dsp_id = v_dsp) then
    raise exception 'applicant_not_found';
  end if;
  v_token := private.upsert_token(p_id, 'booking');   -- always mints fresh
  return jsonb_build_object('token', v_token, 'link', 'https://gorouteready.com/b/' || v_token);
end; $$;
grant execute on function public.booking_link_reset(uuid) to authenticated;

-- ── 6 · Google drift reconciliation (#88) ────────────────────────────────

insert into private.integration_settings (key, value) values
  ('gcal_reconcile_url', 'https://doiwrhkirgblcvuskhno.supabase.co/functions/v1/google-calendar-reconcile')
on conflict (key) do nothing;

do $$ begin
  perform cron.unschedule('gcal-reconcile');
exception when others then null; end $$;
select cron.schedule(
  'gcal-reconcile',
  '45 8 * * *',
  $cron$
    select net.http_post(
      url     := (select value from private.integration_settings where key = 'gcal_reconcile_url'),
      headers := jsonb_build_object('content-type', 'application/json',
                                    'x-rr-sync-token', (select value from private.integration_settings where key = 'gcal_sync_token')),
      body    := '{}'::jsonb)
    where exists (select 1 from public.google_calendar_accounts)
      and exists (select 1 from private.integration_settings where key = 'gcal_sync_token');
  $cron$
);

notify pgrst, 'reload schema';
