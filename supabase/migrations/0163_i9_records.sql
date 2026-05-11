-- Migration 0163 · Form I-9 (Employment Eligibility Verification)
--
-- Integrates I-9 work-authorization verification into the existing
-- onboarding/document ecosystem. One i9_records row per driver, a
-- hash-light append-only i9_events audit trail, and staff RPCs to
-- capture Section 1 (employee info) + Section 2 (employer document
-- review / attestation) and to reopen for corrections.
--
-- v1 is employer-driven: a dispatcher records Section 1 (from what the
-- employee provided) and completes Section 2. A future slice moves
-- Section 1 into the driver PWA via token-auth RPCs; the data model
-- already supports that (section1 jsonb + section1_completed_via).
--
-- Status lifecycle:
--   not_started → section1_complete → verified
--   (any state) → needs_correction → … → verified
--
-- Sensitive PII (SSN, document numbers) lives in the jsonb blobs. RLS
-- restricts the table to the owning DSP's staff; drivers never read it
-- directly. Treat exports accordingly.

create table if not exists public.i9_records (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  driver_id             uuid not null references public.drivers(id) on delete cascade,
  status                text not null default 'not_started',
  -- Section 1 — employee information & attestation.
  section1              jsonb not null default '{}'::jsonb,
  section1_completed_at  timestamptz,
  section1_completed_via text,            -- 'employer' | 'driver_app'
  section1_signer_ip     text,
  -- Section 2 — employer review of identity / work-authorization docs.
  section2              jsonb not null default '{}'::jsonb,   -- { option:'A'|'BC', documents:[{list,title,authority,number,expires_on}], first_day_of_employment }
  section2_completed_at  timestamptz,
  section2_completed_by  uuid references auth.users(id) on delete set null,
  section2_completed_by_name text,
  -- Supporting document images live in the 'documents' bucket; paths here.
  document_paths         text[] not null default '{}',
  needs_correction_note  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (driver_id)
);
create index i9_records_dsp_idx on public.i9_records (dsp_id, status);

create table if not exists public.i9_events (
  id            bigint generated always as identity primary key,
  i9_record_id  uuid not null references public.i9_records(id) on delete cascade,
  kind          text not null,           -- 'created' | 'section1_saved' | 'section1_completed' | 'section2_completed' | 'reopened' | 'document_added'
  actor_kind    text not null,           -- 'dispatcher' | 'driver' | 'system'
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_name    text,
  actor_driver_id uuid references public.drivers(id) on delete set null,
  ip            text,
  event_data    jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index i9_events_record_idx on public.i9_events (i9_record_id, id);

alter table public.i9_records enable row level security;
alter table public.i9_events  enable row level security;
create policy "i9_records_rw" on public.i9_records
  for all using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
create policy "i9_events_select" on public.i9_events
  for select using (exists (
    select 1 from public.i9_records r where r.id = i9_record_id and r.dsp_id = private.current_dsp_id()
  ));
-- i9_events has no insert/update/delete policy — only the RPCs below
-- (security definer) write to it.


-- ── helpers ────────────────────────────────────────────────────────────
create or replace function private.i9_log(
  p_record uuid, p_kind text, p_data jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_name text; v_uid uuid := auth.uid();
begin
  begin select coalesce(nullif(trim(full_name),''), email) into v_name from public.app_users where id = v_uid; exception when others then v_name := null; end;
  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_user_id, actor_name, event_data)
  values (p_record, p_kind, 'dispatcher', v_uid, v_name, coalesce(p_data, '{}'::jsonb));
end;
$$;

create or replace function public.i9_ensure(p_driver_id uuid)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers; v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id;
  if v_row.id is null then
    insert into public.i9_records (dsp_id, driver_id) values (v_dsp, p_driver_id) returning * into v_row;
    perform private.i9_log(v_row.id, 'created', '{}'::jsonb);
  end if;
  return v_row;
end;
$$;
grant execute on function public.i9_ensure(uuid) to authenticated;

create or replace function public.i9_save_section1(p_driver_id uuid, p_section1 jsonb, p_complete boolean default false)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_row := public.i9_ensure(p_driver_id);
  update public.i9_records
     set section1 = coalesce(p_section1, '{}'::jsonb),
         section1_completed_at = case when p_complete then now() else section1_completed_at end,
         section1_completed_via = case when p_complete then 'employer' else section1_completed_via end,
         status = case when p_complete and status in ('not_started','section1_complete','needs_correction') then 'section1_complete' else status end,
         updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, case when p_complete then 'section1_completed' else 'section1_saved' end, '{}'::jsonb);
  return v_row;
end;
$$;
grant execute on function public.i9_save_section1(uuid, jsonb, boolean) to authenticated;

create or replace function public.i9_complete_section2(p_driver_id uuid, p_section2 jsonb, p_document_paths text[] default '{}')
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_name text; v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_section2 is null or jsonb_typeof(p_section2) <> 'object' then raise exception 'section2_must_be_object' using errcode = '22023'; end if;
  v_row := public.i9_ensure(p_driver_id);
  begin select coalesce(nullif(trim(full_name),''), email) into v_name from public.app_users where id = v_uid; exception when others then v_name := null; end;
  update public.i9_records
     set section2 = p_section2,
         document_paths = coalesce(p_document_paths, '{}'),
         section2_completed_at = now(),
         section2_completed_by = v_uid,
         section2_completed_by_name = v_name,
         needs_correction_note = null,
         status = 'verified',
         updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, 'section2_completed', jsonb_build_object('document_count', coalesce(array_length(p_document_paths,1),0)));
  return v_row;
end;
$$;
grant execute on function public.i9_complete_section2(uuid, jsonb, text[]) to authenticated;

create or replace function public.i9_reopen(p_driver_id uuid, p_reason text)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'i9_not_found' using errcode = 'P0002'; end if;
  update public.i9_records set status = 'needs_correction', needs_correction_note = p_reason, updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, 'reopened', jsonb_build_object('reason', p_reason));
  return v_row;
end;
$$;
grant execute on function public.i9_reopen(uuid, text) to authenticated;

notify pgrst, 'reload schema';
