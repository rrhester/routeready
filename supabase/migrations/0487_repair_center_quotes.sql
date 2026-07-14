-- Migration 0487 · Repair Center — Phases 3+4: shop directory columns
-- in use, quote requests, secure no-login shop links, quotes + line
-- items, and the shop-portal RPC surface.
--
-- Builds on 0486 (repair_cases spine). Design notes:
--
--   · Shops stay in public.vendors (0227/0313/0486) — no parallel
--     table. Contacts stay in vendors.contacts jsonb (0313); a
--     dedicated shop_contacts table was considered and rejected as a
--     duplicate system.
--   · Secure links follow the driver-session/document-verify pattern:
--     32 random bytes, hex, shown once; ONLY the sha-256 hash is
--     stored. Links expire, can be revoked, and are scoped to exactly
--     one quote request (one shop × one case).
--   · The shop portal (dashboard/shop.html) talks to the
--     repair-shop-portal edge function, which is the ONLY caller of
--     the repair_portal_* RPCs below (granted to service_role,
--     revoked from everyone else). Shops never get a Supabase session.
--   · Outbound email rides the existing email_messages queue with the
--     DSP's Fleet Bridge 'sent' folder set, so requests appear in the
--     Fleet Bridge Sent view and shop replies route back to the DSP
--     Inbox through webhook-email-inbound (case-matching lands in the
--     document-intelligence phase).
--   · Money is integer cents; quote totals are recomputed
--     server-side from line items. A shop-reported total that
--     disagrees is FLAGGED (totals_mismatch), never silently
--     corrected.
--
-- New tables:  secure_external_links, repair_quote_requests,
--              repair_quotes, repair_quote_line_items
-- New RPCs:    staff — repair_vendor_save, repair_vendors_list,
--                      repair_quote_requests_send,
--                      repair_quote_request_action,
--                      repair_case_quotes, repair_quote_manual_add,
--                      repair_case_attachment_set_visibility
--              portal (service_role only) — repair_portal_load,
--                      repair_portal_save_quote, repair_portal_decline,
--                      repair_portal_question,
--                      repair_portal_register_upload
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. secure_external_links ═══════════════

create table if not exists public.secure_external_links (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  purpose       text not null,
  token_hash    text not null,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  first_accessed_at timestamptz,
  last_accessed_at  timestamptz,
  use_count     int not null default 0,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  metadata      jsonb not null default '{}'::jsonb
);

do $$ begin
  alter table public.secure_external_links
    add constraint secure_external_links_purpose_chk
    check (purpose in ('repair_quote_request'));
exception when duplicate_object then null; end $$;

create unique index if not exists secure_external_links_hash_uq
  on public.secure_external_links (token_hash);
create index if not exists secure_external_links_dsp_idx
  on public.secure_external_links (dsp_id, purpose);

alter table public.secure_external_links enable row level security;
-- Staff may see link metadata for their tenant (never the token — only
-- the hash is stored). All writes go through SECURITY DEFINER RPCs.
drop policy if exists "secure_external_links_tenant_select" on public.secure_external_links;
create policy "secure_external_links_tenant_select"
  on public.secure_external_links for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.secure_external_links to authenticated;


-- ═══════════════════════════ 2. repair_quote_requests ═══════════════

