#!/usr/bin/env bash
# ───────────────────────────────────────────────────────────────────────
# Idempotent migration runner.
#
# Supabase's own schema_migrations table has drifted (migrations are applied
# by hand in the SQL editor), so `supabase db push` is unreliable here. This
# runner keeps its OWN ledger in public.rr_migrations and:
#   • ADOPTS every file at/below BASELINE as already-applied (they were run by
#     hand) — recorded, never executed.
#   • APPLIES any file above BASELINE that isn't recorded yet, then records it.
# New migrations (which we author idempotently) therefore apply themselves on
# every deploy, and old ones are never touched.
#
# Requires: SUPABASE_DB_URL (a Postgres connection URI with the DB password —
# use the Session pooler or Direct connection string from Supabase → Settings
# → Database). Safe to run on every deploy; no-ops when nothing is pending.
# ───────────────────────────────────────────────────────────────────────
set -euo pipefail

# Last migration KNOWN applied by hand; <= this is adopted (recorded, never
# executed), > this is run. Kept current per-wave — with the old stale value
# ("0373" while hand-applies reached 0501) enabling the runner would have
# re-executed 130+ migrations, including the deliberately-skipped
# 0432_gcal_two_way_sync (whose content now ships as 0505; adopting 0432
# below is CORRECT — never re-run the 0432 FILE).
BASELINE="0503"

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL not set — skipping auto-apply (add the secret to enable it)."
  exit 0
fi

run()  { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA "$@"; }
runf() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1     -f "$1"; }

# Ledger lives in the PRIVATE schema (project-review PR#48): public.
# rr_migrations was reachable through PostgREST with no RLS the moment
# SUPABASE_DB_URL is configured — and a deleted ledger row would cause
# re-application of that migration on the next deploy. Migrates any
# legacy public-schema ledger rows across, then drops the exposed table.
run -c "create schema if not exists private;" >/dev/null
run -c "create table if not exists private.rr_migrations (
          filename text primary key,
          applied_at timestamptz not null default now());" >/dev/null
run -c "do \$\$ begin
          if exists (select 1 from pg_tables where schemaname='public' and tablename='rr_migrations') then
            insert into private.rr_migrations(filename, applied_at)
              select filename, applied_at from public.rr_migrations
              on conflict (filename) do nothing;
            drop table public.rr_migrations;
          end if;
        end \$\$;" >/dev/null

applied=0
for f in $(ls supabase/migrations/*.sql | sort); do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ "$(run -c "select 1 from private.rr_migrations where filename='${base}'")" = "1" ]; then
    continue
  fi
  if [[ "$num" < "$BASELINE" || "$num" == "$BASELINE" ]]; then
    echo "adopt  $base"
    run -c "insert into private.rr_migrations(filename) values ('${base}') on conflict do nothing;" >/dev/null
  else
    echo "APPLY  $base"
    runf "$f"
    run -c "insert into private.rr_migrations(filename) values ('${base}');" >/dev/null
    applied=$((applied+1))
  fi
done

echo "migrations up to date (${applied} newly applied)"
