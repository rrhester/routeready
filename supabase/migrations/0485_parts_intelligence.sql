-- Migration 0485 · Parts Intelligence — foundation schema
--
-- Native Fleet feature for finding, verifying, comparing, and purchasing
-- replacement van parts across approved suppliers. This migration lays the
-- data foundation only — it is ADDITIVE and wired to nothing existing, so
-- applying it changes no current behavior.
--
-- Tenant model: every table carries dsp_id → public.dsps(id) and the standard
-- staff RLS (dsp_id = private.current_dsp_id() and private.is_staff(...,'dispatcher')).
-- Business logic lives in security-definer RPCs that re-check is_staff. Money is
-- stored in integer cents. Supplier credentials are NEVER stored here — a source
-- names the secret it needs in `auth_ref`; the real value lives in Supabase
-- edge secrets. All supplier/crawled text is untrusted data.
--
-- Tables:
--   1. canonical_parts             normalized part identities (+ normalization evidence)
--   2. supplier_sources            approved suppliers/feeds/crawlers + health + policy
--   3. supplier_offers             normalized offers, one row per seller listing
--   4. price_observations          historical price/availability snapshots
--   5. vehicle_part_compatibility  fitment rules + evidence + manual overrides
--   6. part_searches               async search jobs + per-source status
--   7. part_watchlists             saved targets + price/stock alerts
--   8. part_purchases              recorded purchases linked to vehicle/issue/RO
--   9. supplier_performance        rollup metrics per supplier (maintained by RPC)
--
-- Idempotent: safe to re-run after a partial apply.

