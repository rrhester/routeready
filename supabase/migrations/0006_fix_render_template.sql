-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0006 · Fix private.render_template ambiguity
--
-- The function in 0004 declared `returns table (subject text, body text)`,
-- which makes `subject` / `body` ambiguous with the same-named columns on
-- public.message_templates. Result: every send_screening_link /
-- send_booking_link call failed with
--   "column reference 'subject' is ambiguous"
-- and the import flow silently swallowed the error.
--
-- Fix: alias the table inside the SELECT so column references qualify
-- to mt.subject / mt.body and the planner can disambiguate.
-- ─────────────────────────────────────────────────────────────────────────

create or replace function private.render_template(p_dsp_id uuid, p_channel public.message_channel, p_key text, p_vars jsonb)
returns table (subject text, body text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  t_subject text;
  t_body    text;
  k text;
begin
  select mt.subject, mt.body
    into t_subject, t_body
  from public.message_templates mt
  where mt.dsp_id = p_dsp_id
    and mt.channel = p_channel
    and mt.key = p_key
    and mt.active = true
  limit 1;

  if t_body is null then
    raise exception 'template_not_found: dsp=%, channel=%, key=%', p_dsp_id, p_channel, p_key;
  end if;

  for k in select jsonb_object_keys(coalesce(p_vars, '{}'::jsonb))
  loop
    t_body    := replace(t_body,    '{{' || k || '}}', coalesce(p_vars->>k, ''));
    t_subject := replace(t_subject, '{{' || k || '}}', coalesce(p_vars->>k, ''));
  end loop;

  subject := t_subject;
  body    := t_body;
  return next;
end;
$$;
