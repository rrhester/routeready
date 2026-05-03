-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0021 · Driver record buildout + decline email + coachings + docs
--
-- Five things:
--
--   1. Email template for applicant.decline (was SMS-only).
--
--   2. drivers gains personal-record columns the DSP asked for:
--        preferred_name, pronouns,
--        address, birthday,
--        emergency_contact_name, emergency_contact_phone,
--        dl_number, dl_expires_on, dl_image_path.
--      DSP can hide pronouns from the UI via dsps.metadata.drivers.show_pronouns.
--
--   3. coachings table — every coaching session, per driver.
--
--   4. driver_documents table — generic doc store (DL, MVR, etc.) for
--      drivers, with storage-bucket linkage.
--
--   5. driver-documents storage bucket (private, tenant-scoped read/write).
-- ─────────────────────────────────────────────────────────────────────────


-- ─── 1. applicant.decline email template ────────────────────────────────

insert into public.message_templates (dsp_id, channel, key, name, subject, body) values
  ('00000000-0000-0000-0000-00000000d000', 'email', 'applicant.decline',
   'Decline notice (email)',
   'Update on your RouteReady application',
   E'Hi {{first_name}},\n\nThanks for your interest in RouteReady. After review, we won''t be moving forward with your application at this time. We wish you the best in your job search.\n\n— The RouteReady team')
on conflict (dsp_id, channel, key) do update
  set body = excluded.body, subject = excluded.subject, updated_at = now();


-- ─── 2. drivers personal-record columns ─────────────────────────────────

alter table public.drivers
  add column if not exists preferred_name           text,
  add column if not exists pronouns                 text,
  add column if not exists address                  text,
  add column if not exists birthday                 date,
  add column if not exists emergency_contact_name   text,
  add column if not exists emergency_contact_phone  text,
  add column if not exists dl_number                text,
  add column if not exists dl_expires_on            date,
  add column if not exists dl_image_path            text;

create index if not exists drivers_dl_expires_idx
  on public.drivers (dsp_id, dl_expires_on)
  where dl_expires_on is not null;

-- DSP-wide toggle: show pronouns on driver records?
update public.dsps
   set metadata = coalesce(metadata, '{}'::jsonb)
                  || jsonb_build_object('drivers',
                       coalesce(metadata->'drivers', '{}'::jsonb)
                       || jsonb_build_object('show_pronouns', true))
 where short_code = 'DEMO'
   and (metadata->'drivers'->'show_pronouns') is null;


-- ─── 3. coachings table ─────────────────────────────────────────────────

create type public.coaching_type as enum (
  'in_person',
  'sms',
  'email',
  'phone_call',
  'video_call',
  'documented_warning'
);

create type public.coaching_topic as enum (
  'safety',
  'performance',
  'attendance',
  'behavior',
  'recognition',
  'other'
);

create table public.coachings (
  id              uuid                        primary key default gen_random_uuid(),
  dsp_id          uuid                        not null references public.dsps(id) on delete cascade,
  driver_id       uuid                        not null references public.drivers(id) on delete cascade,
  coach_user_id   uuid                        references public.app_users(id) on delete set null,

  occurred_at     timestamptz                 not null default now(),
  topic           public.coaching_topic       not null default 'other',
  type            public.coaching_type        not null default 'in_person',
  summary         text,                       -- one-line headline shown on lists
  notes           text,                       -- detailed write-up
  follow_up_at    timestamptz,                -- optional check-back date

  metadata        jsonb                       not null default '{}'::jsonb,
  created_at      timestamptz                 not null default now(),
  updated_at      timestamptz                 not null default now()
);

create index coachings_driver_recent_idx
  on public.coachings (driver_id, occurred_at desc);

create index coachings_dsp_recent_idx
  on public.coachings (dsp_id, occurred_at desc);

create index coachings_topic_idx
  on public.coachings (dsp_id, topic, occurred_at desc);

create trigger trg_coachings_updated_at
  before update on public.coachings
  for each row execute function private.set_updated_at();

alter table public.coachings enable row level security;

create policy "coachings_tenant_rw"
  on public.coachings for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.coachings to authenticated;


-- ─── 4. driver_documents table ──────────────────────────────────────────

create type public.driver_document_kind as enum (
  'drivers_license',
  'mvr',                  -- Motor Vehicle Record
  'dot_medical',
  'background_check',
  'social_security',
  'i9',                   -- Form I-9
  'w4',                   -- Form W-4
  'direct_deposit',
  'vehicle_registration',
  'insurance',
  'other'
);