-- ══════════════════════════════════════════════════════════════════════
-- 1. canonical_parts
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.canonical_parts (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  category              text,                         -- e.g. 'mirror', 'brake', 'lighting'
  part_type             text,                         -- e.g. 'door mirror assembly'
  position              text,                         -- 'front' | 'rear' | ...
  side                  text,                         -- 'left' | 'right' | 'both' | null
  location              text,
  brand                 text,
  is_oem                boolean not null default false,
  oem_part_numbers      text[]  not null default '{}',
  aftermarket_part_numbers text[] not null default '{}',
  interchange_numbers   text[]  not null default '{}',
  superseded_part_numbers text[] not null default '{}',
  gtin                  text,                         -- GTIN / UPC
  description           text,
  specs                 jsonb  not null default '{}'::jsonb,
  connector_type        text,
  dimensions            jsonb  not null default '{}'::jsonb,
  images                jsonb  not null default '[]'::jsonb,   -- [{path|url, source}]
  attributes            jsonb  not null default '{}'::jsonb,   -- structured feature flags
  normalization_confidence numeric,                  -- 0..1
  normalization_evidence jsonb not null default '{}'::jsonb,
  review_status         text not null default 'auto',  -- auto | needs_review | confirmed | rejected
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists canonical_parts_dsp_idx      on public.canonical_parts (dsp_id, category);
create index if not exists canonical_parts_review_idx   on public.canonical_parts (dsp_id, review_status) where review_status = 'needs_review';
create index if not exists canonical_parts_oem_gin      on public.canonical_parts using gin (oem_part_numbers);
create index if not exists canonical_parts_am_gin       on public.canonical_parts using gin (aftermarket_part_numbers);

-- ══════════════════════════════════════════════════════════════════════
-- 2. supplier_sources
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.supplier_sources (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  name                  text not null,
  source_type           text not null default 'manual',  -- api | feed | affiliate_api | crawler | manual | invoice
  base_url              text,
  auth_ref              text,                          -- NAME of the edge secret to use — never the secret itself
  rate_limit_per_min    int not null default 60,
  terms_status          text not null default 'unreviewed',  -- unreviewed | reviewed | prohibited
  robots_status         text not null default 'unknown',     -- unknown | allowed | disallowed
  active                boolean not null default false,
  last_sync_at          timestamptz,
  health_status         text not null default 'unknown',     -- healthy | slow | degraded | blocked | error | unknown
  error_rate            numeric not null default 0,          -- 0..1
  consecutive_failures  int not null default 0,
  crawl_policy          jsonb not null default '{}'::jsonb,  -- {crawl_delay_s, concurrency, user_agent, avoid_paths[]}
  retention_days        int not null default 180,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (dsp_id, name)
);
create index if not exists supplier_sources_dsp_idx on public.supplier_sources (dsp_id, active);

-- ══════════════════════════════════════════════════════════════════════
-- 6. part_searches   (defined before supplier_offers so offers can FK it)
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.part_searches (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  vehicle_id            uuid references public.vehicles(id) on delete set null,
  vin                   text,
  query_text            text,
  part_number           text,
  image_path            text,
  requested_sources     jsonb not null default '[]'::jsonb,  -- [source_id,...]
  filters               jsonb not null default '{}'::jsonb,  -- {condition, oem_pref, max_landed_cents, deliver_by}
  status                text not null default 'pending',     -- pending | running | partial | complete | failed | cancelled
  per_source_status     jsonb not null default '{}'::jsonb,  -- {source_id: {status, count, error, ms}}
  errors                jsonb not null default '[]'::jsonb,
  offer_count           int not null default 0,
  retry_count           int not null default 0,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists part_searches_dsp_idx      on public.part_searches (dsp_id, created_at desc);
create index if not exists part_searches_vehicle_idx  on public.part_searches (vehicle_id, created_at desc);

-- ══════════════════════════════════════════════════════════════════════
-- 3. supplier_offers
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.supplier_offers (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  supplier_source_id    uuid references public.supplier_sources(id) on delete set null,
  search_id             uuid references public.part_searches(id) on delete set null,
  canonical_part_id     uuid references public.canonical_parts(id) on delete set null,
  vehicle_id            uuid references public.vehicles(id) on delete set null,
  seller_name           text,
  seller_part_number    text,
  product_title         text,                          -- factual title only; do not copy full copyrighted descriptions
  product_url           text,
  condition             text not null default 'new',   -- new | remanufactured | refurbished | used | nos | core
  price_cents           int,
  shipping_cents        int,
  tax_cents             int,
  core_charge_cents     int,
  discount_cents        int,
  total_landed_cents    int,
  currency              text not null default 'USD',
  availability          text,                          -- in_stock | low_stock | backorder | out_of_stock | unknown
  quantity              int,
  delivery_days_min     int,
  delivery_days_max     int,
  warranty              text,
  return_policy         text,
  seller_rating         numeric,
  fitment_claim         text,                          -- raw seller claim (untrusted)
  fitment_confidence    text not null default 'unknown', -- exact | high | likely | verify | incompatible | unknown
  fitment_score         numeric,                       -- 0..1 from the engine
  fitment_reasons       jsonb not null default '[]'::jsonb,
  flags                 jsonb not null default '[]'::jsonb,   -- ['suspicious_price','expired',...]
  source_ts             timestamptz,
  last_verified_at      timestamptz,
  raw_source_id         text,                          -- adapter's own id for dedupe
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists supplier_offers_search_idx  on public.supplier_offers (search_id, total_landed_cents);
create index if not exists supplier_offers_vehicle_idx on public.supplier_offers (vehicle_id, created_at desc);
create index if not exists supplier_offers_part_idx    on public.supplier_offers (canonical_part_id);
create index if not exists supplier_offers_dedupe_idx  on public.supplier_offers (dsp_id, supplier_source_id, raw_source_id);

-- ══════════════════════════════════════════════════════════════════════
-- 4. price_observations
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.price_observations (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  supplier_offer_id     uuid references public.supplier_offers(id) on delete cascade,
  canonical_part_id     uuid references public.canonical_parts(id) on delete set null,
  supplier_source_id    uuid references public.supplier_sources(id) on delete set null,
  seller_part_number    text,
  price_cents           int,
  shipping_cents        int,
  tax_cents             int,
  core_charge_cents     int,
  total_landed_cents    int,
  availability          text,
  delivery_days         int,
  observed_at           timestamptz not null default now()
);
create index if not exists price_observations_offer_idx on public.price_observations (supplier_offer_id, observed_at desc);
create index if not exists price_observations_part_idx  on public.price_observations (canonical_part_id, observed_at desc);
create index if not exists price_observations_pn_idx    on public.price_observations (dsp_id, seller_part_number, observed_at desc);

-- ══════════════════════════════════════════════════════════════════════
-- 5. vehicle_part_compatibility
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.vehicle_part_compatibility (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  vehicle_id            uuid references public.vehicles(id) on delete cascade,
  vehicle_config        jsonb not null default '{}'::jsonb,   -- when not tied to a single vehicle
  canonical_part_id     uuid not null references public.canonical_parts(id) on delete cascade,
  status                text not null default 'verify',       -- exact | high | likely | verify | incompatible
  confidence            numeric,                              -- 0..1
  evidence              jsonb not null default '[]'::jsonb,
  source                text,                                 -- oem_catalog | interchange | vin | manual | historical
  required_attributes   jsonb not null default '{}'::jsonb,
  excluded_configs      jsonb not null default '[]'::jsonb,
  verified_at           timestamptz,
  manual_override       boolean not null default false,
  override_by           uuid references auth.users(id) on delete set null,
  override_at           timestamptz,
  override_note         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists vpc_vehicle_idx on public.vehicle_part_compatibility (vehicle_id, canonical_part_id);
create index if not exists vpc_part_idx    on public.vehicle_part_compatibility (canonical_part_id);

-- ══════════════════════════════════════════════════════════════════════
-- 7. part_watchlists
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.part_watchlists (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  vehicle_id            uuid references public.vehicles(id) on delete set null,
  canonical_part_id     uuid references public.canonical_parts(id) on delete set null,
  label                 text,
  query_text            text,
  part_number           text,
  max_price_cents       int,
  required_by           date,
  oem_preference        text not null default 'any',   -- any | prefer_oem | oem_only | prefer_aftermarket
  condition_preference  text not null default 'any',   -- any | new_only | new_or_reman | ...
  alert_types           jsonb not null default '["target_price"]'::jsonb, -- target_price|back_in_stock|delivery|new_oem|price_drop
  price_drop_pct        numeric,
  alert_status          text not null default 'watching',  -- watching | triggered | snoozed | done
  last_alert_at         timestamptz,
  last_seen_landed_cents int,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists part_watchlists_dsp_idx     on public.part_watchlists (dsp_id, alert_status);
create index if not exists part_watchlists_vehicle_idx on public.part_watchlists (vehicle_id);

-- ══════════════════════════════════════════════════════════════════════
-- 8. part_purchases
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.part_purchases (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  vehicle_id            uuid references public.vehicles(id) on delete set null,
  canonical_part_id     uuid references public.canonical_parts(id) on delete set null,
  supplier_source_id    uuid references public.supplier_sources(id) on delete set null,
  supplier_offer_id     uuid references public.supplier_offers(id) on delete set null,
  vehicle_issue_id      uuid references public.vehicle_issues(id) on delete set null,
  repair_order_id       uuid references public.repair_orders(id) on delete set null,
  seller_name           text,
  part_number           text,
  description           text,
  condition             text,
  quantity              int not null default 1,
  final_cost_cents      int,
  currency              text not null default 'USD',
  purchase_date         date not null default current_date,
  po_number             text,
  receipt_path          text,                          -- private bucket path
  installer             text,
  installed_at          date,
  labor_cost_cents      int,
  warranty_expires_on   date,
  return_deadline       date,
  status                text not null default 'ordered', -- ordered | shipped | delivered | installed | returned | cancelled
  fitment_confidence    text,
  notes                 text,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists part_purchases_vehicle_idx on public.part_purchases (vehicle_id, purchase_date desc);
create index if not exists part_purchases_dsp_idx     on public.part_purchases (dsp_id, status);
create index if not exists part_purchases_issue_idx   on public.part_purchases (vehicle_issue_id);

-- ══════════════════════════════════════════════════════════════════════
-- 9. supplier_performance
-- ══════════════════════════════════════════════════════════════════════
create table if not exists public.supplier_performance (
  id                    uuid primary key default gen_random_uuid(),
  dsp_id                uuid not null references public.dsps(id) on delete cascade,
  supplier_source_id    uuid not null references public.supplier_sources(id) on delete cascade,
  delivery_accuracy     numeric,   -- 0..1
  cancellation_rate     numeric,
  return_rate           numeric,
  defect_rate           numeric,
  price_competitiveness numeric,
  fitment_accuracy      numeric,
  user_rating           numeric,
  purchase_volume       int not null default 0,
  computed_at           timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (dsp_id, supplier_source_id)
);

-- ══════════════════════════════════════════════════════════════════════
-- updated_at triggers (canonical private.set_updated_at pattern, 0003)
-- ══════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'canonical_parts','supplier_sources','supplier_offers','vehicle_part_compatibility',
    'part_searches','part_watchlists','part_purchases','supplier_performance'
  ] loop
    execute format('drop trigger if exists trg_%1$s_updated_at on public.%1$s;', t);
    execute format(
      'create trigger trg_%1$s_updated_at before update on public.%1$s
       for each row execute function private.set_updated_at();', t);
  end loop;
end $$;

-- ══════════════════════════════════════════════════════════════════════
-- Row Level Security — staff (dispatcher+) read/write, tenant-scoped
-- ══════════════════════════════════════════════════════════════════════
do $$
declare t text;
begin
  foreach t in array array[
    'canonical_parts','supplier_sources','supplier_offers','price_observations',
    'vehicle_part_compatibility','part_searches','part_watchlists','part_purchases',
    'supplier_performance'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists "%1$s_rw" on public.%1$s;', t);
    execute format(
      'create policy "%1$s_rw" on public.%1$s
         for all
         using      (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), ''dispatcher''))
         with check (dsp_id = private.current_dsp_id() and private.is_staff(private.current_dsp_id(), ''dispatcher''));', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated;', t);
  end loop;
end $$;

-- ══════════════════════════════════════════════════════════════════════
-- RPCs
-- ══════════════════════════════════════════════════════════════════════

-- ── Seed a DSP's default supplier sources (idempotent, first-run) ──────
create or replace function public.parts_seed_default_sources()
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  insert into public.supplier_sources (dsp_id, name, source_type, base_url, auth_ref, rate_limit_per_min, terms_status, robots_status, active)
  values
    (v_dsp, 'Manual entries',  'manual',       null,                         null,               0,   'reviewed',   'allowed', true),
    (v_dsp, 'NHTSA vPIC',      'api',          'https://vpic.nhtsa.dot.gov', null,               60,  'reviewed',   'allowed', true),
    (v_dsp, 'RockAuto',        'api',          'https://www.rockauto.com',   'ROCKAUTO_API_KEY', 60,  'unreviewed', 'unknown', false),
    (v_dsp, 'eBay Motors',     'affiliate_api','https://api.ebay.com',       'EBAY_APP_ID',      120, 'unreviewed', 'unknown', false)
  on conflict (dsp_id, name) do nothing;

  return public.parts_supplier_sources_list();
end;
$$;
grant execute on function public.parts_seed_default_sources() to authenticated;

-- ── List supplier sources ──────────────────────────────────────────────
create or replace function public.parts_supplier_sources_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id, 'name', s.name, 'source_type', s.source_type, 'base_url', s.base_url,
    'rate_limit_per_min', s.rate_limit_per_min, 'terms_status', s.terms_status,
    'robots_status', s.robots_status, 'active', s.active, 'last_sync_at', s.last_sync_at,
    'health_status', s.health_status, 'error_rate', s.error_rate,
    'consecutive_failures', s.consecutive_failures, 'retention_days', s.retention_days
  ) order by s.name), '[]'::jsonb)
  from public.supplier_sources s
  where s.dsp_id = private.current_dsp_id()
    and private.is_staff(s.dsp_id, 'dispatcher');
$$;
grant execute on function public.parts_supplier_sources_list() to authenticated;

-- ── Enable/disable a source ────────────────────────────────────────────
create or replace function public.parts_source_set_active(p_id uuid, p_active boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.supplier_sources set active = coalesce(p_active, false), updated_at = now()
   where id = p_id and dsp_id = v_dsp;
  if not found then raise exception 'source_not_found' using errcode = 'P0002'; end if;
end;
$$;
grant execute on function public.parts_source_set_active(uuid, boolean) to authenticated;

-- ── Upsert a canonical part ────────────────────────────────────────────
create or replace function public.parts_canonical_upsert(
  p_id uuid default null, p_category text default null, p_part_type text default null,
  p_side text default null, p_position text default null, p_brand text default null,
  p_is_oem boolean default false, p_oem_numbers text[] default '{}', p_am_numbers text[] default '{}',
  p_interchange text[] default '{}', p_superseded text[] default '{}', p_gtin text default null,
  p_description text default null, p_connector_type text default null, p_specs jsonb default '{}'::jsonb,
  p_attributes jsonb default '{}'::jsonb, p_norm_confidence numeric default null,
  p_norm_evidence jsonb default '{}'::jsonb, p_review_status text default 'auto'
) returns public.canonical_parts
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.canonical_parts;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_id is null then
    insert into public.canonical_parts (
      dsp_id, category, part_type, side, position, brand, is_oem, oem_part_numbers,
      aftermarket_part_numbers, interchange_numbers, superseded_part_numbers, gtin,
      description, connector_type, specs, attributes, normalization_confidence,
      normalization_evidence, review_status, created_by
    ) values (
      v_dsp, p_category, p_part_type, p_side, p_position, p_brand, coalesce(p_is_oem,false),
      coalesce(p_oem_numbers,'{}'), coalesce(p_am_numbers,'{}'), coalesce(p_interchange,'{}'),
      coalesce(p_superseded,'{}'), p_gtin, p_description, p_connector_type,
      coalesce(p_specs,'{}'::jsonb), coalesce(p_attributes,'{}'::jsonb), p_norm_confidence,
      coalesce(p_norm_evidence,'{}'::jsonb), coalesce(p_review_status,'auto'), auth.uid()
    ) returning * into v_row;
  else
    update public.canonical_parts set
      category=p_category, part_type=p_part_type, side=p_side, position=p_position, brand=p_brand,
      is_oem=coalesce(p_is_oem,is_oem), oem_part_numbers=coalesce(p_oem_numbers,oem_part_numbers),
      aftermarket_part_numbers=coalesce(p_am_numbers,aftermarket_part_numbers),
      interchange_numbers=coalesce(p_interchange,interchange_numbers),
      superseded_part_numbers=coalesce(p_superseded,superseded_part_numbers),
      gtin=p_gtin, description=p_description, connector_type=p_connector_type,
      specs=coalesce(p_specs,specs), attributes=coalesce(p_attributes,attributes),
      normalization_confidence=p_norm_confidence, normalization_evidence=coalesce(p_norm_evidence,normalization_evidence),
      review_status=coalesce(p_review_status,review_status), updated_at=now()
    where id=p_id and dsp_id=v_dsp returning * into v_row;
    if v_row.id is null then raise exception 'part_not_found' using errcode='P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.parts_canonical_upsert(uuid,text,text,text,text,text,boolean,text[],text[],text[],text[],text,text,text,jsonb,jsonb,numeric,jsonb,text) to authenticated;

-- ── Start a search job ─────────────────────────────────────────────────
create or replace function public.parts_search_start(
  p_vehicle_id uuid default null, p_query text default null, p_part_number text default null,
  p_vin text default null, p_image_path text default null,
  p_requested_sources jsonb default '[]'::jsonb, p_filters jsonb default '{}'::jsonb
) returns public.part_searches
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.part_searches;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_query),'')='' and coalesce(trim(p_part_number),'')='' and coalesce(trim(p_image_path),'')='' then
    raise exception 'query_required' using errcode = '22023';
  end if;
  if p_vehicle_id is not null and not exists (select 1 from public.vehicles where id=p_vehicle_id and dsp_id=v_dsp) then
    raise exception 'vehicle_not_found' using errcode='P0002';
  end if;
  insert into public.part_searches (
    dsp_id, vehicle_id, vin, query_text, part_number, image_path,
    requested_sources, filters, status, started_at, created_by
  ) values (
    v_dsp, p_vehicle_id, nullif(upper(trim(p_vin)),''), nullif(trim(p_query),''),
    nullif(trim(p_part_number),''), nullif(trim(p_image_path),''),
    coalesce(p_requested_sources,'[]'::jsonb), coalesce(p_filters,'{}'::jsonb),
    'running', now(), auth.uid()
  ) returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.parts_search_start(uuid,text,text,text,text,jsonb,jsonb) to authenticated;

-- ── Save/normalize an offer + record a price observation ───────────────
create or replace function public.parts_offer_save(
  p_search_id uuid, p_source_id uuid default null, p_canonical_part_id uuid default null,
  p_vehicle_id uuid default null, p_seller_name text default null, p_seller_part_number text default null,
  p_title text default null, p_url text default null, p_condition text default 'new',
  p_price_cents int default null, p_shipping_cents int default null, p_tax_cents int default null,
  p_core_charge_cents int default null, p_discount_cents int default null,
  p_availability text default null, p_quantity int default null,
  p_delivery_days_min int default null, p_delivery_days_max int default null,
  p_warranty text default null, p_return_policy text default null, p_seller_rating numeric default null,
  p_fitment_claim text default null, p_fitment_confidence text default 'unknown',
  p_fitment_score numeric default null, p_fitment_reasons jsonb default '[]'::jsonb,
  p_flags jsonb default '[]'::jsonb, p_raw_source_id text default null
) returns public.supplier_offers
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.supplier_offers;
  v_landed int;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if not exists (select 1 from public.part_searches where id=p_search_id and dsp_id=v_dsp) then
    raise exception 'search_not_found' using errcode='P0002';
  end if;
  if coalesce(p_condition,'new') not in ('new','remanufactured','refurbished','used','nos','core') then
    raise exception 'bad_condition' using errcode='22023';
  end if;
  if coalesce(p_fitment_confidence,'unknown') not in ('exact','high','likely','verify','incompatible','unknown') then
    raise exception 'bad_fitment' using errcode='22023';
  end if;

  v_landed := coalesce(p_price_cents,0) + coalesce(p_shipping_cents,0) + coalesce(p_tax_cents,0)
            + coalesce(p_core_charge_cents,0) - coalesce(p_discount_cents,0);

  -- Dedupe on (source, raw_source_id) within the same search when provided.
  if p_raw_source_id is not null then
    select * into v_row from public.supplier_offers
     where dsp_id=v_dsp and search_id=p_search_id and supplier_source_id is not distinct from p_source_id
       and raw_source_id = p_raw_source_id limit 1;
  end if;

  if v_row.id is null then
    insert into public.supplier_offers (
      dsp_id, supplier_source_id, search_id, canonical_part_id, vehicle_id, seller_name,
      seller_part_number, product_title, product_url, condition, price_cents, shipping_cents,
      tax_cents, core_charge_cents, discount_cents, total_landed_cents, availability, quantity,
      delivery_days_min, delivery_days_max, warranty, return_policy, seller_rating, fitment_claim,
      fitment_confidence, fitment_score, fitment_reasons, flags, source_ts, last_verified_at, raw_source_id
    ) values (
      v_dsp, p_source_id, p_search_id, p_canonical_part_id, p_vehicle_id, p_seller_name,
      p_seller_part_number, p_title, p_url, coalesce(p_condition,'new'), p_price_cents, p_shipping_cents,
      p_tax_cents, p_core_charge_cents, p_discount_cents, v_landed, p_availability, p_quantity,
      p_delivery_days_min, p_delivery_days_max, p_warranty, p_return_policy, p_seller_rating, p_fitment_claim,
      coalesce(p_fitment_confidence,'unknown'), p_fitment_score, coalesce(p_fitment_reasons,'[]'::jsonb),
      coalesce(p_flags,'[]'::jsonb), now(), now(), p_raw_source_id
    ) returning * into v_row;
    update public.part_searches set offer_count = offer_count + 1, updated_at = now() where id = p_search_id;
  else
    update public.supplier_offers set
      canonical_part_id=coalesce(p_canonical_part_id,canonical_part_id), product_title=p_title, product_url=p_url,
      condition=coalesce(p_condition,condition), price_cents=p_price_cents, shipping_cents=p_shipping_cents,
      tax_cents=p_tax_cents, core_charge_cents=p_core_charge_cents, discount_cents=p_discount_cents,
      total_landed_cents=v_landed, availability=p_availability, quantity=p_quantity,
      delivery_days_min=p_delivery_days_min, delivery_days_max=p_delivery_days_max, warranty=p_warranty,
      return_policy=p_return_policy, seller_rating=p_seller_rating, fitment_claim=p_fitment_claim,
      fitment_confidence=coalesce(p_fitment_confidence,fitment_confidence), fitment_score=p_fitment_score,
      fitment_reasons=coalesce(p_fitment_reasons,fitment_reasons), flags=coalesce(p_flags,flags),
      last_verified_at=now(), updated_at=now()
    where id=v_row.id returning * into v_row;
  end if;

  insert into public.price_observations (
    dsp_id, supplier_offer_id, canonical_part_id, supplier_source_id, seller_part_number,
    price_cents, shipping_cents, tax_cents, core_charge_cents, total_landed_cents, availability, delivery_days
  ) values (
    v_dsp, v_row.id, p_canonical_part_id, p_source_id, p_seller_part_number,
    p_price_cents, p_shipping_cents, p_tax_cents, p_core_charge_cents, v_landed, p_availability, p_delivery_days_min
  );

  return v_row;
end;
$$;
grant execute on function public.parts_offer_save(uuid,uuid,uuid,uuid,text,text,text,text,text,int,int,int,int,int,text,int,int,int,text,text,numeric,text,text,numeric,jsonb,jsonb,text) to authenticated;

-- ── Mark a search complete/partial + write per-source status ───────────
create or replace function public.parts_search_finish(
  p_search_id uuid, p_status text default 'complete',
  p_per_source jsonb default '{}'::jsonb, p_errors jsonb default '[]'::jsonb
) returns void
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_status,'complete') not in ('running','partial','complete','failed','cancelled') then
    raise exception 'bad_status' using errcode='22023';
  end if;
  update public.part_searches set
    status = coalesce(p_status,'complete'),
    per_source_status = coalesce(p_per_source, per_source_status),
    errors = coalesce(p_errors, errors),
    completed_at = case when p_status in ('complete','partial','failed','cancelled') then now() else completed_at end,
    updated_at = now()
  where id = p_search_id and dsp_id = v_dsp;
  if not found then raise exception 'search_not_found' using errcode='P0002'; end if;
