# B-2 · Backups + a tested restore

**Finding (audit Blocker B-2):** there is no evidence of a backup policy or a
*tested* restore. A backup you have never restored is not a backup — it is a
hope. Today, a bad migration, an accidental `delete`, or a corrupted table has
no proven recovery path, and this is customer data. This blocker is not code;
it is an operations task on the Supabase project. It stays a blocker until you
have (a) point-in-time recovery on, and (b) actually restored from it once.

> Menu names in the Supabase dashboard move around release to release. Where a
> path below doesn't match exactly, look under **Project Settings → Database**
> and **Database → Backups**, and cross-check the current docs at
> <https://supabase.com/docs/guides/platform/backups> and
> <https://supabase.com/docs/guides/platform/going-into-prod>.

---

## Step 1 — turn on Point-in-Time Recovery (PITR)

Daily snapshots (included on the paid tier) only let you roll back to a
once-a-day point — you can lose up to ~24h. PITR archives the write-ahead log so
you can restore to **any second** within the retention window. For real customer
data, turn it on.

1. Confirm the project is on a plan that offers PITR (Pro or above). Daily
   backups alone are not sufficient for this blocker.
2. Dashboard → **Project Settings → Database → Backups** (or the **Backups**
   tab under **Database**). Enable **Point-in-Time Recovery** and pick a
   retention window (7 days is a sane floor; longer is better).
3. Wait until the UI shows PITR **active** with an earliest-recoverable
   timestamp that is advancing. That timestamp moving forward is your proof WAL
   archiving is actually running.

---

## Step 2 — run a restore DRILL (the part that clears the blocker)

The audit asks for a *tested* restore. Do it **non-destructively** — never
practice by restoring over production. The goal is to prove the backup is
complete and loadable, and to time how long recovery takes.

### Recommended: restore into a throwaway target

1. **Take a logical dump of production** (read-only; safe on a live DB):
   ```sh
   # Connection string: Dashboard → Project Settings → Database → Connection string
   pg_dump "postgresql://postgres:<pw>@db.doiwrhkirgblcvuskhno.supabase.co:5432/postgres" \
     --no-owner --no-privileges -Fc -f rr_prod_$(date +%Y%m%d).dump
   ```
2. **Create a scratch target** — a second (free-tier) Supabase project, or a
   local Postgres 16 — that you can throw away after.
3. **Restore into it:**
   ```sh
   pg_restore --no-owner --no-privileges \
     -d "postgresql://postgres:<pw>@db.<scratch-ref>.supabase.co:5432/postgres" \
     rr_prod_YYYYMMDD.dump
   ```
4. **Verify the restore is real** (not just "no errors"):
   - Row counts on the tables that matter match production, e.g.
     ```sql
     select 'dsps' t, count(*) from dsps
     union all select 'drivers', count(*) from drivers
     union all select 'shifts',  count(*) from shifts
     union all select 'app_users', count(*) from app_users;
     ```
     Run the same query against prod and diff the numbers.
   - Spot-check a few known rows (a real driver, a recent shift) exist with the
     right values.
   - Confirm RLS policies and functions came across:
     `select count(*) from pg_policies;` and
     `select count(*) from pg_proc where pronamespace='public'::regnamespace;`
5. **Write down how long steps 1–4 took.** That number is your Recovery Time
   Objective — the honest answer to "how long are we down if the DB is lost?"
6. **Delete the scratch project** and the dump file (it contains customer PII —
   don't leave it lying around).

### Also verify the in-place PITR path exists

Separately, in the dashboard, confirm the **Restore** control on the Backups
page lets you pick a timestamp (you don't have to run it — just confirm the
button and the time-picker are there and the earliest timestamp covers your
retention window). In a real incident you'd use this to roll production back to
just before the bad change.

---

## Step 3 — write down the policy (one paragraph is enough)

Record, somewhere you'll find it during an incident (a pinned note, this repo,
your ops doc):
- PITR retention window (e.g. "7 days").
- Where the restore button is and who has access.
- Your measured RTO from Step 2.
- A reminder to **re-run the drill** after any big schema change and at least
  quarterly — a restore that worked six months ago is stale evidence.

---

## Done when

- [ ] PITR is **active** with an advancing earliest-recoverable timestamp.
- [ ] You have restored a production dump into a throwaway target and verified
      row counts + spot-checks + policies/functions.
- [ ] You know, in minutes, how long a recovery takes (RTO written down).
- [ ] The scratch target and the PII-bearing dump file are deleted.

Only then is B-2 closed. Until all four are true, treat the data as
unrecoverable and do **not** onboard a paying customer.
