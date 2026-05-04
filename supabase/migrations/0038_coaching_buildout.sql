-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0038 · Coaching record buildout
--
-- Turns `coachings` into a proper paper-trail document:
--
-- 1. Severity (info / concern / warning / final) — sortable on the global
--    feed and used for escalation pattern detection.
-- 2. Incident date separate from coached_at.
-- 3. Action taken — jsonb checkbox set (verbal / written / retraining /
--    suspension / route_change / no_action / other).
-- 4. Witness fields (witness_name, witness_role).
-- 5. Driver visibility + acknowledgment (none / verbal / signed / sms /
--    email) + acknowledged_at + signature blob.
-- 6. Privacy tier (standard / hr_only) — restricts visibility for
--    sensitive content.
-- 7. Lifecycle: resolved_at + archived_at — no hard delete. resolve marks
--    a follow-up complete; archive hides from the default feed.
-- 8. coaching_edits — append-only audit row per UPDATE on tracked fields,
--    snapshotting who, when, and the old → new values.
-- 9. coaching_attachments + private storage bucket scoped per dsp_id.
-- 10. drivers.coaching_view_token + coaching_for_driver_token() RPC for a
--    driver-facing read-only page (no driver auth required, just the
--    token URL the operator sends them).
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1. Enums ──
do $$ begin
  if not exists (select 1 from pg_type where typname = 'coaching_severity') then
    create type public.coaching_severity as enum ('info','concern','warning','final');
  end if;
  if not exists (select 1 from pg_type where typname = 'coaching_privacy_tier') then
    create type public.coaching_privacy_tier as enum ('standard','hr_only');
  end if;
  if not exists (select 1 from pg_type where typname = 'coaching_ack_method') then
    create type public.coaching_ack_method as enum ('none','verbal','signed','sms','email');
  end if;
end $$;

-- Topic additions — operators will tag scorecard / conduct / theft.
alter type public.coaching_topic add value if not exists 'scorecard';
alter type public.coaching_topic add value if not exists 'conduct';
alter type public.coaching_topic add value if not exists 'theft';


-- ── 2. coachings columns ──
alter table public.coachings
  add column if not exists severity            public.coaching_severity   not null default 'concern',
  add column if not exists incident_date       date,
  add column if not exists action_taken        jsonb                       not null default '{}'::jsonb,
  add column if not exists witness_name        text,
  add column if not exists witness_role        text,
  add column if not exists driver_visible      boolean                     not null default false,
  add column if not exists acknowledgment      public.coaching_ack_method  not null default 'none',
  add column if not exists acknowledged_at     timestamptz,
  add column if not exists ack_signature_b64   text,
  add column if not exists privacy_tier        public.coaching_privacy_tier not null default 'standard',
  add column if not exists resolved_at         timestamptz,
  add column if not exists resolved_by         uuid references public.app_users(id) on delete set null,
  add column if not exists archived_at         timestamptz,
  add column if not exists archived_by         uuid references public.app_users(id) on delete set null,
  add column if not exists archived_reason     text,
  add column if not exists coached_by_name     text;

create index if not exists coachings_severity_idx
  on public.coachings (dsp_id, severity, occurred_at desc);
create index if not exists coachings_open_idx
  on public.coachings (dsp_id, occurred_at desc) where archived_at is null;
create index if not exists coachings_followup_open_idx
  on public.coachings (dsp_id, follow_up_at) where follow_up_at is not null and resolved_at is null and archived_at is null;


-- ── 3. Snapshot the coach's name on insert ──
-- Names change, accounts get deleted; the record needs to remember who
-- logged it at the time, even if the user row goes away.
create or replace function private.coachings_snapshot_name()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if NEW.coached_by_name is null and NEW.coach_user_id is not null then
    select au.full_name into NEW.coached_by_name
      from public.app_users au where au.id = NEW.coach_user_id;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_coachings_snapshot_name on public.coachings;
create trigger trg_coachings_snapshot_name
  before insert on public.coachings
  for each row execute function private.coachings_snapshot_name();


-- ── 4. coaching_edits — audit history ──
create table if not exists public.coaching_edits (
  id              uuid                primary key default gen_random_uuid(),
  coaching_id     uuid                not null references public.coachings(id) on delete cascade,
  edited_by       uuid                references public.app_users(id) on delete set null,
  edited_by_name  text,
  edited_at       timestamptz         not null default now(),
  field_name      text                not null,
  old_value       text,
  new_value       text
);

create index if not exists coaching_edits_recent_idx
  on public.coaching_edits (coaching_id, edited_at desc);

