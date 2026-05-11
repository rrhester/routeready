-- Migration 0159 · Documents · edit a template's signature fields
--
-- Slice 6 introduces a visual field-placement editor on the dashboard.
-- The first version uploads the PDF with `fields: []` and then lets
-- the dispatcher drop signature boxes onto the rendered pages. This
-- RPC is the save path — staff-only, idempotent, replaces the whole
-- field array atomically.
--
-- We don't audit field edits at the envelope level (templates aren't
-- on the per-envelope hash chain) — already-sent envelopes carry their
-- own `fields_snapshot` copied at creation time, so changing the
-- template's fields can't retroactively move a signature on a doc
-- that's already in flight.

create or replace function public.documents_template_set_fields(
  p_template_id uuid,
  p_fields      jsonb
) returns public.document_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_tpl public.document_templates;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'array' then
    raise exception 'fields_must_be_array' using errcode = '22023';
  end if;

  update public.document_templates
     set fields     = p_fields,
         updated_at = now()
   where id     = p_template_id
     and dsp_id = v_dsp
     and archived_at is null
  returning * into v_tpl;

  if v_tpl.id is null then
    raise exception 'template_not_found' using errcode = 'P0002';
  end if;
  return v_tpl;
end;
$$;
grant execute on function public.documents_template_set_fields(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
