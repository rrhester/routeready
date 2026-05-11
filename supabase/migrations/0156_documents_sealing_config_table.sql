-- Migration 0156 · Documents · sealing config via a table, not a GUC
--
-- 0155 read the sealing service URL + bearer from Postgres GUCs
-- (`current_setting('app.sealing_service_url')`). That requires
-- `ALTER DATABASE postgres SET ...`, which newer Supabase projects
-- don't permit from the SQL editor (errors with
-- "42501 permission denied to set parameter").  Store the values in a
-- private table instead — the postgres role can always INSERT into a
-- private-schema table it owns, and the trigger function (security
-- definer) can read from it without any RLS hassle.

create table if not exists private.app_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);


-- Replace the trigger function to read from the table.
create or replace function private.document_envelopes_seal_on_signed()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if new.status is distinct from 'signed' then return new; end if;
  if old.status = 'signed' then return new; end if;
  if new.signed_pdf_path is not null then return new; end if;

  select value into v_url    from private.app_settings where key = 'sealing_service_url';
  select value into v_secret from private.app_settings where key = 'sealing_service_secret';

  if v_url is null or v_url = '' or v_secret is null or v_secret = '' then
    raise notice 'document sealing settings missing — skipping trigger for envelope %', new.id;
    return new;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type',  'application/json',
                 'Authorization', 'Bearer ' || v_secret
               ),
    body    := jsonb_build_object('envelope_id', new.id)
  );

  return new;
end;
$$;


-- Best-effort migration of any values someone managed to set as GUCs
-- before. Silently skipped if either is unset or unreadable.
do $$
declare
  v_u text;
  v_s text;
begin
  begin
    v_u := current_setting('app.sealing_service_url', true);
  exception when others then v_u := null;
  end;
  begin
    v_s := current_setting('app.sealing_service_secret', true);
  exception when others then v_s := null;
  end;

  if v_u is not null and v_u <> '' then
    insert into private.app_settings (key, value) values ('sealing_service_url', v_u)
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  if v_s is not null and v_s <> '' then
    insert into private.app_settings (key, value) values ('sealing_service_secret', v_s)
      on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
end $$;


notify pgrst, 'reload schema';
