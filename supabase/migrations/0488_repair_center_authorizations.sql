-- Migration 0488 · Repair Center — Phase 5: authorizations.
--
-- Builds on 0486 (repair_cases) and 0487 (quotes + secure links + shop
-- portal). Adds the decision layer between "quotes are in" and "the
-- shop may start work":
--
--   · repair_authorizations — versioned, immutable-once-issued records
--     of WHAT was authorized: full quote, selected line items,
--     diagnostics only, or a not-to-exceed cap. A new authorization
--     supersedes the previous one (version + supersedes_id chain); the
--     history is never rewritten.
--   · repair_authorization_lines — a SNAPSHOT of the quote's line items
--     with a per-line decision (approved/declined) taken at issue time,
--     so later quote revisions can't mutate what was authorized.
--   · Money stays integer cents and is computed HERE (sum of approved
--     snapshot lines / the quote's stored total / the explicit cap) —
--     never by the client, never by AI.
--   · The shop is notified by email (existing email_messages queue) and
--     acknowledges through the same secure-link portal as quoting; a
--     fresh link is minted per notification (tokens are hash-only, so
--     re-use is impossible by construction — the 'remind' pattern).
--   · Quote statuses follow the decision: the authorized quote becomes
--     'accepted'; optionally the other submitted quotes are 'declined'.
--     Extracted/entered quote data is never modified — only status.
--
-- New RPCs:   staff  — repair_authorization_issue,
--                      repair_authorization_action
--             portal (service_role only) — repair_portal_acknowledge
-- Replaced:   repair_case_quotes  (adds 'authorizations' to the payload)
--             repair_portal_load  (adds the shop's own authorization)
--
-- Idempotent: safe to re-run in the SQL Editor.

-- ═══════════════════════════ 1. repair_authorizations ═══════════════

create table if not exists public.repair_authorizations (
  id              uuid primary key default gen_random_uuid(),
  dsp_id          uuid not null references public.dsps(id) on delete cascade,
  repair_case_id  uuid not null references public.repair_cases(id) on delete cascade,
  quote_id        uuid references public.repair_quotes(id) on delete set null,
  vendor_id       uuid references public.vendors(id) on delete set null,

  authorization_type text not null,
  status          text not null default 'issued',
  version         int not null default 1,
  supersedes_id   uuid references public.repair_authorizations(id) on delete set null,

  -- Integer cents, computed server-side at issue time (see the RPC).
  authorized_total_cents int,
  nte_cap_cents          int,

  po_number       text,
  notes           text,                       -- shown to the shop

  authorized_by   uuid references auth.users(id) on delete set null,
  authorized_at   timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by text,                       -- name typed at the portal / 'dsp'
  superseded_at   timestamptz,
  revoked_at      timestamptz,
  revoke_reason   text,
  email_message_id uuid references public.email_messages(id) on delete set null,
  created_at      timestamptz not null default now()
);

do $$ begin
  alter table public.repair_authorizations
    add constraint repair_authorizations_type_chk check (authorization_type in
      ('full','selected_lines','diagnostics_only','not_to_exceed'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.repair_authorizations
    add constraint repair_authorizations_status_chk check (status in
      ('issued','acknowledged','superseded','revoked'));
exception when duplicate_object then null; end $$;

-- One CURRENT authorization per case; superseded/revoked rows keep the
-- history (the issue RPC supersedes before inserting, same transaction).
create unique index if not exists repair_authorizations_active_uq
  on public.repair_authorizations (repair_case_id)
  where status in ('issued','acknowledged');
create index if not exists repair_authorizations_case_idx
  on public.repair_authorizations (repair_case_id, version desc);
create index if not exists repair_authorizations_dsp_idx
  on public.repair_authorizations (dsp_id);

alter table public.repair_authorizations enable row level security;
drop policy if exists "repair_authorizations_tenant_select" on public.repair_authorizations;
create policy "repair_authorizations_tenant_select"
  on public.repair_authorizations for select to authenticated
  using (dsp_id = private.current_dsp_id());
-- Writes only through the SECURITY DEFINER RPCs below.
grant select on public.repair_authorizations to authenticated;


-- ═══════════════════════════ 2. repair_authorization_lines ══════════
-- Snapshot of the quote's line items at issue time, with the per-line
-- decision. quote_line_item_id is a soft pointer (set null on delete);
-- the descriptive fields are copies so the record stands alone.

create table if not exists public.repair_authorization_lines (
  id                 uuid primary key default gen_random_uuid(),
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  authorization_id   uuid not null references public.repair_authorizations(id) on delete cascade,
  quote_line_item_id uuid references public.repair_quote_line_items(id) on delete set null,
  line_number        int not null default 1,
  category           text,
  description        text not null,
  line_total_cents   int,
  decision           text not null default 'approved',
  created_at         timestamptz not null default now()
);

do $$ begin
  alter table public.repair_authorization_lines
    add constraint repair_authorization_lines_decision_chk check (decision in
      ('approved','declined'));
exception when duplicate_object then null; end $$;

create index if not exists repair_authorization_lines_auth_idx
  on public.repair_authorization_lines (authorization_id, line_number);

alter table public.repair_authorization_lines enable row level security;
drop policy if exists "repair_authorization_lines_tenant_select" on public.repair_authorization_lines;
create policy "repair_authorization_lines_tenant_select"
  on public.repair_authorization_lines for select to authenticated
  using (dsp_id = private.current_dsp_id());
grant select on public.repair_authorization_lines to authenticated;


-- ═══════════════════════════ 3. Authorization email ═════════════════
-- Uses the DSP's custom template (key 'repair.authorization') when
-- configured, else a built-in table-layout HTML matching the
-- quote-request email style. The acknowledge link is optional — a shop
-- reached only by phone still gets the written record by email.

create or replace function private.repair_authorization_email(
  p_dsp public.dsps,
  p_vendor public.vendors,
  p_case public.repair_cases,
  p_vehicle public.vehicles,
  p_auth public.repair_authorizations,
  p_link text
) returns table (subject text, body_html text, body_text text)
language plpgsql
stable
security definer set search_path = ''
as $$
declare
  v_veh text := btrim(concat_ws(' ', p_vehicle.year::text, p_vehicle.make, p_vehicle.model));
  v_unit text := coalesce(p_vehicle.nickname, p_vehicle.name, '');
  v_amount text := case when p_auth.authorized_total_cents is null then null
    else '$' || to_char(p_auth.authorized_total_cents::numeric / 100, 'FM999,999,990.00') end;
  v_headline text;
  v_scope text;
  v_subject text;
  v_html text;
  v_text text;
  v_rows_html text := '';
  v_rows_text text := '';
  v_declined_html text := '';
  v_declined_text text := '';
  t_subject text; t_body text;
  r record;
begin
  v_headline := case p_auth.authorization_type
    when 'full'             then 'Work authorized'
    when 'selected_lines'   then 'Work authorized — selected items'
    when 'diagnostics_only' then 'Diagnostics authorized'
    else 'Work authorized — not to exceed ' || coalesce(v_amount, '') end;
  v_scope := case p_auth.authorization_type
    when 'full'             then 'The quote is approved in full' || case when v_amount is null then '' else ' — ' || v_amount end || '.'
    when 'selected_lines'   then 'Only the line items marked approved below are authorized'
                                 || case when v_amount is null then '' else ' — ' || v_amount || ' total' end || '.'
    when 'diagnostics_only' then 'Diagnosis only is authorized'
                                 || case when v_amount is null then '' else ' — up to ' || v_amount end
                                 || '. Please send findings and an updated quote before any repair work.'
    else 'Work is authorized up to ' || coalesce(v_amount, 'the agreed cap')
         || '. Anything beyond the cap needs written approval before proceeding.' end;

  v_subject := v_headline || ' — ' || v_veh
    || case when v_unit = '' then '' else ' · ' || v_unit end
    || ' (' || coalesce(p_dsp.name, 'RouteReady') || ')';

  select t.subject, t.body into t_subject, t_body
  from private.render_template(p_dsp.id, 'email', 'repair.authorization',
    jsonb_build_object(
      'shop_name', coalesce(p_vendor.name, ''),
      'dsp_name', coalesce(p_dsp.name, ''),
      'vehicle', v_veh, 'unit', v_unit,
      'issue_title', p_case.title,
      'authorization_type', p_auth.authorization_type,
      'amount', coalesce(v_amount, ''),
      'po_number', coalesce(p_auth.po_number, ''),
      'notes', coalesce(p_auth.notes, ''),
      'link', coalesce(p_link, ''))) t;
  if t_body is not null then
    return query select coalesce(t_subject, v_subject), t_body, t_body;
    return;
  end if;

  for r in
    select line_number, description, line_total_cents, decision
    from public.repair_authorization_lines
    where authorization_id = p_auth.id
    order by line_number
  loop
    if r.decision = 'approved' then
      v_rows_html := v_rows_html
        || '<tr><td style="padding:6px 0;font-size:13px;color:#111827;border-bottom:1px solid #F3F4F6">'
        || private._rc_esc(r.description) || '</td>'
        || '<td align="right" style="padding:6px 0;font-size:13px;font-weight:600;color:#111827;border-bottom:1px solid #F3F4F6;white-space:nowrap">'
        || coalesce('$' || to_char(r.line_total_cents::numeric / 100, 'FM999,999,990.00'), '—')
        || '</td></tr>';
      v_rows_text := v_rows_text || E'\n  · ' || r.description
        || coalesce(' — $' || to_char(r.line_total_cents::numeric / 100, 'FM999,999,990.00'), '');
    else
      v_declined_html := v_declined_html
        || '<div style="font-size:13px;color:#6B7280;padding:3px 0">' || private._rc_esc(r.description)
        || coalesce(' — $' || to_char(r.line_total_cents::numeric / 100, 'FM999,999,990.00'), '') || '</div>';
      v_declined_text := v_declined_text || E'\n  · ' || r.description
        || coalesce(' — $' || to_char(r.line_total_cents::numeric / 100, 'FM999,999,990.00'), '');
    end if;
  end loop;

  v_html :=
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3F4F6;padding:24px 12px;font-family:-apple-system,''Segoe UI'',Inter,Arial,sans-serif">'
    || '<tr><td align="center"><table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#FFFFFF;border-radius:10px;border:1px solid #E5E7EB">'
    || '<tr><td style="padding:22px 28px 6px"><div style="font-size:13px;font-weight:700;color:#16A34A;letter-spacing:.06em;text-transform:uppercase">' || private._rc_esc(v_headline) || '</div>'
    || '<div style="font-size:19px;font-weight:700;color:#111827;padding-top:6px">' || private._rc_esc(v_veh)
    || ' — ' || private._rc_esc(p_case.title) || '</div>'
    || '<div style="font-size:13px;color:#6B7280;padding-top:4px">From ' || private._rc_esc(coalesce(p_dsp.name,'a RouteReady fleet operator'))
    || case when v_unit = '' then '' else ' · Unit ' || private._rc_esc(v_unit) end
    || case when p_auth.po_number is null then ''
            when p_auth.po_number ~* '^po' then ' · ' || private._rc_esc(p_auth.po_number)
            else ' · PO ' || private._rc_esc(p_auth.po_number) end
    || '</div></td></tr>'
    || '<tr><td style="padding:14px 28px 0;font-size:14px;line-height:1.55;color:#111827">' || private._rc_esc(v_scope) || '</td></tr>'
    || case when v_rows_html = '' then '' else
       '<tr><td style="padding:14px 28px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
       || '<tr><td style="font-size:11px;font-weight:700;color:#6B7280;letter-spacing:.05em;text-transform:uppercase;padding-bottom:4px">Approved work</td><td></td></tr>'
       || v_rows_html || '</table></td></tr>' end
    || case when v_amount is null then '' else
       '<tr><td style="padding:12px 28px 0;font-size:15px;color:#111827"><strong>'
       || case when p_auth.authorization_type = 'not_to_exceed' then 'Authorized cap: ' else 'Authorized total: ' end
       || private._rc_esc(v_amount) || '</strong></td></tr>' end
    || case when v_declined_html = '' then '' else
       '<tr><td style="padding:14px 28px 0"><div style="font-size:11px;font-weight:700;color:#6B7280;letter-spacing:.05em;text-transform:uppercase;padding-bottom:2px">Not approved</div>'
       || v_declined_html || '</td></tr>' end
    || case when coalesce(btrim(p_auth.notes), '') = '' then '' else
       '<tr><td style="padding:14px 28px 0"><div style="background:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;padding:12px 14px;font-size:14px;line-height:1.55;color:#111827">'
       || private._rc_esc(p_auth.notes) || '</div></td></tr>' end
    || case when p_link is null then
       '<tr><td style="padding:18px 28px 22px;font-size:13px;line-height:1.6;color:#6B7280">Please reply to this email to confirm you''ve received this authorization.</td></tr>'
       else
       '<tr><td style="padding:20px 28px 8px" align="center">'
       || '<a href="' || private._rc_esc(p_link) || '" style="display:inline-block;background:#2563EB;color:#FFFFFF;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px">View authorization &amp; acknowledge</a></td></tr>'
       || '<tr><td style="padding:6px 28px 22px;font-size:12px;line-height:1.6;color:#6B7280" align="center">'
       || 'This private link is for ' || private._rc_esc(coalesce(p_vendor.name,'your shop'))
       || '. Acknowledging tells the operator you''ve seen the authorization and the scope is clear.</td></tr>' end
    || '</table></td></tr></table>';

  v_text := v_headline || ' — ' || coalesce(p_dsp.name,'a RouteReady fleet operator')
    || E'\n\nVehicle: ' || v_veh
    || case when v_unit = '' then '' else ' · Unit ' || v_unit end
    || E'\nIssue: ' || p_case.title
    || case when p_auth.po_number is null then '' else E'\nPO: ' || p_auth.po_number end
    || E'\n\n' || v_scope
    || case when v_rows_text = '' then '' else E'\n\nApproved work:' || v_rows_text end
    || case when v_amount is null then '' else
       E'\n\n' || case when p_auth.authorization_type = 'not_to_exceed' then 'Authorized cap: ' else 'Authorized total: ' end || v_amount end
    || case when v_declined_text = '' then '' else E'\n\nNot approved:' || v_declined_text end
    || case when coalesce(btrim(p_auth.notes), '') = '' then '' else E'\n\n' || p_auth.notes end
    || case when p_link is null then E'\n\nPlease reply to this email to confirm receipt.'
       else E'\n\nView the authorization and acknowledge:\n' || p_link end;

  return query select v_subject, v_html, v_text;
end;
$$;

-- Internal: queue the authorization email for a vendor, minting a fresh
-- portal link when the case has a usable request channel for it. Used
-- by issue() and by the 'resend' action. Returns the email id + link.
create or replace function private.repair_authorization_notify(
  p_auth_id uuid
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_auth public.repair_authorizations;
  v_dsp_row public.dsps;
  v_case public.repair_cases;
  v_vehicle public.vehicles;
  v_vendor public.vendors;
  v_req public.repair_quote_requests;
  v_link record;
  v_email record;
  v_email_id uuid;
  v_sent_folder uuid;
  v_url text := null;
begin
  select * into v_auth from public.repair_authorizations where id = p_auth_id;
  if not found then
    raise exception 'authorization_not_found' using errcode = 'P0002';
  end if;
  select * into v_vendor from public.vendors where id = v_auth.vendor_id;
  if v_vendor.id is null or coalesce(btrim(v_vendor.contact_email), '') = '' then
    return jsonb_build_object('email_queued', false, 'reason', 'vendor_no_email');
  end if;
  select * into v_dsp_row from public.dsps where id = v_auth.dsp_id;
  select * into v_case from public.repair_cases where id = v_auth.repair_case_id;
  select * into v_vehicle from public.vehicles where id = v_case.vehicle_id;

  -- Reuse the case×shop secure-link channel when one exists (tokens are
  -- hash-only, so "reuse" always means revoke + mint fresh — the same
  -- rotation the 'remind' action does).
  select * into v_req from public.repair_quote_requests
   where repair_case_id = v_auth.repair_case_id
     and vendor_id = v_auth.vendor_id
     and request_status in ('queued','sent','opened','submitted')
   order by created_at desc limit 1;
  if found then
    update public.secure_external_links set revoked_at = coalesce(revoked_at, now())
     where id = v_req.secure_link_id;
    select * into v_link
      from private.repair_link_mint(v_auth.dsp_id, 'repair_quote_request', 14, auth.uid());
    update public.repair_quote_requests
       set secure_link_id = v_link.link_id, updated_at = now()
     where id = v_req.id;
    v_url := coalesce(v_dsp_row.metadata->>'public_base_url', 'https://gorouteready.com')
             || '/q/' || v_link.raw_token;
  end if;

  select id into v_sent_folder from public.fb_folders
   where dsp_id = v_auth.dsp_id and kind = 'sent' limit 1;

  select * into v_email from private.repair_authorization_email(
    v_dsp_row, v_vendor, v_case, v_vehicle, v_auth, v_url);

  insert into public.email_messages
    (dsp_id, direction, status, to_email, subject, body_text, body_html, folder_id)
  values
    (v_auth.dsp_id, 'outbound', 'queued', v_vendor.contact_email,
     v_email.subject, v_email.body_text, v_email.body_html, v_sent_folder)
  returning id into v_email_id;

  update public.repair_authorizations
     set email_message_id = v_email_id where id = p_auth_id;

  return jsonb_build_object('email_queued', true, 'link', v_url);
end;
$$;


-- ═══════════════════════════ 4. repair_authorization_issue ══════════
-- The single write path for authorizing work. Everything money is
-- computed here from stored data:
--   full             → the quote's grand total (or its reported total
--                      for totals-only phone quotes)
--   selected_lines   → sum of the approved lines' stored line totals
--   diagnostics_only → the explicit cap (optional)
--   not_to_exceed    → the explicit cap (required)
create or replace function public.repair_authorization_issue(
  p_case_id        uuid,
  p_type           text,
  p_quote_id       uuid default null,
  p_vendor_id      uuid default null,
  p_line_decisions jsonb default '[]'::jsonb,   -- [{id, decision}] for selected_lines
  p_amount_cents   int default null,
  p_po_number      text default null,
  p_notes          text default null,
  p_decline_others boolean default false,
  p_send_email     boolean default true
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_case public.repair_cases;
  v_quote public.repair_quotes;
  v_vendor_id uuid;
  v_total int;
  v_cap int := null;
  v_version int;
  v_prior uuid;
  v_auth public.repair_authorizations;
  v_approved_ids uuid[];
  v_approved_count int := 0;
  v_notify jsonb := jsonb_build_object('email_queued', false);
  v_li record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_type not in ('full','selected_lines','diagnostics_only','not_to_exceed') then
    raise exception 'bad_type' using errcode = '22023';
  end if;
  if p_amount_cents is not null and (p_amount_cents < 0 or p_amount_cents > 100000000) then
    raise exception 'bad_amount' using errcode = '22023';  -- $1M fat-finger ceiling
  end if;

  select * into v_case from public.repair_cases
   where id = p_case_id and dsp_id = v_dsp;
  if not found then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;
  if v_case.stage in ('closed','cancelled') then
    raise exception 'case_closed' using errcode = '22023';
  end if;

  if p_quote_id is not null then
    select * into v_quote from public.repair_quotes
     where id = p_quote_id and repair_case_id = p_case_id and dsp_id = v_dsp;
    if not found then
      raise exception 'quote_not_found' using errcode = 'P0002';
    end if;
    if v_quote.status not in ('submitted','accepted') then
      raise exception 'quote_not_open' using errcode = '22023';
    end if;
  end if;

  if p_type in ('full','selected_lines') then
    if v_quote.id is null then
      raise exception 'quote_required' using errcode = '22023';
    end if;
    v_vendor_id := v_quote.vendor_id;
    if v_vendor_id is null then
      raise exception 'quote_has_no_vendor' using errcode = '22023';
    end if;
  else
    v_vendor_id := coalesce(p_vendor_id, v_quote.vendor_id, v_case.vendor_id);
    if v_vendor_id is null then
      raise exception 'vendor_required' using errcode = '22023';
    end if;
    if not exists (select 1 from public.vendors where id = v_vendor_id and dsp_id = v_dsp) then
      raise exception 'vendor_not_found' using errcode = 'P0002';
    end if;
  end if;

  -- Authorized amount (server math only).
  if p_type = 'full' then
    v_total := coalesce(v_quote.grand_total_cents, v_quote.shop_reported_total_cents);
    if v_total is null then
      raise exception 'quote_has_no_total' using errcode = '22023';
    end if;
  elsif p_type = 'selected_lines' then
    select coalesce(array_agg((d->>'id')::uuid), '{}') into v_approved_ids
    from jsonb_array_elements(coalesce(p_line_decisions, '[]'::jsonb)) d
    where coalesce(d->>'decision', 'approved') = 'approved';
    select coalesce(sum(li.line_total_cents), 0)::int, count(*)::int
      into v_total, v_approved_count
    from public.repair_quote_line_items li
    where li.quote_id = v_quote.id and li.id = any (v_approved_ids);
    if v_approved_count = 0 then
      raise exception 'no_lines_approved' using errcode = '22023';
    end if;
  elsif p_type = 'not_to_exceed' then
    if p_amount_cents is null or p_amount_cents <= 0 then
      raise exception 'amount_required' using errcode = '22023';
    end if;
    v_total := p_amount_cents;
    v_cap := p_amount_cents;
  else -- diagnostics_only; an explicit cap is optional
    v_total := p_amount_cents;
  end if;

  -- Supersede the current authorization (history stays intact).
  select id into v_prior from public.repair_authorizations
   where repair_case_id = p_case_id and status in ('issued','acknowledged')
   order by version desc limit 1;
  update public.repair_authorizations
     set status = 'superseded', superseded_at = now()
   where repair_case_id = p_case_id and status in ('issued','acknowledged');
  select coalesce(max(version), 0) + 1 into v_version
  from public.repair_authorizations where repair_case_id = p_case_id;

  insert into public.repair_authorizations
    (dsp_id, repair_case_id, quote_id, vendor_id, authorization_type,
     status, version, supersedes_id, authorized_total_cents, nte_cap_cents,
     po_number, notes, authorized_by)
  values
    (v_dsp, p_case_id, v_quote.id, v_vendor_id, p_type,
     'issued', v_version, v_prior, v_total, v_cap,
     left(nullif(btrim(coalesce(p_po_number,'')),''), 60),
     left(nullif(btrim(coalesce(p_notes,'')),''), 2000),
     auth.uid())
  returning * into v_auth;

  -- Snapshot the quote's lines with their decisions.
  if v_quote.id is not null and p_type in ('full','selected_lines') then
    for v_li in
      select id, line_number, category, description, line_total_cents
      from public.repair_quote_line_items
      where quote_id = v_quote.id
      order by line_number
    loop
      insert into public.repair_authorization_lines
        (dsp_id, authorization_id, quote_line_item_id, line_number,
         category, description, line_total_cents, decision)
      values
        (v_dsp, v_auth.id, v_li.id, v_li.line_number,
         v_li.category, v_li.description, v_li.line_total_cents,
         case when p_type = 'full' or v_li.id = any (v_approved_ids)
              then 'approved' else 'declined' end);
      update public.repair_quote_line_items
         set approval_status = case when p_type = 'full' or v_li.id = any (v_approved_ids)
                                    then 'approved' else 'declined' end
       where id = v_li.id;
    end loop;
  end if;

  -- Quote statuses follow the decision; quote DATA is never touched.
  update public.repair_quotes set status = 'submitted'
   where repair_case_id = p_case_id and status = 'accepted'
     and (v_quote.id is null or id <> v_quote.id);
  if v_quote.id is not null then
    update public.repair_quotes set status = 'accepted' where id = v_quote.id;
  end if;
  if p_decline_others then
    update public.repair_quotes set status = 'declined'
     where repair_case_id = p_case_id and status = 'submitted'
       and (v_quote.id is null or id <> v_quote.id);
  end if;

  -- The case is committed to this shop; money rollup mirrors the record.
  update public.repair_cases
     set vendor_id = v_vendor_id,
         approved_total_cents = v_total,
         updated_at = now()
   where id = p_case_id;

  if v_case.stage in ('reported','review','quoting','quotes_in','awaiting_approval') then
    update public.repair_cases set stage = 'approved' where id = p_case_id;
    perform private.repair_case_event(
      v_dsp, p_case_id, 'stage_changed', 'Work authorized',
      v_case.stage, 'approved', 'system', false, true, '{}'::jsonb);
  end if;

  perform private.repair_case_event(
    v_dsp, p_case_id, 'authorization_issued',
    case p_type
      when 'full' then 'Authorized in full'
      when 'selected_lines' then 'Authorized — selected line items'
      when 'diagnostics_only' then 'Diagnostics authorized'
      else 'Authorized — not to exceed' end
    || case when v_total is null then ''
       else ' · $' || to_char(v_total::numeric / 100, 'FM999,999,990.00') end
    || ' (v' || v_version || ')',
    null, null, 'dsp', true, false,
    jsonb_build_object('authorization_id', v_auth.id, 'quote_id', v_quote.id,
                       'vendor_id', v_vendor_id, 'type', p_type,
                       'authorized_total_cents', v_total));

  insert into public.compliance_audit_events
    (dsp_id, actor_type, actor_id, kind, summary, object_type, object_id)
  values
    (v_dsp, 'user', auth.uid(), 'repair_authorization_issued',
     v_case.case_number || ' · ' || p_type
       || case when v_total is null then ''
          else ' $' || to_char(v_total::numeric / 100, 'FM999,999,990.00') end,
     'repair_case', p_case_id);

  if p_send_email then
    v_notify := private.repair_authorization_notify(v_auth.id);
  end if;

  return jsonb_build_object(
    'ok', true,
    'authorization_id', v_auth.id,
    'version', v_version,
    'authorization_type', p_type,
    'authorized_total_cents', v_total,
    'nte_cap_cents', v_cap,
    'email_queued', coalesce((v_notify->>'email_queued')::boolean, false),
    'link', v_notify->>'link');
end;
$$;


-- ═══════════════════════════ 5. repair_authorization_action ═════════
-- revoke            · withdraw the current authorization (kept in history)
-- mark_acknowledged · record an out-of-band (phone/email) acknowledgement
-- resend            · queue the authorization email again (fresh link)
create or replace function public.repair_authorization_action(
  p_authorization_id uuid,
  p_action           text,
  p_note             text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_auth public.repair_authorizations;
  v_vendor_name text;
  v_notify jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_auth from public.repair_authorizations
   where id = p_authorization_id and dsp_id = v_dsp;
  if not found then
    raise exception 'authorization_not_found' using errcode = 'P0002';
  end if;
  select name into v_vendor_name from public.vendors where id = v_auth.vendor_id;

  if p_action = 'revoke' then
    if v_auth.status not in ('issued','acknowledged') then
      raise exception 'not_active' using errcode = '22023';
    end if;
    update public.repair_authorizations
       set status = 'revoked', revoked_at = now(),
           revoke_reason = left(nullif(btrim(coalesce(p_note,'')),''), 500)
     where id = v_auth.id;
    -- The rollup tracks the ACTIVE authorization only.
    update public.repair_cases set approved_total_cents = null, updated_at = now()
     where id = v_auth.repair_case_id;
    perform private.repair_case_event(
      v_dsp, v_auth.repair_case_id, 'authorization_revoked',
      'Authorization v' || v_auth.version || ' revoked'
        || case when coalesce(btrim(p_note),'') = '' then '' else ' — ' || left(btrim(p_note), 200) end,
      null, null, 'dsp', true, false,
      jsonb_build_object('authorization_id', v_auth.id));
    return jsonb_build_object('ok', true);

  elsif p_action = 'mark_acknowledged' then
    if v_auth.status <> 'issued' then
      raise exception 'not_active' using errcode = '22023';
    end if;
    update public.repair_authorizations
       set status = 'acknowledged', acknowledged_at = now(),
           acknowledged_by = coalesce(left(nullif(btrim(coalesce(p_note,'')),''), 120), 'recorded by staff')
     where id = v_auth.id;
    perform private.repair_case_event(
      v_dsp, v_auth.repair_case_id, 'authorization_acknowledged',
      coalesce(v_vendor_name, 'Shop') || ' acknowledged the authorization (recorded by staff)',
      null, null, 'dsp', true, false,
      jsonb_build_object('authorization_id', v_auth.id));
    return jsonb_build_object('ok', true);

  elsif p_action = 'resend' then
    if v_auth.status not in ('issued','acknowledged') then
      raise exception 'not_active' using errcode = '22023';
    end if;
    v_notify := private.repair_authorization_notify(v_auth.id);
    perform private.repair_case_event(
      v_dsp, v_auth.repair_case_id, 'authorization_resent',
      'Authorization re-sent to ' || coalesce(v_vendor_name, 'shop'),
      null, null, 'dsp', false, false,
      jsonb_build_object('authorization_id', v_auth.id));
    return jsonb_build_object('ok', true) || coalesce(v_notify, '{}'::jsonb);
  end if;

  raise exception 'bad_action' using errcode = '22023';
end;
$$;

grant execute on function public.repair_authorization_issue(uuid, text, uuid, uuid, jsonb, int, text, text, boolean, boolean) to authenticated;
grant execute on function public.repair_authorization_action(uuid, text, text) to authenticated;


-- ═══════════════════════════ 6. repair_case_quotes (replaced) ═══════
-- Same payload as 0487 plus 'authorizations' — the drawer and the
-- comparison view read everything in one call.
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
        and q.status <> 'draft'), '[]'::jsonb),
    'authorizations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', a.id, 'authorization_type', a.authorization_type,
        'status', a.status, 'version', a.version,
        'quote_id', a.quote_id, 'vendor_id', a.vendor_id,
        'vendor_name', vn.name,
        'authorized_total_cents', a.authorized_total_cents,
        'nte_cap_cents', a.nte_cap_cents,
        'po_number', a.po_number, 'notes', a.notes,
        'authorized_at', a.authorized_at,
        'acknowledged_at', a.acknowledged_at,
        'acknowledged_by', a.acknowledged_by,
        'superseded_at', a.superseded_at,
        'revoked_at', a.revoked_at, 'revoke_reason', a.revoke_reason,
        'lines', coalesce((
          select jsonb_agg(jsonb_build_object(
            'line_number', al.line_number, 'category', al.category,
            'description', al.description,
            'line_total_cents', al.line_total_cents,
            'decision', al.decision)
            order by al.line_number)
          from public.repair_authorization_lines al
          where al.authorization_id = a.id), '[]'::jsonb))
        order by a.version desc)
      from public.repair_authorizations a
      left join public.vendors vn on vn.id = a.vendor_id
      where a.repair_case_id = p_case_id), '[]'::jsonb)
  )
  from public.repair_cases rc
  where rc.id = p_case_id
    and rc.dsp_id = private.current_dsp_id()
    and private.is_staff(rc.dsp_id, 'dispatcher');
