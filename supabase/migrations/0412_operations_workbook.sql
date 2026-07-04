-- 0412_operations_workbook.sql
--
-- Operations Workbook — a RouteReady-native workbook system that combines
-- spreadsheet blocks, rich-text notes, and checklist/task blocks in one
-- durable, org-scoped document. Phase 1 foundation:
--
--   workbooks                 the document (title, description, visibility)
--   workbook_blocks           ordered blocks (sheet | text | checklist)
--   workbook_sheets           sheets inside a spreadsheet block
--   workbook_cells            sparse cell store (value, formula, format)
--   workbook_checklist_items  items inside a checklist block
--   workbook_comments         threaded comments (workbook / block / cell)
--   workbook_mentions         @mention records (notification foundation)
--   workbook_activity         append-only activity/version spine
--   workbook_permissions      per-user shares for private workbooks
--
-- Conventions per the rest of the schema: every table carries a
-- denormalized dsp_id for one-hop RLS, timestamps + set_updated_at
-- triggers, grants to authenticated, idempotent DDL throughout.
--
-- Visibility model (Phase 1):
--   'org'     — every staff member (dispatcher+) in the DSP can view & edit
--   'private' — only the owner and explicitly shared users can view;
--               shared access level: view < comment < edit < admin
-- Enforced server-side by the private.can_view_workbook /
-- private.can_edit_workbook helpers below.

-- ─── Tables ─────────────────────────────────────────────────────────────────

