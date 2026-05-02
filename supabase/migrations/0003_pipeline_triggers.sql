-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0003 · Pipeline triggers
--
-- Wires the schema from 0002 into something useful without external
-- services:
--
--   1. set_updated_at — keep updated_at honest on every table that has it.
--   2. log_applicant_status_change — when applicants.status changes, write
--      a row into applicant_status_changes (the audit trail the dashboard
--      reads for the per-applicant timeline).
--   3. score_applicant_on_response — when a screening_responses row lands,
--      look up the question's scoring + hard_filter rules, set
--      score_awarded / hard_filter_failed, then recompute the parent
--      applicant.score and flip status:
--        • any hard_filter_failed → 'auto_declined'
--        • else, once every required active question is answered →
--          'screening_completed' (caller can promote to 'qualified' later).
--   4. applicant_pipeline_stage(applicant_status) — function mapping the
--      15-state enum to the 4 visual stages the mockup uses. Exposed as a
--      view so the front-end can group + count cleanly.
-- ─────────────────────────────────────────────────────────────────────────


-- ─── 1. set_updated_at ───────────────────────────────────────────────────

create or replace function private.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_dsps_updated_at
  before update on public.dsps
  for each row execute function private.set_updated_at();

create trigger trg_stations_updated_at
  before update on public.stations
  for each row execute function private.set_updated_at();

create trigger trg_app_users_updated_at
  before update on public.app_users
  for each row execute function private.set_updated_at();

create trigger trg_applicants_updated_at
  before update on public.applicants
  for each row execute function private.set_updated_at();

create trigger trg_screening_questions_updated_at
  before update on public.screening_questions
  for each row execute function private.set_updated_at();

create trigger trg_message_templates_updated_at
  before update on public.message_templates
  for each row execute function private.set_updated_at();

create trigger trg_sms_messages_updated_at
  before update on public.sms_messages
  for each row execute function private.set_updated_at();

create trigger trg_email_messages_updated_at
  before update on public.email_messages
  for each row execute function private.set_updated_at();

create trigger trg_cal_events_updated_at
  before update on public.cal_events
  for each row execute function private.set_updated_at();


-- ─── 2. log_applicant_status_change ──────────────────────────────────────

create or replace function private.log_applicant_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT') then
    insert into public.applicant_status_changes
      (dsp_id, applicant_id, from_status, to_status, changed_by)
    values
      (new.dsp_id, new.id, null, new.status, auth.uid());
    return new;
  end if;

  if (tg_op = 'UPDATE') and (new.status is distinct from old.status) then
    insert into public.applicant_status_changes
      (dsp_id, applicant_id, from_status, to_status, reason, changed_by)
    values
      (new.dsp_id, new.id, old.status, new.status, new.auto_declined_reason, auth.uid());
  end if;

  return new;
end;
$$;

create trigger trg_applicants_status_history_insert
  after insert on public.applicants
  for each row execute function private.log_applicant_status_change();

create trigger trg_applicants_status_history_update
  after update of status on public.applicants
  for each row execute function private.log_applicant_status_change();


-- ─── 3. score_applicant_on_response ──────────────────────────────────────
--
-- Called BEFORE INSERT/UPDATE on screening_responses so the row that lands
-- already has score_awarded + hard_filter_failed populated. Then a second
-- AFTER trigger recomputes the parent applicant.score and may flip status.

create or replace function private.compute_response_score()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  q_scoring jsonb;
  q_hard    jsonb;
  answer_key text;
  awarded int;
  failed boolean := false;
begin
  -- Pull scoring + hard_filter from the question. dsp_id check is a belt-
  -- and-suspenders guard — the RLS policy already enforces tenant scope.
  select scoring, hard_filter
    into q_scoring, q_hard
  from public.screening_questions
  where id = new.question_id
    and dsp_id = new.dsp_id;

  -- Resolve the "answer key" we'll match scoring/hard_filter against.
  -- For free-form text/number/date we fall back to answer_text.
  answer_key := coalesce(new.answer_text, new.answer_json->>'value', '');

  if q_scoring is not null and q_scoring ? answer_key then
    awarded := (q_scoring->>answer_key)::int;
  else
    awarded := 0;
  end if;

  if q_hard is not null and q_hard ? 'answer'
     and (q_hard->>'answer') = answer_key then
    failed := true;
  end if;

  new.score_awarded      := awarded;
  new.hard_filter_failed := failed;
  return new;
