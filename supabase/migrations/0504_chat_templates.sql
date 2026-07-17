-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0504 · Message templates (Messages 100-list · Batch 1, #3/#4)
--
-- Canned replies for the dispatch composer. A template belongs to a DSP;
-- `shared = true` templates are visible to every staff member, private
-- ones only to their creator. The dashboard types "/" in the composer to
-- pick one; {{variable}} fill happens client-side (msg-core.mjs).
--
-- Surface:
--   dispatch_templates_list()                            → { templates: [...] }
--   dispatch_template_upsert(id?, name, shortcut, body, shared) → { id }
--   dispatch_template_delete(id)                         → { ok: true }
--
-- Idempotent: create table if not exists + create or replace function.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.dispatch_chat_templates (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id) on delete cascade,
  created_by  uuid references auth.users(id),
  name        text not null check (length(trim(name)) between 1 and 80),
  shortcut    text check (shortcut is null or (length(shortcut) between 1 and 24 and shortcut ~ '^[a-z0-9_-]+$')),
  body        text not null check (length(trim(body)) between 1 and 2000),
  shared      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists dispatch_chat_templates_dsp_idx
  on public.dispatch_chat_templates (dsp_id, shared, name);

alter table public.dispatch_chat_templates enable row level security;
drop policy if exists "dispatch_chat_templates_tenant_r" on public.dispatch_chat_templates;
create policy "dispatch_chat_templates_tenant_r"
  on public.dispatch_chat_templates for select
  using (dsp_id = private.current_dsp_id() and (shared or created_by = auth.uid()));
grant select on public.dispatch_chat_templates to authenticated;

-- List: shared templates + the caller's private ones.
create or replace function public.dispatch_templates_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', t.id, 'name', t.name, 'shortcut', t.shortcut, 'body', t.body,
           'shared', t.shared, 'mine', (t.created_by = v_uid)
         ) order by t.name), '[]'::jsonb)
    into v_out
    from public.dispatch_chat_templates t
   where t.dsp_id = v_dsp and (t.shared or t.created_by = v_uid);
  return jsonb_build_object('templates', v_out);
end;
$$;
grant execute on function public.dispatch_templates_list() to authenticated;

-- Upsert: create when p_id is null, else edit (creator, or any staff for
-- shared templates — a team library shouldn't be locked to one author).
create or replace function public.dispatch_template_upsert(
  p_id       uuid    default null,
  p_name     text    default null,
  p_shortcut text    default null,
  p_body     text    default null,
  p_shared   boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_name text := trim(coalesce(p_name, ''));
  v_body text := trim(coalesce(p_body, ''));
  v_sc   text := nullif(lower(trim(coalesce(p_shortcut, ''))), '');
  v_id   uuid;
  v_row  public.dispatch_chat_templates;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if length(v_name) < 1 or length(v_name) > 80 then raise exception 'bad_name' using errcode = '22023'; end if;
  if length(v_body) < 1 or length(v_body) > 2000 then raise exception 'bad_body' using errcode = '22023'; end if;
  if v_sc is not null and v_sc !~ '^[a-z0-9_-]{1,24}$' then raise exception 'bad_shortcut' using errcode = '22023'; end if;

  if p_id is null then
    insert into public.dispatch_chat_templates (dsp_id, created_by, name, shortcut, body, shared)
    values (v_dsp, v_uid, v_name, v_sc, v_body, coalesce(p_shared, true))
    returning id into v_id;
  else
    select * into v_row from public.dispatch_chat_templates where id = p_id and dsp_id = v_dsp;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    if not v_row.shared and v_row.created_by is distinct from v_uid then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    update public.dispatch_chat_templates
       set name = v_name, shortcut = v_sc, body = v_body,
           shared = coalesce(p_shared, shared), updated_at = now()
     where id = p_id;
    v_id := p_id;
  end if;
  return jsonb_build_object('id', v_id);
end;
$$;
grant execute on function public.dispatch_template_upsert(uuid, text, text, text, boolean) to authenticated;

-- Delete: creator, or any staff for shared templates.
create or replace function public.dispatch_template_delete(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_row public.dispatch_chat_templates;
begin
  if v_dsp is null then raise exception 'unauthorized' using errcode = '42501'; end if;
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.dispatch_chat_templates where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if not v_row.shared and v_row.created_by is distinct from v_uid then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.dispatch_chat_templates where id = p_id;
  return jsonb_build_object('ok', true);
end;
$$;
grant execute on function public.dispatch_template_delete(uuid) to authenticated;