alter table public.coaching_edits enable row level security;

drop policy if exists "coaching_edits_tenant_read" on public.coaching_edits;
create policy "coaching_edits_tenant_read"
  on public.coaching_edits for select
  using (
    exists (select 1 from public.coachings c
             where c.id = coaching_edits.coaching_id
               and c.dsp_id = private.current_dsp_id())
  );

grant select on public.coaching_edits to authenticated;


-- Audit trigger — write a row per changed field, only on UPDATE.
create or replace function private.coachings_audit_changes()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_user_id   uuid;
  v_user_name text;
begin
  begin
    v_user_id := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  exception when others then v_user_id := null;
  end;
  if v_user_id is not null then
    select au.full_name into v_user_name from public.app_users au where au.id = v_user_id;
  end if;

  if NEW.summary        is distinct from OLD.summary        then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'summary',        OLD.summary,         NEW.summary); end if;
  if NEW.notes          is distinct from OLD.notes          then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'notes',          OLD.notes,           NEW.notes); end if;
  if NEW.severity       is distinct from OLD.severity       then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'severity',       OLD.severity::text,  NEW.severity::text); end if;
  if NEW.topic          is distinct from OLD.topic          then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'topic',          OLD.topic::text,     NEW.topic::text); end if;
  if NEW.type           is distinct from OLD.type           then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'type',           OLD.type::text,      NEW.type::text); end if;
  if NEW.action_taken   is distinct from OLD.action_taken   then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'action_taken',   OLD.action_taken::text, NEW.action_taken::text); end if;
  if NEW.witness_name   is distinct from OLD.witness_name   then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'witness_name',   OLD.witness_name,    NEW.witness_name); end if;
  if NEW.witness_role   is distinct from OLD.witness_role   then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'witness_role',   OLD.witness_role,    NEW.witness_role); end if;
  if NEW.driver_visible is distinct from OLD.driver_visible then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'driver_visible', OLD.driver_visible::text, NEW.driver_visible::text); end if;
  if NEW.privacy_tier   is distinct from OLD.privacy_tier   then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'privacy_tier',   OLD.privacy_tier::text, NEW.privacy_tier::text); end if;
  if NEW.follow_up_at   is distinct from OLD.follow_up_at   then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'follow_up_at',   OLD.follow_up_at::text, NEW.follow_up_at::text); end if;
  if NEW.incident_date  is distinct from OLD.incident_date  then insert into public.coaching_edits (coaching_id,edited_by,edited_by_name,field_name,old_value,new_value) values (NEW.id,v_user_id,v_user_name,'incident_date',  OLD.incident_date::text, NEW.incident_date::text); end if;

  return NEW;
end $$;

drop trigger if exists trg_coachings_audit on public.coachings;
create trigger trg_coachings_audit
  after update on public.coachings
  for each row execute function private.coachings_audit_changes();


-- ── 5. coaching_attachments ──
create table if not exists public.coaching_attachments (
  id              uuid                primary key default gen_random_uuid(),
  coaching_id     uuid                not null references public.coachings(id) on delete cascade,
  storage_path    text                not null,
  file_name       text                not null,
  mime_type       text,
  size_bytes      int,
  uploaded_by     uuid                references public.app_users(id) on delete set null,
  uploaded_at     timestamptz         not null default now()
);

create index if not exists coaching_attachments_recent_idx
  on public.coaching_attachments (coaching_id, uploaded_at desc);

alter table public.coaching_attachments enable row level security;

drop policy if exists "coaching_attachments_tenant_rw" on public.coaching_attachments;
create policy "coaching_attachments_tenant_rw"
  on public.coaching_attachments for all
  using (
    exists (select 1 from public.coachings c
             where c.id = coaching_attachments.coaching_id
               and c.dsp_id = private.current_dsp_id())
  )
  with check (
    exists (select 1 from public.coachings c
             where c.id = coaching_attachments.coaching_id
               and c.dsp_id = private.current_dsp_id())
  );

grant select, insert, update, delete on public.coaching_attachments to authenticated;


-- ── 6. Storage bucket — `coaching-attachments`, scoped per DSP folder. ──
insert into storage.buckets (id, name, public)
values ('coaching-attachments', 'coaching-attachments', false)
on conflict (id) do nothing;

drop policy if exists "coaching-attachments-tenant-read"   on storage.objects;
drop policy if exists "coaching-attachments-tenant-insert" on storage.objects;
drop policy if exists "coaching-attachments-tenant-delete" on storage.objects;

