-- ─────────────────────────────────────────────────────────────────────────
-- Migration 0000 · Bootstrap platform extensions
--
-- Several later migrations USE Postgres extensions before any migration
-- CREATES them, so the set cannot be rebuilt from scratch:
--
--   • pg_cron (cron.schedule / cron.unschedule) is first used in
--     0007_immediate_send_triggers.sql but not created until
--     0246_dvic_ai_sweep.sql.
--   • pg_net  (net.http_post / net.http_get) is first used in
--     0007 / 0008 but not created until 0155_documents_sealing_trigger.sql.
--
-- On the production project these extensions were enabled by hand early on,
-- so the ordering drift never surfaced there. But a from-scratch rebuild —
-- disaster recovery, or standing up a fresh staging / tenant project —
-- fails at 0007 with `schema "cron" does not exist`. This migration enables
-- them first so the migration set is self-contained and rebuildable, which
-- the migration-check CI gate verifies on every PR.
--
-- Sorts before 0001 (so it runs first on a clean apply) and is below the
-- apply-migrations.sh baseline (0373), so on production it is simply adopted
-- into the ledger without running — the extensions already exist there.
-- Every statement is `if not exists`, so re-running is a no-op everywhere.
-- ─────────────────────────────────────────────────────────────────────────

create extension if not exists pgcrypto;
create extension if not exists pg_net;
create extension if not exists pg_cron with schema cron;
