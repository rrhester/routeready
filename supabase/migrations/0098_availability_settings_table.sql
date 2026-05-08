-- Fix the long-standing bug where availability rule settings (lead
-- time + approve/deny auto-response templates) silently failed to
-- save. They were stored on public.scheduling_settings keyed by
-- (dsp_id, week_start) where week_start IS NULL was supposed to be
-- the "global default" row — but week_start is declared NOT NULL,
-- so every insert raised
--   "null value in column week_start ... violates not-null constraint"
-- and every read with `where week_start is null` returned no rows
-- (so callers fell back to defaults and operators thought saves had
-- worked when nothing actually persisted).
--
-- Fix the data model rather than patch with a sentinel date: the
-- three columns are global per-DSP, not per-week, and don't belong
-- on a per-week table. Move them to a dedicated availability_settings
-- table keyed by dsp_id alone, then re-point every reader at it.

create table if not exists public.availability_settings (
  dsp_id           uuid          primary key references public.dsps(id) on delete cascade,
  lead_days        int           not null default 7
                     check (lead_days between 0 and 60),
  approve_template text,
  deny_template    text,
  created_at       timestamptz   not null default now(),
  updated_at       timestamptz   not null default now()
);

drop trigger if exists trg_availability_settings_updated_at on public.availability_settings;
create trigger trg_availability_settings_updated_at
  before update on public.availability_settings
  for each row execute function private.set_updated_at();

alter table public.availability_settings enable row level security;
drop policy if exists "availability_settings_tenant_rw" on public.availability_settings;
create policy "availability_settings_tenant_rw"
  on public.availability_settings for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.availability_settings to authenticated;


-- ─── Replace availability_settings_get / _set ────────────────────────────

create or replace function public.availability_settings_get()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_s public.availability_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_s from public.availability_settings where dsp_id = v_dsp;
  return jsonb_build_object(
    'lead_days',         coalesce(v_s.lead_days, 7),
    'approve_template',  coalesce(v_s.approve_template,
      'Your availability request has been approved: {days}. Effective from {effective_from} through {effective_until}.{note}'),
    'deny_template',     coalesce(v_s.deny_template,
      'Your availability request was not approved.{note} Submit a new request from the Availability page.')
  );
end;
$$;
grant execute on function public.availability_settings_get() to authenticated;


