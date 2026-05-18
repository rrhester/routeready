-- Migration 0297 · Vehicle documents — insurance + registration with
-- expiration tracking, fleet-side upload/replace, driver-side view +
-- report, and an append-only audit log.  Surfaces operational exceptions
-- (missing / expired / expiring-soon) on the Fleet roster.
--
-- New surfaces:
--   • vehicle_documents      — one row per uploaded version
--   • vehicle_document_events — append-only audit (view/upload/report/replace)
--   • dsp_vehicle_doc_settings — per-DSP "expiring soon" threshold (days)
--
-- RPCs:
--   • vehicle_documents_for_vehicle(uuid)
--   • vehicle_document_save(…)
--   • vehicle_document_delete(uuid)
--   • vehicle_documents_overview()                — fleet roster decoration
--   • vehicle_doc_settings_get() / _set(int)
--   • driver_assigned_van(text)                   — driver-app payload
--   • driver_vehicle_document_view(text, uuid, text, text)
--   • driver_report_vehicle_document(text, uuid, text, text)
--
-- Storage:
--   • bucket `vehicle-documents` (private).  Path = "<dsp_id>/<vehicle_id>/<kind>/<filename>"
--   • Staff (dispatcher+) RW their DSP's prefix; driver app gets signed
--     URLs from the `vehicle-document-fetch` edge function (service role).
--
-- Idempotent: re-runs cleanly after a partial apply.


-- ── 1. Tables ────────────────────────────────────────────────────────

create table if not exists public.vehicle_documents (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  kind            text not null check (kind in ('insurance','registration')),
  document_number text,                                  -- policy # / reg #
  expiration_date date,
  file_path       text,                                  -- storage path; null = "missing"
  file_name       text,
  file_mime       text,
  file_size_bytes int,
  notes           text,
  replaces_id     uuid references public.vehicle_documents(id) on delete set null,
  replaced_at     timestamptz,                           -- non-null = superseded
  uploaded_by     uuid references auth.users(id) on delete set null,
  uploaded_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists vehicle_documents_vehicle_idx
  on public.vehicle_documents (vehicle_id, kind, replaced_at, expiration_date);
create index if not exists vehicle_documents_dsp_active_idx
  on public.vehicle_documents (dsp_id, kind)
  where replaced_at is null;

-- Only one non-replaced row per (vehicle_id, kind) so the "active"
-- version is always unambiguous.  Replacements set replaced_at on the
-- prior row before inserting the new one.
create unique index if not exists vehicle_documents_active_uq
  on public.vehicle_documents (vehicle_id, kind)
  where replaced_at is null;

alter table public.vehicle_documents enable row level security;
drop policy if exists "vehicle_documents_rw" on public.vehicle_documents;
create policy "vehicle_documents_rw" on public.vehicle_documents
  for all using      (dsp_id = private.current_dsp_id()
                      and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id()
                      and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select, insert, update, delete on public.vehicle_documents to authenticated;


create table if not exists public.vehicle_document_events (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  vehicle_id          uuid not null references public.vehicles(id) on delete cascade,
  vehicle_document_id uuid references public.vehicle_documents(id) on delete set null,
  doc_kind            text,                              -- snapshot at time of event
  kind                text not null,                     -- driver_viewed | driver_reported | fleet_uploaded | fleet_replaced | fleet_deleted
  actor_kind          text not null,                     -- driver | staff | system
  driver_id           uuid references public.drivers(id) on delete set null,
  actor_user_id       uuid references auth.users(id) on delete set null,
  ip                  text,
  user_agent          text,
  payload             jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists vehicle_document_events_doc_idx
  on public.vehicle_document_events (vehicle_document_id, created_at desc);
create index if not exists vehicle_document_events_vehicle_idx
  on public.vehicle_document_events (vehicle_id, created_at desc);
create index if not exists vehicle_document_events_dsp_idx
  on public.vehicle_document_events (dsp_id, created_at desc);

alter table public.vehicle_document_events enable row level security;
-- Read-only for staff via RLS; all inserts come from security-definer RPCs.
drop policy if exists "vehicle_document_events_read" on public.vehicle_document_events;
create policy "vehicle_document_events_read" on public.vehicle_document_events
  for select using (dsp_id = private.current_dsp_id()
                    and private.is_staff(private.current_dsp_id(), 'dispatcher'));

grant select on public.vehicle_document_events to authenticated;


create table if not exists public.dsp_vehicle_doc_settings (
  dsp_id              uuid primary key references public.dsps(id) on delete cascade,
  expiring_soon_days  int  not null default 30 check (expiring_soon_days between 1 and 365),
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now()
);
alter table public.dsp_vehicle_doc_settings enable row level security;
drop policy if exists "dsp_vehicle_doc_settings_rw" on public.dsp_vehicle_doc_settings;
create policy "dsp_vehicle_doc_settings_rw" on public.dsp_vehicle_doc_settings
  for all using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'))
          with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), 'dispatcher'));
