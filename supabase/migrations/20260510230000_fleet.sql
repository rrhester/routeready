-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510230000 · Fleet — vehicles + assets + maintenance + documents
-- Phase 6. Vehicles, asset issuance/return tracking, maintenance records,
-- vehicle/document storage. Closes the FK from Phase 5 form_submissions.
-- ─────────────────────────────────────────────────────────────────────────

create type public.asset_type as enum (
  'phone','fuel_card','toll_tag','key_fob','uniform','scanner','other'
);

create type public.vehicle_status as enum (
  'active','maintenance','out_of_service','retired'
);

-- ─── Vehicles ────────────────────────────────────────────────────────────

create table public.vehicles (
  id                 uuid                   primary key default gen_random_uuid(),
  dsp_id             uuid                   not null references public.dsps(id) on delete cascade,
  station_id         uuid                   references public.stations(id) on delete set null,
  van_number         text                   not null,                       -- 'VAN-08'
  vin                text,
  plate              text,
  make               text,
  model              text,
  year               int,
  status             public.vehicle_status  not null default 'active',
  mileage            int,
  insurance_doc      text,                                                  -- Storage path
  registration_doc   text,
  dot_inspection_at  date,
  notes              text,
  created_at         timestamptz            not null default now(),
  updated_at         timestamptz            not null default now(),
  created_by         uuid                   references public.app_users(id),

  constraint vehicles_van_number_unique unique (dsp_id, van_number)
);

create index vehicles_dsp_status_idx on public.vehicles (dsp_id, status);
create index vehicles_dsp_station_idx on public.vehicles (dsp_id, station_id) where status = 'active';
create index vehicles_dot_expiry_idx on public.vehicles (dot_inspection_at) where dot_inspection_at is not null;

create trigger trg_vehicles_updated_at
  before update on public.vehicles
  for each row execute function moddatetime(updated_at);

-- Now backfill the vehicle_id FK on form_submissions (created in Phase 5)
alter table public.form_submissions
  add constraint form_submissions_vehicle_fk
  foreign key (vehicle_id) references public.vehicles(id) on delete set null;

comment on table public.vehicles is
  'Fleet vehicles. van_number is the human-readable identifier (VAN-08); ' ||
  'VIN + plate are real-world. Documents stored as Storage paths.';

alter table public.vehicles enable row level security;

create policy "vehicles_tenant_select"
  on public.vehicles for select
  using (dsp_id = private.current_dsp_id());

create policy "vehicles_dispatcher_write"
  on public.vehicles for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.vehicles to authenticated;

-- ─── Assets (phones, fuel cards, toll tags, etc.) ───────────────────────

create table public.assets (
  id          uuid              primary key default gen_random_uuid(),
  dsp_id      uuid              not null references public.dsps(id) on delete cascade,
  asset_type  public.asset_type not null,
  identifier  text              not null,                              -- serial, IMEI, card #, etc.
  vendor      text,
  status      text              not null default 'active'
              check (status in ('active','retired','lost','damaged')),
  notes       text,
  created_at  timestamptz       not null default now(),
  updated_at  timestamptz       not null default now(),

  constraint assets_unique_per_type unique (dsp_id, asset_type, identifier)
);

create index assets_dsp_type_idx on public.assets (dsp_id, asset_type) where status = 'active';

create trigger trg_assets_updated_at
  before update on public.assets
  for each row execute function moddatetime(updated_at);

alter table public.assets enable row level security;

create policy "assets_tenant_select"
  on public.assets for select
  using (dsp_id = private.current_dsp_id());

create policy "assets_dispatcher_write"
  on public.assets for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.assets to authenticated;

-- ─── Asset assignments (history of who has what) ────────────────────────

create table public.asset_assignments (
  id                  uuid        primary key default gen_random_uuid(),
  dsp_id              uuid        not null references public.dsps(id) on delete cascade,
  asset_id            uuid        not null references public.assets(id) on delete cascade,
  driver_id           uuid        references public.drivers(id) on delete set null,
  vehicle_id          uuid        references public.vehicles(id) on delete set null,
  assigned_at         timestamptz not null default now(),
  returned_at         timestamptz,
  condition_on_return text,
  notes               text,
  assigned_by         uuid        references public.app_users(id),

  -- An asset can have at most one open assignment at a time
  constraint asset_assignments_one_open
    exclude (asset_id with =) where (returned_at is null)
);

create index asset_assignments_open_driver_idx
  on public.asset_assignments (dsp_id, driver_id) where returned_at is null;
create index asset_assignments_asset_idx
  on public.asset_assignments (asset_id, assigned_at desc);

comment on table public.asset_assignments is
  'Open + closed assignment history. An asset has at most one open ' ||
  'assignment (returned_at IS NULL) — enforced by exclusion constraint.';

alter table public.asset_assignments enable row level security;

create policy "asset_assignments_tenant_select"
  on public.asset_assignments for select
  using (
    dsp_id = private.current_dsp_id()
    and (
      private.is_staff(dsp_id, 'dispatcher')
      or driver_id = private.current_driver_id()
    )
  );

create policy "asset_assignments_dispatcher_write"
  on public.asset_assignments for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.asset_assignments to authenticated;

-- ─── Maintenance records ────────────────────────────────────────────────

create table public.maintenance_records (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  vehicle_id      uuid        not null references public.vehicles(id) on delete cascade,
  service_type    text        not null,
                  -- 'oil','brakes','tires','dot_inspection','damage_repair','recall','other'
  performed_at    date        not null,
  mileage         int,
  cost_cents      int,
  vendor          text,
  notes           text,
  attached_files  text[],     -- receipts, photos, work-order PDFs
  created_at      timestamptz not null default now(),
  created_by      uuid        references public.app_users(id)
);

create index maintenance_records_vehicle_idx
  on public.maintenance_records (dsp_id, vehicle_id, performed_at desc);

alter table public.maintenance_records enable row level security;

create policy "maintenance_tenant_select"
  on public.maintenance_records for select
  using (dsp_id = private.current_dsp_id());

create policy "maintenance_dispatcher_write"
  on public.maintenance_records for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'dispatcher'));

grant select, insert, update, delete on public.maintenance_records to authenticated;

-- ─── Documents (general DSP docs) ──────────────────────────────────────

create table public.documents (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  category        text        not null
                  check (category in
                    ('insurance','registration','dot_inspection','contract',
                     'policy','vendor_invoice','employee_form','other')),
  title           text        not null,
  storage_path    text        not null,                                -- Storage URL
  related_kind    text,                                                 -- 'vehicle','driver','dsp','other'
  related_id      uuid,
  expiry_date     date,
  created_at      timestamptz not null default now(),
  uploaded_by     uuid        references public.app_users(id)
);

create index documents_expiry_idx on public.documents (dsp_id, expiry_date) where expiry_date is not null;
create index documents_related_idx on public.documents (dsp_id, related_kind, related_id);

alter table public.documents enable row level security;

create policy "documents_tenant_select"
  on public.documents for select
  using (dsp_id = private.current_dsp_id());

create policy "documents_ops_write"
  on public.documents for all
  using (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'))
  with check (dsp_id = private.current_dsp_id() and private.is_staff(dsp_id, 'ops'));

grant select, insert, update, delete on public.documents to authenticated;