end;
$$;

create trigger trg_screening_responses_compute_score
  before insert or update on public.screening_responses
  for each row execute function private.compute_response_score();


create or replace function private.recompute_applicant_score()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp_id     uuid;
  v_applicant  uuid;
  v_total      int;
  v_failed_any boolean;
  v_required_total int;
  v_required_done  int;
  v_current_status public.applicant_status;
  v_decline_reason text;
begin
  v_applicant := coalesce(new.applicant_id, old.applicant_id);
  v_dsp_id    := coalesce(new.dsp_id, old.dsp_id);

  select coalesce(sum(score_awarded), 0),
         bool_or(hard_filter_failed)
    into v_total, v_failed_any
  from public.screening_responses
  where applicant_id = v_applicant;

  -- Count required-active questions vs how many have a response.
  select
    count(*) filter (where q.required = true and q.active = true),
    count(*) filter (where q.required = true and q.active = true and r.id is not null)
  into v_required_total, v_required_done
  from public.screening_questions q
  left join public.screening_responses r
    on r.question_id = q.id and r.applicant_id = v_applicant
  where q.dsp_id = v_dsp_id;

  select status
    into v_current_status
  from public.applicants
  where id = v_applicant;

  -- Status transition rules. We never overwrite a terminal status (hired,
  -- rejected) and we don't auto-rewind past interview/orientation.
  if v_failed_any and v_current_status in ('applied','contacted','screening_started','screening_completed') then
    -- Surface the first failed question text as the decline reason.
    select 'Hard filter failed: ' || q.prompt
      into v_decline_reason
    from public.screening_responses r
    join public.screening_questions q on q.id = r.question_id
    where r.applicant_id = v_applicant and r.hard_filter_failed = true
    order by r.created_at asc
    limit 1;

    update public.applicants
      set score = v_total,
          status = 'auto_declined',
          auto_declined_reason = v_decline_reason,
          screening_completed_at = coalesce(screening_completed_at, now())
      where id = v_applicant;

  elsif v_required_total > 0
        and v_required_done >= v_required_total
        and v_current_status in ('applied','contacted','screening_started') then
    update public.applicants
      set score = v_total,
          status = 'screening_completed',
          screening_completed_at = coalesce(screening_completed_at, now())
      where id = v_applicant;

  else
    -- Just keep the score in sync; status moves remain manual / RPC-driven.
    update public.applicants
      set score = v_total,
          status = case
            when status = 'applied' and v_required_done > 0 then 'screening_started'::public.applicant_status
            else status
          end
      where id = v_applicant;
  end if;

  return null;
end;
$$;

create trigger trg_screening_responses_recompute_applicant
  after insert or update or delete on public.screening_responses
  for each row execute function private.recompute_applicant_score();


-- ─── 4. Visual stage mapping ─────────────────────────────────────────────
--
-- The mockup pipeline has 4 buckets: applied, screened, booking_pending,
-- booking_scheduled. Map the 15-state DB enum to those, plus a 'closed'
-- bucket for terminal states the UI hides by default.

create or replace function public.applicant_pipeline_stage(s public.applicant_status)
returns text
language sql
immutable
as $$
  select case s
    when 'applied'              then 'applied'
    when 'contacted'            then 'applied'
    when 'screening_started'    then 'applied'
    when 'screening_completed'  then 'screened'
    when 'qualified'            then 'screened'
    when 'review_needed'        then 'screened'
    when 'interview_invited'    then 'booking_pending'
    when 'orientation_invited'  then 'booking_pending'
    when 'interview_booked'     then 'booking_scheduled'
    when 'orientation_booked'   then 'booking_scheduled'
    when 'interview_completed'  then 'booking_scheduled'
    when 'auto_declined'        then 'closed'
    when 'rejected'             then 'closed'
    when 'no_show'              then 'closed'
    when 'hired'                then 'closed'
  end;
$$;

create or replace view public.applicants_pipeline as
  select
    a.*,
    public.applicant_pipeline_stage(a.status) as pipeline_stage
  from public.applicants a;

-- The view inherits RLS from the underlying table.
grant select on public.applicants_pipeline to authenticated;
