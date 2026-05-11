# rr-document-sealing

Cloudflare Worker that seals a signed envelope:

1. Stamps the driver's signature image (or typed name) onto the source PDF at the field positions captured in `document_envelopes.fields_snapshot` (or the bottom-right of the last page if the template has no fields).
2. Appends a **Certificate of Completion** page listing every audit-trail event for the envelope, with the document SHA-256 hashes and the per-event hash-chain values.
3. Uploads the sealed PDF and the standalone Certificate of Completion to the `documents` bucket (`<dsp_id>/signed/<envelope_id>.pdf` and `<dsp_id>/certificates/<envelope_id>.pdf`).
4. Writes the storage paths back to the envelope and appends a `pdf_sealed` event to the audit chain.

PKCS#7 detached signature + RFC 3161 timestamping land in slice 4b. Until then the sealed PDF is human-defensible (visible signature, certificate page attached, hash chain intact in our DB) but not cryptographically tamper-evident to a PDF reader's "✓ Signed" check.

Triggered by a Postgres trigger on `document_envelopes` UPDATE when `status` transitions to `signed` (see `supabase/migrations/0155_documents_sealing_trigger.sql`).

## How deploys happen

The Worker auto-deploys via GitHub Actions (`.github/workflows/deploy-document-sealing.yml`) whenever anything under `services/document-sealing/` changes on `main`. You never need a local terminal once the one-time setup below is done.

If you ever do want to deploy from your own machine (debugging a candidate change before pushing): `npm install` here, then `npx wrangler login`, then `npx wrangler deploy`.

## One-time setup

Done entirely from a browser.

1. **Cloudflare API token** — Cloudflare → My Profile → API Tokens → **Create Token** → "Edit Cloudflare Workers" template → constrain to your account → Continue / Create. Copy the token.
2. **GitHub Actions secrets** — your repo → Settings → Secrets and variables → Actions → New repository secret. Add two:
   - `CLOUDFLARE_API_TOKEN` — the token from step 1.
   - `CLOUDFLARE_ACCOUNT_ID` — top-right of any Cloudflare dashboard page (the long hex string under your account name).
3. **Trigger the first deploy** — the workflow runs automatically whenever `services/document-sealing/**` changes; the easiest way to trigger it the first time is to merge a PR that touches this dir, or go to GitHub → Actions → "Deploy document-sealing Worker" → **Run workflow**.

   First run creates the Worker on Cloudflare. After it succeeds, the Worker exists at `https://rr-document-sealing.<your-cf-subdomain>.workers.dev` (if you've never used Workers on this Cloudflare account, the dashboard will prompt you to pick a `workers.dev` subdomain the first time — do that before triggering the deploy).
4. **Worker runtime secrets** — Cloudflare → Workers & Pages → `rr-document-sealing` → Settings → Variables → **Secrets** → add three:
   - `SUPABASE_URL` — `https://<project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → `service_role` (NOT the anon key)
   - `SEALING_SECRET` — generate any random string (a 32-byte hex is fine); **keep it open** — you need the same value on the DB side in the next step.
5. **Supabase Postgres settings** — Supabase → SQL Editor:
   ```sql
   alter database postgres set "app.sealing_service_url"
     to 'https://rr-document-sealing.<your-cf-subdomain>.workers.dev';

   alter database postgres set "app.sealing_service_secret"
     to '<the SAME SEALING_SECRET from step 4>';
   ```

Done. Future code changes to the worker auto-deploy on push.

---

## (Local terminal fallback)

If you ever want to deploy directly from a workstation:

1. `npm install` in this directory.
2. Authenticate Wrangler against your Cloudflare account: `npx wrangler login`.
3. Set the three required secrets:
   ```bash
   npx wrangler secret put SUPABASE_URL
   #   → https://<project-ref>.supabase.co

   npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
   #   → service role key from Supabase → Project Settings → API

   npx wrangler secret put SEALING_SECRET
   #   → openssl rand -hex 32   (shared with the DB trigger)
   ```
4. Deploy: `npx wrangler deploy`. Note the public URL (e.g. `https://rr-document-sealing.<account>.workers.dev`).
5. Set two Postgres-level settings so the trigger knows where to call:
   ```sql
   alter database postgres set "app.sealing_service_url"
     to 'https://rr-document-sealing.<account>.workers.dev';

   alter database postgres set "app.sealing_service_secret"
     to '<the same SEALING_SECRET you set on the Worker>';
   ```
   (Same model as the SMS/email immediate-send triggers — see `supabase/SECRETS.md` §5.)

## Triggering manually

The Worker takes `POST { envelope_id }` with `Authorization: Bearer <SEALING_SECRET>`:

```bash
curl -X POST https://rr-document-sealing.<account>.workers.dev \
  -H "Authorization: Bearer $SEALING_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"envelope_id":"<uuid>"}'
```

Useful for re-sealing an envelope after a fix.

## Local development

```bash
npx wrangler dev    # binds to http://127.0.0.1:8787
```

`wrangler dev` reads secrets from `.dev.vars` (gitignored). Create one in this directory for local testing:

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=…
SEALING_SECRET=…
```

## What slice 4b adds

- `ESIGN_SIGNING_KEY_PEM` + `ESIGN_SIGNING_CERT_PEM` Worker secrets (PKCS#8 + PEM cert; self-signed for v1, AATL-issued later).
- `ESIGN_TSA_URL` for RFC 3161 (default `https://freetsa.org/tsr`).
- PKCS#7 detached signature embedded in the PDF's `/Sig` dictionary with a real `ByteRange`.
- Timestamp token from the TSA embedded as an unsigned attribute on the PKCS#7.
- (Optional) long-term validation: CRL/OCSP responses embedded so the signature stays verifiable after the cert expires.
