-- Migration 0245 · Give pg_net 60s for the DVIC AI Edge Function call.
--
-- Claude vision analysis of 1-12 photos typically lands in 10-25s.
-- pg_net's default timeout is 5s — too short, so the trigger logs an
-- error even though the Edge Function still completes and writes the
-- verdict.  Bump to 60s so the audit trail in net._http_response
-- reflects the real outcome.
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
      ),
      timeout_milliseconds := 60000
    );
  exception when others then
    raise warning 'dvic_request_ai_review failed: %', sqlerrm;
  end;
end $$;
grant execute on function private.dvic_request_ai_review(uuid) to authenticated;