end;
$$;
grant execute on function public.parts_search_finish(uuid,text,jsonb,jsonb) to authenticated;

-- ── Read a search + its ranked offers ──────────────────────────────────
create or replace function public.parts_search_results(p_search_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_search jsonb; v_offers jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select to_jsonb(s) into v_search from public.part_searches s where s.id=p_search_id and s.dsp_id=v_dsp;
  if v_search is null then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', o.id, 'supplier_source_id', o.supplier_source_id, 'source_name', src.name,
      'canonical_part_id', o.canonical_part_id, 'seller_name', o.seller_name,
      'seller_part_number', o.seller_part_number, 'product_title', o.product_title, 'product_url', o.product_url,
      'condition', o.condition, 'price_cents', o.price_cents, 'shipping_cents', o.shipping_cents,
      'tax_cents', o.tax_cents, 'core_charge_cents', o.core_charge_cents, 'discount_cents', o.discount_cents,
      'total_landed_cents', o.total_landed_cents, 'currency', o.currency, 'availability', o.availability,
      'quantity', o.quantity, 'delivery_days_min', o.delivery_days_min, 'delivery_days_max', o.delivery_days_max,
      'warranty', o.warranty, 'return_policy', o.return_policy, 'seller_rating', o.seller_rating,
      'fitment_claim', o.fitment_claim, 'fitment_confidence', o.fitment_confidence, 'fitment_score', o.fitment_score,
      'fitment_reasons', o.fitment_reasons, 'flags', o.flags, 'last_verified_at', o.last_verified_at
    ) order by o.total_landed_cents nulls last), '[]'::jsonb)
    into v_offers
    from public.supplier_offers o
    left join public.supplier_sources src on src.id = o.supplier_source_id
   where o.search_id = p_search_id and o.dsp_id = v_dsp;

  return jsonb_build_object('search', v_search, 'offers', v_offers);
