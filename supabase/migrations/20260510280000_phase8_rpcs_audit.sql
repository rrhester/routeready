-- ─────────────────────────────────────────────────────────────────────────
-- Migration 20260510280000 · Phase 8 RPCs + audit
-- The actual AI-call work is done by Edge Functions (smart-drop-extract,
-- generate-coaching-sms, generate-dispute-letter, build-tool, run-tool).
-- The RPCs here just record / route the structured outputs into the
-- right tables.
-- ─────────────────────────────────────────────────────────────────────────

-- ─── route_smart_drop: write extracted rows into the target table ─────

create or replace function public.route_smart_drop(
  p_upload_id     uuid,
  p_target        text,
  p_confirmed_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp        uuid := private.current_dsp_id();
  v_caller     uuid := auth.uid();
  v_upload     public.smart_drop_uploads%rowtype;
  v_inserted   int := 0;
  rec          jsonb;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'route_smart_drop: ops only';
  end if;

  select * into v_upload from public.smart_drop_uploads
   where id = p_upload_id and dsp_id = v_dsp;
  if not found then
    raise exception 'route_smart_drop: upload % not in DSP %', p_upload_id, v_dsp;
  end if;
  if v_upload.status not in ('extracted','rejected') then
    raise exception 'route_smart_drop: upload status is %, must be extracted/rejected', v_upload.status;
  end if;
  if jsonb_typeof(p_confirmed_rows) <> 'array' then
    raise exception 'route_smart_drop: confirmed_rows must be array';
  end if;

  -- Route based on target. Each branch validates the row shape.
  if p_target = 'attendance_events' then
    for rec in select * from jsonb_array_elements(p_confirmed_rows)
    loop
      perform public.record_attendance(
        (rec->>'driver_id')::uuid,
        rec->>'event_type',
        coalesce((rec->>'event_date')::date, current_date),
        rec->>'notes',
        true
      );
      v_inserted := v_inserted + 1;
    end loop;

  elsif p_target = 'drivers' then
    perform public.bulk_import_drivers(p_confirmed_rows);
    v_inserted := jsonb_array_length(p_confirmed_rows);

  elsif p_target = 'vehicles' then
    perform public.bulk_import_vehicles(p_confirmed_rows);
    v_inserted := jsonb_array_length(p_confirmed_rows);

  else
    raise exception 'route_smart_drop: unsupported target %', p_target;
  end if;

  update public.smart_drop_uploads
     set status         = 'routed',
         routing_target = p_target,
         routed_at      = now()
   where id = p_upload_id;

  return jsonb_build_object('upload_id', p_upload_id, 'target', p_target, 'inserted', v_inserted);
end $$;

revoke execute on function public.route_smart_drop(uuid, text, jsonb) from public, anon;
grant execute on function public.route_smart_drop(uuid, text, jsonb) to authenticated;

-- ─── save_ai_tool: store an AI-generated tool definition ──────────────

create or replace function public.save_ai_tool(
  p_name        text,
  p_prompt      text,
  p_definition  jsonb,
  p_description text default null,
  p_source_data text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
  v_id     uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'save_ai_tool: ops only';
  end if;
  if length(trim(coalesce(p_name, ''))) < 2 then
    raise exception 'save_ai_tool: name required';
  end if;
  if jsonb_typeof(p_definition) <> 'object' then
    raise exception 'save_ai_tool: definition must be a JSON object';
  end if;

  insert into public.ai_tools
    (dsp_id, name, description, prompt, definition, source_data, created_by)
  values
    (v_dsp, p_name, p_description, p_prompt, p_definition, p_source_data, v_caller)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.save_ai_tool(text, text, jsonb, text, text) from public, anon;
grant execute on function public.save_ai_tool(text, text, jsonb, text, text) to authenticated;

-- ─── log_ai_tool_run: record an execution of a saved tool ─────────────

create or replace function public.log_ai_tool_run(
  p_tool_id        uuid,
  p_input_data     jsonb default null,
  p_output_results jsonb default null,
  p_flagged_count  int   default 0,
  p_notes          text  default null
)
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp    uuid := private.current_dsp_id();
  v_caller uuid := auth.uid();
  v_id     uuid;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'ops') then
    raise exception 'log_ai_tool_run: ops only';
  end if;

  perform 1 from public.ai_tools where id = p_tool_id and dsp_id = v_dsp;
  if not found then
    raise exception 'log_ai_tool_run: tool % not in DSP %', p_tool_id, v_dsp;
  end if;

  insert into public.ai_tool_runs
    (dsp_id, tool_id, input_data, output_results, flagged_count, notes, triggered_by)
  values
    (v_dsp, p_tool_id, p_input_data, p_output_results, p_flagged_count, p_notes, v_caller)
  returning id into v_id;
  return v_id;
end $$;

revoke execute on function public.log_ai_tool_run(uuid, jsonb, jsonb, int, text) from public, anon;
grant execute on function public.log_ai_tool_run(uuid, jsonb, jsonb, int, text) to authenticated;

-- ─── log_ai_usage: track tokens for cost monitoring ───────────────────

create or replace function public.log_ai_usage(
  p_function_name text,
  p_model         text,
  p_input_tokens  int,
  p_output_tokens int,
  p_cost_cents    int   default null,
  p_related_kind  text  default null,
  p_related_id    uuid  default null
)
returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_dsp uuid := private.current_dsp_id();
begin
  if v_dsp is null then
    raise exception 'log_ai_usage: not authenticated';
  end if;

  insert into public.ai_usage_log
    (dsp_id, function_name, model, input_tokens, output_tokens,
     cost_cents, related_kind, related_id, triggered_by)
  values
    (v_dsp, p_function_name, p_model, p_input_tokens, p_output_tokens,
     p_cost_cents, p_related_kind, p_related_id, auth.uid());
end $$;

revoke execute on function public.log_ai_usage(text, text, int, int, int, text, uuid) from public, anon;
grant execute on function public.log_ai_usage(text, text, int, int, int, text, uuid) to authenticated;

-- ─── Audit triggers ───────────────────────────────────────────────────

create trigger trg_audit_smart_drop_uploads
  after insert or update or delete on public.smart_drop_uploads
  for each row execute function private.fn_audit_log();

create trigger trg_audit_ai_tools
  after insert or update or delete on public.ai_tools
  for each row execute function private.fn_audit_log();

create trigger trg_audit_ai_tool_runs
  after insert or delete on public.ai_tool_runs
  for each row execute function private.fn_audit_log();
