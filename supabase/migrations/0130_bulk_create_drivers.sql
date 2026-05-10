-- Bulk-create drivers from a paste-CSV / paste-spreadsheet flow on
-- the Drivers view.  Operator pastes rows like:
--
--     first_name,last_name,phone,email
--     Jane,Doe,555-0100,jane@example.com
--     ...
--
-- Frontend parses the CSV, validates client-side, then calls this
-- RPC with a JSONB array.  RPC validates each row server-side too
-- (defense in depth), inserts what it can, returns per-row results
-- so the UI can show a clear "imported N, skipped M because ..."
-- summary.
--
-- Behavior:
--   - Caller must be staff (dispatcher+) of their own DSP.  Drivers
--     are auto-attached to the caller's dsp_id via current_dsp_id().
--     No way to insert into a different DSP — RLS-equivalent
--     enforcement at the RPC body.
--   - first_name + last_name required (we synthesize full_name).
--   - email + phone optional but recommended.  Duplicates by lower-
--     case email (within the DSP) are skipped, not failed.  If a
--     driver with the same email exists, we report
--     {ok:false, reason:"duplicate_email"} for that row.
--   - status defaults to 'onboarding' — same as the single Add Driver
--     flow.  Hire date defaults to today.

create or replace function public.bulk_create_drivers(p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp_id        uuid;
  v_row           jsonb;
  v_idx           int := 0;
  v_result        jsonb := '[]'::jsonb;
  v_first         text;
  v_last          text;
  v_full          text;
  v_email         text;
  v_phone         text;
  v_existing_id   uuid;
  v_new_id        uuid;
  v_inserted      int := 0;
  v_skipped       int := 0;
  v_errored       int := 0;
begin
  v_dsp_id := private.current_dsp_id();
  if v_dsp_id is null then
    raise exception 'forbidden';
  end if;
  if not private.is_staff(v_dsp_id, 'dispatcher') then
    raise exception 'forbidden';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_payload: expected JSON array';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_idx := v_idx + 1;
    v_first := nullif(trim(v_row->>'first_name'), '');
    v_last  := nullif(trim(v_row->>'last_name'),  '');
    v_email := lower(nullif(trim(v_row->>'email'), ''));
    v_phone := nullif(trim(v_row->>'phone'), '');

    -- Required field check.
    if v_first is null or v_last is null then
      v_result := v_result || jsonb_build_object(
        'index',  v_idx,
        'ok',     false,
        'reason', 'missing_name',
        'first_name', v_first,
        'last_name',  v_last
      );
      v_errored := v_errored + 1;
      continue;
    end if;

    v_full := v_first || ' ' || v_last;

    -- Duplicate-by-email check inside this DSP.  Empty email = no
    -- duplicate-skip (we allow multiple email-less drivers).
    if v_email is not null then
      select id into v_existing_id
        from public.drivers
       where dsp_id = v_dsp_id and lower(email) = v_email
       limit 1;
      if v_existing_id is not null then
        v_result := v_result || jsonb_build_object(
          'index',     v_idx,
          'ok',        false,
          'reason',    'duplicate_email',
          'driver_id', v_existing_id,
          'email',     v_email
        );
        v_skipped := v_skipped + 1;
        continue;
      end if;
    end if;

    -- Insert.  Wrap in exception block so a single bad row doesn't
    -- abort the whole batch (e.g., a constraint we didn't anticipate).
    begin
      insert into public.drivers (
        dsp_id, first_name, last_name, full_name, email, phone, status, hire_date
      )
      values (
        v_dsp_id, v_first, v_last, v_full, v_email, v_phone, 'onboarding', current_date
      )
      returning id into v_new_id;

      v_result := v_result || jsonb_build_object(
        'index',     v_idx,
        'ok',        true,
        'driver_id', v_new_id,
        'full_name', v_full
      );
      v_inserted := v_inserted + 1;
    exception when others then
      v_result := v_result || jsonb_build_object(
        'index',  v_idx,
        'ok',     false,
        'reason', 'db_error',
        'detail', sqlerrm
      );
      v_errored := v_errored + 1;
    end;
  end loop;

  return jsonb_build_object(
    'ok',        true,
    'inserted',  v_inserted,
    'skipped',   v_skipped,
    'errored',   v_errored,
    'rows',      v_result
  );
end;
$$;

grant execute on function public.bulk_create_drivers(jsonb) to authenticated;