create table if not exists public.repair_quote_requests (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  vendor_id       uuid not null references public.vendors(id) on delete cascade,
  secure_link_id  uuid references public.secure_external_links(id) on delete set null,
  email_message_id uuid references public.email_messages(id) on delete set null,

  request_status  text not null default 'queued',
  mask_vin        boolean not null default true,
  respond_by      timestamptz,
  request_message text,

  sent_at         timestamptz,
  opened_at       timestamptz,
  started_at      timestamptz,
  submitted_at    timestamptz,
  declined_at     timestamptz,
  decline_reason  text,
  reminder_count  int not null default 0,
  last_reminder_at timestamptz,

  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_quote_requests
    add constraint repair_quote_requests_status_chk check (request_status in
      ('queued','sent','opened','submitted','declined','expired','revoked','failed'));
exception when duplicate_object then null; end $$;

-- One ACTIVE request per case × shop (declined/expired/revoked rows
-- don't block a later re-request).
create unique index if not exists repair_quote_requests_active_uq
  on public.repair_quote_requests (repair_case_id, vendor_id)
  where request_status in ('queued','sent','opened');
create index if not exists repair_quote_requests_case_idx
  on public.repair_quote_requests (repair_case_id, created_at desc);
create index if not exists repair_quote_requests_dsp_open_idx
  on public.repair_quote_requests (dsp_id)
  where request_status in ('queued','sent','opened');

alter table public.repair_quote_requests enable row level security;
drop policy if exists "repair_quote_requests_tenant_select" on public.repair_quote_requests;
create policy "repair_quote_requests_tenant_select"
  on public.repair_quote_requests for select to authenticated
  using (dsp_id = private.current_dsp_id());
-- Writes only through the RPCs below.
grant select on public.repair_quote_requests to authenticated;


-- ═══════════════════════════ 3. repair_quotes ═══════════════════════

create table if not exists public.repair_quotes (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  quote_request_id uuid references public.repair_quote_requests(id) on delete set null,
  vendor_id       uuid references public.vendors(id) on delete set null,

  source          text not null default 'shop_form',
  status          text not null default 'draft',
  version         int not null default 1,
  supersedes_id   uuid references public.repair_quotes(id) on delete set null,

  quote_number    text,
  shop_work_order_number text,
  currency        text not null default 'USD',

  -- Totals (integer cents; recomputed from line items server-side)
  diagnostic_total_cents  int,
  labor_total_cents       int,
  parts_total_cents       int,
  sublet_total_cents      int,
  supplies_total_cents    int,
  environmental_total_cents int,
  towing_total_cents      int,
  discounts_total_cents   int,
  tax_total_cents         int,
  core_total_cents        int,
  misc_total_cents        int,
  grand_total_cents       int,
  shop_reported_total_cents int,
  totals_mismatch boolean not null default false,

  earliest_appointment_at timestamptz,
  estimated_start_at      timestamptz,
  estimated_completion_at timestamptz,
  expires_at              timestamptz,
  warranty_summary text,
  parts_availability text,
  notes            text,
  contact_name     text,
  contact_phone    text,
  contact_email    text,
  service_advisor  text,

  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  submitted_at    timestamptz,
  superseded_at   timestamptz
);

do $$ begin
  alter table public.repair_quotes
    add constraint repair_quotes_source_chk check (source in
      ('shop_form','pdf_upload','image_upload','email_attachment',
       'email_body','manual','phone'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_quotes
    add constraint repair_quotes_status_chk check (status in
      ('draft','submitted','superseded','accepted','declined','expired'));
exception when duplicate_object then null; end $$;

create index if not exists repair_quotes_case_idx
  on public.repair_quotes (repair_case_id, created_at desc);
create index if not exists repair_quotes_request_idx
  on public.repair_quotes (quote_request_id);

alter table public.repair_quotes enable row level security;
drop policy if exists "repair_quotes_tenant_select" on public.repair_quotes;
create policy "repair_quotes_tenant_select"
  on public.repair_quotes for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.repair_quotes to authenticated;


-- ═══════════════════════════ 4. repair_quote_line_items ═════════════

create table if not exists public.repair_quote_line_items (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  quote_id        uuid not null references public.repair_quotes(id) on delete cascade,
  line_number     int not null default 1,
  category        text not null default 'labor',
  description     text not null,
  part_number     text,
  part_brand      text,
  part_condition  text,
  quantity        numeric(10,2),
  unit_price_cents int,
  parts_total_cents int,
  labor_hours     numeric(6,2),
  labor_rate_cents int,
  labor_total_cents int,
  fees_cents      int,
  tax_cents       int,
  line_total_cents int,
  required        boolean not null default true,
  recommended     boolean not null default false,
  approval_status text not null default 'pending',
  notes           text,
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_quote_line_items
    add constraint repair_quote_line_items_category_chk check (category in
      ('diagnostic','labor','part_oem','part_aftermarket','part_used',
       'part_reman','sublet','towing','supplies','environmental',
       'tax','discount','misc'));
exception when duplicate_object then null; end $$;

create index if not exists repair_quote_line_items_quote_idx
  on public.repair_quote_line_items (quote_id, line_number);

alter table public.repair_quote_line_items enable row level security;
drop policy if exists "repair_quote_line_items_tenant_select" on public.repair_quote_line_items;
create policy "repair_quote_line_items_tenant_select"
  on public.repair_quote_line_items for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.repair_quote_line_items to authenticated;


-- ═══════════════════════════ 5. Private helpers ═════════════════════

-- HTML-escape for the email/portal builders.
create or replace function private._rc_esc(p text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(replace(coalesce(p, ''),
    '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;');
$$;

-- Mint a secure link: returns (link_id, raw_token). The raw token is
-- returned exactly once and never stored — only its sha-256 hash.
create or replace function private.repair_link_mint(
  p_dsp uuid, p_purpose text, p_days int, p_created_by uuid
) returns table (link_id uuid, raw_token text)
language plpgsql
security definer set search_path = ''
as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_id uuid;
begin
  insert into public.secure_external_links
    (dsp_id, purpose, token_hash, expires_at, created_by)
  values
    (p_dsp, p_purpose,
     encode(extensions.digest(v_token, 'sha256'), 'hex'),
     now() + make_interval(days => greatest(coalesce(p_days, 7), 1)),
     p_created_by)
  returning id into v_id;
  return query select v_id, v_token;
end;
$$;

-- Resolve + validate a portal token → the quote request row.
-- Raises machine-readable errors the edge function maps to friendly
-- copy: invalid_link / link_revoked / link_expired.
create or replace function private.repair_portal_request(p_token text)
returns public.repair_quote_requests
language plpgsql
security definer set search_path = ''
as $$
declare
  v_link public.secure_external_links;
  v_req  public.repair_quote_requests;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{32,128}$' then
    raise exception 'invalid_link' using errcode = 'P0002';
  end if;
  select * into v_link from public.secure_external_links
   where token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and purpose = 'repair_quote_request';
  if not found then
    raise exception 'invalid_link' using errcode = 'P0002';
  end if;
  if v_link.revoked_at is not null then
    raise exception 'link_revoked' using errcode = 'P0002';
  end if;
  if v_link.expires_at < now() then
    raise exception 'link_expired' using errcode = 'P0002';
  end if;
  if v_link.use_count > 5000 then          -- abuse ceiling
    raise exception 'link_revoked' using errcode = 'P0002';
  end if;

  update public.secure_external_links set
    use_count = use_count + 1,
    first_accessed_at = coalesce(first_accessed_at, now()),
    last_accessed_at = now()
  where id = v_link.id;

  select * into v_req from public.repair_quote_requests
   where secure_link_id = v_link.id;
  if not found then
    raise exception 'invalid_link' using errcode = 'P0002';
  end if;
  return v_req;
end;
$$;

-- Recompute a quote's totals from its line items (deterministic; the
-- single money path — no AI, no floats).
create or replace function private.repair_quote_recompute(p_quote_id uuid)
returns void
language plpgsql
security definer set search_path = ''
as $$
begin
  update public.repair_quotes q set
    diagnostic_total_cents = t.diag,
    labor_total_cents      = t.labor,
    parts_total_cents      = t.parts,
    sublet_total_cents     = t.sublet,
    supplies_total_cents   = t.supplies,
    environmental_total_cents = t.env,
    towing_total_cents     = t.towing,
    discounts_total_cents  = t.discount,
    tax_total_cents        = t.tax,
    misc_total_cents       = t.misc,
    grand_total_cents      = t.grand,
    totals_mismatch = (q.shop_reported_total_cents is not null
                       and abs(q.shop_reported_total_cents - t.grand) > 100)
  from (
    select
      coalesce(sum(line_total_cents) filter (where category = 'diagnostic'), 0)::int as diag,
      coalesce(sum(labor_total_cents), 0)::int as labor,
      coalesce(sum(parts_total_cents), 0)::int as parts,
      coalesce(sum(line_total_cents) filter (where category = 'sublet'), 0)::int as sublet,
      coalesce(sum(line_total_cents) filter (where category = 'supplies'), 0)::int as supplies,
      coalesce(sum(line_total_cents) filter (where category = 'environmental'), 0)::int as env,
      coalesce(sum(line_total_cents) filter (where category = 'towing'), 0)::int as towing,
      coalesce(sum(line_total_cents) filter (where category = 'discount'), 0)::int as discount,
      coalesce(sum(tax_cents), 0)::int
        + coalesce(sum(line_total_cents) filter (where category = 'tax'), 0)::int as tax,
      coalesce(sum(line_total_cents) filter (where category = 'misc'), 0)::int as misc,
      coalesce(sum(line_total_cents), 0)::int as grand
    from public.repair_quote_line_items
    where quote_id = p_quote_id
  ) t
  where q.id = p_quote_id;
end;
$$;

-- Build the quote-request email. Uses the DSP's custom
-- message_templates row (key 'repair.quote_request') when present,
-- else a built-in table-layout HTML matching the invite email style.
create or replace function private.repair_request_email(
  p_dsp public.dsps,
  p_vendor public.vendors,
  p_case public.repair_cases,
  p_vehicle public.vehicles,
  p_link text,
  p_respond_by timestamptz,
  p_expires_at timestamptz,
  p_message text,
  p_reminder boolean default false
) returns table (subject text, body_html text, body_text text)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_veh text := btrim(concat_ws(' ', p_vehicle.year::text, p_vehicle.make, p_vehicle.model));
  v_unit text := coalesce(p_vehicle.nickname, p_vehicle.name, '');
  v_subject text;
  v_html text;
  v_text text;
  v_deadline text := case when p_respond_by is null then null
                          else to_char(p_respond_by, 'Dy, Mon FMDD · FMHH12:MI AM') end;
  t_subject text; t_body text;
begin
  v_subject := case when p_reminder then 'Reminder: ' else '' end
    || 'Repair quote request — ' || v_veh
    || case when v_unit = '' then '' else ' · ' || v_unit end
    || ' (' || coalesce(p_dsp.name, 'RouteReady') || ')';

  -- Custom per-DSP template wins when configured.
  select t.subject, t.body into t_subject, t_body
  from private.render_template(p_dsp.id, 'email', 'repair.quote_request',
    jsonb_build_object(
      'shop_name', coalesce(p_vendor.name, ''),
      'dsp_name', coalesce(p_dsp.name, ''),
      'vehicle', v_veh, 'unit', v_unit,
      'issue_title', p_case.title,
      'link', p_link,
      'respond_by', coalesce(v_deadline, ''),
      'message', coalesce(p_message, ''))) t;
  if t_body is not null then
    return query select coalesce(t_subject, v_subject), t_body, t_body;
    return;
  end if;

  v_html :=
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;font-family:-apple-system,''Segoe UI'',Inter,Arial,sans-serif">'
    || '<tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:10px;border:1px solid #E5E7EB">'
    || '<tr><td style="padding:22px 28px 6px"><div style="font-size:13px;font-weight:700;color:#2563EB;letter-spacing:.06em;text-transform:uppercase">Repair quote request</div>'
    || '<div style="font-size:19px;font-weight:700;color:#111827;padding-top:6px">' || private._rc_esc(v_veh)
    || case when v_unit = '' then '' else ' — ' || private._rc_esc(p_case.title) end
    || '</div>'
    || '<div style="font-size:13px;color:#6B7280;padding-top:4px">From ' || private._rc_esc(coalesce(p_dsp.name,'a RouteReady fleet operator'))
    || case when v_unit = '' then '' else ' · Unit ' || private._rc_esc(v_unit) end
    || case when p_vehicle.mileage is null then '' else ' · ' || to_char(p_vehicle.mileage, 'FM999,999,999') || ' mi' end
    || '</div></td></tr>'
    || case when coalesce(btrim(p_message), '') = '' then '' else
       '<tr><td style="padding:14px 28px 0"><div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:#111827">'
       || private._rc_esc(p_message) || '</div></td></tr>' end
    || case when v_deadline is null then '' else
       '<tr><td style="padding:14px 28px 0;font-size:14px;color:#111827"><strong>Please respond by ' || private._rc_esc(v_deadline) || '.</strong></td></tr>' end
    || '<tr><td style="padding:20px 28px 8px" align="center">'
    || '<a href="' || private._rc_esc(p_link) || '" style="display:inline-block;background:#2563EB;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px">View request &amp; submit a quote</a></td></tr>'
    || '<tr><td style="padding:6px 28px 22px;font-size:12px;line-height:1.6;color:#6B7280" align="center">'
    || 'This private link is for ' || private._rc_esc(coalesce(p_vendor.name,'your shop'))
    || ' and expires ' || to_char(p_expires_at, 'Mon FMDD') || '. '
    || 'You can also reply to this email with your written estimate attached.</td></tr>'
    || '</table></td></tr></table>';

  v_text := 'Repair quote request from ' || coalesce(p_dsp.name,'a RouteReady fleet operator')
    || E'\n\nVehicle: ' || v_veh
    || case when v_unit = '' then '' else ' · Unit ' || v_unit end
    || E'\nIssue: ' || p_case.title
    || case when coalesce(btrim(p_message),'') = '' then '' else E'\n\n' || p_message end
    || case when v_deadline is null then '' else E'\n\nPlease respond by ' || v_deadline || '.' end
    || E'\n\nView the request and submit a quote:\n' || p_link
    || E'\n\nThis private link expires ' || to_char(p_expires_at, 'Mon FMDD')
    || E'. You can also reply to this email with your written estimate attached.';

  return query select v_subject, v_html, v_text;
end;
$$;


-- ═══════════════════════════ 6. Staff RPCs ══════════════════════════

-- ── repair_vendor_save ───────────────────────────────────────────────
-- Create / edit a shop with the Repair Center fields. Extends (does
-- not replace) vendor_save/fleet_calendar_provider_upsert.
create or replace function public.repair_vendor_save(
  p_id       uuid default null,
  p_patch    jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vendors;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_id is null then
    if coalesce(btrim(p_patch->>'name'), '') = '' then
      raise exception 'name_required' using errcode = '22023';
    end if;
    insert into public.vendors (dsp_id, name) values (v_dsp, btrim(p_patch->>'name'))
    returning * into v_row;
  else
    select * into v_row from public.vendors where id = p_id and dsp_id = v_dsp;
    if not found then
      raise exception 'vendor_not_found' using errcode = 'P0002';
    end if;
  end if;

  update public.vendors set
    name          = coalesce(nullif(btrim(coalesce(p_patch->>'name','')), ''), name),
    kind          = coalesce(nullif(p_patch->>'kind',''), kind),
    contact_name  = case when p_patch ? 'contact_name'  then nullif(btrim(coalesce(p_patch->>'contact_name','')),'')  else contact_name end,
    contact_phone = case when p_patch ? 'contact_phone' then nullif(btrim(coalesce(p_patch->>'contact_phone','')),'') else contact_phone end,
    contact_email = case when p_patch ? 'contact_email' then lower(nullif(btrim(coalesce(p_patch->>'contact_email','')),'')) else contact_email end,
    address       = case when p_patch ? 'address'       then nullif(btrim(coalesce(p_patch->>'address','')),'')       else address end,
    city          = case when p_patch ? 'city'          then nullif(btrim(coalesce(p_patch->>'city','')),'')          else city end,
    distance_mi   = case when p_patch ? 'distance_mi'   then nullif(p_patch->>'distance_mi','')::numeric              else distance_mi end,
    website       = case when p_patch ? 'website'       then nullif(btrim(coalesce(p_patch->>'website','')),'')       else website end,
    hours_note    = case when p_patch ? 'hours_note'    then nullif(btrim(coalesce(p_patch->>'hours_note','')),'')    else hours_note end,
    notes         = case when p_patch ? 'notes'         then nullif(btrim(coalesce(p_patch->>'notes','')),'')         else notes end,
    preferred_status = coalesce(nullif(p_patch->>'preferred_status',''), preferred_status),
    blocked_reason   = case when p_patch ? 'blocked_reason' then nullif(btrim(coalesce(p_patch->>'blocked_reason','')),'') else blocked_reason end,
    mobile_service   = case when p_patch ? 'mobile_service'   then (p_patch->>'mobile_service')::boolean   else mobile_service end,
    towing_available = case when p_patch ? 'towing_available' then (p_patch->>'towing_available')::boolean else towing_available end,
    after_hours      = case when p_patch ? 'after_hours'      then (p_patch->>'after_hours')::boolean      else after_hours end,
    service_categories       = case when p_patch ? 'service_categories'       then coalesce(p_patch->'service_categories', '[]'::jsonb)       else service_categories end,
    supported_vehicle_types  = case when p_patch ? 'supported_vehicle_types'  then coalesce(p_patch->'supported_vehicle_types', '[]'::jsonb)  else supported_vehicle_types end,
    updated_at    = now()
  where id = v_row.id
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name);
end;
$$;

-- ── repair_vendors_list ──────────────────────────────────────────────
-- The Shop Directory: vendors + live counts derived from Repair Center
-- activity (open cases, active requests, submitted quotes).
create or replace function public.repair_vendors_list()
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(v order by
           case v->>'preferred_status'
             when 'preferred' then 0 when 'approved' then 1
             when 'emergency' then 2 else 3 end,
           v->>'name'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',            vn.id,
      'name',          vn.name,
      'kind',          vn.kind,
      'contact_name',  vn.contact_name,
      'contact_phone', vn.contact_phone,
      'contact_email', vn.contact_email,
      'address',       vn.address,
      'city',          vn.city,
      'distance_mi',   vn.distance_mi,
      'website',       vn.website,
      'hours_note',    vn.hours_note,
      'notes',         vn.notes,
      'contacts',      coalesce(vn.contacts, '[]'::jsonb),
      'preferred_status', vn.preferred_status,
      'blocked_reason',   vn.blocked_reason,
      'mobile_service',   vn.mobile_service,
      'towing_available', vn.towing_available,
      'after_hours',      vn.after_hours,
      'service_categories', vn.service_categories,
      'supported_vehicle_types', vn.supported_vehicle_types,
      'open_cases',    coalesce(oc.cnt, 0),
      'active_requests', coalesce(rq.active_cnt, 0),
      'quotes_submitted', coalesce(rq.submitted_cnt, 0),
      'avg_response_hours', rq.avg_response_hours,
      'completed_cases', coalesce(cc.cnt, 0)
    ) v
    from public.vendors vn
    left join lateral (
      select count(*)::int as cnt from public.repair_cases
      where vendor_id = vn.id and stage not in ('closed','cancelled')
        and archived_at is null
    ) oc on true
    left join lateral (
      select
        count(*) filter (where request_status in ('queued','sent','opened'))::int as active_cnt,
        count(*) filter (where request_status = 'submitted')::int as submitted_cnt,
        round(avg(extract(epoch from (submitted_at - sent_at)) / 3600.0)
              filter (where submitted_at is not null and sent_at is not null), 1) as avg_response_hours
      from public.repair_quote_requests
      where vendor_id = vn.id
    ) rq on true
    left join lateral (
      select count(*)::int as cnt from public.repair_cases
      where vendor_id = vn.id and stage = 'closed'
    ) cc on true
    where vn.dsp_id = private.current_dsp_id()
      and private.is_staff(vn.dsp_id, 'dispatcher')
      and coalesce(vn.paused, false) = false
  ) t;
$$;
grant execute on function public.repair_vendors_list() to authenticated;

-- ── repair_quote_requests_send ───────────────────────────────────────
-- Send the same repair request to one or more shops. Each shop gets
-- its own secure link + email. Returns per-shop results including the
-- RAW link (shown once for copy/share — never stored).
create or replace function public.repair_quote_requests_send(
  p_case_id     uuid,
  p_vendor_ids  uuid[],
  p_message     text default null,
  p_respond_by  timestamptz default null,
  p_expires_days int default 7,
  p_mask_vin    boolean default true,
  p_share_photos boolean default false
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_dsp_row public.dsps;
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_vendor public.vendors;
  v_vendor_id uuid;
  v_link record;
  v_req public.repair_quote_requests;
  v_email record;
  v_email_id uuid;
  v_sent_folder uuid;
  v_base text;
  v_url text;
  v_results jsonb := '[]'::jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_vendor_ids is null or array_length(p_vendor_ids, 1) is null then
    raise exception 'no_vendors' using errcode = '22023';
  end if;

  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  select * into v_dsp_row from public.dsps where id = v_dsp;
  select * into v_vehicle from public.vehicles where id = v_case.vehicle_id;

  v_base := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com');
  select id into v_sent_folder from public.fb_folders
   where dsp_id = v_dsp and kind = 'sent' limit 1;

  if p_share_photos then
    update public.repair_case_attachments
       set shop_visible = true
     where repair_case_id = p_case_id and dsp_id = v_dsp
       and coalesce(mime_type, '') like 'image/%';
  end if;

  foreach v_vendor_id in array p_vendor_ids loop
    select * into v_vendor from public.vendors
     where id = v_vendor_id and dsp_id = v_dsp;
    if not found then
      v_results := v_results || jsonb_build_object(
        'vendor_id', v_vendor_id, 'ok', false, 'error', 'vendor_not_found');
      continue;
    end if;
    if v_vendor.preferred_status = 'blocked' then
      v_results := v_results || jsonb_build_object(
        'vendor_id', v_vendor_id, 'vendor_name', v_vendor.name,
        'ok', false, 'error', 'vendor_blocked');
      continue;
    end if;
    if coalesce(btrim(v_vendor.contact_email), '') = '' then
      v_results := v_results || jsonb_build_object(
        'vendor_id', v_vendor_id, 'vendor_name', v_vendor.name,
        'ok', false, 'error', 'vendor_no_email');
      continue;
    end if;
    if exists (select 1 from public.repair_quote_requests
                where repair_case_id = p_case_id and vendor_id = v_vendor_id
                  and request_status in ('queued','sent','opened')) then
      v_results := v_results || jsonb_build_object(
        'vendor_id', v_vendor_id, 'vendor_name', v_vendor.name,
        'ok', false, 'error', 'request_already_active');
      continue;
    end if;

    select * into v_link
      from private.repair_link_mint(v_dsp, 'repair_quote_request',
                                    p_expires_days, auth.uid());
    v_url := v_base || '/q/' || v_link.raw_token;

    insert into public.repair_quote_requests
      (dsp_id, repair_case_id, vendor_id, secure_link_id, request_status,
       mask_vin, respond_by, request_message, created_by)
    values
      (v_dsp, p_case_id, v_vendor_id, v_link.link_id, 'queued',
       coalesce(p_mask_vin, true), p_respond_by,
       nullif(btrim(coalesce(p_message,'')), ''), auth.uid())
    returning * into v_req;

    select * into v_email from private.repair_request_email(
      v_dsp_row, v_vendor, v_case, v_vehicle, v_url,
      p_respond_by, now() + make_interval(days => greatest(coalesce(p_expires_days,7),1)),
      p_message, false);

    insert into public.email_messages
      (dsp_id, direction, status, to_email, subject, body_text, body_html, folder_id)
    values
      (v_dsp, 'outbound', 'queued', v_vendor.contact_email,
       v_email.subject, v_email.body_text, v_email.body_html, v_sent_folder)
    returning id into v_email_id;

    update public.repair_quote_requests
       set email_message_id = v_email_id, request_status = 'sent',
           sent_at = now(), updated_at = now()
     where id = v_req.id;

    perform private.repair_case_event(
      v_dsp, p_case_id, 'quote_request_sent',
      'Quote request sent to ' || v_vendor.name,
      null, null, 'dsp', false, false,
      jsonb_build_object('request_id', v_req.id, 'vendor_id', v_vendor_id));

    v_results := v_results || jsonb_build_object(
      'vendor_id', v_vendor_id, 'vendor_name', v_vendor.name,
      'ok', true, 'request_id', v_req.id, 'link', v_url);
  end loop;

  -- The case is now out for quotes.
  if v_case.stage in ('reported','review') then
    update public.repair_cases
       set stage = 'quoting', updated_at = now() where id = p_case_id;
    perform private.repair_case_event(
      v_dsp, p_case_id, 'stage_changed', 'Requesting quotes',
      v_case.stage, 'quoting', 'system', false, true, '{}'::jsonb);
  end if;

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
  values
    (v_dsp, 'user', auth.uid(), 'repair_quote_requests_sent',
     v_case.case_number || ' · quote requests sent',
     'repair_case', p_case_id);

  return v_results;
end;
$$;

-- ── repair_quote_request_action ──────────────────────────────────────
-- remind · queue a reminder email      revoke · kill the link
-- regenerate · revoke + mint a fresh link (returned raw, once)
create or replace function public.repair_quote_request_action(
  p_request_id uuid,
  p_action     text
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_req public.repair_quote_requests;
  v_dsp_row public.dsps;
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_vendor public.vendors;
  v_link record;
  v_email record;
  v_email_id uuid;
  v_sent_folder uuid;
  v_base text;
  v_url text;
  v_expires timestamptz;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_req from public.repair_quote_requests
   where id = p_request_id and dsp_id = v_dsp;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;
  select * into v_vendor from public.vendors where id = v_req.vendor_id;
  select * into v_case from public.repair_cases where id = v_req.repair_case_id;

  if p_action = 'revoke' then
    update public.secure_external_links set revoked_at = coalesce(revoked_at, now())
     where id = v_req.secure_link_id;
    update public.repair_quote_requests
       set request_status = 'revoked', updated_at = now() where id = v_req.id;
    perform private.repair_case_event(
      v_dsp, v_req.repair_case_id, 'quote_request_revoked',
      'Quote request to ' || coalesce(v_vendor.name,'shop') || ' revoked',
      null, null, 'dsp', false, false, '{}'::jsonb);
    return jsonb_build_object('ok', true);

  elsif p_action = 'regenerate' then
    -- Allowed even after submission — shops revise quotes through a
    -- fresh link. Only terminal-refusal states are excluded.
    if v_req.request_status in ('declined','expired','failed') then
      raise exception 'request_not_active' using errcode = '22023';
    end if;
    update public.secure_external_links set revoked_at = coalesce(revoked_at, now())
     where id = v_req.secure_link_id;
    select * into v_link
      from private.repair_link_mint(v_dsp, 'repair_quote_request', 7, auth.uid());
    select * into v_dsp_row from public.dsps where id = v_dsp;
    v_base := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com');
    v_url := v_base || '/q/' || v_link.raw_token;
    update public.repair_quote_requests
       set secure_link_id = v_link.link_id,
           request_status = case when request_status = 'revoked' then 'sent' else request_status end,
           updated_at = now()
     where id = v_req.id;
    return jsonb_build_object('ok', true, 'link', v_url);

  elsif p_action = 'remind' then
    if v_req.request_status not in ('sent','opened') then
      raise exception 'request_not_active' using errcode = '22023';
    end if;
    if coalesce(btrim(v_vendor.contact_email), '') = '' then
      raise exception 'vendor_no_email' using errcode = '22023';
    end if;
    -- A reminder reuses the SAME link → mint nothing; rebuild the URL
    -- is impossible (hash-only), so regenerate a fresh link for it.
    update public.secure_external_links set revoked_at = coalesce(revoked_at, now())
     where id = v_req.secure_link_id;
    select * into v_link
      from private.repair_link_mint(v_dsp, 'repair_quote_request', 7, auth.uid());
    v_expires := now() + make_interval(days => 7);
    select * into v_dsp_row from public.dsps where id = v_dsp;
    select * into v_vehicle from public.vehicles where id = v_case.vehicle_id;
    v_base := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com');
    v_url := v_base || '/q/' || v_link.raw_token;
    select id into v_sent_folder from public.fb_folders
     where dsp_id = v_dsp and kind = 'sent' limit 1;
    select * into v_email from private.repair_request_email(
      v_dsp_row, v_vendor, v_case, v_vehicle, v_url,
      v_req.respond_by, v_expires, v_req.request_message, true);
    insert into public.email_messages
      (dsp_id, direction, status, to_email, subject, body_text, body_html, folder_id)
    values
      (v_dsp, 'outbound', 'queued', v_vendor.contact_email,
       v_email.subject, v_email.body_text, v_email.body_html, v_sent_folder)
    returning id into v_email_id;
    update public.repair_quote_requests
       set secure_link_id = v_link.link_id,
           reminder_count = reminder_count + 1,
           last_reminder_at = now(),
           email_message_id = v_email_id,
           updated_at = now()
     where id = v_req.id;
    perform private.repair_case_event(
      v_dsp, v_req.repair_case_id, 'quote_request_reminded',
      'Reminder sent to ' || coalesce(v_vendor.name,'shop'),
      null, null, 'dsp', false, false, '{}'::jsonb);
    return jsonb_build_object('ok', true);
  end if;

  raise exception 'bad_action' using errcode = '22023';
end;
$$;

-- ── repair_case_quotes ───────────────────────────────────────────────
-- Requests + quotes (+ line items) for one case — the drawer's Quotes
-- section and the comparison phase's data source.
create or replace function public.repair_case_quotes(p_case_id uuid)
returns jsonb
language sql
stable
security definer set search_path = ''
as $$
  select jsonb_build_object(
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', r.id, 'vendor_id', r.vendor_id, 'vendor_name', vn.name,
        'request_status', r.request_status, 'respond_by', r.respond_by,
        'sent_at', r.sent_at, 'opened_at', r.opened_at,
        'submitted_at', r.submitted_at, 'declined_at', r.declined_at,
        'decline_reason', r.decline_reason,
        'reminder_count', r.reminder_count,
        'link_expires_at', l.expires_at, 'link_revoked', l.revoked_at is not null)
        order by r.created_at desc)
      from public.repair_quote_requests r
      left join public.vendors vn on vn.id = r.vendor_id
      left join public.secure_external_links l on l.id = r.secure_link_id
      where r.repair_case_id = p_case_id), '[]'::jsonb),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id, 'vendor_id', q.vendor_id, 'vendor_name', vn.name,
        'quote_request_id', q.quote_request_id,
        'source', q.source, 'status', q.status, 'version', q.version,
        'quote_number', q.quote_number,
        'shop_work_order_number', q.shop_work_order_number,
        'grand_total_cents', q.grand_total_cents,
        'shop_reported_total_cents', q.shop_reported_total_cents,
        'totals_mismatch', q.totals_mismatch,
        'labor_total_cents', q.labor_total_cents,
        'parts_total_cents', q.parts_total_cents,
        'tax_total_cents', q.tax_total_cents,
        'earliest_appointment_at', q.earliest_appointment_at,
        'estimated_completion_at', q.estimated_completion_at,
        'expires_at', q.expires_at,
        'warranty_summary', q.warranty_summary,
        'parts_availability', q.parts_availability,
        'notes', q.notes,
        'contact_name', q.contact_name, 'contact_phone', q.contact_phone,
        'submitted_at', q.submitted_at, 'created_at', q.created_at,
        'line_items', coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', li.id, 'line_number', li.line_number,
            'category', li.category, 'description', li.description,
            'part_number', li.part_number, 'part_brand', li.part_brand,
            'part_condition', li.part_condition,
            'quantity', li.quantity, 'unit_price_cents', li.unit_price_cents,
            'parts_total_cents', li.parts_total_cents,
            'labor_hours', li.labor_hours, 'labor_rate_cents', li.labor_rate_cents,
            'labor_total_cents', li.labor_total_cents,
            'fees_cents', li.fees_cents, 'tax_cents', li.tax_cents,
            'line_total_cents', li.line_total_cents,
            'required', li.required, 'recommended', li.recommended,
            'approval_status', li.approval_status, 'notes', li.notes)
            order by li.line_number)
          from public.repair_quote_line_items li
          where li.quote_id = q.id), '[]'::jsonb))
        order by q.created_at desc)
      from public.repair_quotes q
      left join public.vendors vn on vn.id = q.vendor_id
      where q.repair_case_id = p_case_id
        and q.status <> 'draft'), '[]'::jsonb)
  )
  from public.repair_cases rc
  where rc.id = p_case_id
    and rc.dsp_id = private.current_dsp_id()
    and private.is_staff(rc.dsp_id, 'dispatcher');
