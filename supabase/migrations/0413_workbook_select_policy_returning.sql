-- 0413_workbook_select_policy_returning.sql
--
-- Fix: creating a workbook failed with "new row violates row-level
-- security policy for table workbooks".
--
-- Root cause: the dashboard inserts with RETURNING (supabase-js
-- .insert(...).select()), and Postgres applies the SELECT policy to
-- RETURNING rows. 0412's select policy delegated to
-- private.can_view_workbook(id), which re-queries public.workbooks —
-- and a row inserted by the *same statement* isn't visible to that
-- inner scan yet (same command-id snapshot), so the check failed for
-- the very row being created.
--
-- Fix: evaluate the visibility predicate directly against the row's
-- own columns (no self-table scan). Semantics are identical to
-- can_view_workbook: same DSP + dispatcher-or-higher, and the workbook
-- is org-visible, owned by the caller, or explicitly shared with them.
-- can_view_workbook stays in place unchanged for the child tables,
-- where it scans a *different* (pre-existing) row and works fine.

drop policy if exists "workbooks_select" on public.workbooks;
create policy "workbooks_select" on public.workbooks for select
  using (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
    and (
      visibility = 'org'
      or owner_user_id = auth.uid()
      or exists (
        select 1
        from public.workbook_permissions p
        where p.workbook_id = workbooks.id
          and (
            (p.subject_type = 'user' and p.subject_id = auth.uid())
            or p.subject_type = 'org'
          )
      )
    )
  );

notify pgrst, 'reload schema';
