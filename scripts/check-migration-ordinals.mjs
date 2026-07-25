#!/usr/bin/env node
// Blocks NEW duplicate migration ordinals (project-review PR#45), and
// requires every migration from 0506 on to SELF-RECORD in the
// private.rr_migrations ledger (see below).
//
// supabase/migrations/ has 31 historically duplicated 4-digit prefixes
// (two 0492s, two 0500s, three 0439s, …). Those are grandfathered — prod
// applies by full filename, so they work — but every new collision is a
// live hazard: the operator applies migrations by hand in the SQL Editor
// and tracks progress by ordinal, so "0432 applied" is ambiguous when two
// 0432s exist. That exact ambiguity is the most likely cause of the known
// 0432 skip (0432_gcal_two_way_sync vs 0432_team_tasks).
//
// Rule: a PR may not introduce a duplicate prefix beyond the frozen list
// below, and may not deepen an existing collision. New migrations take
// the next unused ordinal. Do NOT add entries to the frozen list — it
// exists only to grandfather history.
//
//   node scripts/check-migration-ordinals.mjs

import fs from "node:fs";
import path from "node:path";

const dir = path.join(import.meta.dirname, "..", "supabase", "migrations");

// prefix → number of files, frozen 2026-07-17. Never grow this.
const FROZEN = new Map([
  ["0264", 2],
  ["0283", 2],
  ["0284", 2],
  ["0285", 2],
  ["0421", 2],
  ["0432", 2],
  ["0433", 3],
  ["0435", 2],
  ["0436", 3],
  ["0437", 2],
  ["0438", 2],
  ["0439", 3],
  ["0440", 2],
  ["0441", 2],
  ["0442", 2],
  ["0445", 3],
  ["0446", 2],
  ["0447", 2],
  ["0452", 2],
  ["0453", 2],
  ["0454", 2],
  ["0457", 2],
  ["0458", 2],
  ["0473", 2],
  ["0475", 2],
  ["0480", 2],
  ["0489", 2],
  ["0490", 3],
  ["0492", 3],
  ["0493", 2],
  ["0500", 2],
]);

const counts = new Map();
const files = [];
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith(".sql")) continue;
  const m = /^(\d{4})_/.exec(f);
  if (!m) {
    console.error(`✗ ${f} — migration filenames must start with a 4-digit ordinal + underscore.`);
    process.exit(1);
  }
  counts.set(m[1], (counts.get(m[1]) || 0) + 1);
  files.push(f);
}

let failed = false;
const maxOrdinal = [...counts.keys()].sort().at(-1);
for (const [prefix, n] of [...counts].sort()) {
  if (n <= 1) continue;
  const frozen = FROZEN.get(prefix) || 0;
  if (n > frozen) {
    failed = true;
    console.error(
      `✗ ordinal ${prefix} now has ${n} files (frozen at ${frozen || "unique"}). ` +
      `Renumber the new migration to the next free ordinal (last used: ${maxOrdinal}).`
    );
  }
}

if (failed) {
  console.error(
    "\nDuplicate ordinals are ambiguous for the operator's by-hand SQL-Editor " +
    "workflow ('did I run 0432?' has two answers) — pick the next unused number instead."
  );
  process.exit(1);
}

// ── Self-record gate ──────────────────────────────────────────────────────
// The private.rr_migrations ledger (0504) is what rr_schema_version() and
// the dashboard's "database is behind this app" banner read. It only
// advances when a migration inserts its own filename — 0506–0567 shipped
// without that insert, so the ledger sat frozen at 0505 while the operator
// pasted weeks of SQL (fixed by the 0569 backfill + retrofit). Every
// migration from 0506 on must reference the ledger AND its own filename;
// append this to new migrations (adjust the filename):
//
//   do $$
//   begin
//     if to_regclass('private.rr_migrations') is not null then
//       insert into private.rr_migrations (filename)
//       values ('NNNN_your_migration.sql')
//       on conflict (filename) do nothing;
//     end if;
//   end $$;
const SELF_RECORD_FROM = 506;
let selfRecordFailed = false;
for (const f of files) {
  if (parseInt(f.slice(0, 4), 10) < SELF_RECORD_FROM) continue;
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  if (!text.includes("private.rr_migrations") || !text.includes(`'${f}'`)) {
    selfRecordFailed = true;
    console.error(
      `✗ ${f} — must self-record in private.rr_migrations (an insert of its own ` +
      `filename, guarded by to_regclass). See the block in this script's comments.`
    );
  }
}
if (selfRecordFailed) process.exit(1);

// ── Banner-sync gate ──────────────────────────────────────────────────────
// dashboard/live.js shows a "database is behind this app" banner when
// rr_schema_version() < _RR_SCHEMA_EXPECTED. The old convention ("bump when
// a migration the dashboard depends on lands") silently froze the constant
// at 0534 while 35 dashboard-relevant migrations shipped — the same failure
// mode the self-record gate exists for. Rule: the constant tracks the
// LATEST ordinal; a PR that adds a migration bumps it in the same diff.
const liveSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "dashboard", "live.js"), "utf8"
);
const expMatch = /_RR_SCHEMA_EXPECTED\s*=\s*(\d+)/.exec(liveSrc);
if (!expMatch || parseInt(expMatch[1], 10) !== parseInt(maxOrdinal, 10)) {
  console.error(
    `✗ dashboard/live.js _RR_SCHEMA_EXPECTED is ` +
    `${expMatch ? "0" + expMatch[1] : "missing"} but the latest migration ` +
    `ordinal is ${maxOrdinal} — set the constant to match so the schema ` +
    `banner can tell the operator what to apply.`
  );
  process.exit(1);
}

console.log(
  `✓ migration ordinals ok (${counts.size} distinct, ${FROZEN.size} grandfathered collisions unchanged); ` +
  `self-record ledger inserts present from 0${SELF_RECORD_FROM} on; ` +
  `banner _RR_SCHEMA_EXPECTED in sync at ${maxOrdinal}`
);
