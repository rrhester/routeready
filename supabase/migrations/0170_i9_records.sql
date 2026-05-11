-- Migration 0170 · Form I-9 — data model (rebuild, done properly)
--
-- An earlier I-9 attempt (0163) was reverted (0164 dropped it). This
-- is the foundation for the real workflow: one i9_records row per
-- driver + an append-only i9_events audit trail + staff RPCs to
-- capture Section 1 (employee info) and Section 2 (employer document
-- review / attestation), to anchor the 3-business-day clock, and to
-- reopen for corrections.
--
-- Driver-PWA Section-1 completion (the employee self-completes and
-- e-signs in the app) lands in a later slice via token-auth RPCs;
-- this slice supports the employer recording Section 1 as a bridge,
-- and the model already distinguishes section1_completed_via.
--
-- Status lifecycle:
--   not_started → section1_complete → verified
--   (any state)  → needs_correction → … → verified
--
-- Sensitive PII (SSN, document numbers) lives in the jsonb blobs; RLS
-- restricts the table to the owning DSP's dispatchers. Treat exports
-- accordingly. NOT legal advice — the official form rendering,
-- attestation wording, and procedure should be reviewed by counsel.

create table if not exists public.i9_records (
  id                        uuid primary key default gen_random_uuid(),
  dsp_id                    uuid not null references public.dsps(id) on delete cascade,
  driver_id                 uuid not null references public.drivers(id) on delete cascade,
  status                    text not null default 'not_started',
  first_day_of_employment   date,                       -- anchors the Section-1 deadline + the 3-business-day Section-2 clock

  -- ── Section 1 — employee information & attestation ──────────────────
  -- jsonb: { last_name, first_name, middle_initial, other_last_names,
  --          addr_street, addr_apt, addr_city, addr_state, addr_zip,
  --          dob, ssn, email, phone, citizen_status, auth_doc_type,
  --          auth_doc_number, auth_expires, preparer_used }
  section1                  jsonb not null default '{}'::jsonb,
  section1_signature        jsonb,                      -- { method:'drawn'|'typed', data, signer_name }
  section1_completed_at      timestamptz,
  section1_completed_via     text,                      -- 'employer' | 'driver_app'
  section1_signer_ip         text,
  section1_consent_version   text,
  section1_consent_text      text,

  -- ── Section 2 — employer review of identity / work-auth documents ──
  -- jsonb: { exam_method:'in_person'|'remote_alternative', list_used:'A'|'BC',
  --          documents:[{ list, title, issuing_authority, number, expires_on }],
  --          additional_info }
  section2                  jsonb not null default '{}'::jsonb,
  section2_document_paths    text[] not null default '{}',  -- storage paths for uploaded doc images
  section2_signature         jsonb,
  section2_completed_at      timestamptz,
  section2_completed_by      uuid references auth.users(id) on delete set null,
  section2_completed_by_name text,
  section2_completed_by_title text,
  section2_signer_ip         text,
  section2_consent_version   text,
  section2_consent_text      text,

  needs_correction_note     text,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  unique (driver_id)
);
create index i9_records_dsp_idx on public.i9_records (dsp_id, status);

