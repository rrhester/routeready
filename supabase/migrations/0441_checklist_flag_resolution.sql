-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0441 · Flag resolution workflow
--
-- Flagged answers (checklist_answers.failed_flag — e.g. "Brakes OK? No", a
-- number out of range) were surfaced only as a transient realtime toast to
-- dispatch (0437). A safety flag shouldn't vanish on a page refresh. This
-- adds a persistent, actionable queue: each flagged answer has a resolution
-- state (open → resolved/dismissed) with who/when/note, plus list + count +
-- resolve/reopen RPCs.
--
-- Resolution lives on the answer row. clf_write_submission re-inserts
-- answers on every save, so a *resubmit* naturally re-opens the flag (the
-- underlying data changed) — which is what we want. Only submitted /
-- reopened submissions surface, so in-progress autosave churn is ignored.
-- ─────────────────────────────────────────────────────────────────────────


-- ── 1. Resolution columns ─────────────────────────────────────────────
alter table public.checklist_answers add column if not exists flag_resolved_at timestamptz;
alter table public.checklist_answers add column if not exists flag_resolved_by uuid references auth.users(id) on delete set null;
alter table public.checklist_answers add column if not exists flag_disposition text;   -- 'resolved' | 'dismissed'
alter table public.checklist_answers add column if not exists flag_note text;

-- Fast open-flags lookup per DSP.
create index if not exists clf_answers_open_flags_idx
  on public.checklist_answers (dsp_id, created_at desc)
  where failed_flag and flag_resolved_at is null;


-- ── 2. Open-flag count (badge) ────────────────────────────────────────
create or replace function public.checklist_flags_open_count()
returns int language plpgsql stable security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_n int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select count(*)::int into v_n
  from public.checklist_answers a
  join public.checklist_submissions s on s.id = a.submission_id
  where a.dsp_id = v_dsp and a.failed_flag and a.flag_resolved_at is null
    and s.status in ('submitted','reopened');
  return coalesce(v_n, 0);
end $$;
grant execute on function public.checklist_flags_open_count() to authenticated;


-- ── 3. Flags list (open by default; include_resolved for history) ─────
create or replace function public.checklist_flags_list(
  p_include_resolved boolean default false,
  p_limit int default 100,
  p_offset int default 0
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(row_to_json(r)::jsonb), '[]'::jsonb) into v_out
  from (
    select
      a.id            as answer_id,
      a.submission_id,
      s.template_id,
      f.name          as checklist_name,
      a.item_id,
      coalesce(a.item_label, i.label)     as item_label,
      coalesce(a.item_type,  i.item_type) as item_type,
      a.value_text, a.value_bool, a.value_number, a.note,
      a.flag_resolved_at, a.flag_disposition, a.flag_note,
      au.email        as resolved_by_email,
      s.driver_id, d.full_name as driver_name,
      s.status        as submission_status,
      s.submitted_at, a.created_at
    from public.checklist_answers a
    join public.checklist_submissions s on s.id = a.submission_id
    join public.checklist_forms f       on f.id = s.template_id
    join public.drivers d               on d.id = s.driver_id
    left join public.checklist_items i  on i.id = a.item_id
    left join auth.users au             on au.id = a.flag_resolved_by
    where a.dsp_id = v_dsp and a.failed_flag
      and s.status in ('submitted','reopened')
      and (p_include_resolved or a.flag_resolved_at is null)
    order by s.submitted_at desc nulls last, a.created_at desc
    limit  greatest(1, least(coalesce(p_limit, 100), 500))
    offset greatest(0, coalesce(p_offset, 0))
  ) r;
  return v_out;
end $$;
grant execute on function public.checklist_flags_list(boolean, int, int) to authenticated;


-- ── 4. Resolve / dismiss a flag ───────────────────────────────────────
create or replace function public.checklist_flag_resolve(
  p_answer_id uuid,
  p_disposition text default 'resolved',
  p_note text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_a public.checklist_answers;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_disposition not in ('resolved','dismissed') then raise exception 'bad_disposition' using errcode = 'P0001'; end if;
  update public.checklist_answers
     set flag_resolved_at = now(),
         flag_resolved_by = auth.uid(),
         flag_disposition = p_disposition,
         flag_note        = nullif(trim(coalesce(p_note, '')), '')
   where id = p_answer_id and dsp_id = v_dsp and failed_flag
   returning * into v_a;
  if v_a.id is null then raise exception 'flag_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('answer_id', v_a.id, 'flag_resolved_at', v_a.flag_resolved_at, 'flag_disposition', v_a.flag_disposition);
end $$;
grant execute on function public.checklist_flag_resolve(uuid, text, text) to authenticated;


-- ── 5. Reopen a resolved flag ─────────────────────────────────────────
create or replace function public.checklist_flag_reopen(p_answer_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.checklist_answers
     set flag_resolved_at = null, flag_resolved_by = null, flag_disposition = null, flag_note = null
   where id = p_answer_id and dsp_id = v_dsp and failed_flag;
end $$;
grant execute on function public.checklist_flag_reopen(uuid) to authenticated;


notify pgrst, 'reload schema';
