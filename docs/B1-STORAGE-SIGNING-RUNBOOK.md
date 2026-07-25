# B-1 · Close the cross-tenant driver-file exposure — runbook

**Finding (from `CUSTOMER_READINESS_AUDIT.md`, Blocker B-1):** the driver PWA
authenticates as the identity-less `anon` Postgres role, so the three private
driver buckets were opened with a **bucket-wide `anon SELECT`** policy. Because
the anon key ships in every browser and the driver app, any holder of that key
can sign/enumerate **every tenant's** driver-license images, face photos, and
chat attachments — not just their own.

The fix follows the pattern already proven in this repo for the `documents`
bucket (`driver-document-fetch`): a service-role edge function validates the
driver's session token, confirms **ownership** server-side, then mints a
short-lived signed URL. The bucket-wide anon read policies then go away.

---

## What is already built and safe to ship (this branch)

These are **inert until the app calls them and you drop the anon policies** —
shipping them changes nothing on their own:

| Piece | File | What it does |
|---|---|---|
| Ownership RPC | `supabase/migrations/0538_driver_file_ownership.sql` | `public.driver_can_read_file(token, bucket, path)` — validates the token → driver, then checks ownership per bucket. Service-role only. **Validated against PostgreSQL 16: 13/13 assertions pass, incl. cross-tenant denial.** |
| Signing edge fn | `supabase/functions/driver-file-sign/index.ts` | Token + bucket + path → ownership check → signed URL, or 403. Registered `--no-verify-jwt` in `config.toml` + the deploy workflow. |
| Driver-app switch | `app/app.js` (`_signDriverFile` / `_signDriverFiles` + 6 read sites) | **Now implemented** — all six file reads go through `driver-file-sign` instead of the direct anon `createSignedUrl`. Syntax + eslint clean; `SHELL_CACHE` bumped. Still needs on-device QA (below) before 0539. |

**Ownership rules** (mirroring how the app stores files):
- `driver-photos` (`<driver_id>/…`) — any driver **in the caller's own DSP**
  (own avatar + teammate avatars the app shows), never another tenant's.
- `driver-documents` (`<dsp>/…/<driver_id>/…`) — only files whose path carries
  the **caller's** id (their own DVIC / DL / documents).
- `driver-chat-attachments` — authoritative: the path must be referenced by a
  `driver_messages` row in the **caller's own thread** (covers dispatch-sent
  attachments).

## What is built but GATED (do NOT apply yet)

| Piece | File | Gate |
|---|---|---|
| Drop anon reads | `supabase/migrations/0539_drop_anon_storage_reads.sql` | **Apply only after** the driver app is switched over and QA'd (below). It removes the anon read policies — the actual leak — but until the app uses `driver-file-sign`, dropping them makes drivers unable to open their own files. |

---

## Deploy order (do these in sequence)

1. **Ship + merge this branch.** Merging deploys the `driver-file-sign` edge
   function automatically (it's in the `Deploy Supabase` workflow's
   no-verify-jwt list) **and the driver-app change** (the PWA now reads through
   `driver-file-sign`). Apply **migration 0538** by hand in the SQL Editor.
   → The app now uses the new signing path, while the anon policies *still
   exist* as an inert backstop — so nothing is broken even if a read regresses.
2. **QA on a real device** (checklist below). The new path is the only one the
   app uses now, so anything broken shows here — before any policy is dropped.
3. **Only once QA is green:** apply **migration 0539** in the SQL Editor. The
   cross-tenant hole is now closed. Re-run the driver QA once more to confirm
   files still load with the anon policies gone.

The driver-app read sites are already switched (the spec below documents what
changed, for review + QA). Because the helpers preserve the supabase-js return
shape, the change is a callee swap at six sites plus two helpers.

At no point is there a window where the leak is closed but drivers are broken:
the app switches while the old policy still works, and the policy drops only
after the new path is proven.

---

## Driver-app change spec (`app/app.js`)

Add two drop-in helpers (they return the **same shape** as the supabase-js
storage signing calls, so the call sites barely change). `session` is the
current driver session object already used at the `driver-document-fetch` call
site (`session.token`); `cfg` is `RR_CONFIG`.