$$;
grant execute on function public.repair_case_quotes(uuid) to authenticated;

-- ── repair_quote_manual_add ──────────────────────────────────────────
-- Phone / manual quote entry by staff. Line items optional; totals
-- recomputed from them when present, else taken from p_grand_total.
create or replace function public.repair_quote_manual_add(
  p_case_id   uuid,
  p_vendor_id uuid,
  p_source    text default 'phone',
  p_grand_total_cents int default null,
  p_line_items jsonb default '[]'::jsonb,
  p_details   jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_quote public.repair_quotes;
  v_item jsonb;
  v_n int := 0;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_source not in ('phone','manual') then
    raise exception 'bad_source' using errcode = '22023';
  end if;
  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.vendors where id = p_vendor_id and dsp_id = v_dsp) then
    raise exception 'vendor_not_found' using errcode = 'P0002';
  end if;

  insert into public.repair_quotes
    (dsp_id, repair_case_id, vendor_id, source, status,
     quote_number, shop_work_order_number,
     grand_total_cents, shop_reported_total_cents,
     earliest_appointment_at, estimated_completion_at, expires_at,
     warranty_summary, parts_availability, notes,
     contact_name, contact_phone, service_advisor,
     created_by, submitted_at)
  values
    (v_dsp, p_case_id, p_vendor_id, p_source, 'submitted',
     nullif(btrim(coalesce(p_details->>'quote_number','')),''),
     nullif(btrim(coalesce(p_details->>'shop_work_order_number','')),''),
     p_grand_total_cents, p_grand_total_cents,
     nullif(p_details->>'earliest_appointment_at','')::timestamptz,
     nullif(p_details->>'estimated_completion_at','')::timestamptz,
     nullif(p_details->>'expires_at','')::timestamptz,
     nullif(btrim(coalesce(p_details->>'warranty_summary','')),''),
     nullif(btrim(coalesce(p_details->>'parts_availability','')),''),
     nullif(btrim(coalesce(p_details->>'notes','')),''),
     nullif(btrim(coalesce(p_details->>'contact_name','')),''),
     nullif(btrim(coalesce(p_details->>'contact_phone','')),''),
     nullif(btrim(coalesce(p_details->>'service_advisor','')),''),
     auth.uid(), now())
  returning * into v_quote;

  for v_item in select * from jsonb_array_elements(coalesce(p_line_items, '[]'::jsonb)) loop
    v_n := v_n + 1;
    insert into public.repair_quote_line_items
      (dsp_id, quote_id, line_number, category, description,
       part_number, quantity, unit_price_cents, parts_total_cents,
       labor_hours, labor_rate_cents, labor_total_cents,
       fees_cents, tax_cents, line_total_cents, required, recommended)
    values
      (v_dsp, v_quote.id,
       coalesce(nullif(v_item->>'line_number','')::int, v_n),
       coalesce(nullif(v_item->>'category',''), 'labor'),
       coalesce(nullif(btrim(coalesce(v_item->>'description','')),''), 'Line ' || v_n),
       nullif(btrim(coalesce(v_item->>'part_number','')),''),
       nullif(v_item->>'quantity','')::numeric,
       nullif(v_item->>'unit_price_cents','')::int,
       nullif(v_item->>'parts_total_cents','')::int,
       nullif(v_item->>'labor_hours','')::numeric,
       nullif(v_item->>'labor_rate_cents','')::int,
       nullif(v_item->>'labor_total_cents','')::int,
       nullif(v_item->>'fees_cents','')::int,
       nullif(v_item->>'tax_cents','')::int,
       nullif(v_item->>'line_total_cents','')::int,
       coalesce((v_item->>'required')::boolean, true),
       coalesce((v_item->>'recommended')::boolean, false));
  end loop;

  if v_n > 0 then
    perform private.repair_quote_recompute(v_quote.id);
  end if;

  perform private.repair_case_event(
    v_dsp, p_case_id, 'quote_received',
    'Quote recorded (' || p_source || ')',
    null, null, p_source, false, false,
    jsonb_build_object('quote_id', v_quote.id, 'vendor_id', p_vendor_id));

  if v_case.stage = 'quoting' then
    update public.repair_cases set stage = 'quotes_in', updated_at = now()
     where id = p_case_id;
    perform private.repair_case_event(
      v_dsp, p_case_id, 'stage_changed', 'Quotes received',
      'quoting', 'quotes_in', 'system', false, true, '{}'::jsonb);
  end if;

  return public.repair_case_quotes(p_case_id);