create table if not exists public.workbooks (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  owner_user_id  uuid references auth.users(id) on delete set null,
  title          text not null default 'Untitled workbook',
  description    text not null default '',
  visibility     text not null default 'org' check (visibility in ('org','private')),
  template_key   text,
  archived_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists idx_workbooks_dsp on public.workbooks (dsp_id, archived_at, updated_at desc);

-- type is deliberately unconstrained text so future RouteReady-native
-- block types (driver list, route coverage, forecast gap, ...) don't
-- need a migration; clients render unknown types as a placeholder.
create table if not exists public.workbook_blocks (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  workbook_id  uuid not null references public.workbooks(id) on delete cascade,
  type         text not null,
  title        text not null default '',
  position     integer not null default 0,
  settings     jsonb not null default '{}'::jsonb,
  content      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_workbook_blocks_wb on public.workbook_blocks (workbook_id, position);

create table if not exists public.workbook_sheets (
  id           uuid primary key default gen_random_uuid(),
  dsp_id       uuid not null references public.dsps(id) on delete cascade,
  workbook_id  uuid not null references public.workbooks(id) on delete cascade,
  block_id     uuid not null references public.workbook_blocks(id) on delete cascade,
  name         text not null default 'Sheet 1',
  position     integer not null default 0,
  row_count    integer not null default 200 check (row_count between 1 and 10000),
  col_count    integer not null default 26 check (col_count between 1 and 200),
  frozen_rows  integer not null default 0 check (frozen_rows between 0 and 1),
  frozen_cols  integer not null default 0 check (frozen_cols between 0 and 1),
  col_widths   jsonb not null default '{}'::jsonb,
  row_heights  jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_workbook_sheets_block on public.workbook_sheets (block_id, position);

-- Sparse cell store: one row per non-empty cell, upserted in batches on
-- (sheet_id, row_index, col_index). value holds the raw user input,
-- formula the "=..." source when the cell is a formula, computed the
-- last client-evaluated result (kept server-side for export/reporting;
-- the client re-evaluates on load).
create table if not exists public.workbook_cells (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  workbook_id   uuid not null references public.workbooks(id) on delete cascade,
  sheet_id      uuid not null references public.workbook_sheets(id) on delete cascade,
  row_index     integer not null check (row_index >= 0),
  col_index     integer not null check (col_index >= 0),
  value         text,
  formula       text,
  computed      text,
  value_type    text,
  format        jsonb not null default '{}'::jsonb,
  updated_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (sheet_id, row_index, col_index)
);
create index if not exists idx_workbook_cells_sheet on public.workbook_cells (sheet_id);

create table if not exists public.workbook_checklist_items (
  id                uuid primary key default gen_random_uuid(),
  dsp_id            uuid not null references public.dsps(id) on delete cascade,
  workbook_id       uuid not null references public.workbooks(id) on delete cascade,
  block_id          uuid not null references public.workbook_blocks(id) on delete cascade,
  label             text not null default '',
  note              text not null default '',
  position          integer not null default 0,
  priority          text check (priority in ('low','normal','high')),
  due_date          date,
  assignee_user_id  uuid references auth.users(id) on delete set null,
  completed_at      timestamptz,
  completed_by      uuid references auth.users(id) on delete set null,
  created_by        uuid references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_workbook_checklist_items_block on public.workbook_checklist_items (block_id, position);
create index if not exists idx_workbook_checklist_items_wb on public.workbook_checklist_items (workbook_id);

-- Comments attach at three levels: workbook (block_id/cell null),
-- block, or a specific cell (sheet_id + cell_ref like "B12"; row/col
-- kept numerically so future row/col shifts can re-anchor). Replies
-- via parent_comment_id (one level deep in the UI).
create table if not exists public.workbook_comments (
  id                 uuid primary key default gen_random_uuid(),
  dsp_id             uuid not null references public.dsps(id) on delete cascade,
  workbook_id        uuid not null references public.workbooks(id) on delete cascade,
  block_id           uuid references public.workbook_blocks(id) on delete cascade,
  sheet_id           uuid references public.workbook_sheets(id) on delete cascade,
  cell_ref           text,
  row_index          integer,
  col_index          integer,
  parent_comment_id  uuid references public.workbook_comments(id) on delete cascade,
  author_user_id     uuid references auth.users(id) on delete set null,
  body               text not null default '',
  resolved_at        timestamptz,
  resolved_by        uuid references auth.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_workbook_comments_wb on public.workbook_comments (workbook_id, created_at);

-- Mention records: the notification-inbox foundation. No in-app
-- notification system exists yet, so Phase 1 stores the rows (and the
-- comments panel renders mention chips); a future inbox can query
-- unseen mentions per user.
create table if not exists public.workbook_mentions (
  id                  uuid primary key default gen_random_uuid(),
  dsp_id              uuid not null references public.dsps(id) on delete cascade,
  workbook_id         uuid not null references public.workbooks(id) on delete cascade,
  comment_id          uuid references public.workbook_comments(id) on delete cascade,
  mentioned_user_id   uuid not null references auth.users(id) on delete cascade,
  created_by_user_id  uuid references auth.users(id) on delete set null,
  seen_at             timestamptz,
  created_at          timestamptz not null default now()
);
create index if not exists idx_workbook_mentions_user on public.workbook_mentions (mentioned_user_id, seen_at);

-- Append-only activity spine (also the version-history foundation:
-- cell-edit events carry capped prev/next values in detail so a later
-- release can add rollback without a schema change). Never updated or
-- deleted by clients.
create table if not exists public.workbook_activity (
  id             uuid primary key default gen_random_uuid(),
  dsp_id         uuid not null references public.dsps(id) on delete cascade,
  workbook_id    uuid not null references public.workbooks(id) on delete cascade,
  actor_user_id  uuid references auth.users(id) on delete set null,
  action         text not null,
  target_type    text,
  target_id      uuid,
  summary        text not null default '',
  detail         jsonb not null default '{}'::jsonb,
  created_at     timestamptz not null default now()
);
create index if not exists idx_workbook_activity_wb on public.workbook_activity (workbook_id, created_at desc);

-- Per-user shares for private workbooks. subject_type 'user' is the
-- only kind the Phase 1 UI writes; 'role' and 'org' are reserved for
-- group shares later.
create table if not exists public.workbook_permissions (
  id            uuid primary key default gen_random_uuid(),
  dsp_id        uuid not null references public.dsps(id) on delete cascade,
  workbook_id   uuid not null references public.workbooks(id) on delete cascade,
  subject_type  text not null default 'user' check (subject_type in ('user','role','org')),
  subject_id    uuid,
  access_level  text not null default 'view' check (access_level in ('view','comment','edit','admin')),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists idx_workbook_permissions_subject
  on public.workbook_permissions (workbook_id, subject_type, subject_id);

-- ─── updated_at triggers ────────────────────────────────────────────────────

drop trigger if exists trg_workbooks_updated_at on public.workbooks;
create trigger trg_workbooks_updated_at
  before update on public.workbooks
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_blocks_updated_at on public.workbook_blocks;
create trigger trg_workbook_blocks_updated_at
  before update on public.workbook_blocks
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_sheets_updated_at on public.workbook_sheets;
create trigger trg_workbook_sheets_updated_at
  before update on public.workbook_sheets
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_cells_updated_at on public.workbook_cells;
create trigger trg_workbook_cells_updated_at
  before update on public.workbook_cells
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_checklist_items_updated_at on public.workbook_checklist_items;
create trigger trg_workbook_checklist_items_updated_at
  before update on public.workbook_checklist_items
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_comments_updated_at on public.workbook_comments;
create trigger trg_workbook_comments_updated_at
  before update on public.workbook_comments
  for each row execute function private.set_updated_at();

drop trigger if exists trg_workbook_permissions_updated_at on public.workbook_permissions;
create trigger trg_workbook_permissions_updated_at
  before update on public.workbook_permissions
  for each row execute function private.set_updated_at();

-- ─── Access helpers ─────────────────────────────────────────────────────────
-- SECURITY DEFINER so RLS policies on child tables can consult the
-- workbook + its permission rows without policy recursion. Staff-gated:
-- the operator dashboard is dispatcher+ everywhere (same rule as the
-- checklists feature).

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
              or p.subject_type = 'org'
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
            and p.subject_type = 'user'
            and p.subject_id = auth.uid()
            and p.access_level in ('edit','admin')
        )
      )
  );
$$;

-- Sharing management: the owner, an 'admin'-level share, or ops+.
create or replace function private.can_admin_workbook(p_workbook_id uuid)
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
      and (
        w.owner_user_id = auth.uid()
        or private.is_staff(w.dsp_id, 'ops')
        or exists (
          select 1 from public.workbook_permissions p
          where p.workbook_id = w.id
            and p.subject_type = 'user'
            and p.subject_id = auth.uid()
            and p.access_level = 'admin'
        )
      )
  );
$$;

-- ─── RLS ────────────────────────────────────────────────────────────────────

alter table public.workbooks                enable row level security;
alter table public.workbook_blocks          enable row level security;
alter table public.workbook_sheets          enable row level security;
alter table public.workbook_cells           enable row level security;
alter table public.workbook_checklist_items enable row level security;
alter table public.workbook_comments        enable row level security;
alter table public.workbook_mentions        enable row level security;
alter table public.workbook_activity        enable row level security;
alter table public.workbook_permissions     enable row level security;

-- workbooks: anyone who can view may select; creating requires staff in
-- own DSP; edits require edit access; delete is owner-or-ops.
drop policy if exists "workbooks_select" on public.workbooks;
create policy "workbooks_select" on public.workbooks for select
  using (private.can_view_workbook(id));

drop policy if exists "workbooks_insert" on public.workbooks;
create policy "workbooks_insert" on public.workbooks for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.is_staff(dsp_id, 'dispatcher')
    and (owner_user_id is null or owner_user_id = auth.uid())
  );

drop policy if exists "workbooks_update" on public.workbooks;
create policy "workbooks_update" on public.workbooks for update
  using (private.can_edit_workbook(id))
  with check (dsp_id = private.current_dsp_id());

drop policy if exists "workbooks_delete" on public.workbooks;
create policy "workbooks_delete" on public.workbooks for delete
  using (private.can_admin_workbook(id));

-- Child content tables share one shape: view → select, edit → write.
drop policy if exists "workbook_blocks_select" on public.workbook_blocks;
create policy "workbook_blocks_select" on public.workbook_blocks for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_blocks_write" on public.workbook_blocks;
create policy "workbook_blocks_write" on public.workbook_blocks for all
  using (private.can_edit_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id() and private.can_edit_workbook(workbook_id));

drop policy if exists "workbook_sheets_select" on public.workbook_sheets;
create policy "workbook_sheets_select" on public.workbook_sheets for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_sheets_write" on public.workbook_sheets;
create policy "workbook_sheets_write" on public.workbook_sheets for all
  using (private.can_edit_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id() and private.can_edit_workbook(workbook_id));

drop policy if exists "workbook_cells_select" on public.workbook_cells;
create policy "workbook_cells_select" on public.workbook_cells for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_cells_write" on public.workbook_cells;
create policy "workbook_cells_write" on public.workbook_cells for all
  using (private.can_edit_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id() and private.can_edit_workbook(workbook_id));

drop policy if exists "workbook_checklist_items_select" on public.workbook_checklist_items;
create policy "workbook_checklist_items_select" on public.workbook_checklist_items for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_checklist_items_write" on public.workbook_checklist_items;
create policy "workbook_checklist_items_write" on public.workbook_checklist_items for all
  using (private.can_edit_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id() and private.can_edit_workbook(workbook_id));

-- comments: any viewer can read and add; authors may edit/delete their
-- own; editors may also update (resolve/unresolve any thread).
drop policy if exists "workbook_comments_select" on public.workbook_comments;
create policy "workbook_comments_select" on public.workbook_comments for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_comments_insert" on public.workbook_comments;
create policy "workbook_comments_insert" on public.workbook_comments for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.can_view_workbook(workbook_id)
    and author_user_id = auth.uid()
  );