grant select, insert, update, delete on public.dsp_vehicle_doc_settings to authenticated;


-- ── 2. Storage bucket + policies ─────────────────────────────────────
insert into storage.buckets (id, name, public)
  values ('vehicle-documents', 'vehicle-documents', false)
  on conflict (id) do nothing;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'vehicle_documents_staff_read'
  ) then
    create policy "vehicle_documents_staff_read" on storage.objects for select
      using (
        bucket_id = 'vehicle-documents'
        and split_part(name, '/', 1) = private.current_dsp_id()::text
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
      );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'vehicle_documents_staff_write'
  ) then
    create policy "vehicle_documents_staff_write" on storage.objects for insert
      with check (
        bucket_id = 'vehicle-documents'
        and split_part(name, '/', 1) = private.current_dsp_id()::text
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
      );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'vehicle_documents_staff_update'
  ) then
    create policy "vehicle_documents_staff_update" on storage.objects for update
      using (
        bucket_id = 'vehicle-documents'
        and split_part(name, '/', 1) = private.current_dsp_id()::text
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
      );
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'vehicle_documents_staff_delete'
  ) then
    create policy "vehicle_documents_staff_delete" on storage.objects for delete
      using (
        bucket_id = 'vehicle-documents'
        and split_part(name, '/', 1) = private.current_dsp_id()::text
        and private.is_staff(private.current_dsp_id(), 'dispatcher')
      );
  end if;
end $$;


-- ── 3. Internal helpers ──────────────────────────────────────────────

-- Resolve the driver's van for `p_date` (today by default).  Mirrors
-- the per-day resolution baked into driver_vehicle_days (0187) + the
-- DVIC/concerns van-resolver (0289) so the driver app gets the same van
-- their inspection / concern form would attach to.
create or replace function private.driver_van_for(p_driver public.drivers, p_date date default current_date)
returns public.vehicles
language plpgsql stable security definer set search_path = ''
as $$
declare v_v public.vehicles;
begin
  select v.* into v_v
  from public.vehicles v
  where v.dsp_id = p_driver.dsp_id
    and v.archived_at is null
    and v.id = coalesce(
      -- per-day override for this driver
      (select vehicle_id from public.vehicle_day_assignments
        where driver_id = p_driver.id and date = p_date and dsp_id = p_driver.dsp_id
        limit 1),
      -- primary van (rank 0) when not overridden
      (select v2.id from public.vehicles v2
         join public.vehicle_driver_assignments a on a.vehicle_id = v2.id and a.driver_id = p_driver.id and a.rank = 0
        where v2.dsp_id = p_driver.dsp_id and v2.status = 'active' and v2.archived_at is null
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v2.id and oa.date = p_date
          )
        order by v2.name limit 1),
      -- backup van when primary isn't scheduled
      (select v3.id from public.vehicles v3
         join public.vehicle_driver_assignments a on a.vehicle_id = v3.id and a.driver_id = p_driver.id and a.rank > 0
         left join public.vehicle_driver_assignments pri_a on pri_a.vehicle_id = v3.id and pri_a.rank = 0
        where v3.dsp_id = p_driver.dsp_id and v3.status = 'active' and v3.archived_at is null
          and not exists (
            select 1 from public.vehicle_day_assignments oa
            where oa.vehicle_id = v3.id and oa.date = p_date
          )
          and (pri_a.driver_id is null
            or not exists (
              select 1 from public.shifts ps
              where ps.driver_id = pri_a.driver_id and ps.date = p_date
                and ps.dsp_id = p_driver.dsp_id and ps.status in ('scheduled','completed','late')
            ))
        order by a.rank, v3.name limit 1)
    );
  return v_v;
end;
$$;