end;
$$;

-- ── repair_case_attachment_set_visibility ────────────────────────────
create or replace function public.repair_case_attachment_set_visibility(
  p_attachment_id uuid,
  p_shop_visible  boolean
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.repair_case_attachments
     set shop_visible = coalesce(p_shop_visible, false)
   where id = p_attachment_id and dsp_id = v_dsp;
  if not found then
    raise exception 'attachment_not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function public.repair_vendor_save(uuid, jsonb) to authenticated;
grant execute on function public.repair_quote_requests_send(uuid, uuid[], text, timestamptz, int, boolean, boolean) to authenticated;
grant execute on function public.repair_quote_request_action(uuid, text) to authenticated;
grant execute on function public.repair_quote_manual_add(uuid, uuid, text, int, jsonb, jsonb) to authenticated;
grant execute on function public.repair_case_attachment_set_visibility(uuid, boolean) to authenticated;


-- ═══════════════════════════ 7. Portal RPCs (service_role only) ═════
-- Called exclusively by the repair-shop-portal edge function, which
-- owns token transport, rate limiting, and file handling. Everything
-- here re-validates the token server-side (defense in depth).

-- ── repair_portal_load ───────────────────────────────────────────────
create or replace function public.repair_portal_load(p_token text)
returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_vendor public.vendors;
  v_dsp public.dsps;
  v_quote public.repair_quotes;
begin
  v_req := private.repair_portal_request(p_token);

  if v_req.opened_at is null then
    update public.repair_quote_requests
       set opened_at = now(),
           request_status = case when request_status = 'sent' then 'opened' else request_status end,
           updated_at = now()
     where id = v_req.id;
    perform private.repair_case_event(
      v_req.dsp_id, v_req.repair_case_id, 'quote_request_opened',
      'Shop opened the request', null, null, 'shop_link', true, true, '{}'::jsonb);
  end if;

  select * into v_case from public.repair_cases where id = v_req.repair_case_id;
  select * into v_vehicle from public.vehicles where id = v_case.vehicle_id;
  select * into v_vendor from public.vendors where id = v_req.vendor_id;
  select * into v_dsp from public.dsps where id = v_req.dsp_id;
  select * into v_quote from public.repair_quotes
   where quote_request_id = v_req.id and status in ('draft','submitted')
   order by created_at desc limit 1;

  return jsonb_build_object(
    'request', jsonb_build_object(
      'id', v_req.id, 'status', v_req.request_status,
      'respond_by', v_req.respond_by, 'message', v_req.request_message,
      'declined_at', v_req.declined_at, 'submitted_at', v_req.submitted_at),
    'dsp', jsonb_build_object('name', v_dsp.name),
    'shop', jsonb_build_object('name', v_vendor.name),
    'vehicle', jsonb_build_object(
      'year', v_vehicle.year, 'make', v_vehicle.make, 'model', v_vehicle.model,
      'unit', coalesce(v_vehicle.nickname, v_vehicle.name),
      'mileage', v_vehicle.mileage,
      'vin', case when v_req.mask_vin and v_vehicle.vin is not null
                  then '…' || right(v_vehicle.vin, 8)
                  else v_vehicle.vin end),
    'case', jsonb_build_object(
      'title', v_case.title, 'description', v_case.description,
      'category', v_case.category, 'severity', v_case.severity,
      'drivable', v_case.drivable, 'towing_required', v_case.towing_required,
      'required_completion_at', v_case.required_completion_at),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type,
        'storage_bucket', a.storage_bucket, 'storage_path', a.storage_path)
        order by a.created_at)
      from public.repair_case_attachments a
      where a.repair_case_id = v_case.id and a.shop_visible), '[]'::jsonb),
    'quote', case when v_quote.id is null then null else jsonb_build_object(
      'id', v_quote.id, 'status', v_quote.status,
      'quote_number', v_quote.quote_number,
      'shop_work_order_number', v_quote.shop_work_order_number,
      'shop_reported_total_cents', v_quote.shop_reported_total_cents,
      'grand_total_cents', v_quote.grand_total_cents,
      'earliest_appointment_at', v_quote.earliest_appointment_at,
      'estimated_completion_at', v_quote.estimated_completion_at,
      'expires_at', v_quote.expires_at,
      'warranty_summary', v_quote.warranty_summary,
      'parts_availability', v_quote.parts_availability,
      'notes', v_quote.notes,
      'contact_name', v_quote.contact_name,
      'contact_phone', v_quote.contact_phone,
      'contact_email', v_quote.contact_email,
      'line_items', coalesce((
        select jsonb_agg(jsonb_build_object(
          'line_number', li.line_number, 'category', li.category,
          'description', li.description, 'part_number', li.part_number,
          'quantity', li.quantity, 'unit_price_cents', li.unit_price_cents,
          'parts_total_cents', li.parts_total_cents,
          'labor_hours', li.labor_hours, 'labor_rate_cents', li.labor_rate_cents,
          'labor_total_cents', li.labor_total_cents,
          'fees_cents', li.fees_cents, 'tax_cents', li.tax_cents,
          'line_total_cents', li.line_total_cents, 'required', li.required)
          order by li.line_number)
        from public.repair_quote_line_items li
        where li.quote_id = v_quote.id), '[]'::jsonb)) end
  );
