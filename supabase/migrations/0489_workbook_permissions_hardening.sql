-- 0489_workbook_permissions_hardening.sql
--
-- Access-control hardening for the Operations Workbook (100-list #96, #97).
--
--  #96  visibility / owner_user_id could be changed by ANY editor of an
--       org-visible workbook: workbooks_update only requires can_edit.
--       Sharing is meant to be admin-gated (can_admin_workbook). RLS
--       policies can't compare OLD vs NEW, so guard the two admin-only
--       columns with a BEFORE UPDATE trigger.
--
--  #97  workbook_permissions rows with subject_type='org' granted view
--       to staff of any DSP whose workbook carried such a row — the
--       subject_id was never checked. Pin org rows to the workbook's
--       own DSP. Also implement the reserved 'role' shares: a new
--       subject_role column + minimum-rank match via private.is_staff,
--       so a private workbook can be shared with "everyone at ops+".
--       Group rows (org/role) grant at most 'edit' — admin stays
--       per-user only, same as before.

-- ─── #97a · schema: role shares get a real column ───────────────────────────

alter table public.workbook_permissions
  add column if not exists subject_role text;

do $$ begin
  alter table public.workbook_permissions
    add constraint workbook_permissions_subject_role_chk
    check (subject_role is null or subject_role in ('dispatcher','ops','owner'));
exception when duplicate_object then null; end $$;

-- one role row per (workbook, role)
create unique index if not exists idx_workbook_permissions_role
  on public.workbook_permissions (workbook_id, subject_role)
  where subject_type = 'role';

-- org rows must point at the workbook's own DSP; backfill legacy rows
update public.workbook_permissions
   set subject_id = dsp_id
 where subject_type = 'org'
   and (subject_id is null or subject_id <> dsp_id);

-- ─── #97b · access helpers honor scoped org rows + role rows ────────────────

create or replace function private.can_view_workbook(p_workbook_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workbooks w
    where w.id = p_workbook_id
      and w.dsp_id = private.current_dsp_id()
      and private.is_staff(w.dsp_id, 'dispatcher')
      and (
        w.visibility = 'org'
        or w.owner_user_id = auth.uid()
        or exists (
          select 1 from public.workbook_permissions p
          where p.workbook_id = w.id
            and (
              (p.subject_type = 'user' and p.subject_id = auth.uid())
              or (p.subject_type = 'org'  and p.subject_id = w.dsp_id)
              or (p.subject_type = 'role' and p.subject_role is not null
                  and private.is_staff(w.dsp_id, p.subject_role))
            )
        )
      )
  );
$$;

create or replace function private.can_edit_workbook(p_workbook_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workbooks w
    where w.id = p_workbook_id
      and w.dsp_id = private.current_dsp_id()
      and private.is_staff(w.dsp_id, 'dispatcher')
      and (
        w.visibility = 'org'
        or w.owner_user_id = auth.uid()
        or exists (
          select 1 from public.workbook_permissions p
          where p.workbook_id = w.id
            and p.access_level in ('edit','admin')
            and (
              (p.subject_type = 'user' and p.subject_id = auth.uid())
              or (p.subject_type = 'org'  and p.subject_id = w.dsp_id)
              or (p.subject_type = 'role' and p.subject_role is not null
                  and private.is_staff(w.dsp_id, p.subject_role))
            )
        )
      )
  );
$$;

-- can_admin_workbook is unchanged on purpose: admin remains owner /
-- ops+ / an explicit per-USER admin share. Group rows never grant admin.

-- ─── #96 · admin-only columns guard ─────────────────────────────────────────

create or replace function private.workbook_admin_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- service-role / SQL-editor maintenance (no auth context) passes through
  if auth.uid() is null then return new; end if;
  if (new.visibility is distinct from old.visibility
      or new.owner_user_id is distinct from old.owner_user_id)
     and not private.can_admin_workbook(old.id) then
    raise exception 'Only a workbook admin can change visibility or ownership'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_workbooks_admin_fields on public.workbooks;
create trigger trg_workbooks_admin_fields
  before update on public.workbooks
  for each row execute function private.workbook_admin_fields_guard();
