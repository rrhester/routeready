-- ─────────────────────────────────────────────────────────────────────────
-- pgTAP test · Phase 7 finance
-- Invoice import, line items, dispute filing, resolution, roll-up trigger.
-- ─────────────────────────────────────────────────────────────────────────

begin;
select plan(10);

create extension if not exists pgtap;

-- ─── Setup ────────────────────────────────────────────────────────────

insert into public.dsps (id, name, slug)
values ('aaee2200-0000-0000-0000-000000000001', 'Finance Test DSP', 'fin-test');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at,
                        raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                        confirmation_token, recovery_token, email_change_token_new, email_change)
values
  ('aaee2200-0000-0000-0000-aaaaaaaaaaaa',
   '00000000-0000-0000-0000-000000000000','authenticated','authenticated',
   'fin-ops@test.test', now(), '{}'::jsonb, '{}'::jsonb,
   now(), now(), '', '', '', '');

insert into public.app_users (id, dsp_id, role, email) values
  ('aaee2200-0000-0000-0000-aaaaaaaaaaaa',
   'aaee2200-0000-0000-0000-000000000001', 'ops', 'fin-ops@test.test');

create or replace function pg_temp.act_as_ops()
returns void language plpgsql as $$ begin
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub','aaee2200-0000-0000-0000-aaaaaaaaaaaa',
                       'dsp_id','aaee2200-0000-0000-0000-000000000001',
                       'role','ops')::text, true);
  perform set_config('role','authenticated', true);
end $$;

-- ─── Import invoice + lines ──────────────────────────────────────────

select pg_temp.act_as_ops();

-- 1. import_invoice creates invoice + lines
do $$
declare v_id uuid;
begin
  v_id := public.import_invoice(
    'amazon_variable',
    current_date - 14, current_date - 1,
    'INV-2026-001',
    1850000,                       -- $18,500
    null, null,
    '[
      {"line_number":1,"description":"Damages — Driver Davidson","amount_cents":250000,"category":"damages"},
      {"line_number":2,"description":"Late returns ×3","amount_cents":75000,"category":"late_returns"},
      {"line_number":3,"description":"Scan compliance miss","amount_cents":120000,"category":"scan_compliance"}
    ]'::jsonb,
    'Amazon Logistics'
  );
end $$;

select is(
  (select count(*) from public.invoices
    where dsp_id = 'aaee2200-0000-0000-0000-000000000001'),
  1::bigint,
  'import_invoice creates 1 invoice');

-- 2. Lines created
select is(
  (select count(*) from public.invoice_line_items
    where dsp_id = 'aaee2200-0000-0000-0000-000000000001'),
  3::bigint,
  '3 line items created');

-- 3. Total billed matches input
select is(
  (select amount_billed_cents from public.invoices
    where dsp_id = 'aaee2200-0000-0000-0000-000000000001'),
  1850000,
  'amount_billed_cents = $18,500');

-- ─── Flag + file dispute ─────────────────────────────────────────────

-- 4. Flag the damages line
do $$
declare v_line uuid;
begin
  select id into v_line from public.invoice_line_items
   where category = 'damages' limit 1;
  perform public.flag_invoice_line(
    v_line, true,
    '{"rule":"damage_at_fault","match":false,"actual":"Third-party fault per dashcam","expected":"Driver fault"}'::jsonb
  );
end $$;

select is(
  (select flagged from public.invoice_line_items where category = 'damages'),
  true,
  'Line flagged after flag_invoice_line');

-- 5. file_dispute creates dispute row + marks line disputed
do $$
declare v_line uuid;
begin
  select id into v_line from public.invoice_line_items
   where category = 'damages' limit 1;
  perform public.file_dispute(
    (select id from public.invoices limit 1),
    v_line, 250000,
    'Disputing damages charge: dashcam shows third-party at fault. Telematics confirms vehicle was stationary at incident time.',
    '{"dashcam_clip":"dc-001","telematics":"tlm-001"}'::jsonb,
    array['/storage/dashcam/dc-001.mp4']
  );
end $$;

select is(
  (select count(*) from public.disputes
    where dsp_id = 'aaee2200-0000-0000-0000-000000000001'),
  1::bigint,
  'Dispute row created');

-- 6. Line marked disputed
select is(
  (select disputed from public.invoice_line_items where category = 'damages'),
  true,
  'Line marked disputed=true');

-- 7. Roll-up trigger updated invoice.amount_disputed
select is(
  (select amount_disputed_cents from public.invoices limit 1),
  250000,
  'invoices.amount_disputed_cents updated by roll-up trigger');

-- 8. Invoice status flipped to 'disputed'
select is(
  (select status::text from public.invoices limit 1),
  'disputed',
  'Invoice status flipped to disputed');

-- ─── Resolve dispute ──────────────────────────────────────────────────

-- 9. resolve_dispute with 'won' updates recovered + invoice rolls up
do $$
declare v_d uuid;
begin
  select id into v_d from public.disputes limit 1;
  perform public.resolve_dispute(v_d, 'won', 250000, 'Amazon credited full amount');
end $$;

select is(
  (select amount_recovered_cents from public.invoices limit 1),
  250000,
  'invoices.amount_recovered_cents updated after resolve_dispute');

-- 10. Status flipped to 'closed' (no more pending)
select is(
  (select status::text from public.invoices limit 1),
  'closed',
  'Invoice status = closed when no pending disputes + recovery exists');

-- ─── Wrap up ──────────────────────────────────────────────────────────

select * from finish();
rollback;
