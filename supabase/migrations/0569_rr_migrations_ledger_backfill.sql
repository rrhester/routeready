-- 0569_rr_migrations_ledger_backfill.sql
--
-- (First shipped as 0568_… and renumbered same-day: a concurrently merged
-- fleet PR took ordinal 0568 for 0568_dvic_odometer_capture.sql. This file
-- retires any ledger row recorded under the old name and probes the DVIC
-- migration alongside the historical range.)
--
-- The private.rr_migrations ledger (0504) only advances when a migration
-- records itself — and every migration from 0506 through 0567 shipped
-- WITHOUT the self-record insert. So on a by-hand-applied database,
-- rr_schema_version() has reported 0505 forever, no matter how much newer
-- SQL was actually pasted, and the dashboard's "database is behind this
-- app" banner can neither clear nor tell you what is genuinely missing.
--
-- This migration makes the ledger honest again:
--   * For each migration 0506–0568 it probes the catalogs for positive
--     evidence that the migration's objects are actually present (a table,
--     index, trigger, enum value, function signature, or a distinctive
--     token in a function body for create-or-replace re-issues), and
--     records ONLY what it detects. Nothing is blindly assumed applied.
--   * Two migrations are drop-only (0562, 0567 — they remove storage
--     policies) and leave no positive evidence; they are reported but NOT
--     recorded. Re-run those two files once — like every migration file
--     from 0506 on, they now end with a self-record block, so re-running
--     records them. (Re-running any migration here is safe; they are all
--     idempotent.)
--   * Ordinals 0545–0559 were never used (parallel-session renumbering
--     gap) — there are no such files, nothing to record.
--
-- The final statement returns a per-migration report: what was detected
-- (and is now recorded) and what was not, so the SQL Editor shows exactly
-- which files still need to be pasted.
--
-- Notes on detection fidelity:
--   * For re-issued functions the newest re-issue keeps its predecessors'
--     distinctive tokens (verified against the repo), so "0519 detected"
--     can also mean "0534's superseding body is in place" — functionally
--     equivalent for the ledger's purpose.
--   * 0509 re-asserts 0484/0481 content on DBs that skipped them; its
--     signature (channel_polls) is unique to 0509 itself.
--
-- Idempotent: pure inserts guarded by `on conflict do nothing`; the temp
-- helper functions live in pg_temp and vanish with the session.

-- ── Session-scoped detection helpers ────────────────────────────────────

create or replace function pg_temp.rr_has_fn(p_schema text, p_fn text)
returns boolean language sql stable as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = p_schema and p.proname = p_fn
  );
$$;

create or replace function pg_temp.rr_fn_body_has(p_schema text, p_fn text, p_needle text)
returns boolean language sql stable as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = p_schema and p.proname = p_fn
      and p.prosrc like '%' || p_needle || '%'
  );
$$;

create or replace function pg_temp.rr_fn_min_args(p_schema text, p_fn text, p_min int)
returns boolean language sql stable as $$
  select exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = p_schema and p.proname = p_fn and p.pronargs >= p_min
  );
$$;

create or replace function pg_temp.rr_has_col(p_table text, p_col text)
returns boolean language sql stable as $$
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = p_table and column_name = p_col
  );
$$;

create or replace function pg_temp.rr_has_trigger(p_trigger text)
returns boolean language sql stable as $$
  select exists (select 1 from pg_trigger where tgname = p_trigger and not tgisinternal);
$$;

create or replace function pg_temp.rr_has_enum_value(p_type text, p_label text)
returns boolean language sql stable as $$
  select exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = p_type and e.enumlabel = p_label
  );
$$;

-- ── Detect, record, and report ──────────────────────────────────────────

-- Renumber healing: if the earlier paste of this file (as 0568_…) was run,
-- retire its ledger row so ordinal 0568 unambiguously means the DVIC file.
delete from private.rr_migrations
 where filename = '0568_rr_migrations_ledger_backfill.sql';

