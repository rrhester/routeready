-- Migration 0490 · Move a notebook section into (or out of) a section group.
--
-- The section rail had no way to place a section inside a group — "New section
-- group" created an empty group and left the section ungrouped, so groups could
-- never hold anything. This RPC sets a section's group_id (NULL = ungrouped) and
-- optionally its position. Idempotent: create or replace.

create or replace function public.notebook_section_move(
  p_id uuid, p_group_id uuid default null, p_position double precision default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_sec_nb uuid;
  v_grp_nb uuid;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select notebook_id into v_sec_nb
    from public.notebook_sections
   where id = p_id and dsp_id = v_dsp;
  if v_sec_nb is null then
    raise exception 'section_not_found' using errcode = 'P0002';
  end if;

  -- A target group must exist in the same notebook (NULL means "ungroup").
  if p_group_id is not null then
    select notebook_id into v_grp_nb
      from public.notebook_section_groups
     where id = p_group_id and dsp_id = v_dsp and deleted_at is null;
    if v_grp_nb is null or v_grp_nb <> v_sec_nb then
      raise exception 'group_not_found' using errcode = 'P0002';
    end if;
  end if;

  update public.notebook_sections
     set group_id = p_group_id,
         position = coalesce(p_position, position)
   where id = p_id and dsp_id = v_dsp;
end; $$;

grant execute on function public.notebook_section_move(uuid, uuid, double precision) to authenticated;

notify pgrst, 'reload schema';