end;
$$;
grant execute on function public.parts_search_results(uuid) to authenticated;

-- ── Price history for a part number ────────────────────────────────────
create or replace function public.parts_price_history(p_part_number text, p_days int default 90)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'observed_at', po.observed_at, 'total_landed_cents', po.total_landed_cents,
    'price_cents', po.price_cents, 'availability', po.availability, 'source_id', po.supplier_source_id
  ) order by po.observed_at), '[]'::jsonb)
  from public.price_observations po
  where po.dsp_id = private.current_dsp_id()
    and private.is_staff(po.dsp_id, 'dispatcher')
    and upper(po.seller_part_number) = upper(p_part_number)
    and po.observed_at >= now() - make_interval(days => greatest(coalesce(p_days,90),1));
$$;
grant execute on function public.parts_price_history(text, int) to authenticated;

-- ── Manual fitment override (audit-logged on the row) ──────────────────
create or replace function public.parts_compat_override(
  p_vehicle_id uuid, p_canonical_part_id uuid, p_status text, p_note text default null
) returns public.vehicle_part_compatibility
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.vehicle_part_compatibility;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_status,'') not in ('exact','high','likely','verify','incompatible') then
    raise exception 'bad_status' using errcode='22023';
  end if;
  -- Update the existing manual-override row for this (vehicle, part) if present,
  -- otherwise insert one. One manual-override row per (dsp, vehicle, part).
  update public.vehicle_part_compatibility set
    status=p_status, source='manual', manual_override=true, override_by=auth.uid(),
    override_at=now(), override_note=nullif(trim(p_note),''), verified_at=now(),
    confidence = case p_status when 'exact' then 1.0 when 'incompatible' then 0.0 else confidence end,
    updated_at=now()
  where dsp_id=v_dsp and vehicle_id=p_vehicle_id and canonical_part_id=p_canonical_part_id and manual_override=true
  returning * into v_row;
  if v_row.id is null then
    insert into public.vehicle_part_compatibility (
      dsp_id, vehicle_id, canonical_part_id, status, source, confidence,
      verified_at, manual_override, override_by, override_at, override_note
    ) values (
      v_dsp, p_vehicle_id, p_canonical_part_id, p_status, 'manual',
      case p_status when 'exact' then 1.0 when 'incompatible' then 0.0 else null end,
      now(), true, auth.uid(), now(), nullif(trim(p_note),'')
    ) returning * into v_row;
  end if;
  return v_row;
