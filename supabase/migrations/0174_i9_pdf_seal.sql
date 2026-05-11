-- Migration 0174 · Form I-9 — sealed PDF (real document on the Documents page)
--
-- When a Form I-9 reaches `verified`, fire the rr-document-sealing
-- Cloudflare Worker to render the completed form into a PDF, append a
-- Certificate of Completion, cryptographically seal it (ECDSA P-256 over
-- SHA-256), and stamp an RFC 3161 trusted timestamp — exactly the same
-- security envelope as the e-signature documents. The worker calls
-- i9_log_sealed back (service-role only) to record the artifact paths
-- and append a `pdf_sealed` event to the I-9 audit trail.
--
-- Same trigger model as document_envelopes_seal_on_signed (migration
-- 0155). The endpoint URL + shared secret are read from
-- private.app_settings (keys: sealing_service_url / sealing_service_secret).

create extension if not exists pg_net;

alter table public.i9_records
  add column if not exists pdf_path             text,
  add column if not exists pdf_certificate_path text,
  add column if not exists pdf_seal_path        text,
  add column if not exists pdf_sealed_at         timestamptz,
  add column if not exists pdf_byte_count        int;


-- ── i9_log_sealed · the worker's callback (service-role only) ──────────
create or replace function public.i9_log_sealed(
  p_i9_record_id    uuid,
  p_pdf_path        text,
  p_certificate_path text,
  p_seal_path       text default null,
  p_byte_count      int default null,
  p_pdf_sha256      text default null,
  p_signature_b64   text default null,
  p_key_fingerprint text default null,
  p_tsa_url         text default null,
  p_tsa_gen_time    text default null
) returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare v_row public.i9_records;
begin
  select * into v_row from public.i9_records where id = p_i9_record_id;
  if v_row.id is null then raise exception 'i9_not_found' using errcode = 'P0002'; end if;
  update public.i9_records
     set pdf_path             = p_pdf_path,
         pdf_certificate_path = p_certificate_path,
         pdf_seal_path        = p_seal_path,
         pdf_byte_count       = p_byte_count,
         pdf_sealed_at        = now()
   where id = p_i9_record_id returning * into v_row;
  insert into public.i9_events (i9_record_id, kind, actor_kind, actor_name, event_data)
  values (p_i9_record_id, 'pdf_sealed', 'system', 'rr-document-sealing',
          jsonb_build_object(
            'pdf_path',        p_pdf_path,
            'certificate_path', p_certificate_path,
            'seal_path',       p_seal_path,
            'byte_count',      p_byte_count,
            'pdf_sha256',      p_pdf_sha256,
            'signature_b64',   p_signature_b64,
            'key_fingerprint', p_key_fingerprint,
            'tsa_url',         p_tsa_url,
            'tsa_gen_time',    p_tsa_gen_time,
            'sealed',          (p_signature_b64 is not null)
          ));
  return v_row;
end;
$$;
grant execute on function public.i9_log_sealed(uuid, text, text, text, int, text, text, text, text, text) to service_role;


-- ── trigger · POST to the sealing worker when an I-9 is verified ───────
create or replace function private.i9_seal_on_verified()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if new.status is distinct from 'verified' then return new; end if;
  if old.status = 'verified' and new.pdf_path is not null then return new; end if;
  if new.pdf_path is not null and (old.pdf_path is not distinct from new.pdf_path) then return new; end if;
  begin select value into v_url    from private.app_settings where key = 'sealing_service_url';    exception when others then v_url := null; end;
  begin select value into v_secret from private.app_settings where key = 'sealing_service_secret'; exception when others then v_secret := null; end;
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    raise notice 'i9 sealing settings missing — skipping for i9_record %', new.id;
    return new;
  end if;
  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object('i9_record_id', new.id)
    );
  exception when others then
    raise notice 'i9 sealing http_post failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

drop trigger if exists i9_seal_on_verified on public.i9_records;
create trigger i9_seal_on_verified
  after update of status on public.i9_records
  for each row execute function private.i9_seal_on_verified();


-- ── i9_seal_now · dispatcher-triggered (re)generation ─────────────────
create or replace function public.i9_seal_now(p_driver_id uuid)
returns public.i9_records
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.i9_records;
  v_url text; v_secret text;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id and dsp_id = v_dsp;
  if v_row.id is null then raise exception 'i9_not_found' using errcode = 'P0002'; end if;
  if v_row.status <> 'verified' then raise exception 'i9_not_verified' using errcode = 'P0001'; end if;
  begin select value into v_url    from private.app_settings where key = 'sealing_service_url';    exception when others then v_url := null; end;
  begin select value into v_secret from private.app_settings where key = 'sealing_service_secret'; exception when others then v_secret := null; end;
  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    raise exception 'sealing_service_not_configured' using errcode = 'P0001';
  end if;
  begin
    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret),
      body    := jsonb_build_object('i9_record_id', v_row.id, 'force', true)
    );
  exception when others then raise notice 'i9_seal_now http_post failed: %', sqlerrm;
  end;
  return v_row;
end;
$$;
grant execute on function public.i9_seal_now(uuid) to authenticated;


-- Recreate i9_get so its rowtype picks up the new pdf_* columns
-- (to_jsonb(v_row) then includes them).
create or replace function public.i9_get(p_driver_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.i9_records;
  v_events jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into v_row from public.i9_records where driver_id = p_driver_id and dsp_id = v_dsp;
  if v_row.id is null then
    return jsonb_build_object('record', null, 'events', '[]'::jsonb);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',         e.id,
    'kind',       e.kind,
    'actor_kind', e.actor_kind,
    'actor_name', e.actor_name,
    'event_data', e.event_data,
    'created_at', e.created_at
  ) order by e.id), '[]'::jsonb)
  into v_events
  from public.i9_events e where e.i9_record_id = v_row.id;
  return jsonb_build_object('record', to_jsonb(v_row), 'events', v_events);
end;
$$;
grant execute on function public.i9_get(uuid) to authenticated;

notify pgrst, 'reload schema';
