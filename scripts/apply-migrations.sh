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

BASELINE="0373"   # last migration applied by hand; <= this is adopted, > this is run

if [ -z "${SUPABASE_DB_URL:-}" ]; then
  echo "SUPABASE_DB_URL not set — skipping auto-apply (add the secret to enable it)."
  exit 0
fi

run()  { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -tA "$@"; }
runf() { psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1     -f "$1"; }

run -c "create table if not exists public.rr_migrations (
          filename text primary key,
          applied_at timestamptz not null default now());" >/dev/null

applied=0
for f in $(ls supabase/migrations/*.sql | sort); do
  base="$(basename "$f")"
  num="${base%%_*}"
  if [ "$(run -c "select 1 from public.rr_migrations where filename='${base}'")" = "1" ]; then
    continue
  fi
  if [[ "$num" < "$BASELINE" || "$num" == "$BASELINE" ]]; then
    echo "adopt  $base"
    run -c "insert into public.rr_migrations(filename) values ('${base}') on conflict do nothing;" >/dev/null
  else
    echo "APPLY  $base"
    runf "$f"
    run -c "insert into public.rr_migrations(filename) values ('${base}');" >/dev/null
    applied=$((applied+1))
  fi
done

echo "migrations up to date (${applied} newly applied)"