create table if not exists public.i9_events (
  id              bigint generated always as identity primary key,
  i9_record_id    uuid not null references public.i9_records(id) on delete cascade,
  kind            text not null,           -- created | section1_requested | section1_saved | section1_completed | documents_uploaded | section2_completed | reopened | reverification_due
  actor_kind      text not null,           -- dispatcher | driver | system
  actor_user_id   uuid references auth.users(id) on delete set null,
  actor_driver_id uuid references public.drivers(id) on delete set null,
  actor_name      text,
  ip              text,
  event_data      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index i9_events_record_idx on public.i9_events (i9_record_id, id);

alter table public.i9_records enable row level security;
alter table public.i9_events  enable row level security;
-- Dispatchers (and up) of the owning DSP can see / write their records.
create policy "i9_records_rw" on public.i9_records
  for all using (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
create policy "i9_events_select" on public.i9_events
  for select using (exists (
    select 1 from public.i9_records r
     where r.id = i9_record_id and r.dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher')
  ));
-- i9_events has no insert/update/delete policy — only the RPCs (security
-- definer) below write to it.


-- ── helper: append an audit event ──────────────────────────────────────
create or replace function private.i9_log(
  p_record uuid, p_kind text, p_actor_kind text default 'dispatcher', p_data jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_name text; v_uid uuid := auth.uid();
begin
  if p_actor_kind = 'dispatcher' and v_uid is not null then
    begin select coalesce(nullif(trim(full_name),''), email) into v_name from public.app_users where id = v_uid; exception when others then v_name := null; end;
  end if;
  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_user_id, actor_name, event_data)
  values (p_record, p_kind, p_actor_kind, case when p_actor_kind = 'dispatcher' then v_uid end, v_name, coalesce(p_data, '{}'::jsonb));
end;
$$;


-- ── i9_ensure · create the record if missing ───────────────────────────
create or replace function public.i9_ensure(p_driver_id uuid)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv public.drivers;
  v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_drv from public.drivers where id = p_driver_id and dsp_id = v_dsp;
  if v_drv.id is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id;
  if v_row.id is null then
    insert into public.i9_records (dsp_id, driver_id, first_day_of_employment)
    values (v_dsp, p_driver_id, v_drv.hire_date)
    returning * into v_row;
    perform private.i9_log(v_row.id, 'created', 'dispatcher', '{}'::jsonb);
  end if;
  return v_row;
end;
$$;
grant execute on function public.i9_ensure(uuid) to authenticated;


-- ── i9_set_first_day · adjust the start date the clocks key off ────────
create or replace function public.i9_set_first_day(p_driver_id uuid, p_date date)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  v_row := public.i9_ensure(p_driver_id);
  update public.i9_records set first_day_of_employment = p_date, updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, 'first_day_set', 'dispatcher', jsonb_build_object('first_day_of_employment', p_date));
  return v_row;
end;
$$;
grant execute on function public.i9_set_first_day(uuid, date) to authenticated;


-- ── i9_save_section1 · record employee info (employer-side bridge) ─────
create or replace function public.i9_save_section1(
  p_driver_id uuid,
  p_section1  jsonb,
  p_complete  boolean default false,
  p_signature jsonb default null,
  p_consent_version text default null,
  p_consent_text    text default null
) returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_section1 is null or jsonb_typeof(p_section1) <> 'object' then raise exception 'section1_must_be_object' using errcode = '22023'; end if;
  v_row := public.i9_ensure(p_driver_id);
  update public.i9_records
     set section1 = p_section1,
         section1_signature       = case when p_complete then p_signature else section1_signature end,
         section1_completed_at    = case when p_complete then now() else section1_completed_at end,
         section1_completed_via   = case when p_complete then 'employer' else section1_completed_via end,
         section1_consent_version = case when p_complete then p_consent_version else section1_consent_version end,
         section1_consent_text    = case when p_complete then p_consent_text else section1_consent_text end,
         status = case when p_complete and status in ('not_started','section1_complete','needs_correction') then 'section1_complete' else status end,
         updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, case when p_complete then 'section1_completed' else 'section1_saved' end, 'dispatcher', '{}'::jsonb);
  return v_row;
end;
$$;
grant execute on function public.i9_save_section1(uuid, jsonb, boolean, jsonb, text, text) to authenticated;


-- ── i9_complete_section2 · employer document review + attestation ──────
create or replace function public.i9_complete_section2(
  p_driver_id        uuid,
  p_section2         jsonb,
  p_document_paths   text[] default '{}',
  p_signature        jsonb default null,
  p_signer_title     text default null,
  p_consent_version  text default null,
  p_consent_text     text default null
) returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_uid uuid := auth.uid(); v_name text; v_row public.i9_records;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_section2 is null or jsonb_typeof(p_section2) <> 'object' then raise exception 'section2_must_be_object' using errcode = '22023'; end if;
  v_row := public.i9_ensure(p_driver_id);
  if v_row.status = 'not_started' then raise exception 'section1_not_complete' using errcode = 'P0001'; end if;
  begin select coalesce(nullif(trim(full_name),''), email) into v_name from public.app_users where id = v_uid; exception when others then v_name := null; end;
  update public.i9_records
     set section2 = p_section2,
         section2_document_paths = coalesce(p_document_paths, '{}'),
         section2_signature      = p_signature,
         section2_completed_at   = now(),
         section2_completed_by   = v_uid,
         section2_completed_by_name  = v_name,
         section2_completed_by_title = p_signer_title,
         section2_consent_version = p_consent_version,
         section2_consent_text    = p_consent_text,
         needs_correction_note = null,
         status = 'verified',
         updated_at = now()
   where id = v_row.id returning * into v_row;
  perform private.i9_log(v_row.id, 'section2_completed', 'dispatcher',
    jsonb_build_object('exam_method', p_section2->>'exam_method', 'document_count', coalesce(array_length(p_document_paths,1),0)));
  return v_row;
end;
$$;
grant execute on function public.i9_complete_section2(uuid, jsonb, text[], jsonb, text, text, text) to authenticated;


-- ── i9_reopen · reopen for correction ─────────────────────────────────
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
  perform private.i9_log(v_row.id, 'reopened', 'dispatcher', jsonb_build_object('reason', p_reason));
  return v_row;
end;
$$;
grant execute on function public.i9_reopen(uuid, text) to authenticated;

notify pgrst, 'reload schema';
