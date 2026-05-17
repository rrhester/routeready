-- 0277_list_forms_includes_archived.sql
--
-- The dispatcher Workspaces · Forms sidebar surfaces Active /
-- Archived / Categories as filter scopes.  list_forms (0080) hides
-- archived rows server-side, which prevented the sidebar from showing
-- an Archived count or letting the operator restore an archived form
-- without leaving the page.
--
-- Drop the `status <> 'archived'` predicate so the client receives
-- every form in the DSP; the dispatcher UI applies the scope filter
-- in-process now.  RLS still gates by DSP via policy; only the
-- archived filter moves out of the RPC.
--
-- Idempotent: `create or replace function` re-runs cleanly.


create or replace function public.list_forms()
returns setof public.forms
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.forms
   where dsp_id = private.current_dsp_id()
   order by updated_at desc;
$$;

grant execute on function public.list_forms() to authenticated;

-- restore_form — counterpart to archive_form (0080).  Flips an
-- archived form back to draft so the operator can publish it again.
-- Without this the only way out of archived was a hand-rolled
-- upsert_form payload, which our Workspaces UI doesn't ship.
create or replace function public.restore_form(p_id uuid)
returns public.forms
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.forms;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.forms
     set status = 'draft'
   where id = p_id and dsp_id = v_dsp and status = 'archived'
   returning * into v_row;
  if v_row.id is null then raise exception 'form_not_found_or_not_archived'; end if;
  return v_row;
end;
$$;

grant execute on function public.restore_form(uuid) to authenticated;

notify pgrst, 'reload schema';