-- The "expiring soon" threshold for a DSP, with sensible default.
create or replace function private.vehicle_doc_threshold(p_dsp_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select expiring_soon_days from public.dsp_vehicle_doc_settings where dsp_id = p_dsp_id),
    30
  );
$$;


-- ── 4. RPCs — staff-side ─────────────────────────────────────────────

-- List every document (history) for a vehicle.  Used by the Documents
-- tab in the fleet drawer.  Computes a derived `status` per row.
create or replace function public.vehicle_documents_for_vehicle(p_vehicle_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',              d.id,
             'kind',            d.kind,
             'document_number', d.document_number,
             'expiration_date', d.expiration_date,
             'file_path',       d.file_path,
             'file_name',       d.file_name,
             'file_mime',       d.file_mime,
             'file_size_bytes', d.file_size_bytes,
             'notes',           d.notes,
             'replaces_id',     d.replaces_id,
             'replaced_at',     d.replaced_at,
             'uploaded_at',     d.uploaded_at,
             'created_at',      d.created_at,
             'updated_at',      d.updated_at,
             'status', case
                         when d.replaced_at is not null then 'replaced'
                         when d.file_path is null then 'missing'
                         when d.expiration_date is not null and d.expiration_date < current_date then 'expired'
                         else 'active'
                       end,
             'days_until_expiration', case
                         when d.expiration_date is null then null
                         else (d.expiration_date - current_date)
                       end
           ) order by d.kind, d.replaced_at nulls first, d.created_at desc)
    from public.vehicle_documents d
    where d.vehicle_id = p_vehicle_id and d.dsp_id = v_dsp
  ), '[]'::jsonb);
end;
$$;
grant execute on function public.vehicle_documents_for_vehicle(uuid) to authenticated;


-- Upsert a vehicle document.  When p_id is null this is treated as a
-- new version: any prior non-replaced row for the same (vehicle_id, kind)
-- is marked replaced_at = now() and the new row links to it via
-- replaces_id.  When p_id is not null we update fields on that row in
-- place (used to fix metadata without uploading a new file).
create or replace function public.vehicle_document_save(
  p_id              uuid    default null,
  p_vehicle_id      uuid    default null,
  p_kind            text    default null,
  p_document_number text    default null,
  p_expiration_date date    default null,
  p_file_path       text    default null,
  p_file_name       text    default null,
  p_file_mime       text    default null,
  p_file_size_bytes int     default null,
  p_notes           text    default null
) returns public.vehicle_documents
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_documents;
  v_prior_id uuid;
  v_event_kind text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('insurance','registration') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_id is null then
    if p_vehicle_id is null then raise exception 'vehicle_id_required' using errcode = '22023'; end if;
    if not exists (select 1 from public.vehicles where id = p_vehicle_id and dsp_id = v_dsp) then
      raise exception 'vehicle_not_found' using errcode = 'P0002';
    end if;

    -- Path must start with "<dsp_id>/<vehicle_id>/" when provided.  We
    -- skip the check when no file is being uploaded (just a metadata
    -- placeholder so fleet can stage an upcoming renewal).
    if p_file_path is not null and p_file_path <> ''
       and not (p_file_path like v_dsp::text || '/' || p_vehicle_id::text || '/%') then
      raise exception 'invalid_file_path' using errcode = '42501';
    end if;

    -- Supersede the currently-active row for this (vehicle, kind).
    update public.vehicle_documents
       set replaced_at = now(), updated_at = now()
     where vehicle_id = p_vehicle_id and kind = p_kind
       and dsp_id = v_dsp and replaced_at is null
    returning id into v_prior_id;

    insert into public.vehicle_documents (
      dsp_id, vehicle_id, kind, document_number, expiration_date,
      file_path, file_name, file_mime, file_size_bytes, notes,
      replaces_id, uploaded_by, uploaded_at
    ) values (
      v_dsp, p_vehicle_id, p_kind,
      nullif(trim(p_document_number), ''),
      p_expiration_date,
      nullif(p_file_path, ''),
      nullif(trim(p_file_name), ''),
      nullif(trim(p_file_mime), ''),
      p_file_size_bytes,
      nullif(trim(p_notes), ''),
      v_prior_id,
      auth.uid(),
      case when p_file_path is not null and p_file_path <> '' then now() else null end
    ) returning * into v_row;

    v_event_kind := case when v_prior_id is not null then 'fleet_replaced' else 'fleet_uploaded' end;
    insert into public.vehicle_document_events
      (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, actor_user_id, payload)
    values (
      v_dsp, p_vehicle_id, v_row.id, p_kind, v_event_kind, 'staff', auth.uid(),
      jsonb_build_object(
        'expiration_date', p_expiration_date,
        'file_uploaded',   p_file_path is not null and p_file_path <> '',
        'document_number_set', nullif(trim(p_document_number), '') is not null,
        'previous_id', v_prior_id
      )
    );
  else
    update public.vehicle_documents set
      document_number = nullif(trim(p_document_number), ''),
      expiration_date = coalesce(p_expiration_date, expiration_date),
      file_path       = coalesce(nullif(p_file_path, ''), file_path),
      file_name       = coalesce(nullif(trim(p_file_name), ''), file_name),
      file_mime       = coalesce(nullif(trim(p_file_mime), ''), file_mime),
      file_size_bytes = coalesce(p_file_size_bytes, file_size_bytes),
      notes           = nullif(trim(p_notes), ''),
      updated_at      = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'document_not_found' using errcode = 'P0002'; end if;
    insert into public.vehicle_document_events
      (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, actor_user_id, payload)
    values (
      v_dsp, v_row.vehicle_id, v_row.id, v_row.kind, 'fleet_uploaded', 'staff', auth.uid(),
      jsonb_build_object('edit_only', true)
    );
  end if;
  return v_row;
