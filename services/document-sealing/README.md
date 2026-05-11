# rr-document-sealing

Cloudflare Worker that seals a signed envelope:

1. Stamps the driver's signature image (or typed name) onto the source PDF at the field positions captured in `document_envelopes.fields_snapshot` (or the bottom-right of the last page if the template has no fields).
2. Appends a **Certificate of Completion** page listing every audit-trail event for the envelope, with the document SHA-256 hashes and the per-event hash-chain values.
3. **Cryptographic seal (Phase 1)** — computes SHA-256 of the sealed PDF bytes and signs that digest with an ECDSA P-256 key (`RR_SIGNING_PRIVATE_JWK` Worker secret). The signature + digest + key fingerprint + timestamps are written as a JSON sidecar at `<dsp_id>/seal/<envelope_id>.json`, and a `pdf_signed` event lands on the audit chain. The sealed PDF bytes stay byte-identical to what you'd hand to a court — the proof lives next to it, not embedded inside (embedding the signature would change the bytes and invalidate the signature you just made). If `RR_SIGNING_PRIVATE_JWK` is unset, this step is skipped gracefully.
4. **RFC 3161 trusted timestamp (Phase 2)** — builds a `TimeStampReq` for the sealed PDF's SHA-256 and POSTs it to a Time Stamping Authority (`RR_TSA_URL`, default `https://freetsa.org/tsr`). The TSA's `TimeStampToken` (a PKCS#7 attesting "this hash existed at or before time T", signed by the TSA — not by us) is stored in the same sidecar as `tst_b64`, along with `tsa_url` and a best-effort parse of the token's `genTime`. If the TSA is unreachable, the seal still ships without a timestamp.
5. Uploads the sealed PDF, the standalone Certificate of Completion, and (if sealed) the JSON sidecar to the `documents` bucket.
6. Writes the storage paths back to the envelope and appends `pdf_sealed` (+ `pdf_signed` when sealed) events to the audit chain.

The public key that validates a seal is served at **`GET /public-key`** on the Worker (returns the ECDSA P-256 public JWK). A verifier downloads the sealed PDF + its sidecar, re-hashes the PDF, confirms the hash matches `pdf_sha256`, verifies `signature_b64` against that hash with the public key, and (if present) verifies `tst_b64` with any RFC 3161 verifier.

### Sidecar JSON shape (`<dsp>/seal/<envelope>.json`)

```jsonc
{
  "version": "rr-seal-v1",
  "envelope_id": "…",
  "pdf_sha256": "<hex>",                  // SHA-256 of the sealed PDF bytes
  "signature_alg": "ECDSA-P256-SHA256",
  "signature_b64": "<base64 raw r||s>",   // ECDSA signature over pdf_sha256
  "key_id": "rr-seal-2026",
  "key_fingerprint": "<first 32 hex of SHA-256(SPKI)>",
  "public_jwk": { "kty": "EC", "crv": "P-256", "x": "…", "y": "…" },
  "signed_at": "2026-…Z",                 // our clock — informational
  "tsa_url": "https://freetsa.org/tsr",   // present only if Phase 2 succeeded
  "tsa_gen_time": "2026-…Z",              // the TSA's attested time
  "tst_b64": "<base64 RFC 3161 TimeStampResp>"
}
```

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
   - `RR_TSA_URL` *(optional)* — RFC 3161 Time Stamping Authority endpoint. Defaults to FreeTSA (`https://freetsa.org/tsr`), which is free and needs no account. Point it at a commercial TSA (DigiCert, Sectigo, etc.) if you want an SLA. If the TSA is down, sealing still works — the sidecar just won't have a `tst_b64`.
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

# 4. (If the sidecar has tst_b64) verify the RFC 3161 timestamp:
#    base64-decode tst_b64 into tst.tsr, then:
openssl ts -reply -in tst.tsr -text          # inspect: hash, genTime, TSA
openssl ts -verify -data signed.pdf -in tst.tsr -CAfile <tsa-ca-bundle>.pem
#    → confirms the token covers exactly this PDF and was issued by the
#      TSA at the stated time. (Grab FreeTSA's CA bundle from
#      https://freetsa.org/files/cacert.pem if you're using the default.)
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

## Slice 4b — what shipped vs. what's deferred

**Shipped (Phase 1 + Phase 2):**
- `RR_SIGNING_PRIVATE_JWK` (+ optional `RR_SIGNING_KEY_ID`) — ECDSA P-256 seal over the sealed PDF's SHA-256, written to the sidecar.
- `RR_TSA_URL` (default `https://freetsa.org/tsr`) — RFC 3161 `TimeStampToken` on the same digest, stored in the sidecar as `tst_b64`.
- `GET /public-key` serves the public JWK for independent verification.
- The Certificate of Completion + the `pdf_signed` audit event carry the seal + timestamp metadata.

**Deferred (only needed if a counterparty demands the Adobe Acrobat "✓ Signed" badge):**
- A PAdES signature embedded in the PDF's `/Sig` dictionary with a real `ByteRange` (placeholder-splice). Requires a PKCS#7/CMS `SignedData` build — `@signpdf/signpdf` or hand-rolled.
- A document-signing certificate from an Adobe-AATL CA (GlobalSign / DigiCert / Sectigo / Entrust, ~$300–900/yr, identity-verified) so Acrobat shows the green ribbon rather than a yellow "signer identity unknown" triangle. Until then we deliberately embed *no* signature object in the PDF — a clean PDF + COC + sidecar beats a yellow-triangle warning.
- The TSA token embedded as an unsigned attribute on that PKCS#7, plus optional long-term validation (CRL/OCSP responses embedded so the signature stays verifiable after the cert expires).
