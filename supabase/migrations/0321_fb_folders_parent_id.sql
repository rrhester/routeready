-- 0321_fb_folders_parent_id.sql
-- ════════════════════════════════════════════════════════════════════
-- Fleet Bridge · sub-folders
--
-- Adds a parent_id self-reference on fb_folders so custom folders can
-- nest underneath any other folder (system or custom). The UI renders
-- them as an indented tree; from the data layer's perspective each
-- folder still owns its own messages (no aggregation up the tree).
--
-- Idempotent. Built-in folders keep parent_id = NULL.
-- ════════════════════════════════════════════════════════════════════

alter table public.fb_folders
  add column if not exists parent_id uuid;

do $$ begin
  alter table public.fb_folders
    add constraint fb_folders_parent_fk
    foreign key (parent_id) references public.fb_folders(id) on delete cascade;
exception when duplicate_object then null;
end $$;

create index if not exists fb_folders_parent_idx on public.fb_folders(parent_id);

-- Guard against direct self-cycles. Deeper cycles are unlikely given
-- the UI only lets a custom folder be created with one chosen parent,
-- but the trivial self-loop is worth blocking at the DB.
do $$ begin
  alter table public.fb_folders
    add constraint fb_folders_no_self_parent
    check (parent_id is null or parent_id <> id);
exception when duplicate_object then null;
end $$;