drop policy if exists "workbook_comments_update" on public.workbook_comments;
create policy "workbook_comments_update" on public.workbook_comments for update
  using (author_user_id = auth.uid() or private.can_edit_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id());
drop policy if exists "workbook_comments_delete" on public.workbook_comments;
create policy "workbook_comments_delete" on public.workbook_comments for delete
  using (author_user_id = auth.uid() or private.can_admin_workbook(workbook_id));

drop policy if exists "workbook_mentions_select" on public.workbook_mentions;
create policy "workbook_mentions_select" on public.workbook_mentions for select
  using (private.can_view_workbook(workbook_id) or mentioned_user_id = auth.uid());
drop policy if exists "workbook_mentions_insert" on public.workbook_mentions;
create policy "workbook_mentions_insert" on public.workbook_mentions for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.can_view_workbook(workbook_id)
    and created_by_user_id = auth.uid()
  );
-- mentioned user may mark their own mention seen
drop policy if exists "workbook_mentions_update" on public.workbook_mentions;
create policy "workbook_mentions_update" on public.workbook_mentions for update
  using (mentioned_user_id = auth.uid())
  with check (mentioned_user_id = auth.uid());

-- activity: append-only. Any viewer can read and append; no update or
-- delete policies exist, so history cannot be rewritten by clients.
drop policy if exists "workbook_activity_select" on public.workbook_activity;
create policy "workbook_activity_select" on public.workbook_activity for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_activity_insert" on public.workbook_activity;
create policy "workbook_activity_insert" on public.workbook_activity for insert
  with check (
    dsp_id = private.current_dsp_id()
    and private.can_view_workbook(workbook_id)
    and (actor_user_id is null or actor_user_id = auth.uid())
  );