create or replace function public.availability_settings_set(
  p_lead_days        int,
  p_approve_template text,
  p_deny_template    text
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  insert into public.availability_settings
    (dsp_id, lead_days, approve_template, deny_template)
  values
    (v_dsp,
     greatest(0, least(60, coalesce(p_lead_days, 7))),
     nullif(trim(coalesce(p_approve_template, '')), ''),
     nullif(trim(coalesce(p_deny_template, '')), ''))
  on conflict (dsp_id) do update set
    lead_days        = excluded.lead_days,
    approve_template = excluded.approve_template,
    deny_template    = excluded.deny_template,
    updated_at       = now();
end;
$$;
grant execute on function public.availability_settings_set(int, text, text) to authenticated;


-- ─── Re-point availability_request_decide at the new table ───────────────
-- 0063 read v_settings.availability_change_lead_days +
-- v_settings.availability_{approve,deny}_template from
-- public.scheduling_settings where week_start is null. Same body, just
-- swap the source. Everything else (effective_from math, message
-- templating, conversation upsert) is unchanged.

create or replace function public.availability_request_decide(
  p_request_id uuid,
  p_approve    boolean,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_req        public.driver_availability_requests;
  v_drv        public.drivers;
  v_meta       jsonb;
  v_lead_days  int;
  v_eff_from   date;
  v_eff_until  date;
  v_msg_body   text;
  v_dlabel     text;
  v_clean_note text;
  v_template   text;
  v_settings   public.availability_settings;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_req
    from public.driver_availability_requests
   where id = p_request_id and dsp_id = v_dsp
   for update;
  if v_req.id is null then raise exception 'request_not_found' using errcode = 'P0002'; end if;
  if v_req.status <> 'pending' then raise exception 'request_already_decided' using errcode = 'P0001'; end if;

  v_clean_note := nullif(trim(coalesce(p_note, '')), '');

  select string_agg(initcap(d), ', ' order by array_position(
    array['mon','tue','wed','thu','fri','sat','sun'], d
  )) into v_dlabel from unnest(v_req.days) d;
  if v_dlabel is null or v_dlabel = '' then v_dlabel := '(no days)'; end if;

  select * into v_settings from public.availability_settings where dsp_id = v_dsp;
  v_lead_days := coalesce(v_settings.lead_days, 7);

  if p_approve then
    v_eff_from  := current_date + v_lead_days;
    v_eff_until := v_eff_from + 21;

    update public.driver_availability_requests
       set status          = 'approved',
           decided_at      = now(),
           decided_by      = auth.uid(),
           decision_note   = v_clean_note,
           effective_from  = v_eff_from,
           effective_until = v_eff_until
     where id = p_request_id;

    if v_lead_days <= 0 then
      select * into v_drv from public.drivers where id = v_req.driver_id;
      v_meta := coalesce(v_drv.metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'availability', jsonb_build_object('days', to_jsonb(v_req.days))
                );
      update public.drivers set metadata = v_meta where id = v_req.driver_id;
    end if;

    v_template := coalesce(
      v_settings.approve_template,
      'Your availability request has been approved: {days}. Effective from {effective_from} through {effective_until}.{note}'
    );
    v_msg_body := replace(v_template, '{days}',            v_dlabel);
    v_msg_body := replace(v_msg_body, '{effective_from}',  to_char(v_eff_from,  'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{effective_until}', to_char(v_eff_until, 'Mon DD, YYYY'));
    v_msg_body := replace(v_msg_body, '{note}',            coalesce(' Note: ' || v_clean_note, ''));
  else
    update public.driver_availability_requests
       set status        = 'denied',
           decided_at    = now(),
           decided_by    = auth.uid(),
           decision_note = v_clean_note
     where id = p_request_id;

    v_template := coalesce(
      v_settings.deny_template,
      'Your availability request was not approved.{note} Submit a new request from the Availability page.'
    );
    v_msg_body := replace(v_template, '{days}', v_dlabel);
    v_msg_body := replace(v_msg_body, '{note}', coalesce(' Reason: ' || v_clean_note, ''));
  end if;

  insert into public.driver_messages (driver_id, dsp_id, sender_kind, sender_user_id, body)
  values (v_req.driver_id, v_dsp, 'dispatch', auth.uid(), v_msg_body);

  insert into public.driver_conversations (driver_id, dsp_id, last_message_at)
  values (v_req.driver_id, v_dsp, now())
  on conflict (driver_id) do update set last_message_at = now();

  return jsonb_build_object(
    'id',     p_request_id,
    'status', case when p_approve then 'approved' else 'denied' end,
    'effective_from',  case when p_approve then to_jsonb(v_eff_from::text)  else 'null'::jsonb end,
    'effective_until', case when p_approve then to_jsonb(v_eff_until::text) else 'null'::jsonb end
  );
end;
$$;
grant execute on function public.availability_request_decide(uuid, boolean, text) to authenticated;


-- ─── Re-point driver_get_availability at the new table ──────────────────
-- Driver app shows "your change takes effect Friday" preview; that
-- math now reads from availability_settings.lead_days too.

create or replace function public.driver_get_availability(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_active_days jsonb;
  v_pending public.driver_availability_requests;
  v_last_decided public.driver_availability_requests;
  v_blackout public.availability_blackouts;
  v_lead int;
begin
  v_drv := private.driver_validate_token(p_token);

  v_active_days := coalesce(v_drv.metadata -> 'availability' -> 'days', '[]'::jsonb);

  select * into v_pending
    from public.driver_availability_requests
   where driver_id = v_drv.id and status = 'pending'
   order by submitted_at desc limit 1;

  select * into v_last_decided
    from public.driver_availability_requests
   where driver_id = v_drv.id and status in ('approved','denied')
   order by decided_at desc nulls last limit 1;

  select * into v_blackout from public.availability_blackouts
   where dsp_id = v_drv.dsp_id
     and start_date <= current_date and end_date >= current_date
   order by start_date desc limit 1;

  select coalesce(lead_days, 7) into v_lead
    from public.availability_settings
   where dsp_id = v_drv.dsp_id;
  if v_lead is null then v_lead := 7; end if;

  return jsonb_build_object(
    'days',    v_active_days,
    'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
    'effective_until', to_jsonb((v_last_decided.effective_until)::text),
    'lead_days', v_lead,
    'blackout', case when v_blackout.id is null then null else jsonb_build_object(
      'reason',     v_blackout.reason,
      'start_date', to_jsonb((v_blackout.start_date)::text),
      'end_date',   to_jsonb((v_blackout.end_date)::text)
    ) end,
    'pending', case when v_pending.id is null then null else jsonb_build_object(
      'days',         to_jsonb(v_pending.days),
      'submitted_at', to_jsonb(v_pending.submitted_at)
    ) end,
    'last_decision', case when v_last_decided.id is null then null else jsonb_build_object(
      'status',          v_last_decided.status,
      'decided_at',      to_jsonb(v_last_decided.decided_at),
      'decision_note',   v_last_decided.decision_note,
      'effective_from',  to_jsonb((v_last_decided.effective_from)::text),
      'effective_until', to_jsonb((v_last_decided.effective_until)::text)
    ) end
  );
end;
$$;
grant execute on function public.driver_get_availability(text) to anon, authenticated;


notify pgrst, 'reload schema';