with candidate(filename, applied, evidence) as (values
  ('0506_chat_templates.sql',
     to_regclass('public.dispatch_chat_templates') is not null,
     'table dispatch_chat_templates'),
  ('0507_chat_replies_reactions_pins_history.sql',
     to_regclass('public.driver_message_pins') is not null,
     'table driver_message_pins'),
  ('0508_thread_prefs.sql',
     to_regclass('public.dispatch_thread_prefs') is not null,
     'table dispatch_thread_prefs'),
  ('0509_channel_upgrades.sql',
     to_regclass('public.channel_polls') is not null,
     'table channel_polls'),
  ('0510_msg_notifications.sql',
     to_regclass('public.dispatch_operator_msg_prefs') is not null,
     'table dispatch_operator_msg_prefs'),
  ('0511_msg_admin_compliance.sql',
     pg_temp.rr_has_fn('public', 'dispatch_msg_audit'),
     'function dispatch_msg_audit'),
  ('0512_swap_offer_dispatcher_visibility.sql',
     pg_temp.rr_has_trigger('trg_shift_offers_response_notify'),
     'trigger trg_shift_offers_response_notify'),
  ('0513_okami_demand_audit.sql',
     pg_temp.rr_has_fn('public', 'okami_demand_audit'),
     'function okami_demand_audit'),
  ('0514_notebook_comment_edited_at.sql',
     pg_temp.rr_has_col('notebook_comments', 'edited_at'),
     'column notebook_comments.edited_at'),
  ('0515_notebook_comment_reactions.sql',
     to_regclass('public.notebook_comment_reactions') is not null,
     'table notebook_comment_reactions'),
  ('0516_notebook_backlink_snippet.sql',
     pg_temp.rr_has_fn('private', 'notebook_link_snippet'),
     'function private.notebook_link_snippet'),
  ('0517_notebook_mention_notifications.sql',
     to_regclass('public.notebook_mention_notifications') is not null,
     'table notebook_mention_notifications'),
  ('0518_xl_helper_seats.sql',
     pg_temp.rr_fn_body_has('private', 'generate_shifts', 'helper'),
     'generate_shifts body mentions helper seats'),
  ('0519_xl_helper_cushion.sql',
     pg_temp.rr_fn_body_has('public', 'apply_cushion_to_week', 'target_helper_cushion'),
     'apply_cushion_to_week body sizes a helper cushion'),
  ('0520_helper_seat_cert_exemption.sql',
     pg_temp.rr_fn_body_has('private', 'driver_can_take_shift', 'helper'),
     'driver_can_take_shift body exempts helper seats'),
  ('0521_helper_van_inheritance.sql',
     pg_temp.rr_fn_body_has('public', 'driver_vehicle_days', 'helper'),
     'driver_vehicle_days body mirrors the paired van'),
  ('0522_helper_not_a_route.sql',
     pg_temp.rr_fn_body_has('public', 'okami_grid', 'helper'),
     'okami_grid body excludes helper seats from filled'),
  ('0523_helper_service_type_pairs.sql',
     pg_temp.rr_fn_body_has('private', 'generate_shifts', '''HELPER'''),
     'generate_shifts body pairs the HELPER service type'),
  ('0524_helper_no_van_compliance.sql',
     pg_temp.rr_fn_body_has('public', 'compliance_workspace_bundle', 'helper'),
     'compliance_workspace_bundle body skips helper seats'),
  ('0525_driver_stations.sql',
     to_regclass('public.driver_stations') is not null,
     'table driver_stations'),
  ('0526_today_plan_station_scope.sql',
     pg_temp.rr_fn_min_args('public', 'today_plan', 1),
     'today_plan takes p_station_id'),
  ('0527_referral_program_persistence.sql',
     pg_temp.rr_fn_body_has('public', 'referral_settings_save', 'program_enabled'),
     'referral_settings_save body persists program_enabled'),
  ('0528_interview_roster_station.sql',
     pg_temp.rr_fn_body_has('public', 'interview_day_roster', 'station_code'),
     'interview_day_roster body returns station_code'),
  ('0529_vehicles_list_station.sql',
     pg_temp.rr_fn_body_has('public', 'vehicles_list', 'station_code'),
     'vehicles_list body returns station_code'),
  ('0530_repair_summary_station_scope.sql',
     pg_temp.rr_fn_min_args('public', 'repair_center_summary', 1),
     'repair_center_summary takes p_station_id'),
  ('0531_active_drivers_station_scope.sql',
     pg_temp.rr_fn_min_args('public', 'active_drivers_for_horizon', 3),
     'active_drivers_for_horizon takes p_station_id'),
  ('0532_driver_stations_sync.sql',
     pg_temp.rr_has_trigger('trg_sync_driver_station_membership'),
     'trigger trg_sync_driver_station_membership'),
  ('0533_shift_station_membership.sql',
     pg_temp.rr_has_trigger('trg_sync_shift_station_membership'),
     'trigger trg_sync_shift_station_membership'),
  ('0534_cushion_apportioned_to_plan.sql',
     pg_temp.rr_fn_body_has('public', 'apply_cushion_to_week', 'largest remainder'),
     'apply_cushion_to_week body apportions by largest remainder'),
  ('0535_email_read_state.sql',
     to_regclass('public.email_messages_unread_idx') is not null,
     'index email_messages_unread_idx'),
  ('0536_email_star_snooze_meta.sql',
     to_regclass('public.email_messages_starred_idx') is not null,
     'index email_messages_starred_idx'),
  ('0537_email_composer_drafts_bcc.sql',
     pg_temp.rr_has_enum_value('message_status', 'draft'),
     'message_status enum has draft'),
  ('0538_email_send_after_importance.sql',
     to_regclass('public.email_messages_queued_idx') is not null,
     'index email_messages_queued_idx'),
  ('0539_fleet_inventory_foundation.sql',
     pg_temp.rr_has_col('vehicles', 'fuel_type'),
     'column vehicles.fuel_type'),
  ('0540_parts_stock_inventory.sql',
     to_regclass('public.parts_stock_items') is not null,
     'table parts_stock_items'),
  ('0541_email_search_and_rules.sql',
     to_regclass('public.email_rules') is not null,
     'table email_rules'),
  ('0542_email_folder_counts_trash_purge.sql',
     pg_temp.rr_has_fn('public', 'email_folder_unread_counts'),
     'function email_folder_unread_counts'),
  ('0543_email_thread_headers.sql',
     to_regclass('public.email_messages_in_reply_to_idx') is not null,
     'index email_messages_in_reply_to_idx'),
  ('0544_email_inbound_hardening.sql',
     to_regclass('public.email_dead_letters') is not null,
     'table email_dead_letters'),
  ('0560_edv_and_license_buffer_gates.sql',
     pg_temp.rr_fn_body_has('private', 'driver_can_take_shift', 'requires_edv'),
     'driver_can_take_shift body gates requires_edv'),
  ('0561_driver_file_ownership.sql',
     pg_temp.rr_has_fn('public', 'driver_can_read_file'),
     'function driver_can_read_file'),
  ('0562_drop_anon_storage_reads.sql',
     false,
     'undetectable: drop-only (storage policies) — re-run the file to record it'),
  ('0563_driver_schedule_publish_gate.sql',
     pg_temp.rr_has_fn('public', 'get_publish_gate_settings'),
     'function get_publish_gate_settings'),
  ('0564_rpc_role_gates.sql',
     pg_temp.rr_fn_body_has('public', 'coaching_archive', 'is_staff'),
     'coaching_archive body role-gated via is_staff'),
  ('0565_mfa_server_enforcement.sql',
     pg_temp.rr_has_fn('private', 'mfa_ok'),
     'function private.mfa_ok'),
  ('0566_vehicle_vin_dedup.sql',
     pg_temp.rr_has_trigger('trg_vehicles_no_dup_vin'),
     'trigger trg_vehicles_no_dup_vin'),
  ('0567_drop_receipts_anon_read.sql',
     false,
     'undetectable: drop-only (storage policy) — re-run the file to record it'),
  ('0568_dvic_odometer_capture.sql',
     pg_temp.rr_has_trigger('vehicle_inspections_log_mileage'),
     'trigger vehicle_inspections_log_mileage'),
  ('0569_rr_migrations_ledger_backfill.sql',
     true,
     'this migration')
),
ins as (
  insert into private.rr_migrations (filename)
  select filename from candidate where applied
  on conflict (filename) do nothing
  returning filename
)
select c.filename,
       case
         when c.applied then 'detected — recorded'
         when c.evidence like 'undetectable%' then 'cannot auto-detect — re-run the file once to record it'
         else 'NOT detected — paste this migration file (it now self-records)'
       end as ledger_status,
       c.evidence
from candidate c
order by c.filename;
