-- 0455_seed_dsp_starter_notebook.sql
--
-- Every DSP can use Notebooks on day 1. Until now the starter notebook was
-- provisioned client-side on a staff member's first visit to the Notebooks
-- view (view-notebooks.frag, gated by a localStorage flag) — which means a
-- brand-new DSP has no notebook until someone happens to open that tab, and
-- the flag can misfire across browsers/devices. Operator request: "I want
-- every future DSP to have the ability to make notebooks on day 1."
--
-- Same pattern as service types (0050/0078/0323/0349):
--   1. private.dsp_seed_starter_notebook(dsp_id, name) creates one workspace
--      notebook ("<DSP name> Notebook", matching the client's default naming)
--      with a "Notes" section — but only for a DSP that has never had any
--      notebook row (live or soft-deleted), so operators who emptied their
--      workspace on purpose don't get it recreated on a re-run.
--   2. Backfill every existing DSP.
--   3. trg_dsp_seed_starter_notebook on dsps seeds every future DSP the
--      moment it's provisioned (admin_create_dsp or any direct insert).
--
-- owner_id / created_by stay null: kind='workspace' means every dispatcher+
-- staff member is an editor via private.notebook_role (0454), so the seeded
-- notebook is immediately usable by whoever joins the DSP first. The client's
-- first-run provisioning only fires when notebooks_list() comes back empty,
-- so it becomes a no-op — no duplicate starter notebooks.
--
-- Idempotent: create or replace, drop trigger if exists, and the has-a-row
-- guard in the seed function.

-- ── seed helper ─────────────────────────────────────────────────────────────
create or replace function private.dsp_seed_starter_notebook(p_dsp_id uuid, p_dsp_name text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_nb uuid;
begin
  -- any notebook row — even soft-deleted — means this DSP is past day 1
  if exists (select 1 from public.notebooks where dsp_id = p_dsp_id) then
    return;
  end if;
  insert into public.notebooks (dsp_id, name, color, kind, position)
  values (p_dsp_id,
          coalesce(nullif(trim(p_dsp_name), '') || ' Notebook', 'Workspace'),
          '#2563eb', 'workspace', 0)
  returning id into v_nb;
  insert into public.notebook_sections (dsp_id, notebook_id, name, color, position)
  values (p_dsp_id, v_nb, 'Notes', '#2563eb', 0);
end; $$;

-- ── backfill: every existing DSP that never had a notebook ──────────────────
do $$
declare d record;
begin
  for d in select id, name from public.dsps loop
    perform private.dsp_seed_starter_notebook(d.id, d.name);
  end loop;
end $$;

-- ── future DSPs: seed at provisioning time ──────────────────────────────────
create or replace function private.tg_dsp_seed_starter_notebook()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- a starter notebook is a nicety — it must never block DSP provisioning
  begin
    perform private.dsp_seed_starter_notebook(NEW.id, NEW.name);
  exception when others then null;
  end;
  return NEW;
end; $$;

drop trigger if exists trg_dsp_seed_starter_notebook on public.dsps;
create trigger trg_dsp_seed_starter_notebook
  after insert on public.dsps
  for each row execute function private.tg_dsp_seed_starter_notebook();

notify pgrst, 'reload schema';
