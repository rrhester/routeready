-- 0492_workbook_permissions_hardening_fix.sql
--
-- Corrects 0489: private.is_staff's second argument is the enum
-- public.app_role, not text. A text column (workbook_permissions.subject_role)
-- does not implicitly cast to the enum in a function-argument position, so
-- 0489's can_view/can_edit failed with:
--   ERROR 42883: function private.is_staff(uuid, text) does not exist
--
-- This migration is a complete, idempotent superset of 0489's #97/#96 work,
-- so it can be run standalone whether or not 0489 partially applied. The only
-- change vs 0489 is the `p.subject_role::public.app_role` cast.

-- ─── schema (idempotent; may already exist from a partial 0489 run) ──────────

alter table public.workbook_permissions
  add column if not exists subject_role text;

do $$ begin
  alter table public.workbook_permissions
    add constraint workbook_permissions_subject_role_chk
    check (subject_role is null or subject_role in ('dispatcher','ops','owner'));
exception when duplicate_object then null; end $$;

create unique index if not exists idx_workbook_permissions_role
  on public.workbook_permissions (workbook_id, subject_role)
  where subject_type = 'role';

update public.workbook_permissions
   set subject_id = dsp_id
 where subject_type = 'org'
   and (subject_id is null or subject_id <> dsp_id);

-- ─── access helpers, with the subject_role::app_role cast ────────────────────

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
                  and private.is_staff(w.dsp_id, p.subject_role::public.app_role))
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
                  and private.is_staff(w.dsp_id, p.subject_role::public.app_role))
            )
        )
      )
  );
$$;

-- ─── #96 admin-only columns guard (unchanged from 0489; idempotent) ──────────

create or replace function private.workbook_admin_fields_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
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
