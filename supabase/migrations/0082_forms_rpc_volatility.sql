-- 0082_forms_rpc_volatility.sql
--
-- driver_list_forms / driver_get_form / list_form_submissions were
-- shipped with the STABLE volatility marker in 0081.  STABLE
-- functions execute in a read-only transaction, but each of these
-- calls private.driver_validate_token (or in the dispatcher's
-- case, depends on auth.uid()) which writes
-- driver_sessions.last_seen_at.  Postgres rejects the inner
-- UPDATE with "cannot execute UPDATE in a read-only transaction"
-- and the driver app surfaces "Forms RPC failed".
--
-- Drop STABLE so these run as VOLATILE (the default) like every
-- other driver_* RPC in the project.

create or replace function public.driver_list_forms(p_token text)
returns jsonb
language plpgsql
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


create or replace function public.driver_get_form(p_token text, p_id uuid)
returns jsonb
language plpgsql
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


create or replace function public.list_form_submissions(p_form_id uuid default null)
returns jsonb
language plpgsql
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