$$;
grant execute on function public.repair_case_quotes(uuid) to authenticated;


-- ═══════════════════════════ 7. repair_portal_load (replaced) ═══════
-- Same projection as 0487 plus 'authorization': the CURRENT
-- authorization for THIS shop only — never another vendor's, never the
-- history, never internal notes beyond the authorization's own note.
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
  v_auth public.repair_authorizations;
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
   where quote_request_id = v_req.id and status in ('draft','submitted','accepted')
   order by created_at desc limit 1;
  select * into v_auth from public.repair_authorizations
   where repair_case_id = v_req.repair_case_id
     and vendor_id = v_req.vendor_id
     and status in ('issued','acknowledged')
   order by version desc limit 1;

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
        where li.quote_id = v_quote.id), '[]'::jsonb)) end,
    'authorization', case when v_auth.id is null then null else jsonb_build_object(
      'id', v_auth.id,
      'authorization_type', v_auth.authorization_type,
      'status', v_auth.status,
      'authorized_total_cents', v_auth.authorized_total_cents,
      'nte_cap_cents', v_auth.nte_cap_cents,
      'po_number', v_auth.po_number,
      'notes', v_auth.notes,
      'authorized_at', v_auth.authorized_at,
      'acknowledged_at', v_auth.acknowledged_at,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object(
          'line_number', al.line_number, 'category', al.category,
          'description', al.description,
          'line_total_cents', al.line_total_cents,
          'decision', al.decision)
          order by al.line_number)
        from public.repair_authorization_lines al
        where al.authorization_id = v_auth.id), '[]'::jsonb)) end
  );