create table public.driver_documents (
  id              uuid                          primary key default gen_random_uuid(),
  dsp_id          uuid                          not null references public.dsps(id) on delete cascade,
  driver_id       uuid                          not null references public.drivers(id) on delete cascade,

  kind            public.driver_document_kind   not null,
  label           text,                         -- free-form label override
  file_path       text,                         -- storage object key
  file_size       int,
  mime_type       text,
  expires_on      date,                         -- expiry / renewal date

  uploaded_by     uuid                          references public.app_users(id) on delete set null,
  metadata        jsonb                         not null default '{}'::jsonb,
  created_at      timestamptz                   not null default now(),
  updated_at      timestamptz                   not null default now()
);

create index driver_documents_driver_idx
  on public.driver_documents (driver_id, created_at desc);

create index driver_documents_expires_idx
  on public.driver_documents (dsp_id, expires_on)
  where expires_on is not null;

create trigger trg_driver_documents_updated_at
  before update on public.driver_documents
  for each row execute function private.set_updated_at();

alter table public.driver_documents enable row level security;

create policy "driver_documents_tenant_rw"
  on public.driver_documents for all
  using (dsp_id = private.current_dsp_id())
  with check (dsp_id = private.current_dsp_id());

grant select, insert, update, delete on public.driver_documents to authenticated;


-- ─── 5. driver-documents storage bucket ─────────────────────────────────

insert into storage.buckets (id, name, public)
values ('driver-documents', 'driver-documents', false)
on conflict (id) do nothing;

-- Tenant staff can read + write files in their DSP. Files are keyed
-- "<dsp_id>/<driver_id>/<filename>" so the foldername prefix gates
-- access to the right tenant.
create policy "driver_docs_tenant_select"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "driver_docs_tenant_insert"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );

create policy "driver_docs_tenant_delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'driver-documents'
    and (storage.foldername(name))[1]::uuid = private.current_dsp_id()
  );


-- ─── Convenience: driver record summary ─────────────────────────────────

create or replace function public.driver_record(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_drv jsonb;
  v_coachings jsonb;
  v_docs jsonb;
begin
  select to_jsonb(d) into v_drv
  from public.drivers d
  where d.id = p_id and d.dsp_id = v_dsp;
  if v_drv is null then raise exception 'driver_not_found' using errcode = 'P0002'; end if;

  select coalesce(jsonb_agg(to_jsonb(c) order by c.occurred_at desc), '[]'::jsonb)
    into v_coachings
  from public.coachings c
  where c.driver_id = p_id and c.dsp_id = v_dsp;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb)
    into v_docs
  from public.driver_documents x
  where x.driver_id = p_id and x.dsp_id = v_dsp;

  return jsonb_build_object(
    'driver',     v_drv,
    'coachings',  v_coachings,
    'documents',  v_docs
  );
end;
$$;
grant execute on function public.driver_record(uuid) to authenticated;


-- ─── Extend screening_load with video config ────────────────────────────
--
-- The applicant-facing screening page reads video settings (enabled,
-- prompt, max length) from the response so the operator's toggle in
-- Settings → Screening actually controls what applicants see.

create or replace function public.screening_load(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_app public.applicants;
  v_dsp public.dsps;
  v_questions jsonb;
  v_video jsonb;
begin
  v_app := private.applicant_for_token('screening', p_token);
  if v_app.id is null then
    raise exception 'invalid_or_expired_token' using errcode = 'P0002';
  end if;
  if v_app.status in ('rejected','auto_declined','hired','no_show','not_hired') then
    raise exception 'screening_closed';
  end if;

  select * into v_dsp from public.dsps where id = v_app.dsp_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', q.id, 'prompt', q.prompt, 'field_type', q.field_type,
    'options', q.options, 'required', q.required, 'display_order', q.display_order
  ) order by q.display_order), '[]'::jsonb)
  into v_questions
  from public.screening_questions q
  where q.dsp_id = v_app.dsp_id and q.active = true;

  v_video := coalesce(v_dsp.metadata->'video', '{}'::jsonb);

  return jsonb_build_object(
    'applicant', jsonb_build_object(
      'id', v_app.id,
      'first_name', v_app.first_name,
      'full_name', v_app.full_name,
      'status', v_app.status
    ),
    'questions', v_questions,
    'video', jsonb_build_object(
      'enabled', coalesce((v_video->>'enabled')::boolean, true),
      'prompt',  coalesce(v_video->>'prompt',
                          'Tell us about yourself and why you''d be a great fit for our team.'),
      'max_seconds', coalesce((v_video->>'max_seconds')::int, 60)
    )
  );
end;
$$;
grant execute on function public.screening_load(text) to anon, authenticated;
