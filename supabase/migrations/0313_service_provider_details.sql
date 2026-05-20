-- Migration 0313 · Service providers — full detail record
--
-- The fleet-calendar provider rail now opens a detail card on click
-- (name, address, phone, email, points of contact, notes). This adds
-- the columns that card needs and an upsert RPC for it.
--
--   · vendors.address   — street / mailing address
--   · vendors.contacts  — jsonb array of points of contact
--   · fleet_calendar_providers()        — returns the detail fields
--   · fleet_calendar_provider_upsert()  — create / edit a provider

alter table public.vendors
  add column if not exists address  text,
  add column if not exists contacts jsonb not null default '[]'::jsonb;


-- ── Read · provider list with detail fields ─────────────────────────
create or replace function public.fleet_calendar_providers()
returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id',       v.id,
           'name',     v.name,
           'kind',     v.kind,
           'address',  v.address,
           'phone',    v.contact_phone,
           'email',    v.contact_email,
           'contacts', coalesce(v.contacts, '[]'::jsonb),
           'notes',    v.notes
         ) order by v.name), '[]'::jsonb)
  from public.vendors v
  where v.dsp_id = private.current_dsp_id()
    and private.is_staff(private.current_dsp_id(), 'dispatcher')
    and coalesce(v.paused, false) = false;
$$;
grant execute on function public.fleet_calendar_providers() to authenticated;


-- ── Write · create (p_id null) / edit a service provider ────────────
create or replace function public.fleet_calendar_provider_upsert(
  p_id       uuid,
  p_name     text,
  p_kind     text  default 'repair',
  p_address  text  default null,
  p_phone    text  default null,
  p_email    text  default null,
  p_contacts jsonb default '[]'::jsonb,
  p_notes    text  default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.vendors;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_name), '') = '' then
    raise exception 'name_required' using errcode = '22023';
  end if;

  if p_id is null then
    insert into public.vendors
      (dsp_id, name, kind, address, contact_phone, contact_email, contacts, notes)
    values
      (v_dsp, btrim(p_name), coalesce(nullif(p_kind, ''), 'repair'),
       nullif(btrim(p_address), ''), nullif(btrim(p_phone), ''),
       nullif(btrim(p_email), ''), coalesce(p_contacts, '[]'::jsonb),
       nullif(btrim(p_notes), ''))
    returning * into v_row;
  else
    update public.vendors set
      name          = btrim(p_name),
      kind          = coalesce(nullif(p_kind, ''), kind),
      address       = nullif(btrim(p_address), ''),
      contact_phone = nullif(btrim(p_phone), ''),
      contact_email = nullif(btrim(p_email), ''),
      contacts      = coalesce(p_contacts, '[]'::jsonb),
      notes         = nullif(btrim(p_notes), ''),
      updated_at    = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then
      raise exception 'vendor_not_found' using errcode = 'P0002';
    end if;
  end if;

  return jsonb_build_object(
    'id',       v_row.id,
    'name',     v_row.name,
    'kind',     v_row.kind,
    'address',  v_row.address,
    'phone',    v_row.contact_phone,
    'email',    v_row.contact_email,
    'contacts', coalesce(v_row.contacts, '[]'::jsonb),
    'notes',    v_row.notes
  );
end;
$$;
grant execute on function public.fleet_calendar_provider_upsert(uuid, text, text, text, text, text, jsonb, text) to authenticated;


notify pgrst, 'reload schema';
