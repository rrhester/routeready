-- 0501_workbook_mention_delivery.sql
--
-- Workbook @-mention delivery (100-list #75). The workbook already RECORDS
-- mentions in public.workbook_mentions whenever a comment @-tags a teammate,
-- but nothing ever DELIVERED them — the mentioned person only found out by
-- reopening the workbook. This adds an AFTER INSERT trigger that fires a
-- best-effort Web Push to the mentioned teammate (via 0497's
-- private.notify_staff_push → the send-staff-push edge function), deep-linking
-- straight to the workbook (?wb=<id>). Idempotent; no client change — the app
-- already writes the workbook_mentions rows this trigger reacts to.
--
-- Best-effort by design: if the mentioned user has no push subscription, or
-- the push settings aren't configured, notify_staff_push silently no-ops. The
-- mention row itself is never blocked.

create or replace function private.workbook_mention_notify()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_email   text;
  v_author  text;
  v_wbtitle text;
  v_snippet text;
begin
  -- never ping yourself for your own @-mention
  if new.mentioned_user_id is null or new.mentioned_user_id = new.created_by_user_id then
    return new;
  end if;

  -- the mentioned teammate must be an active member of this DSP with an email
  select u.email into v_email
    from public.app_users u
   where u.id = new.mentioned_user_id and u.dsp_id = new.dsp_id and u.active
     and u.email is not null and position('@' in u.email) > 0;
  if v_email is null then return new; end if;

  select coalesce(nullif(btrim(a.full_name), ''), 'A teammate') into v_author
    from public.app_users a where a.id = new.created_by_user_id;

  select coalesce(nullif(btrim(w.title), ''), 'a workbook') into v_wbtitle
    from public.workbooks w where w.id = new.workbook_id;

  select left(btrim(c.body), 120) into v_snippet
    from public.workbook_comments c where c.id = new.comment_id;

  perform private.notify_staff_push(
    new.dsp_id,
    coalesce(v_author, 'A teammate') || ' mentioned you',
    coalesce(v_wbtitle, 'a workbook')
      || case when nullif(v_snippet, '') is not null then ': ' || v_snippet else '' end,
    '/dashboard/index.html?wb=' || new.workbook_id,
    array[v_email]);

  return new;
exception when others then
  return new;   -- delivery is best-effort; never break the mention insert
end; $$;

drop trigger if exists trg_workbook_mention_notify on public.workbook_mentions;
create trigger trg_workbook_mention_notify
  after insert on public.workbook_mentions
  for each row execute function private.workbook_mention_notify();

notify pgrst, 'reload schema';