end;
$$;
grant execute on function public.vehicle_document_save(
  uuid, uuid, text, text, date, text, text, text, int, text
) to authenticated;


create or replace function public.vehicle_document_delete(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vehicle_documents;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.vehicle_documents where id = p_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  delete from public.vehicle_documents where id = p_id and dsp_id = v_dsp;
  insert into public.vehicle_document_events
    (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, actor_user_id, payload)
  values (v_dsp, v_row.vehicle_id, null, v_row.kind, 'fleet_deleted', 'staff', auth.uid(),
          jsonb_build_object('deleted_document_id', v_row.id));
end;
$$;
grant execute on function public.vehicle_document_delete(uuid) to authenticated;


-- Fleet-wide overview: per-vehicle worst document state.  Used to
-- decorate vehicles_roster + power the Fleet Roster exception filters.
create or replace function public.vehicle_documents_overview()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with active as (
    select d.*,
           case
             when d.file_path is null then 'missing'
             when d.expiration_date is not null and d.expiration_date < current_date then 'expired'
             when d.expiration_date is not null
                  and d.expiration_date <= current_date + private.vehicle_doc_threshold(d.dsp_id) then 'expiring_soon'
             else 'active'
           end as derived_status,
           case when d.expiration_date is null then null else (d.expiration_date - current_date) end as days_until
    from public.vehicle_documents d
    where d.dsp_id = private.current_dsp_id()
      and d.replaced_at is null
      and private.is_staff(d.dsp_id, 'dispatcher')
  ),
  rolled as (
    select v.id as vehicle_id,
           jsonb_object_agg(
             k.kind,
             coalesce(
               (select to_jsonb(a) - 'dsp_id' - 'vehicle_id' || jsonb_build_object('derived_status', a.derived_status, 'days_until', a.days_until)
                  from active a where a.vehicle_id = v.id and a.kind = k.kind),
               jsonb_build_object('derived_status', 'missing', 'kind', k.kind)
             )
           ) as docs
    from public.vehicles v
    cross join (values ('insurance'), ('registration')) k(kind)
    where v.dsp_id = private.current_dsp_id()
      and v.archived_at is null
    group by v.id
  )
  select coalesce(jsonb_agg(jsonb_build_object('vehicle_id', vehicle_id, 'documents', docs)), '[]'::jsonb)
  from rolled;
$$;
grant execute on function public.vehicle_documents_overview() to authenticated;


create or replace function public.vehicle_doc_settings_get()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object('expiring_soon_days', private.vehicle_doc_threshold(v_dsp));
end;
$$;
grant execute on function public.vehicle_doc_settings_get() to authenticated;

create or replace function public.vehicle_doc_settings_set(p_days int)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_days is null or p_days < 1 or p_days > 365 then raise exception 'bad_days' using errcode = '22023'; end if;
  insert into public.dsp_vehicle_doc_settings (dsp_id, expiring_soon_days, updated_by)
       values (v_dsp, p_days, auth.uid())
  on conflict (dsp_id) do update
       set expiring_soon_days = excluded.expiring_soon_days,
           updated_by = excluded.updated_by,
           updated_at = now();
  return jsonb_build_object('expiring_soon_days', p_days);
end;
$$;
grant execute on function public.vehicle_doc_settings_set(int) to authenticated;


-- ── 5. RPCs — driver-side ────────────────────────────────────────────

-- Driver's assigned van for today + the active insurance / registration
-- snapshots (no file paths exposed).  The driver app renders the Van
-- Documents section from this payload.  Returns `{vehicle: null, ...}`
-- when no van is resolved so the app can show its empty state.
create or replace function public.driver_assigned_van(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_v   public.vehicles;
  v_threshold int;
  v_docs jsonb;
begin
  v_drv := private.driver_validate_token(p_token);
  v_v := private.driver_van_for(v_drv, current_date);
  if v_v.id is null then
    return jsonb_build_object('vehicle', null, 'documents', '[]'::jsonb,
                              'threshold_days', private.vehicle_doc_threshold(v_drv.dsp_id));
  end if;
  v_threshold := private.vehicle_doc_threshold(v_drv.dsp_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'id',              d.id,
           'kind',            d.kind,
           'document_number', d.document_number,
           'expiration_date', d.expiration_date,
           'days_until_expiration',
             case when d.expiration_date is null then null else (d.expiration_date - current_date) end,
           'has_file',        (d.file_path is not null and d.file_path <> ''),
           'status', case
                       when d.file_path is null then 'missing'
                       when d.expiration_date is not null and d.expiration_date < current_date then 'expired'
                       when d.expiration_date is not null
                            and d.expiration_date <= current_date + v_threshold then 'expiring_soon'
                       else 'active'
                     end,
           'uploaded_at',     d.uploaded_at
         ) order by d.kind), '[]'::jsonb)
    into v_docs
    from public.vehicle_documents d
   where d.dsp_id = v_drv.dsp_id and d.vehicle_id = v_v.id and d.replaced_at is null;

  return jsonb_build_object(
    'vehicle', jsonb_build_object(
       'id',     v_v.id,
       'name',   v_v.name,
       'plate',  v_v.plate,
       'plate_state', v_v.plate_state,
       'vin',    v_v.vin,
       'make',   v_v.make,
       'model',  v_v.model,
       'year',   v_v.year
    ),
    'documents',     v_docs,
    'threshold_days', v_threshold
  );
