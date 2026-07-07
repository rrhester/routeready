-- 0440_form_submission_review.sql
--
-- Dispatcher review loop for form submissions. The form_submissions
-- table has carried status / flagged / notes columns (and a dispatcher
-- UPDATE RLS policy) since 0081, but nothing ever wrote them — the
-- "dispatcher review queue" that migration's comment promised was never
-- built. This adds the single RPC the dashboard needs to triage a
-- submission: set its status, flag/unflag it, and attach notes.
--
-- list_form_submissions already returns status / flagged / notes, so no
-- read-side change is needed; the dashboard filters + CSV export work off
-- that existing payload client-side.
--
-- Idempotent: create or replace only.

create or replace function public.form_review_submission(
  p_id      uuid,
  p_status  text    default null,
  p_flagged boolean default null,
  p_notes   text    default null
)
returns public.form_submissions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.form_submissions;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- Only the four triage states are accepted. Passing null leaves the
  -- current status untouched (partial update).
  if p_status is not null
     and p_status not in ('submitted','reviewed','follow_up','resolved') then
    raise exception 'invalid_status: %', p_status using errcode = 'P0001';
  end if;

  update public.form_submissions
     set status  = coalesce(p_status,  status),
         flagged = coalesce(p_flagged, flagged),
         -- notes: null = leave as-is; empty string = clear.
         notes   = case when p_notes is null then notes
                        else nullif(btrim(p_notes), '') end
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;

  if v_row.id is null then
    raise exception 'submission_not_found' using errcode = 'P0001';
  end if;
  return v_row;
end;
$$;
grant execute on function public.form_review_submission(uuid, text, boolean, text) to authenticated;


notify pgrst, 'reload schema';
