-- Migration 0503 · Duplicate a notebook section together with all of its pages.
--
-- Copies the section (name + " (copy)", same notebook/group/color) and every
-- non-deleted page in it, preserving the parent/child hierarchy, level,
-- position, title, content and tags. Pages are copied parents-first (order by
-- level) so a child's new parent id is already known via the old→new map.
-- Idempotent: create or replace.

create or replace function public.notebook_section_duplicate(p_section_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_dsp     uuid := private.current_dsp_id();
  v_src     public.notebook_sections;
  v_new_sec uuid;
  v_pos     double precision;
  v_name    text;
  v_map     jsonb := '{}'::jsonb;
  v_new     uuid;
  v_parent  uuid;
  r         record;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_src
    from public.notebook_sections
   where id = p_section_id and dsp_id = v_dsp and deleted_at is null;
  if v_src.id is null then
    raise exception 'section_not_found' using errcode = 'P0002';
  end if;

  v_name := left(coalesce(v_src.name, 'Section'), 180) || ' (copy)';
  select coalesce(max(position), 0) + 1 into v_pos
    from public.notebook_sections
   where notebook_id = v_src.notebook_id and deleted_at is null;

  insert into public.notebook_sections (dsp_id, notebook_id, group_id, name, color, position)
  values (v_dsp, v_src.notebook_id, v_src.group_id, v_name, v_src.color, v_pos)
  returning id into v_new_sec;

  for r in
    select * from public.notebook_pages
     where section_id = p_section_id and dsp_id = v_dsp and deleted_at is null
     order by level asc nulls first, position asc, created_at asc
  loop
    v_parent := null;
    if r.parent_page_id is not null then
      v_parent := nullif(v_map ->> r.parent_page_id::text, '')::uuid;
    end if;
    insert into public.notebook_pages
      (dsp_id, notebook_id, section_id, parent_page_id, title, content_html, content_text, level, position, tags, created_by, updated_by)
    values
      (v_dsp, v_src.notebook_id, v_new_sec, v_parent, r.title, r.content_html, r.content_text, r.level, r.position, r.tags, auth.uid(), auth.uid())
    returning id into v_new;
    v_map := v_map || jsonb_build_object(r.id::text, v_new::text);
  end loop;

  return jsonb_build_object('id', v_new_sec, 'name', v_name, 'color', v_src.color, 'position', v_pos);
end; $$;

grant execute on function public.notebook_section_duplicate(uuid) to authenticated;

notify pgrst, 'reload schema';