end;
$$;
grant execute on function public.driver_assigned_van(text) to anon, authenticated;


-- Logged-on-view audit + path lookup.  Returns the storage path so the
-- edge function (which holds the service role) can mint a signed URL
-- without needing to re-query.  Driver path uses the session token
-- + ownership-by-resolution: the document must belong to the van the
-- driver is currently assigned to.
create or replace function public.driver_vehicle_document_view(
  p_token text,
  p_vehicle_document_id uuid,
  p_ip text default null,
  p_user_agent text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_v   public.vehicles;
  v_doc public.vehicle_documents;
begin
  v_drv := private.driver_validate_token(p_token);
  v_v := private.driver_van_for(v_drv, current_date);
  if v_v.id is null then raise exception 'no_van_assigned' using errcode = 'P0001'; end if;
  select * into v_doc from public.vehicle_documents
    where id = p_vehicle_document_id and dsp_id = v_drv.dsp_id and vehicle_id = v_v.id and replaced_at is null;
  if v_doc.id is null then raise exception 'document_not_found' using errcode = 'P0002'; end if;
  if v_doc.file_path is null then raise exception 'no_file' using errcode = 'P0001'; end if;

  insert into public.vehicle_document_events
    (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, driver_id, ip, user_agent, payload)
  values (
    v_drv.dsp_id, v_v.id, v_doc.id, v_doc.kind, 'driver_viewed', 'driver', v_drv.id,
    p_ip, p_user_agent, jsonb_build_object('expiration_date', v_doc.expiration_date)
  );

  return jsonb_build_object(
    'vehicle_document_id', v_doc.id,
    'file_path',           v_doc.file_path,
    'file_name',           v_doc.file_name,
    'file_mime',           v_doc.file_mime,
    'kind',                v_doc.kind,
    'expiration_date',     v_doc.expiration_date
  );
end;
$$;
grant execute on function public.driver_vehicle_document_view(text, uuid, text, text) to anon, authenticated;


-- Driver reports the document for the *current* van is missing or
-- wrong.  Creates a vehicle_issues row (so it surfaces on the Fleet
-- roster + Issues tab + driver-reported badge) and appends an audit
-- event.  Idempotent enough — duplicate reports just create additional
-- events; the issue row remains the single open ticket per kind.
create or replace function public.driver_report_vehicle_document(
  p_token text,
  p_kind  text,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_v   public.vehicles;
  v_existing_issue uuid;
  v_issue_id uuid;
  v_doc_id   uuid;
  v_title text;
begin
  if coalesce(p_kind, '') not in ('insurance','registration') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  v_drv := private.driver_validate_token(p_token);
  v_v := private.driver_van_for(v_drv, current_date);
  if v_v.id is null then raise exception 'no_van_assigned' using errcode = 'P0001'; end if;

  select id into v_doc_id from public.vehicle_documents
   where vehicle_id = v_v.id and kind = p_kind and replaced_at is null
   limit 1;

  v_title := case p_kind
    when 'insurance' then 'Insurance card · driver-reported concern'
    when 'registration' then 'Registration · driver-reported concern'
  end;

  -- Reuse the open issue for this kind if one already exists.
  select id into v_existing_issue
    from public.vehicle_issues
   where vehicle_id = v_v.id
     and source = 'driver_self_report'
     and category = 'documents'
     and status <> 'completed'
     and title = v_title
   order by reported_at desc
   limit 1;

  if v_existing_issue is not null then
    update public.vehicle_issues
       set description = coalesce(nullif(trim(p_reason), ''), description),
           reported_at = now(),
           updated_at  = now()
     where id = v_existing_issue;
    v_issue_id := v_existing_issue;
  else
    insert into public.vehicle_issues (
      dsp_id, vehicle_id, reported_at, severity, category,
      title, description, status, source
    ) values (
      v_drv.dsp_id, v_v.id, now(),
      'high', 'documents',
      v_title,
      nullif(trim(p_reason), ''),
      'open', 'driver_self_report'
    ) returning id into v_issue_id;
  end if;

  insert into public.vehicle_document_events
    (dsp_id, vehicle_id, vehicle_document_id, doc_kind, kind, actor_kind, driver_id, payload)
  values (
    v_drv.dsp_id, v_v.id, v_doc_id, p_kind, 'driver_reported', 'driver', v_drv.id,
    jsonb_build_object('reason', p_reason, 'issue_id', v_issue_id)
  );

  return jsonb_build_object('issue_id', v_issue_id, 'vehicle_id', v_v.id, 'kind', p_kind);
end;
$$;
grant execute on function public.driver_report_vehicle_document(text, text, text) to anon, authenticated;


-- ── 6. vehicles_roster · decorate with document exception summary ────
-- Adds:
--   • doc_exception_state   — worst-state across {insurance,registration}
--                              ('expired' > 'missing' > 'expiring_soon' > 'active')
--   • doc_exception_label   — short, operator-facing string ("Registration expired",
--                             "Insurance expires in 5 days", "Insurance missing")
--   • doc_insurance         — {status, expiration_date, days_until}
--   • doc_registration      — {status, expiration_date, days_until}
-- Keeps every prior field intact.
create or replace function public.vehicles_roster()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  with thresh as (
    select private.vehicle_doc_threshold(private.current_dsp_id()) as days
  ),
  active_docs as (
    select d.vehicle_id, d.kind, d.expiration_date, d.file_path,
           case when d.expiration_date is null then null else (d.expiration_date - current_date) end as days_until,
           case
             when d.file_path is null then 'missing'
             when d.expiration_date is not null and d.expiration_date < current_date then 'expired'
             when d.expiration_date is not null and d.expiration_date <= current_date + (select days from thresh) then 'expiring_soon'
             else 'active'
           end as status
    from public.vehicle_documents d
    where d.dsp_id = private.current_dsp_id()
      and d.replaced_at is null
  ),
  doc_rolled as (
    select v.id as vehicle_id,
           (select jsonb_build_object(
                     'status', coalesce(ad.status, 'missing'),
                     'expiration_date', ad.expiration_date,
                     'days_until', ad.days_until)
              from active_docs ad where ad.vehicle_id = v.id and ad.kind = 'insurance') as ins,
           (select jsonb_build_object(
                     'status', coalesce(ad.status, 'missing'),
                     'expiration_date', ad.expiration_date,
                     'days_until', ad.days_until)
              from active_docs ad where ad.vehicle_id = v.id and ad.kind = 'registration') as reg
    from public.vehicles v
    where v.dsp_id = private.current_dsp_id() and v.archived_at is null
  )
  select coalesce(jsonb_agg(v order by v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',                 vh.id,
      'name',               vh.name,
      'nickname',           vh.nickname,
      'kind',               vh.kind,
      'status',             vh.status,
      'ownership',          vh.ownership,
      'operational_status', vh.operational_status,
      'year',               vh.year,
      'make',               vh.make,
      'model',              vh.model,
      'trim_level',         vh.trim_level,
      'color',              vh.color,
      'plate',              vh.plate,
      'plate_state',        vh.plate_state,
      'vin',                vh.vin,
      'mileage',            vh.mileage,
      'mileage_updated_at', vh.mileage_updated_at,
      'last_route_completed_at', vh.last_route_completed_at,
      'photo_path',         vh.photo_path,
      'station_id',         vh.station_id,
      'station_code',       st.code,
      'last_service_at',    vh.last_service_at,
      'next_service_due_at',vh.next_service_due_at,
      'dot_inspection_at',  vh.dot_inspection_at,
      'registration_expires_on', vh.registration_expires_on,
      'insurance_expires_on',    vh.insurance_expires_on,
      'updated_at',         vh.updated_at,
      'primary_driver_id',  pri.driver_id,
      'primary_driver_name',pri.name,
      'backup_count',       coalesce(ch.backup_count, 0),
      'open_issue_count',   coalesce(oi.cnt, 0),
      'driver_reported_open_count', coalesce(dri.cnt, 0),
      'doc_insurance',      coalesce(dr.ins, jsonb_build_object('status','missing')),
      'doc_registration',   coalesce(dr.reg, jsonb_build_object('status','missing')),
      'doc_exception_state', (
        -- precedence order: expired > missing > expiring_soon > active
        select case
                 when (dr.ins->>'status') = 'expired'      or (dr.reg->>'status') = 'expired'      then 'expired'
                 when (dr.ins->>'status') = 'missing'      or (dr.reg->>'status') = 'missing'      then 'missing'
                 when (dr.ins->>'status') = 'expiring_soon' or (dr.reg->>'status') = 'expiring_soon' then 'expiring_soon'
                 else 'active'
               end
      ),
      'doc_exception_label', (
        select case
          when (dr.ins->>'status') = 'expired'      then 'Insurance Expired'
          when (dr.reg->>'status') = 'expired'      then 'Registration Expired'
          when (dr.ins->>'status') = 'missing'      then 'Insurance Missing'
          when (dr.reg->>'status') = 'missing'      then 'Registration Missing'
          when (dr.ins->>'status') = 'expiring_soon' then
            'Insurance Expires in ' || (dr.ins->>'days_until') || (case when (dr.ins->>'days_until') = '1' then ' Day' else ' Days' end)
          when (dr.reg->>'status') = 'expiring_soon' then
            'Registration Expires in ' || (dr.reg->>'days_until') || (case when (dr.reg->>'days_until') = '1' then ' Day' else ' Days' end)
          else null
        end
      )
    ) v
    from public.vehicles vh
    left join public.stations st on st.id = vh.station_id
    left join doc_rolled dr on dr.vehicle_id = vh.id
    left join lateral (
      select a.driver_id,
             coalesce(nullif(trim(d.full_name), ''), nullif(trim(d.preferred_name), ''), 'Driver') as name
      from public.vehicle_driver_assignments a
      join public.drivers d on d.id = a.driver_id
      where a.vehicle_id = vh.id and a.rank = 0
      limit 1
    ) pri on true
    left join lateral (
      select greatest(count(*)::int - 1, 0) as backup_count
      from public.vehicle_driver_assignments
      where vehicle_id = vh.id
    ) ch on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed'
    ) oi on true
    left join lateral (
      select count(*)::int as cnt
      from public.vehicle_issues
      where vehicle_id = vh.id and status <> 'completed' and source = 'driver_self_report'
    ) dri on true
    where vh.dsp_id = private.current_dsp_id()
      and vh.archived_at is null
      and private.is_staff(vh.dsp_id, 'dispatcher')
  ) t;
$$;
grant execute on function public.vehicles_roster() to authenticated;


notify pgrst, 'reload schema';
