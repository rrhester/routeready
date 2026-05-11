-- Migration 0176 · Document tiers — secure (compliance) vs informational
--
-- Every document template now carries a `kind`:
--
--   'secure'        — compliance-grade. Signature targets, hash-chained
--                     audit, ECDSA P-256 + RFC 3161 sealing, a
--                     Certificate of Completion. This is the existing
--                     envelope / signing flow (I-9, agreements, tax
--                     forms, legal acknowledgements).
--
--   'informational' — lightweight. A PDF the driver opens and
--                     acknowledges — welcome packets, orientation
--                     guides, uniform/parking instructions, safety
--                     reminders. No signature fields, no PKCS#7 seal,
--                     no audit certificate; still delivered through an
--                     envelope so the DSP sees who opened / acknowledged.
--
-- Existing templates default to 'secure' (they were all built for the
-- signing flow). New uploads pick the kind at creation time.

alter table public.document_templates
  add column if not exists kind text not null default 'secure'
    check (kind in ('secure', 'informational'));

-- Recreate documents_template_create with a `p_kind` argument. The old
-- 6-arg signature is dropped first so a named-arg call doesn't become
-- ambiguous between the two overloads. (This RPC is only called from the
-- dashboard's document-upload flow, which is bumped in the same release.)
drop function if exists public.documents_template_create(text, text, text, text, int, jsonb);

create or replace function public.documents_template_create(
  p_title       text,
  p_source_path text,
  p_source_hash text,
  p_description text  default null,
  p_source_size int   default null,
  p_fields      jsonb default '[]'::jsonb,
  p_kind        text  default 'secure'
) returns public.document_templates
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.document_templates;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(trim(p_title), '') = '' then
    raise exception 'title_required' using errcode = 'P0001';
  end if;
  if p_source_path is null or p_source_path = '' then
    raise exception 'source_path_required' using errcode = 'P0001';
  end if;
  if p_source_hash is null or length(p_source_hash) <> 64 then
    raise exception 'source_hash_required' using errcode = 'P0001';
  end if;
  if p_source_path not like (v_dsp::text || '/templates/%') then
    raise exception 'invalid_source_path' using errcode = '42501';
  end if;
  if coalesce(p_kind, 'secure') not in ('secure', 'informational') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;

  insert into public.document_templates
    (dsp_id, title, description, source_path, source_hash, source_size, fields, kind, created_by)
  values
    (v_dsp, trim(p_title),
     nullif(trim(coalesce(p_description, '')), ''),
     p_source_path, p_source_hash, p_source_size,
     coalesce(p_fields, '[]'::jsonb), coalesce(p_kind, 'secure'), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.documents_template_create(text, text, text, text, int, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