```js
// Sign a driver-owned file via the ownership-checked edge function.
// Drop-in for sb.storage.from(bucket).createSignedUrl(path, ttl):
// returns { data: { signedUrl }|null, error }.
async function _signDriverFile(bucket, path, ttl = 3600) {
  if (!path || !session?.token) return { data: null, error: { message: "no_token_or_path" } };
  try {
    const resp = await fetch(`${cfg.SUPABASE_URL}/functions/v1/driver-file-sign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY,
        "apikey": cfg.SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ token: session.token, bucket, path, expires_in: ttl }),
    });
    if (!resp.ok) return { data: null, error: { message: "HTTP " + resp.status } };
    const body = await resp.json();
    return body?.signed_url
      ? { data: { signedUrl: body.signed_url }, error: null }
      : { data: null, error: { message: "no_url" } };
  } catch (e) { return { data: null, error: { message: e?.message || "network" } }; }
}

// Drop-in for createSignedUrls: returns { data: [{ path, signedUrl, error }], error }.
async function _signDriverFiles(bucket, paths, ttl = 3600) {
  const data = await Promise.all((paths || []).map(async (p) => {
    const { data: d } = await _signDriverFile(bucket, p, ttl);
    return { path: p, signedUrl: d?.signedUrl || null, error: d?.signedUrl ? null : "sign_failed" };
  }));
  return { data, error: null };
}
```

Then replace the six read sites (uploads stay unchanged — the anon INSERT
policies remain):

| # | Site | Replace | With |
|---|---|---|---|
| 1 | own profile photo (~L1264) | `sb.storage.from("driver-photos").createSignedUrl(data.photo_path, 7*24*60*60)` | `_signDriverFile("driver-photos", data.photo_path, 7*24*60*60)` |
| 2 | teammate photos, **batch** (~L7620) | `sb.storage.from("driver-photos").createSignedUrls(_paths, 7*24*60*60)` | `_signDriverFiles("driver-photos", _paths, 7*24*60*60)` |
| 3 | chat attachment (~L7005) | `sb.storage.from("driver-chat-attachments").createSignedUrl(path, 60*60*8)` | `_signDriverFile("driver-chat-attachments", path, 60*60*8)` |
| 4 | DL front image (~L8713) | `sb.storage.from("driver-documents").createSignedUrl(prof.dl_image_path, 60*60)` | `_signDriverFile("driver-documents", prof.dl_image_path, 60*60)` |
| 5 | DL back image (~L8718) | `sb.storage.from("driver-documents").createSignedUrl(prof.dl_back_image_path, 60*60)` | `_signDriverFile("driver-documents", prof.dl_back_image_path, 60*60)` |
| 6 | generic doc signer `_clkSignedUrl` (~L10075) | `sb.storage.from("driver-documents").createSignedUrl(path, 3600)` | `_signDriverFile("driver-documents", path, 3600)` |

Because the helpers return the same `{ data: { signedUrl } }` shape, the
existing consumers (`_ps?.signedUrl`, the `createSignedUrls` map over
`{path, signedUrl}`, `data?.signedUrl`) work unchanged. Bump `SHELL_CACHE`
(run `npm run build`) so installed PWAs pick up the change.

---

## Device-QA checklist (step 3 — before dropping any policy)

On a real phone, logged in as a driver, confirm each still loads:
- [ ] **Profile photo** renders (settings / header avatar).
- [ ] **Teammate photos** render on the schedule/team view (initials fallback is OK for drivers with no photo, but real photos must appear).
- [ ] **Driver-license images** (front + back) render where the app shows them.
- [ ] **DVIC / uploaded documents** open.
- [ ] **Chat attachment** (a photo/voice note in a dispatch thread) opens.
- [ ] Uploads still work (post a chat attachment, take a DVIC photo) — the anon INSERT path is unchanged.
- [ ] **Negative check (optional, strong):** with the driver's token, calling `driver-file-sign` for a path under *another* driver's id in a *different* DSP returns **403** (not a URL).

If any read fails, do **not** apply 0539 — the app path has a bug; fix and re-deploy first.

---

## Follow-up (not in this change)

- **`receipts` bucket** has the same bucket-wide `receipts_anon_read` policy
  (migration 0435). Close it the same way: add `receipts` to
  `driver-file-sign`'s allow-list + `driver_can_read_file` (path carries the
  driver id, like `driver-documents`), switch the app's receipt reads, then
  drop `receipts_anon_read`. Left out here to keep this change to buckets whose
  read paths are covered.
- The **anon INSERT** policies remain by design. Tightening uploads to an
  edge-function-mediated path is a separate, lower-priority hardening step.
```
