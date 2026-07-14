-- 0480_notebook_set_kind.sql
-- Toggle a notebook between private ('personal') and public ('workspace'),
-- and back, on demand.
--
-- Owner-gated: only the notebook's owner may change its visibility, so no one
-- can expose another user's private notes or lock down a colleague's shared
-- notebook. A shared notebook with no owner yet may be claimed + locked down by
-- any dispatcher. Object (record-bound) notebooks are fixed to their record and
-- cannot be toggled. Idempotent (create or replace).

create or replace function public.notebook_set_kind(p_notebook_id uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_uid uuid := auth.uid();
  v_nb  public.notebooks;
  v_new public.notebook_kind := (case when p_kind = 'personal' then 'personal' else 'workspace' end)::public.notebook_kind;
begin
  if v_dsp is null or not private.is_staff(v_dsp, 'dispatcher') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_nb
    from public.notebooks
   where id = p_notebook_id and dsp_id = v_dsp and deleted_at is null;
  if not found then
    raise exception 'notebook_not_found' using errcode = 'P0002';
  end if;

  -- record-bound notebooks stay tied to their object
  if v_nb.kind = 'object' then
    raise exception 'object_notebook_visibility_fixed' using errcode = '22023';
  end if;

  -- already the requested visibility → no-op
  if v_new = v_nb.kind then
    return jsonb_build_object('id', v_nb.id, 'kind', v_nb.kind, 'my_role', private.notebook_role(v_nb.id));
  end if;

  -- only the owner may flip visibility (an unowned shared notebook may be
  -- claimed by any dispatcher so it can be locked down)
  if not (v_nb.owner_id = v_uid or v_nb.owner_id is null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  update public.notebooks
     set kind       = v_new,
         owner_id   = coalesce(owner_id, v_uid),   -- guarantee an owner so access survives going private
         updated_at = now()
   where id = p_notebook_id and dsp_id = v_dsp;

  return jsonb_build_object('id', v_nb.id, 'kind', v_new, 'my_role', private.notebook_role(v_nb.id));
end;
$$;

grant execute on function public.notebook_set_kind(uuid, text) to authenticated;
