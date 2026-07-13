# RouteReady Automation — Sheet hardening

`setup-automation-sheet.gs` applies the 5 improvements from the spreadsheet
review to the **"RouteReady Automation"** Google Sheet
(`1HbjfgmgqzlSShbqO8ZIZMTBrJo_jqACZQVYJb8ki52Q`).

The sheet is driven by a **container-bound Apps Script**, so these changes have
to run *inside* the sheet — they can't be applied from this repo. This folder
is the version-controlled source of truth for that script.

## Install / run

1. Open the sheet → **Extensions → Apps Script**.
2. New file → paste the contents of `setup-automation-sheet.gs` → **Save**.
3. Run **`setupRouteReadySheet()`** and grant permissions.

`setupRouteReadySheet()` runs only the **safe, additive** steps — it cannot
break your automation:

| # | What | How it stays safe |
|---|------|-------------------|
| 2 | Dropdowns on Status / Priority / Attendance / VideoStatus | `allowInvalid` = **warn only**, never rejects a write |
| 3 | New **Dashboard** tab (counts vs. HeadcountTarget) | brand-new tab, touches nothing else |
| 4 | Freeze headers, header styling, row banding, conditional colors | cosmetic |
| 1 | Copies secrets → Script Properties | **copy only**, leaves the cells intact |

## Then do the security fix (#1) — this part is on you

The Settings tab currently holds **live** secrets in plaintext: your Anthropic
key, Cal.com **live** key, Cloudflare R2 access + secret keys, and the dashboard
password hash/salt. `setupRouteReadySheet()` copied them into Script Properties
but left the cells working. To finish:

1. **Swap your reads.** Anywhere your automation does
   `settings['CalComAPIKey']`, change it to `getSecret_('CalComAPIKey')`
   (helper included in the script — it falls back to the cell until migrated,
   so you can roll this out gradually).
2. **Blank the cells.** Once reads go through `getSecret_()`, run
   **`redactSecretCells()`**.
3. **Rotate the keys** — they were stored in a shared doc, so treat them as
   compromised:
   - Anthropic: console.anthropic.com → API keys → roll `Claude API Key`.
   - Cal.com: Settings → Developer → API keys → regenerate.
   - Cloudflare R2: roll `R2AccessKeyId` / `R2SecretAccessKey`.
   - Dashboard password: reset it so a fresh hash/salt is generated.
   Update the new values in Script Properties (Project Settings → Script
   Properties), **not** in the sheet.

## Reader-sensitive extras (#5) — run individually after a quick check

These change values/headers your existing automation might read. Both are
trivially reversible.

- **`fixHeaderTypo()`** — `Phone Numer` → `Phone Number` in Master. Safe if your
  code reads columns by position; skip if it reads by the literal header text.
- **`standardizeToggles()`** — normalizes `RouteReadyLogic`,
  `VideoScreeningEnabled`, `ReferralProgramOn` to `TRUE`/`FALSE`. Skip if your
  code expects the strings `ON`/`OFF`.

## Tuning

The dropdown/count vocabulary (`VOCAB` in the script) is my best guess. If your
automation writes different status strings (e.g. lowercase `booked`), update
`VOCAB` and the `COUNTIF` criteria in `buildDashboard_()` to match. `COUNTIF`
is case-insensitive, so casing differences alone are already handled.

## Manual fallback (no script)

- **Freeze headers:** View → Freeze → 1 row (per tab).
- **Dropdowns:** select the column → Data → Data validation → *Dropdown* → list.
- **Banding:** Format → Alternating colors.
- **Conditional colors:** Format → Conditional formatting → *Text is exactly*.
- **Dashboard:** new tab, then `=COUNTA(Master!A2:A)`,
  `=COUNTIF(Master!F2:F,"Booked")`, `=VLOOKUP("HeadcountTarget",Settings!A:B,2,0)`.
