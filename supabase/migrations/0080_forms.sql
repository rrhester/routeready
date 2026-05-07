-- 0080_forms.sql
--
-- Forms — DSP-owned dispatcher-built forms.  Activates the "Build
-- a form" tool on /forms.  Driver-side fill-out lands in a later
-- migration; this one ships the dispatcher CRUD.
--
-- Adds:
--   1. forms table — title, description, status (draft / published /
--      archived), category, fields (JSONB array of field defs), and
--      settings (JSONB blob for assignment + schedule + flags).
--   2. RLS policies — staff of the owning DSP can read; dispatchers
--      can write.
--   3. RPCs — list_forms, get_form, upsert_form (used for both
--      INSERT and UPDATE), publish_form, archive_form, delete_form.
--
-- Field shape (stored inside forms.fields):
--   { id: uuid, type: 'short_text' | 'long_text' | 'email' | 'phone'
--                    | 'number' | 'single_choice' | 'multi_choice'
--                    | 'dropdown' | 'yes_no' | 'rating' | 'date'
--                    | 'time' | 'photo' | 'file' | 'signature'
--                    | 'gps' | 'section_header' | 'divider',
--     label: text, help: text, required: bool, options: text[] }


-- 1. forms table

do $$ begin
  if not exists (select 1 from pg_type where typname = 'form_status') then
    create type public.form_status as enum ('draft','published','archived');
  end if;
end $$;

create table if not exists public.forms (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  title        text not null default 'Untitled form',
  description  text,
  category     text default 'general',
  status       public.form_status not null default 'draft',
  fields       jsonb not null default '[]'::jsonb,
  settings     jsonb not null default '{}'::jsonb,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  published_at timestamptz
);

create index if not exists forms_dsp_idx on public.forms(dsp_id, updated_at desc);
create index if not exists forms_status_idx on public.forms(dsp_id, status);

-- updated_at maintenance
create or replace function private.tg_forms_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  NEW.updated_at := now();
  return NEW;
end;
$$;

drop trigger if exists trg_forms_touch_updated_at on public.forms;
create trigger trg_forms_touch_updated_at
  before update on public.forms
  for each row execute function private.tg_forms_touch_updated_at();


-- 2. RLS

alter table public.forms enable row level security;

drop policy if exists forms_tenant_select on public.forms;
create policy forms_tenant_select on public.forms
  for select to authenticated
  using (dsp_id = private.current_dsp_id());

drop policy if exists forms_tenant_insert on public.forms;
create policy forms_tenant_insert on public.forms
  for insert to authenticated
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists forms_tenant_update on public.forms;
create policy forms_tenant_update on public.forms
  for update to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

drop policy if exists forms_tenant_delete on public.forms;
create policy forms_tenant_delete on public.forms
  for delete to authenticated
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.forms to authenticated;


-- 3. RPCs

create or replace function public.list_forms()
returns setof public.forms
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.forms
   where dsp_id = private.current_dsp_id()
     and status <> 'archived'
   order by updated_at desc;
$$;
grant execute on function public.list_forms() to authenticated;


create or replace function public.get_form(p_id uuid)
returns public.forms
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.forms
   where id = p_id and dsp_id = private.current_dsp_id();
$$;
grant execute on function public.get_form(uuid) to authenticated;


-- upsert_form handles both create (when p_id is null) and update.
-- The payload only carries operator-editable columns; status comes
-- from publish_form / archive_form / delete_form so we don't accept
-- it here.  Returns the saved row.
create or replace function public.upsert_form(p_id uuid, p_payload jsonb)
returns public.forms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_id is null then
    insert into public.forms (dsp_id, title, description, category, fields, settings, created_by)
    values (
      v_dsp,
      coalesce(nullif(trim(p_payload->>'title'), ''), 'Untitled form'),
      p_payload->>'description',
      coalesce(nullif(p_payload->>'category', ''), 'general'),
      coalesce(p_payload->'fields', '[]'::jsonb),
      coalesce(p_payload->'settings', '{}'::jsonb),
      auth.uid()
    )
    returning * into v_row;
  else
    update public.forms
       set title       = coalesce(nullif(trim(p_payload->>'title'), ''), title),
           description = coalesce(p_payload->>'description', description),
           category    = coalesce(nullif(p_payload->>'category', ''), category),
           fields      = coalesce(p_payload->'fields', fields),
           settings    = coalesce(p_payload->'settings', settings)
     where id = p_id and dsp_id = v_dsp
     returning * into v_row;
    if v_row.id is null then raise exception 'form_not_found'; end if;
  end if;

  return v_row;
end;
$$;
grant execute on function public.upsert_form(uuid, jsonb) to authenticated;


create or replace function public.publish_form(p_id uuid)
returns public.forms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.forms
     set status       = 'published',
         published_at = coalesce(published_at, now())
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if v_row.id is null then raise exception 'form_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.publish_form(uuid) to authenticated;


create or replace function public.archive_form(p_id uuid)
returns public.forms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.forms
     set status = 'archived'
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if v_row.id is null then raise exception 'form_not_found'; end if;
  return v_row;
end;
$$;
grant execute on function public.archive_form(uuid) to authenticated;


create or replace function public.delete_form(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.forms where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.delete_form(uuid) to authenticated;


notify pgrst, 'reload schema';
