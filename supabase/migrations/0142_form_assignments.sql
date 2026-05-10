-- Migration 0142 · Assign workflows (forms) to specific drivers
--
-- A published form can be targeted at a subset of drivers.  With no
-- assignments it behaves as before — visible to every driver in the DSP.
-- With assignments, only the assigned drivers see it in the PWA.

create table if not exists public.form_assignments (
  form_id    uuid not null references public.forms(id)    on delete cascade,
  driver_id  uuid not null references public.drivers(id)  on delete cascade,
  dsp_id     uuid not null references public.dsps(id)     on delete cascade,
  created_at timestamptz not null default now(),
  primary key (form_id, driver_id)
);
create index if not exists form_assignments_form_idx on public.form_assignments(form_id);
alter table public.form_assignments enable row level security;
drop policy if exists "form_assignments_staff_rw" on public.form_assignments;
create policy "form_assignments_staff_rw" on public.form_assignments for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));
grant select, insert, update, delete on public.form_assignments to authenticated;


-- form_set_assignments(form_id, driver_ids[]) — replace the set.  Empty
-- array → no targeting → the form is visible to everyone.
create or replace function public.form_set_assignments(p_form_id uuid, p_driver_ids uuid[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.forms f where f.id = p_form_id and f.dsp_id = v_dsp) then
    raise exception 'form_not_found' using errcode = 'P0002';
  end if;
  delete from public.form_assignments where form_id = p_form_id;
  insert into public.form_assignments (form_id, driver_id, dsp_id)
    select p_form_id, d.id, v_dsp
      from public.drivers d
     where d.dsp_id = v_dsp and d.id = any(coalesce(p_driver_ids, '{}'::uuid[]))
    on conflict do nothing;
end;
$$;
grant execute on function public.form_set_assignments(uuid, uuid[]) to authenticated;


-- form_get_assignments(form_id) — the assigned driver_ids ([] = all).
create or replace function public.form_get_assignments(p_form_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(driver_id) from public.form_assignments where form_id = p_form_id and dsp_id = v_dsp), '[]'::jsonb);
end;
$$;
grant execute on function public.form_get_assignments(uuid) to authenticated;


-- form_assignment_counts() — { form_id, n } for forms with assignments;
-- lets the workflows list show "assigned to N drivers".
create or replace function public.form_assignment_counts()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('form_id', form_id, 'n', n))
      from (select form_id, count(*)::int n from public.form_assignments where dsp_id = v_dsp group by form_id) t
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.form_assignment_counts() to authenticated;


-- driver_list_forms — now respects assignments: a published form is shown
-- to a driver if it has no assignments, or this driver is among them.
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
    and f.status = 'published'
    and (
      not exists (select 1 from public.form_assignments fa where fa.form_id = f.id)
      or exists (select 1 from public.form_assignments fa where fa.form_id = f.id and fa.driver_id = v_drv.id)
    );

  return v_forms;
end;
$$;
grant execute on function public.driver_list_forms(text) to anon, authenticated;

notify pgrst, 'reload schema';
