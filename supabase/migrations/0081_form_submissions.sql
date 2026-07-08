-- 0081_form_submissions.sql
--
-- Driver-side fill-out for forms published from the dispatcher
-- builder.  Activates the path: DSP publishes → driver sees a card
-- on Tasks → driver fills out → dispatcher reads submission.
--
-- Adds:
--   1. form_submissions table — one row per fill-out; `answers`
--      JSONB indexed by field id with the driver's response.
--   2. driver_list_forms(p_token) — returns every form published
--      by the driver's DSP, decorated with whether the driver has
--      a submission yet.  Drivers can fill the same form multiple
--      times unless forms.settings.once_per_driver is true.
--   3. driver_get_form(p_token, p_id) — returns one form's
--      schema for the fill-out screen.
--   4. driver_submit_form(p_token, p_form_id, p_answers) — writes
--      the submission row.
--   5. list_form_submissions(p_form_id default null) — dispatcher
--      reads submissions, scoped by DSP.  When p_form_id is null
--      it returns the whole tenant's submissions (powers the
--      Submissions tab on the Forms page).
--   6. RLS: drivers (who hit RPCs as anon with a token) never
--      touch form_submissions directly — all writes go through
--      the security-definer driver_submit_form.  Staff selects
--      via list_form_submissions.


-- 1. form_submissions table

create table if not exists public.form_submissions (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  form_id      uuid not null references public.forms(id) on delete cascade,
  driver_id    uuid not null references public.drivers(id) on delete cascade,
  answers      jsonb not null default '{}'::jsonb,
  submitted_at timestamptz not null default now(),
  -- Status/flagged let dispatchers triage submissions. Inserted as
  -- 'submitted'/false here; the dispatcher review queue that drives them
  -- (reviewed / flagged transitions) landed later in migration 0440
  -- (form_submission_review).
  status       text not null default 'submitted',
  flagged      boolean not null default false,
  notes        text
);

create index if not exists form_subm_dsp_idx       on public.form_submissions(dsp_id, submitted_at desc);
create index if not exists form_subm_form_idx      on public.form_submissions(form_id, submitted_at desc);
create index if not exists form_subm_driver_idx    on public.form_submissions(driver_id, submitted_at desc);
create index if not exists form_subm_dsp_status_ix on public.form_submissions(dsp_id, status);


-- RLS: only DSP staff can read; driver writes go through the
-- security-definer RPC below, not direct INSERT.
alter table public.form_submissions enable row level security;

drop policy if exists form_subm_tenant_select on public.form_submissions;
create policy form_subm_tenant_select on public.form_submissions
  for select to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists form_subm_tenant_update on public.form_submissions;
create policy form_subm_tenant_update on public.form_submissions
  for update to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, update on public.form_submissions to authenticated;


-- 2. driver_list_forms — what's available to fill out
create or replace function public.driver_list_forms(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_forms jsonb;
begin
  v_drv := private.driver_validate_token(p_token);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           f.id,
    'title',        f.title,
    'description',  f.description,
    'category',     f.category,
    'field_count',  jsonb_array_length(coalesce(f.fields, '[]'::jsonb)),
    'settings',     f.settings,
    'published_at', f.published_at,
    'last_submitted_at', (
      select max(submitted_at) from public.form_submissions s
       where s.form_id = f.id and s.driver_id = v_drv.id
    ),
    'submission_count', (
      select count(*)::int from public.form_submissions s
       where s.form_id = f.id and s.driver_id = v_drv.id
    )
  ) order by f.published_at desc nulls last), '[]'::jsonb)
    into v_forms
  from public.forms f
  where f.dsp_id = v_drv.dsp_id
    and f.status = 'published';

  return v_forms;
end;
$$;
grant execute on function public.driver_list_forms(text) to anon, authenticated;


-- 3. driver_get_form — schema for the fill-out screen
create or replace function public.driver_get_form(p_token text, p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.forms;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_row from public.forms
   where id = p_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_row.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;
  return jsonb_build_object(
    'id',          v_row.id,
    'title',       v_row.title,
    'description', v_row.description,
    'fields',      v_row.fields,
    'settings',    v_row.settings
  );
end;
$$;
grant execute on function public.driver_get_form(text, uuid) to anon, authenticated;


-- 4. driver_submit_form — write the submission
create or replace function public.driver_submit_form(
  p_token text,
  p_form_id uuid,
  p_answers jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_form public.forms;
  v_row public.form_submissions;
begin
  v_drv := private.driver_validate_token(p_token);
  select * into v_form from public.forms
   where id = p_form_id and dsp_id = v_drv.dsp_id and status = 'published';
  if v_form.id is null then raise exception 'form_not_found' using errcode = 'P0001'; end if;

  -- once_per_driver guard — when the form's settings request it,
  -- block a second submission from the same driver.
  if coalesce((v_form.settings->>'once_per_driver')::boolean, false) then
    if exists (
      select 1 from public.form_submissions
       where form_id = p_form_id and driver_id = v_drv.id
    ) then
      raise exception 'already_submitted' using errcode = 'P0001';
    end if;
  end if;

  insert into public.form_submissions (dsp_id, form_id, driver_id, answers)
  values (v_drv.dsp_id, p_form_id, v_drv.id, coalesce(p_answers, '{}'::jsonb))
  returning * into v_row;

  return jsonb_build_object(
    'id',           v_row.id,
    'submitted_at', v_row.submitted_at
  );
end;
$$;
grant execute on function public.driver_submit_form(text, uuid, jsonb) to anon, authenticated;


-- 5. list_form_submissions — dispatcher Submissions tab
create or replace function public.list_form_submissions(p_form_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_rows jsonb;
begin
  if v_dsp is null then return '[]'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           s.id,
    'form_id',      s.form_id,
    'form_title',   f.title,
    'driver_id',    s.driver_id,
    'driver_name',  d.full_name,
    'answers',      s.answers,
    'status',       s.status,
    'flagged',      s.flagged,
    'notes',        s.notes,
    'submitted_at', s.submitted_at
  ) order by s.submitted_at desc), '[]'::jsonb)
    into v_rows
  from public.form_submissions s
  join public.forms   f on f.id = s.form_id
  join public.drivers d on d.id = s.driver_id
  where s.dsp_id = v_dsp
    and (p_form_id is null or s.form_id = p_form_id);

  return v_rows;
end;
$$;
grant execute on function public.list_form_submissions(uuid) to authenticated;


notify pgrst, 'reload schema';
