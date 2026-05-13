-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0191 · Onboarding notes
--
-- Internal, timestamped notes a DSP keeps against a driver while they're in
-- onboarding — context, follow-ups, "called about the I-9 on Tuesday", etc.
-- These are never surfaced to the driver; they're staff-only and scoped to
-- the DSP.  The Orientation dashboard's right-side Notes drawer reads/writes
-- through the three RPCs below; every keystroke autosaves, so there is no
-- "save" verb anywhere in the UI.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.onboarding_notes (
  id          uuid primary key default gen_random_uuid(),
  dsp_id      uuid not null references public.dsps(id)    on delete cascade,
  driver_id   uuid not null references public.drivers(id) on delete cascade,
  body        text not null default '',
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now()
);

create index if not exists onboarding_notes_driver_idx
  on public.onboarding_notes (dsp_id, driver_id, created_at);

alter table public.onboarding_notes enable row level security;
drop policy if exists "onboarding_notes_rw" on public.onboarding_notes;
create policy "onboarding_notes_rw" on public.onboarding_notes
  for all
  using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));

-- All notes for one driver, oldest → newest (chronological log order).
create or replace function public.onboarding_notes_list(p_driver_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_out jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id',         n.id,
             'body',       n.body,
             'created_at', n.created_at,
             'updated_at', n.updated_at,
             'author',     coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate'),
             'mine',       (n.created_by = auth.uid())
           ) order by n.created_at, n.id
         ), '[]'::jsonb)
    into v_out
    from public.onboarding_notes n
    left join public.app_users au on au.id = n.created_by
   where n.dsp_id = v_dsp and n.driver_id = p_driver_id;
  return v_out;
end;
$$;
grant execute on function public.onboarding_notes_list(uuid) to authenticated;

-- Upsert one note.  p_id null → insert a new note (returns it, so the UI
-- can hang the id off the freshly-typed card); p_id set → update the body
-- of an existing note in place.
create or replace function public.onboarding_note_save(p_driver_id uuid, p_body text, p_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.onboarding_notes; v_author text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_id is null then
    insert into public.onboarding_notes (dsp_id, driver_id, body, created_by, updated_by)
    values (v_dsp, p_driver_id, coalesce(p_body, ''), auth.uid(), auth.uid())
    returning * into v_row;
  else
    update public.onboarding_notes
       set body = coalesce(p_body, ''), updated_by = auth.uid(), updated_at = now()
     where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'note_not_found' using errcode = 'P0002'; end if;
  end if;
  select coalesce(nullif(trim(au.full_name), ''), au.email, 'A teammate')
    into v_author from public.app_users au where au.id = v_row.created_by;
  return jsonb_build_object(
    'id', v_row.id, 'body', v_row.body, 'created_at', v_row.created_at, 'updated_at', v_row.updated_at,
    'author', coalesce(v_author, 'A teammate'), 'mine', (v_row.created_by = auth.uid())
  );
end;
$$;
grant execute on function public.onboarding_note_save(uuid, text, uuid) to authenticated;

create or replace function public.onboarding_note_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.onboarding_notes where id = p_id and dsp_id = v_dsp;
end;
$$;
grant execute on function public.onboarding_note_delete(uuid) to authenticated;

notify pgrst, 'reload schema';