end;
$$;

-- ── repair_portal_save_quote ─────────────────────────────────────────
-- Draft (p_submit=false) or submit a structured quote from the portal.
-- Line items replace the draft's; totals are recomputed here.
create or replace function public.repair_portal_save_quote(
  p_token  text,
  p_quote  jsonb,
  p_submit boolean default false
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
  v_case public.repair_cases;
  v_quote public.repair_quotes;
  v_prior uuid;
  v_item jsonb;
  v_n int := 0;
begin
  v_req := private.repair_portal_request(p_token);
  if v_req.request_status in ('declined','revoked','expired') then
    raise exception 'request_closed' using errcode = '22023';
  end if;

  -- Reuse the open draft for this request, else start a new version.
  select * into v_quote from public.repair_quotes
   where quote_request_id = v_req.id and status = 'draft'
   order by created_at desc limit 1;

  if v_quote.id is null then
    select id into v_prior from public.repair_quotes
     where quote_request_id = v_req.id and status = 'submitted'
     order by version desc limit 1;
    insert into public.repair_quotes
      (dsp_id, repair_case_id, quote_request_id, vendor_id, source, status,
       version, supersedes_id)
    values
      (v_req.dsp_id, v_req.repair_case_id, v_req.id, v_req.vendor_id,
       'shop_form', 'draft',
       coalesce((select version + 1 from public.repair_quotes where id = v_prior), 1),
       v_prior)
    returning * into v_quote;
  end if;

  update public.repair_quotes set
    quote_number = nullif(btrim(coalesce(p_quote->>'quote_number','')),''),
    shop_work_order_number = nullif(btrim(coalesce(p_quote->>'shop_work_order_number','')),''),
    shop_reported_total_cents = nullif(p_quote->>'shop_reported_total_cents','')::int,
    earliest_appointment_at = nullif(p_quote->>'earliest_appointment_at','')::timestamptz,
    estimated_start_at      = nullif(p_quote->>'estimated_start_at','')::timestamptz,
    estimated_completion_at = nullif(p_quote->>'estimated_completion_at','')::timestamptz,
    expires_at              = nullif(p_quote->>'expires_at','')::timestamptz,
    warranty_summary   = nullif(btrim(coalesce(p_quote->>'warranty_summary','')),''),
    parts_availability = nullif(btrim(coalesce(p_quote->>'parts_availability','')),''),
    notes              = nullif(btrim(coalesce(p_quote->>'notes','')),''),
    contact_name       = nullif(btrim(coalesce(p_quote->>'contact_name','')),''),
    contact_phone      = nullif(btrim(coalesce(p_quote->>'contact_phone','')),''),
    contact_email      = lower(nullif(btrim(coalesce(p_quote->>'contact_email','')),'')),
    service_advisor    = nullif(btrim(coalesce(p_quote->>'service_advisor','')),'')
  where id = v_quote.id;

  delete from public.repair_quote_line_items where quote_id = v_quote.id;
  for v_item in select * from jsonb_array_elements(coalesce(p_quote->'line_items', '[]'::jsonb)) loop
    v_n := v_n + 1;
    exit when v_n > 100;                     -- sanity ceiling
    insert into public.repair_quote_line_items
      (dsp_id, quote_id, line_number, category, description,
       part_number, part_brand, part_condition,
       quantity, unit_price_cents, parts_total_cents,
       labor_hours, labor_rate_cents, labor_total_cents,
       fees_cents, tax_cents, line_total_cents, required, recommended, notes)
    values
      (v_req.dsp_id, v_quote.id, v_n,
       coalesce(nullif(v_item->>'category',''), 'labor'),
       left(coalesce(nullif(btrim(coalesce(v_item->>'description','')),''), 'Line ' || v_n), 500),
       left(nullif(btrim(coalesce(v_item->>'part_number','')),''), 80),
       left(nullif(btrim(coalesce(v_item->>'part_brand','')),''), 80),
       left(nullif(btrim(coalesce(v_item->>'part_condition','')),''), 40),
       nullif(v_item->>'quantity','')::numeric,
       nullif(v_item->>'unit_price_cents','')::int,
       nullif(v_item->>'parts_total_cents','')::int,
       nullif(v_item->>'labor_hours','')::numeric,
       nullif(v_item->>'labor_rate_cents','')::int,
       nullif(v_item->>'labor_total_cents','')::int,
       nullif(v_item->>'fees_cents','')::int,
       nullif(v_item->>'tax_cents','')::int,
       nullif(v_item->>'line_total_cents','')::int,
       coalesce((v_item->>'required')::boolean, true),
       coalesce((v_item->>'recommended')::boolean, false),
       left(nullif(btrim(coalesce(v_item->>'notes','')),''), 300));
  end loop;

  perform private.repair_quote_recompute(v_quote.id);

  if p_submit then
    -- Supersede any previously submitted version from this request.
    update public.repair_quotes
       set status = 'superseded', superseded_at = now()
     where quote_request_id = v_req.id and status = 'submitted' and id <> v_quote.id;

    update public.repair_quotes
       set status = 'submitted', submitted_at = now()
     where id = v_quote.id;

    update public.repair_quote_requests
       set request_status = 'submitted', submitted_at = now(),
           started_at = coalesce(started_at, now()), updated_at = now()
     where id = v_req.id;

    perform private.repair_case_event(
      v_req.dsp_id, v_req.repair_case_id, 'quote_received',
      'Quote submitted via secure link',
      null, null, 'shop_link', true, false,
      jsonb_build_object('quote_id', v_quote.id, 'vendor_id', v_req.vendor_id));

    select * into v_case from public.repair_cases where id = v_req.repair_case_id;
    if v_case.stage = 'quoting' then
      update public.repair_cases set stage = 'quotes_in', updated_at = now()
       where id = v_case.id;
      perform private.repair_case_event(
        v_req.dsp_id, v_case.id, 'stage_changed', 'Quotes received',
        'quoting', 'quotes_in', 'system', false, true, '{}'::jsonb);
    end if;
  else
    update public.repair_quote_requests
       set started_at = coalesce(started_at, now()), updated_at = now()
     where id = v_req.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'quote_id', v_quote.id,
    'submitted', coalesce(p_submit, false),
    'grand_total_cents', (select grand_total_cents from public.repair_quotes where id = v_quote.id),
    'totals_mismatch', (select totals_mismatch from public.repair_quotes where id = v_quote.id));
