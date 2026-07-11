-- 0457_seed_template_attachments.sql
--
-- Follow-up to 0456 (day-one DSP parity), from PR #3703 review: the
-- message-template copy omits message_templates.attachments — a column added
-- in 0023 and read by every send_*_link RPC when queuing messages. The same
-- omission existed in admin_create_dsp's inline copy since 0141, so any DSP
-- seeded from the template got the template text but silently lost the
-- attached assets (MMS media / email attachments).
--
--   1. Re-issue private.dsp_seed_from_template with attachments included.
--      (screening_questions has had no columns added since 0002 — checked.)
--   2. Repair pass: a DSP whose ENTIRE template set is a pristine,
--      attachment-less copy of the template DSP's (same channel/key set,
--      identical name/subject/body/active, every attachments = '[]') can only
--      be a fresh seed — copy the missing attachments over. Any operator
--      customization (one diverging row, one extra/missing key, any existing
--      attachment) disqualifies the whole DSP, so tuned tenants are never
--      touched. Idempotent: after the repair the rows carry attachments, so
--      the DSP no longer qualifies on a re-run.
--   3. Inherited attachments point at files under the TEMPLATE DSP's folder
--      in the private message-attachments bucket. Outbound sends already
--      work (send-sms / send-email sign with the service role, which
--      bypasses storage RLS), but the 0447 read policy is tenant-folder-
--      scoped, so seeded tenants couldn't sign dashboard previews. Extend
--      the read policy to also cover the template DSP's folder — exactly
--      the shared assets this seeder distributes (and which already leave
--      the building in every sent email/MMS). Writes stay tenant-scoped
--      (0023), so tenants still can't modify or delete the shared files.

-- ── 1. seeder now copies attachments ─────────────────────────────────────────
create or replace function private.dsp_seed_from_template(p_dsp_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_tmpl uuid := private.template_dsp_id();
begin
  if v_tmpl is null or v_tmpl = p_dsp_id then return; end if;

  if not exists (select 1 from public.screening_questions where dsp_id = p_dsp_id) then
    insert into public.screening_questions
      (dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active)
    select p_dsp_id, prompt, field_type, options, required, hard_filter, scoring, display_order, active
      from public.screening_questions where dsp_id = v_tmpl;
  end if;

  if not exists (select 1 from public.message_templates where dsp_id = p_dsp_id) then
    insert into public.message_templates
      (dsp_id, channel, key, name, subject, body, active, attachments)
    select p_dsp_id, channel, key, name, subject, body, active, attachments
      from public.message_templates where dsp_id = v_tmpl
    on conflict (dsp_id, channel, key) do nothing;
  end if;
end; $$;

-- ── 2. repair DSPs seeded without attachments ────────────────────────────────
do $$
declare v_tmpl uuid := private.template_dsp_id(); d record;
begin
  if v_tmpl is null then return; end if;
  for d in select distinct dsp_id from public.message_templates where dsp_id <> v_tmpl loop
    if
      -- every row is an untouched, attachment-less copy of a template row
      not exists (
        select 1 from public.message_templates t
         where t.dsp_id = d.dsp_id
           and (t.attachments <> '[]'::jsonb
                or not exists (
                     select 1 from public.message_templates s
                      where s.dsp_id = v_tmpl
                        and s.channel = t.channel and s.key = t.key
                        and s.name = t.name and s.body = t.body
                        and s.active = t.active
                        and coalesce(s.subject, '') = coalesce(t.subject, ''))))
      -- and no template row is missing from the copy
      and not exists (
        select 1 from public.message_templates s
         where s.dsp_id = v_tmpl
           and not exists (
                 select 1 from public.message_templates t
                  where t.dsp_id = d.dsp_id
                    and t.channel = s.channel and t.key = s.key))
    then
      update public.message_templates t
         set attachments = s.attachments,
             updated_at  = now()
        from public.message_templates s
       where t.dsp_id = d.dsp_id and s.dsp_id = v_tmpl
         and s.channel = t.channel and s.key = t.key
         and s.attachments <> '[]'::jsonb;
    end if;
  end loop;
end $$;

-- ── 3. tenants may sign/preview inherited template attachments ───────────────
-- Replaces the 0447 read policy. Guarded like 0453 so a bare stack without the
-- storage schema skips cleanly instead of failing the migration run.
do $$ begin
  execute 'drop policy if exists msg_attach_tenant_read on storage.objects';
  execute $pol$
    create policy "msg_attach_tenant_read" on storage.objects
      for select to authenticated
      using (
        bucket_id = 'message-attachments'
        and (
          (storage.foldername(name))[1]::uuid = private.current_dsp_id()
          or (storage.foldername(name))[1]::uuid = private.template_dsp_id()
        )
      )
  $pol$;
exception
  when undefined_table then null;        -- storage.objects absent
  when invalid_schema_name then null;    -- storage schema absent entirely
  when undefined_function then null;     -- storage.foldername absent
  when insufficient_privilege then null; -- storage.objects owned elsewhere; policy ships via dashboard
end $$;

notify pgrst, 'reload schema';