create policy "coaching-attachments-tenant-read"
  on storage.objects for select
  using (
    bucket_id = 'coaching-attachments'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );

create policy "coaching-attachments-tenant-insert"
  on storage.objects for insert
  with check (
    bucket_id = 'coaching-attachments'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );

create policy "coaching-attachments-tenant-delete"
  on storage.objects for delete
  using (
    bucket_id = 'coaching-attachments'
    and (storage.foldername(name))[1] = private.current_dsp_id()::text
  );


-- ── 7. Driver-facing token ──
alter table public.drivers
  add column if not exists coaching_view_token text unique;

create or replace function private.drivers_set_coaching_token()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if NEW.coaching_view_token is null then
    NEW.coaching_view_token := encode(gen_random_bytes(16), 'hex');
  end if;
  return NEW;
end $$;

drop trigger if exists trg_drivers_set_coaching_token on public.drivers;
create trigger trg_drivers_set_coaching_token
  before insert on public.drivers
  for each row execute function private.drivers_set_coaching_token();

-- Backfill tokens for existing drivers.
update public.drivers
   set coaching_view_token = encode(gen_random_bytes(16), 'hex')
 where coaching_view_token is null;


-- ── 8. Lifecycle RPCs ──
create or replace function public.coaching_resolve(p_id uuid)
returns public.coachings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_row  public.coachings;
begin
  update public.coachings
     set resolved_at = now(),
         resolved_by = v_user,
         updated_at  = now()
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if not found then raise exception 'coaching not found' using errcode = '42704'; end if;
  return v_row;
end $$;
grant execute on function public.coaching_resolve(uuid) to authenticated;


create or replace function public.coaching_archive(p_id uuid, p_reason text)
returns public.coachings
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp  uuid := private.current_dsp_id();
  v_user uuid := nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
  v_row  public.coachings;
begin
  update public.coachings
     set archived_at     = now(),
         archived_by     = v_user,
         archived_reason = p_reason,
         updated_at      = now()
   where id = p_id and dsp_id = v_dsp
   returning * into v_row;
  if not found then raise exception 'coaching not found' using errcode = '42704'; end if;
  return v_row;
end $$;
grant execute on function public.coaching_archive(uuid, text) to authenticated;


-- ── 9. Driver-facing read RPC (no auth — token only) ──
create or replace function public.coaching_for_driver_token(p_token text)
returns table (
  id                uuid,
  occurred_at       timestamptz,
  topic             text,
  type              text,
  severity          text,
  summary           text,
  notes             text,
  action_taken      jsonb,
  coached_by_name   text,
  acknowledgment    text,
  acknowledged_at   timestamptz,
  driver_full_name  text
)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
begin
  select * into v_drv from public.drivers where coaching_view_token = p_token;
  if not found then raise exception 'invalid token' using errcode = '42501'; end if;

  return query
  select c.id, c.occurred_at,
         c.topic::text, c.type::text, c.severity::text,
         c.summary, c.notes, c.action_taken,
         c.coached_by_name,
         c.acknowledgment::text, c.acknowledged_at,
         v_drv.full_name
    from public.coachings c
   where c.driver_id = v_drv.id
     and c.driver_visible = true
     and c.archived_at is null
     and c.privacy_tier = 'standard'
   order by c.occurred_at desc;
end $$;
grant execute on function public.coaching_for_driver_token(text) to anon, authenticated;


create or replace function public.coaching_acknowledge_via_token(
  p_token         text,
  p_coaching_id   uuid,
  p_method        text,
  p_signature_b64 text
) returns public.coachings
language plpgsql security definer set search_path = ''
as $$
declare
  v_drv public.drivers;
  v_row public.coachings;
begin
  select * into v_drv from public.drivers where coaching_view_token = p_token;
  if not found then raise exception 'invalid token' using errcode = '42501'; end if;
  if p_method not in ('verbal','signed','sms','email') then
    raise exception 'invalid method' using errcode = '22023';
  end if;
  update public.coachings
     set acknowledgment   = p_method::public.coaching_ack_method,
         acknowledged_at  = now(),
         ack_signature_b64 = p_signature_b64,
         updated_at        = now()
   where id = p_coaching_id
     and driver_id = v_drv.id
     and driver_visible = true
   returning * into v_row;
  if not found then raise exception 'coaching not found' using errcode = '42704'; end if;
  return v_row;
end $$;
grant execute on function public.coaching_acknowledge_via_token(text, uuid, text, text) to anon, authenticated;
