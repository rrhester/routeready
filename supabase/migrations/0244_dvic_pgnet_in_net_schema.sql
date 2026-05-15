-- Migration 0244 · pg_net lives in the `net` schema on Supabase Cloud.
--
-- Migration 0242 called extensions.http_post(...), but Supabase Cloud
-- installs pg_net into the `net` schema (extensions.http_post doesn't
-- exist there).  The `exception when others then null` block in the
-- trigger silently swallowed the failure, so the AI review never
-- fired even though everything else was wired correctly.
--
-- Switch the call to net.http_post and surface unexpected errors as
-- warnings so a future schema change doesn't hide silently again.
--
-- Idempotent.

create or replace function private.dvic_request_ai_review(p_inspection_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_url text := private.app_setting('dvic_ai_review_url');
  v_key text := private.app_setting('service_role_key');
begin
  if coalesce(v_url, '') = '' or coalesce(v_key, '') = '' then
    return;
  end if;
  begin
    perform net.http_post(
      url     := v_url,
      body    := jsonb_build_object('inspection_id', p_inspection_id),
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || v_key
      )
    );
  exception when others then
    -- Don't fail the parent transaction, but make the failure greppable.
    raise warning 'dvic_request_ai_review failed: %', sqlerrm;
  end;
end $$;
grant execute on function private.dvic_request_ai_review(uuid) to authenticated;