end;
$$;

-- ── repair_portal_decline ────────────────────────────────────────────
create or replace function public.repair_portal_decline(
  p_token  text,
  p_reason text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
begin
  v_req := private.repair_portal_request(p_token);
  update public.repair_quote_requests
     set request_status = 'declined', declined_at = now(),
         decline_reason = left(nullif(btrim(coalesce(p_reason,'')),''), 500),
         updated_at = now()
   where id = v_req.id;
  perform private.repair_case_event(
    v_req.dsp_id, v_req.repair_case_id, 'quote_request_declined',
    'Shop declined the request'
      || case when coalesce(btrim(p_reason),'') = '' then '' else ' — ' || left(btrim(p_reason), 200) end,
    null, null, 'shop_link', true, false, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;

-- ── repair_portal_question ───────────────────────────────────────────
create or replace function public.repair_portal_question(
  p_token   text,
  p_message text
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
begin
  v_req := private.repair_portal_request(p_token);
  if coalesce(btrim(p_message), '') = '' then
    raise exception 'message_required' using errcode = '22023';
  end if;
  perform private.repair_case_event(
    v_req.dsp_id, v_req.repair_case_id, 'shop_question',
    left(btrim(p_message), 1000),
    null, null, 'shop_link', true, false,
    jsonb_build_object('request_id', v_req.id, 'vendor_id', v_req.vendor_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- ── repair_portal_register_upload ────────────────────────────────────
-- The edge function uploads the file bytes with the service role, then
-- records it here (source shop_link, visible both ways).
create or replace function public.repair_portal_register_upload(
  p_token        text,
  p_storage_path text,
  p_file_name    text,
  p_mime_type    text default null,
  p_byte_size    bigint default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
  v_row public.repair_case_attachments;
begin
  v_req := private.repair_portal_request(p_token);
  if p_storage_path not like v_req.dsp_id::text || '/' || v_req.repair_case_id::text || '/%' then
    raise exception 'bad_storage_path' using errcode = '22023';
  end if;
  insert into public.repair_case_attachments
    (dsp_id, repair_case_id, storage_path, file_name, mime_type,
     byte_size, attachment_type, source, shop_visible)
  values
    (v_req.dsp_id, v_req.repair_case_id, p_storage_path,
     left(btrim(p_file_name), 160), p_mime_type, p_byte_size,
     'estimate', 'shop_link', true)
  returning * into v_row;
  perform private.repair_case_event(
    v_req.dsp_id, v_req.repair_case_id, 'attachment_added',
    'Shop uploaded ' || left(btrim(p_file_name), 120),
    null, null, 'shop_link', true, false,
    jsonb_build_object('attachment_id', v_row.id, 'request_id', v_req.id));
  return jsonb_build_object('ok', true, 'attachment_id', v_row.id);
end;
$$;

-- ── repair_portal_upload_target ──────────────────────────────────────
-- Mints the storage path for a shop upload. The edge function asks for
-- the target, uploads the bytes with the service role, then registers
-- the file — the shop client never supplies tenant/case ids.
create or replace function public.repair_portal_upload_target(
  p_token     text,
  p_file_name text
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
  v_safe text;
begin
  v_req := private.repair_portal_request(p_token);
  v_safe := left(regexp_replace(coalesce(nullif(btrim(p_file_name),''),'file'),
                                '[^A-Za-z0-9._-]+', '_', 'g'), 100);
  return jsonb_build_object(
    'bucket', 'repair-attachments',
    'path', v_req.dsp_id::text || '/' || v_req.repair_case_id::text
            || '/shop-' || to_char(now(), 'YYYYMMDDHH24MISS')
            || '-' || v_safe);
end;
$$;

-- Portal functions: service_role only.
revoke execute on function public.repair_portal_upload_target(text, text) from public, anon, authenticated;
grant execute on function public.repair_portal_upload_target(text, text) to service_role;
revoke execute on function public.repair_portal_load(text) from public, anon, authenticated;
revoke execute on function public.repair_portal_save_quote(text, jsonb, boolean) from public, anon, authenticated;
revoke execute on function public.repair_portal_decline(text, text) from public, anon, authenticated;
revoke execute on function public.repair_portal_question(text, text) from public, anon, authenticated;
revoke execute on function public.repair_portal_register_upload(text, text, text, text, bigint) from public, anon, authenticated;
grant execute on function public.repair_portal_load(text) to service_role;
grant execute on function public.repair_portal_save_quote(text, jsonb, boolean) to service_role;
grant execute on function public.repair_portal_decline(text, text) to service_role;
grant execute on function public.repair_portal_question(text, text) to service_role;
grant execute on function public.repair_portal_register_upload(text, text, text, text, bigint) to service_role;


notify pgrst, 'reload schema';
