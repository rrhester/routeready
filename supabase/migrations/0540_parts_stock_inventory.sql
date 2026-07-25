-- Migration 0540 · Parts stock inventory (the parts room)
--
-- Parts Intelligence (0485) is a SOURCING system — search, compare,
-- purchase. Nothing tracks what's actually on the shelf. This adds the
-- on-hand side: stock items with bins, min-quantity reorder points and
-- a moving-average unit cost, plus an append-only movement ledger
-- (receive / consume / return / adjust) that is the ONLY way quantity
-- changes. Consumption can link a vehicle and/or repair case, so parts
-- pulled for a job show up in that van's cost history.
--
-- Conventions: dsp_id tenancy, integer cents, staff (dispatcher+)
-- writes, security-definer RPCs with their own is_staff guard.
-- Idempotent — safe to re-run. Requires 0485 (canonical_parts) and
-- 0486 (repair_cases) for the soft FKs, both long-applied.

create table if not exists public.parts_stock_items (
  id                uuid        primary key default gen_random_uuid(),
  dsp_id            uuid        not null references public.dsps(id) on delete cascade,
  canonical_part_id uuid        references public.canonical_parts(id) on delete set null,
  name              text        not null,
  part_number       text,
  category          text,
  bin_location      text,
  station_id        uuid        references public.stations(id) on delete set null,
  qty_on_hand       int         not null default 0 check (qty_on_hand >= 0),
  min_qty           int         check (min_qty is null or min_qty >= 0),
  unit_cost_cents   int         check (unit_cost_cents is null or unit_cost_cents >= 0),
  active            boolean     not null default true,
  notes             text,
  created_by        uuid        references auth.users(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists parts_stock_items_dsp_idx
  on public.parts_stock_items (dsp_id, active, name);

create table if not exists public.parts_stock_movements (
  id              uuid        primary key default gen_random_uuid(),
  dsp_id          uuid        not null references public.dsps(id) on delete cascade,
  item_id         uuid        not null references public.parts_stock_items(id) on delete cascade,
  kind            text        not null check (kind in ('receive','consume','return','adjust')),
  qty_delta       int         not null check (qty_delta <> 0),
  unit_cost_cents int         check (unit_cost_cents is null or unit_cost_cents >= 0),
  vehicle_id      uuid        references public.vehicles(id) on delete set null,
  repair_case_id  uuid        references public.repair_cases(id) on delete set null,
  note            text,
  created_by      uuid        references auth.users(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index if not exists parts_stock_movements_item_idx
  on public.parts_stock_movements (item_id, created_at desc);
create index if not exists parts_stock_movements_vehicle_idx
  on public.parts_stock_movements (vehicle_id, created_at desc);

alter table public.parts_stock_items     enable row level security;
alter table public.parts_stock_movements enable row level security;

drop policy if exists parts_stock_items_tenant_select on public.parts_stock_items;
create policy parts_stock_items_tenant_select
  on public.parts_stock_items for select
  using (dsp_id = private.current_dsp_id());
-- Writes go through the security-definer RPCs ONLY (they run as the
-- table owner and bypass RLS). No client-facing write policy and no
-- write grants — a dispatcher hitting PostgREST directly could
-- otherwise set qty_on_hand without a movement or delete an item and
-- cascade its ledger, defeating the append-only invariant
-- (Codex review, PR #4124).
drop policy if exists parts_stock_items_staff_write on public.parts_stock_items;
drop policy if exists parts_stock_movements_staff_insert on public.parts_stock_movements;

drop policy if exists parts_stock_movements_tenant_select on public.parts_stock_movements;
create policy parts_stock_movements_tenant_select
  on public.parts_stock_movements for select
  using (dsp_id = private.current_dsp_id());

revoke insert, update, delete on public.parts_stock_items     from authenticated;
revoke insert, update, delete on public.parts_stock_movements from authenticated;
grant select on public.parts_stock_items     to authenticated;
grant select on public.parts_stock_movements to authenticated;


-- ── parts_stock_item_save — create/edit the descriptive fields ──────
-- Quantity is NOT editable here: it only moves through
-- parts_stock_move(), so the ledger always explains the shelf count.
-- p_initial_qty (create only) books the opening balance as a
-- 'receive' movement.
create or replace function public.parts_stock_item_save(
  p_id                uuid    default null,
  p_name              text    default null,
  p_part_number       text    default null,
  p_category          text    default null,
  p_bin_location      text    default null,
  p_station_id        uuid    default null,
  p_min_qty           int     default null,
  p_unit_cost_cents   int     default null,
  p_active            boolean default true,
  p_notes             text    default null,
  p_canonical_part_id uuid    default null,
  p_initial_qty       int     default null
) returns public.parts_stock_items
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_row public.parts_stock_items;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'name_required' using errcode = '22023'; end if;
  if p_min_qty is not null and p_min_qty < 0 then raise exception 'bad_min_qty' using errcode = '22023'; end if;
  if p_unit_cost_cents is not null and p_unit_cost_cents < 0 then raise exception 'bad_cost' using errcode = '22023'; end if;
  if p_initial_qty is not null and p_initial_qty < 0 then raise exception 'bad_qty' using errcode = '22023'; end if;

  if p_id is null then
    insert into public.parts_stock_items
      (dsp_id, canonical_part_id, name, part_number, category, bin_location,
       station_id, qty_on_hand, min_qty, unit_cost_cents, active, notes, created_by)
    values
      (v_dsp, p_canonical_part_id, trim(p_name),
       nullif(trim(coalesce(p_part_number,'')), ''),
       nullif(trim(coalesce(p_category,'')), ''),
       nullif(trim(coalesce(p_bin_location,'')), ''),
       p_station_id,
       coalesce(p_initial_qty, 0), p_min_qty, p_unit_cost_cents,
       coalesce(p_active, true), nullif(trim(coalesce(p_notes,'')), ''), auth.uid())
    returning * into v_row;

    if coalesce(p_initial_qty, 0) > 0 then
      insert into public.parts_stock_movements
        (dsp_id, item_id, kind, qty_delta, unit_cost_cents, note, created_by)
      values
        (v_dsp, v_row.id, 'receive', p_initial_qty, p_unit_cost_cents,
         'Opening balance', auth.uid());
    end if;
  else
    update public.parts_stock_items set
      canonical_part_id = p_canonical_part_id,
      name              = trim(p_name),
      part_number       = nullif(trim(coalesce(p_part_number,'')), ''),
      category          = nullif(trim(coalesce(p_category,'')), ''),
      bin_location      = nullif(trim(coalesce(p_bin_location,'')), ''),
      station_id        = p_station_id,
      min_qty           = p_min_qty,
      unit_cost_cents   = coalesce(p_unit_cost_cents, unit_cost_cents),
      active            = coalesce(p_active, true),
      notes             = nullif(trim(coalesce(p_notes,'')), ''),
      updated_at        = now()
    where id = p_id and dsp_id = v_dsp
    returning * into v_row;
    if v_row.id is null then raise exception 'item_not_found' using errcode = 'P0002'; end if;
  end if;
  return v_row;
end;
$$;
grant execute on function public.parts_stock_item_save(
  uuid, text, text, text, text, uuid, int, int, boolean, text, uuid, int
) to authenticated;


-- ── parts_stock_move — the ONLY quantity writer ─────────────────────
--   receive: +qty (moving-average unit cost when a cost is given)
--   return:  +qty (part came back off a job; cost unchanged)
--   consume: -qty (refuses to go below zero)
--   adjust:  p_qty is the NEW ABSOLUTE count (cycle count / correction)
create or replace function public.parts_stock_move(
  p_item_id         uuid,
  p_kind            text,
  p_qty             int,
  p_unit_cost_cents int  default null,
  p_vehicle_id      uuid default null,
  p_repair_case_id  uuid default null,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_item public.parts_stock_items;
  v_delta int;
  v_new_qty int;
  v_new_cost int;
  v_mv public.parts_stock_movements;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_kind, '') not in ('receive','consume','return','adjust') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if p_qty is null or (p_kind <> 'adjust' and p_qty <= 0) or (p_kind = 'adjust' and p_qty < 0) then
    raise exception 'bad_qty' using errcode = '22023';
  end if;
  if p_unit_cost_cents is not null and p_unit_cost_cents < 0 then
    raise exception 'bad_cost' using errcode = '22023';
  end if;

  select * into v_item
    from public.parts_stock_items
   where id = p_item_id and dsp_id = v_dsp
   for update;
  if v_item.id is null then raise exception 'item_not_found' using errcode = 'P0002'; end if;

  if p_vehicle_id is not null
     and not exists (select 1 from public.vehicles v where v.id = p_vehicle_id and v.dsp_id = v_dsp) then
    raise exception 'vehicle_not_found' using errcode = 'P0002';
  end if;
  -- Repair-case link must be this tenant's case, and when both a van
  -- and a case are given the case must be for that van (or have no van
  -- on file) — cross-attribution corrupts both ledgers.
  if p_repair_case_id is not null
     and not exists (
       select 1 from public.repair_cases rc
       where rc.id = p_repair_case_id and rc.dsp_id = v_dsp
         and (p_vehicle_id is null or rc.vehicle_id is null or rc.vehicle_id = p_vehicle_id)
     ) then
    raise exception 'case_not_found' using errcode = 'P0002';
  end if;

  v_delta := case p_kind
    when 'receive' then p_qty
    when 'return'  then p_qty
    when 'consume' then -p_qty
    else p_qty - v_item.qty_on_hand   -- adjust: to the new absolute count
  end;
  if v_delta = 0 then
    raise exception 'no_change' using errcode = '22023';
  end if;

  v_new_qty := v_item.qty_on_hand + v_delta;
  if v_new_qty < 0 then
    raise exception 'insufficient_stock' using errcode = '22023';
  end if;

  -- Moving-average cost: only a costed receive shifts it.
  v_new_cost := v_item.unit_cost_cents;
  if p_kind = 'receive' and p_unit_cost_cents is not null then
    if v_item.unit_cost_cents is null or v_item.qty_on_hand <= 0 then
      v_new_cost := p_unit_cost_cents;
    else
      v_new_cost := round(
        (v_item.qty_on_hand::numeric * v_item.unit_cost_cents + p_qty::numeric * p_unit_cost_cents)
        / (v_item.qty_on_hand + p_qty))::int;
    end if;
  end if;

  update public.parts_stock_items
     set qty_on_hand     = v_new_qty,
         unit_cost_cents = v_new_cost,
         updated_at      = now()
   where id = v_item.id;

  -- Consume/return movements snapshot the item's moving-average unit
  -- cost when no explicit cost is given, so vehicle_cost_summary can
  -- price the parts pulled for a van (Codex review, PR #4124).
  insert into public.parts_stock_movements
    (dsp_id, item_id, kind, qty_delta, unit_cost_cents,
     vehicle_id, repair_case_id, note, created_by)
  values
    (v_dsp, v_item.id, p_kind, v_delta,
     coalesce(p_unit_cost_cents,
              case when p_kind in ('consume','return') then v_item.unit_cost_cents end),
     p_vehicle_id, p_repair_case_id, nullif(trim(coalesce(p_note,'')), ''), auth.uid())
  returning * into v_mv;

  return jsonb_build_object(
    'item_id',      v_item.id,
    'qty_on_hand',  v_new_qty,
    'unit_cost_cents', v_new_cost,
    'movement_id',  v_mv.id
  );
end;
$$;
grant execute on function public.parts_stock_move(
  uuid, text, int, int, uuid, uuid, text
) to authenticated;


-- ── parts_stock_list — items + low-stock flags + summary ────────────
-- Station lens: station-tied items show under their station's scope;
-- items with no station (the shared parts room) show in every scope —
-- same convention as DSP-wide message channels.
create or replace function public.parts_stock_list(
  p_station_id       uuid    default null,
  p_include_inactive boolean default false
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_dsp uuid := private.current_dsp_id();
  v_items jsonb;
  v_summary jsonb;
begin
  if not private.is_staff(v_dsp, 'dispatcher') then raise exception 'forbidden' using errcode = '42501'; end if;

  select
    coalesce(jsonb_agg(srow order by srow->>'name'), '[]'::jsonb),
    jsonb_build_object(
      'items',            count(*),
      'low_stock_count',  count(*) filter (where (srow->>'low_stock')::boolean),
      'total_value_cents', coalesce(sum((srow->>'value_cents')::bigint), 0)
    )
  into v_items, v_summary
  from (
    select jsonb_build_object(
      'id', i.id,
      'canonical_part_id', i.canonical_part_id,
      'name', i.name,
      'part_number', i.part_number,
      'category', i.category,
      'bin_location', i.bin_location,
      'station_id', i.station_id,
      'station_code', st.code,
      'qty_on_hand', i.qty_on_hand,
      'min_qty', i.min_qty,
      'unit_cost_cents', i.unit_cost_cents,
      'value_cents', coalesce(i.qty_on_hand::bigint * i.unit_cost_cents, 0),
      'low_stock', (i.min_qty is not null and i.qty_on_hand <= i.min_qty),
      'active', i.active,
      'notes', i.notes,
      'last_movement_at', lm.created_at,
      'updated_at', i.updated_at
    ) as srow
    from public.parts_stock_items i
    left join public.stations st on st.id = i.station_id
    left join lateral (
      select m.created_at
      from public.parts_stock_movements m
      where m.item_id = i.id
      order by m.created_at desc
      limit 1
    ) lm on true
    where i.dsp_id = v_dsp
      and (p_include_inactive or i.active)
      and (p_station_id is null or i.station_id is null or i.station_id = p_station_id)
  ) t;

  return jsonb_build_object(
    'items',   v_items,
    'summary', coalesce(v_summary, jsonb_build_object(
                 'items',0,'low_stock_count',0,'total_value_cents',0)),
    'generated_at', now()
  );
end;
$$;
grant execute on function public.parts_stock_list(uuid, boolean) to authenticated;


-- ── parts_stock_movements_list — one item's ledger ──────────────────
create or replace function public.parts_stock_movements_list(
  p_item_id uuid,
  p_limit   int default 50
) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(mrow), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id', m.id,
      'kind', m.kind,
      'qty_delta', m.qty_delta,
      'unit_cost_cents', m.unit_cost_cents,
      'vehicle_id', m.vehicle_id,
      'vehicle_name', v.name,
      'repair_case_id', m.repair_case_id,
      'note', m.note,
      'created_at', m.created_at
    ) as mrow
    from public.parts_stock_movements m
    join public.parts_stock_items i on i.id = m.item_id
    left join public.vehicles v on v.id = m.vehicle_id
    where m.item_id = p_item_id
      and i.dsp_id = private.current_dsp_id()
      and private.is_staff(i.dsp_id, 'dispatcher')
    order by m.created_at desc
    limit greatest(coalesce(p_limit, 50), 1)
  ) t;
$$;
grant execute on function public.parts_stock_movements_list(uuid, int) to authenticated;


notify pgrst, 'reload schema';

-- Self-record in the migration ledger (private.rr_migrations, 0504) so
-- rr_schema_version() and the dashboard schema banner track by-hand pastes.
-- No-op on a DB that predates 0504.
do $$
begin
  if to_regclass('private.rr_migrations') is not null then
    insert into private.rr_migrations (filename)
    values ('0540_parts_stock_inventory.sql')
    on conflict (filename) do nothing;
  end if;
end $$;