-- permissions: viewers can see who has access; only owner/admin/ops may change.
drop policy if exists "workbook_permissions_select" on public.workbook_permissions;
create policy "workbook_permissions_select" on public.workbook_permissions for select
  using (private.can_view_workbook(workbook_id));
drop policy if exists "workbook_permissions_write" on public.workbook_permissions;
create policy "workbook_permissions_write" on public.workbook_permissions for all
  using (private.can_admin_workbook(workbook_id))
  with check (dsp_id = private.current_dsp_id() and private.can_admin_workbook(workbook_id));

-- ─── Grants ─────────────────────────────────────────────────────────────────

grant select, insert, update, delete on public.workbooks                to authenticated;
grant select, insert, update, delete on public.workbook_blocks          to authenticated;
grant select, insert, update, delete on public.workbook_sheets          to authenticated;
grant select, insert, update, delete on public.workbook_cells           to authenticated;
grant select, insert, update, delete on public.workbook_checklist_items to authenticated;
grant select, insert, update, delete on public.workbook_comments        to authenticated;
grant select, insert, update        on public.workbook_mentions         to authenticated;
grant select, insert                on public.workbook_activity         to authenticated;
grant select, insert, update, delete on public.workbook_permissions     to authenticated;

-- ─── Realtime ───────────────────────────────────────────────────────────────
-- Live-collaboration foundation: cell, comment, checklist and activity
-- changes stream to open clients. Presence uses an ephemeral channel
-- (no table needed).

do $$
declare t text;
        tables text[] := array[
          'workbooks',
          'workbook_cells',
          'workbook_comments',
          'workbook_checklist_items',
          'workbook_activity'
        ];
begin
  foreach t in array tables loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null;
    end;
  end loop;
end $$;

notify pgrst, 'reload schema';