end;
$$;
grant execute on function public.parts_compat_override(uuid,uuid,text,text) to authenticated;

-- ── Watchlist save / list / delete ─────────────────────────────────────
create or replace function public.parts_watchlist_save(
  p_id uuid default null, p_vehicle_id uuid default null, p_canonical_part_id uuid default null,
  p_label text default null, p_query text default null, p_part_number text default null,
  p_max_price_cents int default null, p_required_by date default null,
  p_oem_preference text default 'any', p_condition_preference text default 'any',
  p_alert_types jsonb default '["target_price"]'::jsonb, p_price_drop_pct numeric default null
) returns public.part_watchlists
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.part_watchlists;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_id is null then
    insert into public.part_watchlists (
      dsp_id, vehicle_id, canonical_part_id, label, query_text, part_number, max_price_cents,
      required_by, oem_preference, condition_preference, alert_types, price_drop_pct, created_by
    ) values (
      v_dsp, p_vehicle_id, p_canonical_part_id, nullif(trim(p_label),''), nullif(trim(p_query),''),
      nullif(trim(p_part_number),''), p_max_price_cents, p_required_by,
      coalesce(p_oem_preference,'any'), coalesce(p_condition_preference,'any'),
      coalesce(p_alert_types,'["target_price"]'::jsonb), p_price_drop_pct, auth.uid()
    ) returning * into v_row;
  else
    update public.part_watchlists set
      vehicle_id=p_vehicle_id, canonical_part_id=p_canonical_part_id, label=nullif(trim(p_label),''),
      query_text=nullif(trim(p_query),''), part_number=nullif(trim(p_part_number),''),
      max_price_cents=p_max_price_cents, required_by=p_required_by,
      oem_preference=coalesce(p_oem_preference,oem_preference),
      condition_preference=coalesce(p_condition_preference,condition_preference),
      alert_types=coalesce(p_alert_types,alert_types), price_drop_pct=p_price_drop_pct, updated_at=now()
    where id=p_id and dsp_id=v_dsp returning * into v_row;
    if v_row.id is null then raise exception 'watch_not_found' using errcode='P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.parts_watchlist_save(uuid,uuid,uuid,text,text,text,int,date,text,text,jsonb,numeric) to authenticated;

