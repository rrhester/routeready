-- Hiring messages should always carry the operator's current DSP name
-- (the value in gear icon → Workspace settings). Two things to fix:
--
--   1. Auto-inject {{dsp_name}} and {{dsp_short_code}} into every render
--      of private.render_template by looking up the dsps row at render
--      time. Caller-provided p_vars still win for any matching key, so
--      a future caller can override if it ever needs to.
--
--   2. Sweep existing message_templates.subject + body so the seeded
--      copies (and any rows still carrying the literal "RouteReady"
--      string) interpolate {{dsp_name}} instead. Operators who already
--      edited their templates to a custom string aren't touched.
--
-- After this migration, changing dsps.name from the dashboard updates
-- every subsequent hiring message immediately — no template edit
-- required.

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
  v_vars    jsonb;
  v_dsp     public.dsps;
  k text;
begin
  select * into v_dsp from public.dsps where id = p_dsp_id;

  -- Auto-injected vars first; explicit p_vars override.
  v_vars := jsonb_build_object(
              'dsp_name',       coalesce(v_dsp.name, ''),
              'dsp_short_code', coalesce(v_dsp.short_code, '')
            )
            || coalesce(p_vars, '{}'::jsonb);

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

  for k in select jsonb_object_keys(v_vars)
  loop
    t_body    := replace(t_body,    '{{' || k || '}}', coalesce(v_vars->>k, ''));
    t_subject := replace(t_subject, '{{' || k || '}}', coalesce(v_vars->>k, ''));
  end loop;

  subject := t_subject;
  body    := t_body;
  return next;
end;
$$;

-- Existing seeded templates referenced "RouteReady" as a literal. Swap to
-- the {{dsp_name}} placeholder so they pick up each tenant's workspace
-- name. Limit to rows that still contain the literal — operators who
-- customized their templates to a different string keep their edits.
update public.message_templates
   set body = replace(body, 'RouteReady', '{{dsp_name}}')
 where body like '%RouteReady%';

update public.message_templates
   set subject = replace(subject, 'RouteReady', '{{dsp_name}}')
 where subject like '%RouteReady%';