end;
$$;


-- ═══════════════════════════ 8. repair_portal_acknowledge ═══════════
-- The shop confirms it has seen the authorization and the scope is
-- clear. Idempotent: acknowledging twice is a no-op success.
create or replace function public.repair_portal_acknowledge(
  p_token text,
  p_name  text default null
) returns jsonb
language plpgsql
security definer set search_path = ''
as $$
declare
  v_req public.repair_quote_requests;
  v_auth public.repair_authorizations;
  v_vendor_name text;
begin
  v_req := private.repair_portal_request(p_token);

  select * into v_auth from public.repair_authorizations
   where repair_case_id = v_req.repair_case_id
     and vendor_id = v_req.vendor_id
     and status in ('issued','acknowledged')
   order by version desc limit 1;
  if not found then
    raise exception 'no_authorization' using errcode = 'P0002';
  end if;
  if v_auth.status = 'acknowledged' then
    return jsonb_build_object('ok', true, 'acknowledged_at', v_auth.acknowledged_at);
  end if;

  update public.repair_authorizations
     set status = 'acknowledged', acknowledged_at = now(),
         acknowledged_by = coalesce(left(nullif(btrim(coalesce(p_name,'')),''), 120), 'via secure link')
   where id = v_auth.id;

  select name into v_vendor_name from public.vendors where id = v_req.vendor_id;
  perform private.repair_case_event(
    v_req.dsp_id, v_req.repair_case_id, 'authorization_acknowledged',
    coalesce(v_vendor_name, 'Shop') || ' acknowledged the authorization'
      || case when coalesce(btrim(p_name),'') = '' then '' else ' — ' || left(btrim(p_name), 80) end,
    null, null, 'shop_link', true, false,
    jsonb_build_object('authorization_id', v_auth.id));

  return jsonb_build_object('ok', true, 'acknowledged_at', now());
end;
$$;

-- Portal function: service_role only (edge function owns transport).
revoke execute on function public.repair_portal_acknowledge(text, text) from public, anon, authenticated;
grant execute on function public.repair_portal_acknowledge(text, text) to service_role;


notify pgrst, 'reload schema';