create or replace function public.parts_watchlist_list()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', w.id, 'vehicle_id', w.vehicle_id, 'vehicle_name', v.name, 'canonical_part_id', w.canonical_part_id,
    'label', w.label, 'query_text', w.query_text, 'part_number', w.part_number, 'max_price_cents', w.max_price_cents,
    'required_by', w.required_by, 'oem_preference', w.oem_preference, 'condition_preference', w.condition_preference,
    'alert_types', w.alert_types, 'price_drop_pct', w.price_drop_pct, 'alert_status', w.alert_status,
    'last_alert_at', w.last_alert_at, 'last_seen_landed_cents', w.last_seen_landed_cents
  ) order by w.created_at desc), '[]'::jsonb)
  from public.part_watchlists w
  left join public.vehicles v on v.id = w.vehicle_id
  where w.dsp_id = private.current_dsp_id() and private.is_staff(w.dsp_id, 'dispatcher');
$$;
grant execute on function public.parts_watchlist_list() to authenticated;

create or replace function public.parts_watchlist_delete(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.part_watchlists where id=p_id and dsp_id=v_dsp;
  if not found then raise exception 'watch_not_found' using errcode='P0002'; end if;
end; $$;
grant execute on function public.parts_watchlist_delete(uuid) to authenticated;

-- ── Purchase save + list-for-vehicle ───────────────────────────────────
create or replace function public.parts_purchase_save(
  p_id uuid default null, p_vehicle_id uuid default null, p_canonical_part_id uuid default null,
  p_supplier_source_id uuid default null, p_supplier_offer_id uuid default null,
  p_vehicle_issue_id uuid default null, p_repair_order_id uuid default null,
  p_seller_name text default null, p_part_number text default null, p_description text default null,
  p_condition text default null, p_quantity int default 1, p_final_cost_cents int default null,
  p_purchase_date date default null, p_po_number text default null, p_receipt_path text default null,
  p_installer text default null, p_installed_at date default null, p_labor_cost_cents int default null,
  p_warranty_expires_on date default null, p_return_deadline date default null,
  p_status text default 'ordered', p_fitment_confidence text default null, p_notes text default null
) returns public.part_purchases
language plpgsql security definer set search_path = ''
as $$
declare v_dsp uuid := private.current_dsp_id(); v_row public.part_purchases;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_status,'ordered') not in ('ordered','shipped','delivered','installed','returned','cancelled') then
    raise exception 'bad_status' using errcode='22023';
  end if;
  if p_id is null then
    insert into public.part_purchases (
      dsp_id, vehicle_id, canonical_part_id, supplier_source_id, supplier_offer_id, vehicle_issue_id,
      repair_order_id, seller_name, part_number, description, condition, quantity, final_cost_cents,
      purchase_date, po_number, receipt_path, installer, installed_at, labor_cost_cents,
      warranty_expires_on, return_deadline, status, fitment_confidence, notes, created_by
    ) values (
      v_dsp, p_vehicle_id, p_canonical_part_id, p_supplier_source_id, p_supplier_offer_id, p_vehicle_issue_id,
      p_repair_order_id, p_seller_name, p_part_number, p_description, p_condition, coalesce(p_quantity,1),
      p_final_cost_cents, coalesce(p_purchase_date,current_date), p_po_number, p_receipt_path, p_installer,
      p_installed_at, p_labor_cost_cents, p_warranty_expires_on, p_return_deadline,
      coalesce(p_status,'ordered'), p_fitment_confidence, nullif(trim(p_notes),''), auth.uid()
    ) returning * into v_row;
  else
    update public.part_purchases set
      vehicle_id=p_vehicle_id, canonical_part_id=p_canonical_part_id, supplier_source_id=p_supplier_source_id,
      supplier_offer_id=p_supplier_offer_id, vehicle_issue_id=p_vehicle_issue_id, repair_order_id=p_repair_order_id,
      seller_name=p_seller_name, part_number=p_part_number, description=p_description, condition=p_condition,
      quantity=coalesce(p_quantity,quantity), final_cost_cents=p_final_cost_cents,
      purchase_date=coalesce(p_purchase_date,purchase_date), po_number=p_po_number, receipt_path=p_receipt_path,
      installer=p_installer, installed_at=p_installed_at, labor_cost_cents=p_labor_cost_cents,
      warranty_expires_on=p_warranty_expires_on, return_deadline=p_return_deadline,
      status=coalesce(p_status,status), fitment_confidence=p_fitment_confidence, notes=nullif(trim(p_notes),''),
      updated_at=now()
    where id=p_id and dsp_id=v_dsp returning * into v_row;
    if v_row.id is null then raise exception 'purchase_not_found' using errcode='P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.parts_purchase_save(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,text,int,int,date,text,text,text,date,int,date,date,text,text,text) to authenticated;

create or replace function public.parts_purchases_for_vehicle(p_vehicle_id uuid)
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'canonical_part_id', p.canonical_part_id, 'seller_name', p.seller_name,
    'part_number', p.part_number, 'description', p.description, 'condition', p.condition,
    'quantity', p.quantity, 'final_cost_cents', p.final_cost_cents, 'purchase_date', p.purchase_date,
    'po_number', p.po_number, 'installer', p.installer, 'installed_at', p.installed_at,
    'warranty_expires_on', p.warranty_expires_on, 'return_deadline', p.return_deadline,
    'status', p.status, 'vehicle_issue_id', p.vehicle_issue_id, 'repair_order_id', p.repair_order_id
  ) order by p.purchase_date desc), '[]'::jsonb)
  from public.part_purchases p
  where p.dsp_id = private.current_dsp_id() and private.is_staff(p.dsp_id, 'dispatcher')
    and p.vehicle_id = p_vehicle_id;
$$;
grant execute on function public.parts_purchases_for_vehicle(uuid) to authenticated;

notify pgrst, 'reload schema';
