-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0012 · Fix private.upsert_token to create the tokens object
--
-- jsonb_set(target, '{tokens, screening}', '"x"', true) silently no-ops
-- if 'tokens' doesn't already exist as a top-level key on target — it
-- only creates the LEAF, not intermediate objects. Result: every
-- screening invite for an applicant whose metadata was the default
-- {} ended up with a null token in the database, even though the
-- email/SMS got queued. Applicants then hit "invalid_or_expired_token"
-- when they clicked the link.
--
-- Fix: idempotently ensure metadata.tokens exists before jsonb_set,
-- via concat with a defaulted object.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.upsert_token(p_applicant uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  t text := replace(gen_random_uuid()::text, '-', '');
begin
  update public.applicants
     set metadata = jsonb_set(
       -- Concatenation guarantees 'tokens' exists as an object.
       coalesce(metadata, '{}'::jsonb)
         || jsonb_build_object('tokens', coalesce(metadata -> 'tokens', '{}'::jsonb)),
       array['tokens', p_kind],
       to_jsonb(t)
     )
   where id = p_applicant;
  return t;
end;
$$;
