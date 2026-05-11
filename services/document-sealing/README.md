# rr-document-sealing

Cloudflare Worker that seals a signed envelope:

1. Stamps the driver's signature image (or typed name) onto the source PDF at the field positions captured in `document_envelopes.fields_snapshot` (or the bottom-right of the last page if the template has no fields).
2. Appends a **Certificate of Completion** page listing every audit-trail event for the envelope, with the document SHA-256 hashes and the per-event hash-chain values.
3. **Cryptographic seal (Phase 1)** — computes SHA-256 of the sealed PDF bytes and signs that digest with an ECDSA P-256 key (`RR_SIGNING_PRIVATE_JWK` Worker secret). The signature + digest + key fingerprint + timestamps are written as a JSON sidecar at `<dsp_id>/seal/<envelope_id>.json`, and a `pdf_signed` event lands on the audit chain. The sealed PDF bytes stay byte-identical to what you'd hand to a court — the proof lives next to it, not embedded inside (embedding the signature would change the bytes and invalidate the signature you just made). If `RR_SIGNING_PRIVATE_JWK` is unset, this step is skipped gracefully.
4. Uploads the sealed PDF, the standalone Certificate of Completion, and (if sealed) the JSON sidecar to the `documents` bucket.
5. Writes the storage paths back to the envelope and appends `pdf_sealed` (+ `pdf_signed` when sealed) events to the audit chain.

The public key that validates a seal is served at **`GET /public-key`** on the Worker (returns the ECDSA P-256 public JWK). A verifier downloads the sealed PDF + its sidecar, re-hashes the PDF, confirms the hash matches `pdf_sha256`, then verifies `signature_b64` against that hash with the public key.

RFC 3161 TSA timestamping (Phase 2) will stamp a `tst_b64` from FreeTSA-or-similar into the same sidecar — same shape, just anchors "when" to an independent authority rather than the chain's `created_at` timestamps.

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
4. **Worker runtime secrets** — Cloudflare → Workers & Pages → `rr-document-sealing` → Settings → Variables → **Secrets** → add:
   - `SUPABASE_URL` — `https://<project-ref>.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API → `service_role` (NOT the anon key)
   - `SEALING_SECRET` — generate any random string (a 32-byte hex is fine); **keep it open** — you need the same value on the DB side in the next step.
   - `RR_SIGNING_PRIVATE_JWK` *(optional but recommended)* — the ECDSA P-256 signing key as JWK JSON. Generate it once (see [Generating the signing key](#generating-the-signing-key) below) and paste the whole JSON object. Omit it and sealing still works, just without the cryptographic sidecar.
   - `RR_SIGNING_KEY_ID` *(optional)* — a human-readable label for the active key (e.g. `rr-seal-2026`), written into every seal so you know which public key validates which sidecar after a rotation.
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

## Generating the signing key

The seal uses ECDSA P-256 (a.k.a. `prime256v1` / `secp256r1`). You need the **private** key as a JWK for the Worker secret, and you should keep the **public** key somewhere you can hand to counterparties (it's also served at `GET /public-key`).

From any machine with `openssl` and `node`:

```bash
# 1. Generate a P-256 private key (PEM).
openssl ecparam -name prime256v1 -genkey -noout -out rr-seal-private.pem

# 2. Convert PEM → JWK. (jose is a tiny dep; or use any PEM→JWK tool.)
npx --yes jose-cli pem2jwk --private < rr-seal-private.pem
#   → prints a JSON object like:
#     {"kty":"EC","crv":"P-256","x":"...","y":"...","d":"..."}
```

Paste that JSON object as the value of the `RR_SIGNING_PRIVATE_JWK` Worker secret. The Worker derives the public JWK (`x`/`y`, drops `d`) automatically and serves it at `/public-key`.

**Keep `rr-seal-private.pem` (and the `d` value) secret.** Treat it like the `SEALING_SECRET` — anyone with it can forge seals. To rotate: generate a new key, bump `RR_SIGNING_KEY_ID`, set both secrets. Old sidecars still validate against the old public key (the `key_id`/`key_fingerprint` in each sidecar tells you which).

### Verifying a sealed PDF independently

```bash
# Download both files from the documents bucket (or the dashboard's
# audit modal): the sealed PDF and its <envelope>.json sidecar.

# 1. Re-hash the PDF and compare to sidecar.pdf_sha256:
openssl dgst -sha256 signed.pdf
#   → must equal the "pdf_sha256" field in the sidecar.

# 2. Fetch the public key:
curl https://rr-document-sealing.<account>.workers.dev/public-key > pub.jwk

# 3. Verify sidecar.signature_b64 (raw r||s, 64 bytes) over the SHA-256
#    digest with that public key. Easiest with a 3-line node script using
#    crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, key, sig, digest).
```

A `verify` page on the dashboard (slice 5) will do all of this in the browser.

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
