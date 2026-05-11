// rr-document-sealing · Cloudflare Worker
//
// Invoked by a Postgres trigger on document_envelopes when an envelope
// transitions to 'signed' (via pg_net.http_post — see migration 0155).
// Responsibilities:
//   1. Authenticate the call (bearer SEALING_SECRET).
//   2. Fetch the envelope + template + last 'signed' audit event from
//      Supabase via the service role.
//   3. Download the source PDF from the 'documents' bucket.
//   4. Stamp the driver's signature image (drawn) or typed name onto
//      the PDF — at the field positions captured in fields_snapshot,
//      or a default position at the bottom-right of the last page.
//   5. Append a Certificate of Completion page listing every audit
//      event and the chain hashes — the human-readable proof page.
//   6. Upload the sealed PDF (and the cert as a separate file) back to
//      the 'documents' bucket and stamp the envelope.
//   7. Log a `pdf_sealed` event on the audit chain.
//
// Slice 4b — cryptographic integrity (Phase 1):
//   • The Worker computes SHA-256 of the sealed PDF bytes (after the
//     signature stamp + COC are baked in).
//   • It signs that digest with an ECDSA P-256 key held as a Worker
//     secret (RR_SIGNING_PRIVATE_JWK). The matching public key is
//     exposed via GET /public-key so verifiers can validate the seal
//     without our private material.
//   • A JSON sidecar is written to <dsp>/seal/<id>.json containing
//     the digest, signature, key fingerprint, and timestamps — this
//     means the sealed PDF bytes stay byte-identical to what you'd
//     hand to a court while the proof lives next to it.
//   • The Certificate of Completion prints the digest + signature
//     fingerprint, and a `pdf_signed` event lands on the audit chain.
//
// If RR_SIGNING_PRIVATE_JWK isn't set, sealing degrades to the
// previous (uncryptographic) behavior — the sealed PDF + COC still
// upload, just without the sidecar.
//
// Slice 4b Phase 2 — RFC 3161 trusted timestamp:
//   • After signing, the Worker builds an ASN.1 TimeStampReq for the
//     sealed PDF's SHA-256 and POSTs it to a Time Stamping Authority
//     (RR_TSA_URL, default FreeTSA). The TSA returns a TimeStampResp
//     whose embedded TimeStampToken (a PKCS#7 SignedData) attests
//     "this exact hash existed at or before time T" — signed by the
//     TSA, not by us. We store the response bytes verbatim in the
//     sidecar as `tst_b64`, plus the TSA URL and a best-effort parse
//     of the token's genTime for display.
//   • If the TSA is unreachable or returns an error, the seal still
//     ships — `tst_b64` is just omitted (degrades like the rest).
//
// Inputs (POST JSON body): { envelope_id: string }
// Auth: Authorization: Bearer <SEALING_SECRET>

import {
  PDFDocument,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  SEALING_SECRET: string;
  // ECDSA P-256 private key in JWK JSON form. Generate locally with:
  //   openssl ecparam -name prime256v1 -genkey -noout -out key.pem
  //   openssl ec -in key.pem -text -noout    # inspect
  //   then convert to JWK and `wrangler secret put RR_SIGNING_PRIVATE_JWK`.
  // If unset, sealing skips the cryptographic step gracefully.
  RR_SIGNING_PRIVATE_JWK?: string;
  // Optional human-readable identifier for the active key, written into
  // every seal — useful when you rotate keys and need to know which
  // public key validates which seal.
  RR_SIGNING_KEY_ID?: string;
  // RFC 3161 Time Stamping Authority endpoint. Defaults to FreeTSA's
  // public service. Set to a commercial TSA if you want an SLA.
  RR_TSA_URL?: string;
}

interface AuditEvent {
  id: number;
  kind: string;
  actor_kind: string;
  actor_name: string | null;
  actor_email: string | null;
  ip: string | null;
  user_agent: string | null;
  event_data: Record<string, unknown> | null;
  prev_event_hash: string;
  event_hash: string;
  created_at: string;
}

interface Envelope {
  id: string;
  dsp_id: string;
  template_id: string;
  recipient_name: string;
  recipient_email: string;
  doc_hash_at_send: string;
  doc_hash_at_sign: string | null;
  fields_snapshot: Array<{
    id?: string;
    kind?: string;
    label?: string;
    page?: number;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
  }>;
  field_values?: Record<string, unknown> | null;
  status: string;
  signed_at: string | null;
  sent_at: string;
  signed_pdf_path: string | null;
  certificate_pdf_path: string | null;
  seal_path: string | null;
}

interface Template {
  id: string;
  title: string;
  source_path: string;
  source_hash: string;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Public-key endpoint — anyone can fetch this. Returns the
    // ECDSA P-256 public JWK that validates seals we produce. Used by
    // future external verifiers (slice 5) and is also documented for
    // counterparties who want to verify a sealed PDF independently.
    if (req.method === "GET" && url.pathname === "/public-key") {
      try {
        const pub = await loadPublicKeyJwk(env);
        if (!pub) return json({ error: "signing_key_not_configured" }, 404);
        return json(pub, 200, { "Cache-Control": "public, max-age=300" });
      } catch (err) {
        return json({ error: String((err as Error)?.message || err) }, 500);
      }
    }

    // Diagnostic: probe each configured TSA with a fixed hash and report
    // exactly what came back (status, content-type, response prefix,
    // parsed PKI status, genTime, or the error). No auth — it leaks
    // nothing sensitive, just whether the TSA is reachable from here.
    if (req.method === "GET" && url.pathname === "/timestamp-test") {
      const urls = env.RR_TSA_URL ? env.RR_TSA_URL.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TSA_URLS;
      const fixed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rr-tsa-test")));
      const reqDer = buildTimeStampReq(fixed);
      const out: unknown[] = [];
      for (const u of urls) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 12_000);
        try {
          const r = await fetch(u, { method: "POST", headers: { "Content-Type": "application/timestamp-query", "Accept": "application/timestamp-reply" }, body: reqDer, signal: ctrl.signal });
          const buf = new Uint8Array(await r.arrayBuffer());
          const hex = Array.from(buf.slice(0, 40)).map((b) => b.toString(16).padStart(2, "0")).join("");
          out.push({ url: u, ok: r.ok, status: r.status, contentType: r.headers.get("content-type"), bodyLen: buf.byteLength, bodyHexPrefix: hex, pkiStatus: r.ok ? readTsaStatus(buf) : null, genTime: r.ok ? extractGenTime(buf) : null });
        } catch (err) {
          out.push({ url: u, error: String((err as Error)?.message || err) });
        } finally { clearTimeout(t); }
      }
      return json({ reqDerLen: reqDer.byteLength, results: out }, 200);
    }

    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    // Shared-secret auth between the Postgres trigger and the Worker.
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.SEALING_SECRET || token !== env.SEALING_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }

    const body = (await req.json().catch(() => ({}))) as { envelope_id?: string };
    const envelopeId = body?.envelope_id;
    if (!envelopeId) return json({ error: "missing_envelope_id" }, 400);

    try {
      const result = await sealEnvelope(envelopeId, env);
      return json(result, 200);
    } catch (err) {
      console.error("sealEnvelope failed:", err);
      return json({ error: String((err as Error)?.message || err) }, 500);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────
// Sealing pipeline
// ─────────────────────────────────────────────────────────────────────────

async function sealEnvelope(envelopeId: string, env: Env) {
  // 1. Envelope + template.
  const envelope = await sb<Envelope>(env, `document_envelopes?id=eq.${envelopeId}&select=*`);
  if (!envelope[0]) throw new Error("envelope_not_found");
  const env_ = envelope[0];
  if (env_.status !== "signed") return { skipped: "not_signed", status: env_.status };
  if (env_.signed_pdf_path)      return { skipped: "already_sealed", path: env_.signed_pdf_path };

  const tplArr = await sb<Template>(env, `document_templates?id=eq.${env_.template_id}&select=*`);
  if (!tplArr[0]) throw new Error("template_not_found");
  const tpl = tplArr[0];

  // 2. Audit events (full chain for the Certificate of Completion).
  const events = await sb<AuditEvent>(
    env,
    `document_events?envelope_id=eq.${envelopeId}&order=id.asc&select=*`,
  );
  const signedEvent = events.reverse().find((e) => e.kind === "signed");
  events.reverse(); // restore chronological order
  if (!signedEvent) throw new Error("no_signed_event");
  const sigData = (signedEvent.event_data?.signature_data as string) || "";
  const sigMethod = (signedEvent.event_data?.signature_method as string) || "typed";
  const typedName = (signedEvent.event_data?.typed_name as string) || env_.recipient_name;

  // 3. Download source PDF.
  const sourceBytes = await downloadStorage(env, "documents", tpl.source_path);

  // 3b. Load the signing key metadata up front. The key id +
  // fingerprint don't depend on the PDF bytes, so we can print them
  // inside the embedded Certificate of Completion. The actual digest
  // + signature can only be computed *after* the final PDF exists —
  // and would be circular if printed inside it — so those go in the
  // sidecar JSON (and the standalone COC, which is a separate file).
  const keyMeta = await loadSealKeyMeta(env);
  const sealPath = `${env_.dsp_id}/seal/${env_.id}.json`;
  const sealStub: SealStub | null = keyMeta
    ? { key_id: keyMeta.key_id, key_fingerprint: keyMeta.key_fingerprint, seal_path: sealPath }
    : null;

  // 4. Stamp the signature into the PDF + append the Certificate of
  // Completion (with the seal stub if we have a key).
  const pdf = await PDFDocument.load(sourceBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  await stampSignature(pdf, env_, sigMethod, sigData, typedName, helvBold);
  await appendCertificate(pdf, env_, tpl, events, helv, helvBold, sealStub, null);
  const sealedBytes = await pdf.save();

  // 5. Cryptographic seal: ECDSA P-256 signature over the sealed PDF's
  // SHA-256 (Phase 1) + an RFC 3161 trusted timestamp on the same
  // digest (Phase 2). Both null if not configured / unreachable.
  let sealInfo = keyMeta ? await signBytes(keyMeta, env_.id, sealedBytes) : null;
  let tsaError: string | null = null;
  if (sealInfo) {
    const ts = await maybeTimestamp(env, sealedBytes);
    if (ts.info) sealInfo = { ...sealInfo, ...ts.info };
    if (ts.error) tsaError = ts.error;
  }
  const sidecarBytes = sealInfo
    ? new TextEncoder().encode(JSON.stringify(sealInfo, null, 2))
    : null;

  // 6. Save the Certificate of Completion as a standalone PDF — this
  // one isn't part of the sealed bytes, so it can print the full
  // digest + signature fingerprint.
  const certPdf = await PDFDocument.create();
  const certHelv = await certPdf.embedFont(StandardFonts.Helvetica);
  const certHelvBold = await certPdf.embedFont(StandardFonts.HelveticaBold);
  await appendCertificate(certPdf, env_, tpl, events, certHelv, certHelvBold, sealStub, sealInfo);
  const certBytes = await certPdf.save();

  // 7. Upload to <dsp>/signed/<envelope>.pdf, <dsp>/certificates/<envelope>.pdf,
  // and (if sealed) <dsp>/seal/<envelope>.json.
  const sealedPath = `${env_.dsp_id}/signed/${env_.id}.pdf`;
  const certPath = `${env_.dsp_id}/certificates/${env_.id}.pdf`;
  // sealPath was computed in step 3b.
  await uploadStorage(env, "documents", sealedPath, sealedBytes, "application/pdf");
  await uploadStorage(env, "documents", certPath,   certBytes,   "application/pdf");
  if (sidecarBytes) {
    await uploadStorage(env, "documents", sealPath, sidecarBytes, "application/json");
  }

  // 8. Update the envelope row with the storage paths.
  await sbPatch(env, `document_envelopes?id=eq.${env_.id}`, {
    signed_pdf_path:      sealedPath,
    certificate_pdf_path: certPath,
    seal_path:            sidecarBytes ? sealPath : null,
  });

  // 9. Append the pdf_sealed event to the audit chain (will be the next
  // event after `signed`).
  await sbRpc(env, "append_document_event_signed_pdf", null).catch(() => {
    /* fall through to the private RPC */
  });
  await sbRpc(env, "document_log_sealed", {
    p_envelope_id:        env_.id,
    p_signed_pdf_path:    sealedPath,
    p_certificate_path:   certPath,
    p_sealed_byte_count:  sealedBytes.byteLength,
  }).catch(async () => {
    // No public wrapper exists — call private.append_document_event
    // directly. The migration 0155 creates a public alias so we don't
    // need to grant on private.
    await sbRpc(env, "append_document_event", {
      p_envelope_id:     env_.id,
      p_kind:            "pdf_sealed",
      p_actor_kind:      "system",
      p_actor_user_id:   null,
      p_actor_driver_id: null,
      p_actor_email:     null,
      p_actor_name:      null,
      p_ip:              null,
      p_user_agent:      "rr-document-sealing/0.1",
      p_event_data: {
        signed_pdf_path:      sealedPath,
        certificate_pdf_path: certPath,
        sealed_byte_count:    sealedBytes.byteLength,
        cert_byte_count:      certBytes.byteLength,
        sealing_algorithm:    "stamp+certificate-v1",
      },
    });
  });

  // 10. If we cryptographically sealed, append a `pdf_signed` event
  // documenting the seal. Best-effort — the sealed PDF + sidecar
  // already make the proof verifiable independently of the chain.
  if (sealInfo) {
    await sbRpc(env, "append_document_event", {
      p_envelope_id:     env_.id,
      p_kind:            "pdf_signed",
      p_actor_kind:      "system",
      p_actor_user_id:   null,
      p_actor_driver_id: null,
      p_actor_email:     null,
      p_actor_name:      null,
      p_ip:              null,
      p_user_agent:      "rr-document-sealing/0.1",
      p_event_data: {
        seal_path:        sealPath,
        pdf_sha256:       sealInfo.pdf_sha256,
        signature_alg:    sealInfo.signature_alg,
        signature_b64:    sealInfo.signature_b64,
        key_id:           sealInfo.key_id,
        key_fingerprint:  sealInfo.key_fingerprint,
        signed_at:        sealInfo.signed_at,
        tsa_url:          sealInfo.tsa_url ?? null,
        tsa_gen_time:     sealInfo.tsa_gen_time ?? null,
        has_tst:          !!sealInfo.tst_b64,
        tsa_error:        sealInfo.tst_b64 ? null : (tsaError ?? null),
      },
    }).catch((err) => {
      console.error("pdf_signed audit log failed", err);
    });
  }

  return {
    ok: true,
    envelope_id:           env_.id,
    signed_pdf_path:       sealedPath,
    certificate_pdf_path:  certPath,
    seal_path:             sidecarBytes ? sealPath : null,
    sealed_byte_count:     sealedBytes.byteLength,
    sealed:                !!sealInfo,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Cryptographic seal (Phase 1) — ECDSA P-256 over the sealed PDF bytes.
// ─────────────────────────────────────────────────────────────────────────

// What we can print inside the *embedded* COC (no PDF digest — that
// would be circular). What we put in the sidecar JSON + standalone COC
// + audit event (the full thing) is SealInfo.
interface SealStub {
  key_id:          string;
  key_fingerprint: string;
  seal_path:       string;
}
interface SealInfo {
  version:         "rr-seal-v1";
  envelope_id:     string;
  pdf_sha256:      string;
  signature_alg:   "ECDSA-P256-SHA256";
  signature_b64:   string;
  key_id:          string;
  key_fingerprint: string;
  public_jwk:      JsonWebKey;
  signed_at:       string;
  // RFC 3161 trusted timestamp on `pdf_sha256` — present only when a
  // TSA was reachable. `tst_b64` is the raw TimeStampResp; verify with
  // `openssl ts -reply -in tst.tsr -text` or any RFC 3161 verifier.
  tsa_url?:        string;
  tsa_gen_time?:   string;   // best-effort parse of the token's genTime
  tst_b64?:        string;
}

interface TimestampInfo {
  tsa_url:       string;
  tsa_gen_time?: string;
  tst_b64:       string;
}

interface SealKeyMeta {
  privKey:         CryptoKey;
  pubJwk:          JsonWebKey;
  key_id:          string;
  key_fingerprint: string;
}

// Imports RR_SIGNING_PRIVATE_JWK and derives the public material +
// fingerprint. Returns null (and logs) when no key is configured or
// the JWK is malformed — callers degrade to unsealed sealing.
async function loadSealKeyMeta(env: Env): Promise<SealKeyMeta | null> {
  if (!env.RR_SIGNING_PRIVATE_JWK) return null;
  let priv: JsonWebKey;
  try {
    priv = JSON.parse(env.RR_SIGNING_PRIVATE_JWK);
  } catch {
    console.error("RR_SIGNING_PRIVATE_JWK is not valid JSON; skipping seal");
    return null;
  }
  try {
    const privKey = await crypto.subtle.importKey(
      "jwk", priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
    );
    const pubJwk: JsonWebKey = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y };
    const pubKey = await crypto.subtle.importKey(
      "jwk", pubJwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"],
    );
    // Fingerprint = first 32 hex chars of SHA-256 over the canonical SPKI bytes.
    const spki = (await crypto.subtle.exportKey("spki", pubKey)) as ArrayBuffer;
    const fpFull = await crypto.subtle.digest("SHA-256", spki);
    const fingerprint = bytesToHex(new Uint8Array(fpFull)).slice(0, 32);
    return {
      privKey,
      pubJwk,
      key_id:          env.RR_SIGNING_KEY_ID || "rr-seal-2026",
      key_fingerprint: fingerprint,
    };
  } catch (err) {
    console.error("failed to import signing key; skipping seal", err);
    return null;
  }
}

// Signs SHA-256(bytes) with the configured ECDSA P-256 key.
async function signBytes(
  meta: SealKeyMeta,
  envelopeId: string,
  bytes: Uint8Array,
): Promise<SealInfo | null> {
  try {
    const pdfDigest = await crypto.subtle.digest("SHA-256", bytes);
    const sig = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, meta.privKey, pdfDigest,
    );
    return {
      version:         "rr-seal-v1",
      envelope_id:     envelopeId,
      pdf_sha256:      bytesToHex(new Uint8Array(pdfDigest)),
      signature_alg:   "ECDSA-P256-SHA256",
      signature_b64:   bytesToBase64(new Uint8Array(sig)),
      key_id:          meta.key_id,
      key_fingerprint: meta.key_fingerprint,
      public_jwk:      meta.pubJwk,
      signed_at:       new Date().toISOString(),
    };
  } catch (err) {
    console.error("seal signing failed; uploading unsealed", err);
    return null;
  }
}

async function loadPublicKeyJwk(env: Env): Promise<JsonWebKey | null> {
  if (!env.RR_SIGNING_PRIVATE_JWK) return null;
  const priv: JsonWebKey = JSON.parse(env.RR_SIGNING_PRIVATE_JWK);
  return { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, key_ops: ["verify"] };
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}
function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

// ─────────────────────────────────────────────────────────────────────────
// RFC 3161 — trusted timestamp on the sealed PDF's SHA-256.
// ─────────────────────────────────────────────────────────────────────────

// Default chain of RFC 3161 TSAs, tried in order. FreeTSA is the
// "ideal" (its TST chains to its own CA you can publish), but it's a
// free volunteer service that's frequently slow/down — so we fall back
// to DigiCert's and Sectigo's public timestamp endpoints, which are
// widely used and accept arbitrary SHA-256 hashes. Override with
// RR_TSA_URL (comma-separated) to use a paid/SLA'd TSA instead.
const DEFAULT_TSA_URLS = [
  "https://freetsa.org/tsr",
  "http://timestamp.digicert.com",
  "http://timestamp.sectigo.com",
];

// Try one TSA endpoint once. Returns the parsed token or a short error
// string describing why it didn't (so callers can surface it).
async function tryOneTsa(tsaUrl: string, reqDer: Uint8Array): Promise<{ info?: TimestampInfo; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const resp = await fetch(tsaUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/timestamp-query",
        "Accept":       "application/timestamp-reply",
      },
      body: reqDer,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = (await resp.text().catch(() => "")).slice(0, 120);
      const e = `${tsaUrl}: HTTP ${resp.status}${txt ? " " + txt : ""}`;
      console.error("TSA non-200", e);
      return { error: e };
    }
    const respDer = new Uint8Array(await resp.arrayBuffer());
    // TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL }
    // status 0 = granted, 1 = grantedWithMods.
    const status = readTsaStatus(respDer);
    if (status !== 0 && status !== 1) {
      const e = `${tsaUrl}: rejected (PKI status ${status})`;
      console.error("TSA rejected", e);
      return { error: e };
    }
    return {
      info: {
        tsa_url:      tsaUrl,
        tsa_gen_time: extractGenTime(respDer) ?? undefined,
        tst_b64:      bytesToBase64(respDer),
      },
    };
  } catch (err) {
    const e = `${tsaUrl}: ${String((err as Error)?.message || err)}`;
    console.error("TSA request failed", e);
    return { error: e };
  } finally {
    clearTimeout(t);
  }
}

// Returns { info } on success or { error } describing why every TSA
// failed. The seal ships either way; { error } is recorded on the
// pdf_signed event so it's visible in the audit view.
async function maybeTimestamp(env: Env, sealedBytes: Uint8Array): Promise<{ info?: TimestampInfo; error?: string }> {
  const urls = env.RR_TSA_URL
    ? env.RR_TSA_URL.split(",").map((s) => s.trim()).filter(Boolean)
    : DEFAULT_TSA_URLS;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", sealedBytes));
    const reqDer = buildTimeStampReq(digest);
    const errs: string[] = [];
    for (const url of urls) {
      // One retry per endpoint — TSAs flake transiently.
      let r = await tryOneTsa(url, reqDer);
      if (!r.info) { await new Promise((res) => setTimeout(res, 800)); r = await tryOneTsa(url, reqDer); }
      if (r.info) return { info: r.info };
      if (r.error) errs.push(r.error);
    }
    const error = "all TSA endpoints failed — " + errs.join(" | ");
    console.error(error);
    return { error };
  } catch (err) {
    const error = "timestamp step failed: " + String((err as Error)?.message || err);
    console.error(error);
    return { error };
  }
}

// Minimal DER builders for the one structure we need:
//   TimeStampReq ::= SEQUENCE {
//     version        INTEGER { v1(1) },
//     messageImprint SEQUENCE { hashAlgorithm AlgorithmIdentifier, hashedMessage OCTET STRING },
//     certReq        BOOLEAN }     -- we ask for the TSA cert to be returned
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return [0x80 | bytes.length, ...bytes];
}
function derTLV(tag: number, value: number[]): number[] {
  return [tag, ...derLen(value.length), ...value];
}
function buildTimeStampReq(sha256Digest: Uint8Array): Uint8Array {
  // AlgorithmIdentifier for SHA-256: SEQUENCE { OID 2.16.840.1.101.3.4.2.1, NULL }
  const sha256Oid = [0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01];
  const algId = derTLV(0x30, [...sha256Oid, 0x05, 0x00]);
  const hashedMessage = derTLV(0x04, Array.from(sha256Digest));
  const messageImprint = derTLV(0x30, [...algId, ...hashedMessage]);
  const version = derTLV(0x02, [0x01]);          // INTEGER 1
  const certReq = derTLV(0x01, [0xff]);          // BOOLEAN TRUE
  const req = derTLV(0x30, [...version, ...messageImprint, ...certReq]);
  return new Uint8Array(req);
}

// Read the integer in TimeStampResp.status.PKIStatusInfo.status (the
// first INTEGER inside the first inner SEQUENCE). Returns -1 on parse
// surprise so callers treat it as a rejection.
function readTsaStatus(der: Uint8Array): number {
  try {
    let p = 0;
    if (der[p++] !== 0x30) return -1;             // outer SEQUENCE
    p += skipLen(der, p);                         // skip outer length
    if (der[p++] !== 0x30) return -1;             // PKIStatusInfo SEQUENCE
    const statusInfoLen = readLen(der, p); p += skipLen(der, p);
    void statusInfoLen;
    if (der[p++] !== 0x02) return -1;             // INTEGER (status)
    const n = readLen(der, p); p += skipLen(der, p);
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 8) | der[p + i];
    return v;
  } catch { return -1; }
}

// Best-effort: walk the DER linearly and return the first GeneralizedTime
// (tag 0x18) as an ISO string. In a TimeStampToken the TSTInfo (which
// contains genTime) precedes the signer certificates in the SignedData
// structure, so the first GeneralizedTime we hit is the timestamp's
// genTime. Returns null on any surprise.
function extractGenTime(der: Uint8Array): string | null {
  try {
    for (let i = 0; i + 2 < der.length; i++) {
      if (der[i] !== 0x18) continue;              // GeneralizedTime
      const len = der[i + 1];
      if (len < 13 || len > 32 || i + 2 + len > der.length) continue;
      const s = new TextDecoder().decode(der.subarray(i + 2, i + 2 + len));
      // GeneralizedTime: YYYYMMDDHHMMSS[.fff]Z
      const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
      if (!m) continue;
      const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? m[7] : ""}Z`;
      const d = new Date(iso);
      if (isNaN(d.getTime())) continue;
      return d.toISOString();
    }
    return null;
  } catch { return null; }
}

function readLen(der: Uint8Array, p: number): number {
  const first = der[p];
  if (first < 0x80) return first;
  const n = first & 0x7f;
  let v = 0;
  for (let i = 1; i <= n; i++) v = (v << 8) | der[p + i];
  return v;
}
function skipLen(der: Uint8Array, p: number): number {
  const first = der[p];
  return first < 0x80 ? 1 : 1 + (first & 0x7f);
}

// ─────────────────────────────────────────────────────────────────────────
// Stamping + Certificate of Completion
// ─────────────────────────────────────────────────────────────────────────

async function stampSignature(
  pdf: PDFDocument,
  envelope: Envelope,
  method: string,
  payload: string,
  typedName: string,
  bold: PDFFont,
) {
  const pages = pdf.getPages();
  const fields = Array.isArray(envelope.fields_snapshot) && envelope.fields_snapshot.length > 0
    ? envelope.fields_snapshot
    : null;

  // Auto-filled field values, all derived from the signing event — the
  // signer never edits these (DocuSign-style "Date Signed" / "Full
  // Name" fields). Date falls back to today if signed_at is missing.
  const signedDate = envelope.signed_at ? new Date(envelope.signed_at) : new Date();
  const dateStr = `${String(signedDate.getUTCMonth() + 1).padStart(2, "0")}/${String(signedDate.getUTCDate()).padStart(2, "0")}/${signedDate.getUTCFullYear()}`;
  const fullName = (typedName || envelope.recipient_name || "").trim();
  const initialsStr = fullName.split(/\s+/).map((p) => p[0]).filter(Boolean).join("").toUpperCase().slice(0, 5) || "—";
  const fieldValues = (envelope.field_values && typeof envelope.field_values === "object") ? envelope.field_values : {};

  if (fields) {
    for (const f of fields) {
      const kind = f.kind || "signature";
      if (!["signature", "date", "name", "initials", "text", "checkbox"].includes(kind)) continue;
      const pageIdx = Math.max(0, Math.min(pages.length - 1, (f.page ?? 1) - 1));
      const page = pages[pageIdx];
      const { width: pw, height: ph } = page.getSize();
      // Field coords are stored as fractions of the page (0..1) with
      // origin at the top-left; pdf-lib's origin is bottom-left, so flip y.
      const x = (f.x ?? 0.6) * pw;
      const w = (f.w ?? 0.3) * pw;
      const h = (f.h ?? 0.08) * ph;
      const y = ph - ((f.y ?? 0.85) * ph) - h;
      if (kind === "date")          drawAutoTextBox(page, x, y, w, h, dateStr, "Date", bold);
      else if (kind === "name")     drawAutoTextBox(page, x, y, w, h, fullName, "Name", bold);
      else if (kind === "initials") drawAutoTextBox(page, x, y, w, h, initialsStr, "Initials", bold);
      else if (kind === "text")     drawAutoTextBox(page, x, y, w, h, String((f.id && (fieldValues as Record<string, unknown>)[f.id]) ?? ""), f.label || "", bold);
      else if (kind === "checkbox") drawCheckboxBox(page, x, y, w, h, !!(f.id && (fieldValues as Record<string, unknown>)[f.id]), f.label || "", bold);
      else                          await drawSignatureBox(pdf, page, x, y, w, h, method, payload, typedName, bold);
    }
  } else {
    // Default placement: bottom-right of the last page.
    const page = pages[pages.length - 1];
    const { width: pw, height: ph } = page.getSize();
    const w = pw * 0.32;
    const h = ph * 0.07;
    const x = pw - w - pw * 0.06;
    const y = ph * 0.08;
    await drawSignatureBox(pdf, page, x, y, w, h, method, payload, typedName, bold);
  }
}

async function drawSignatureBox(
  pdf: PDFDocument,
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  method: string,
  payload: string,
  typedName: string,
  bold: PDFFont,
) {
  // Thin label above the box so the signer's name + timestamp are clear.
  page.drawText("Signed by " + typedName, {
    x, y: y + h + 4, size: 8, font: bold, color: rgb(0.18, 0.22, 0.30),
  });

  if (method === "drawn" && payload.startsWith("data:image/")) {
    // Decode the data URL and embed the PNG (drawn signatures use PNG).
    const comma = payload.indexOf(",");
    if (comma > 0) {
      const isPng = payload.slice(0, comma).includes("image/png");
      const raw = atob(payload.slice(comma + 1));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const img = isPng ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
      // Fit the signature image inside the box, preserving aspect.
      const scale = Math.min(w / img.width, h / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      page.drawImage(img, { x: x + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
    }
  } else {
    // Typed name — render in a script-ish way using bold italic-ish
    // Helvetica (pdf-lib's bundled fonts are limited; the typed name is
    // visually weighted to read as a signature without a custom font).
    const size = Math.min(h * 0.85, 28);
    page.drawText(typedName || payload || "", {
      x: x + 6, y: y + (h - size) / 2 + 2, size, font: bold, color: rgb(0.06, 0.10, 0.18),
    });
  }

  // Thin underline under the signature.
  page.drawLine({
    start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 },
    thickness: 0.6, color: rgb(0.55, 0.60, 0.70),
  });
}

// An auto-filled text field (Date / Name / Initials) — the value comes
// from the signing event, never from something the signer typed. Drawn
// in its box (left-aligned, shrunk to fit width) with a small caption
// above and an underline, mirroring the signature box.
function drawAutoTextBox(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  value: string,
  caption: string,
  bold: PDFFont,
) {
  page.drawText(caption, {
    x, y: y + h + 4, size: 8, font: bold, color: rgb(0.18, 0.22, 0.30),
  });
  const txt = value || "—";
  let size = Math.min(h * 0.62, 16);
  // Shrink to fit the box width.
  while (size > 6 && bold.widthOfTextAtSize(txt, size) > w - 8) size -= 0.5;
  page.drawText(txt, {
    x: x + 4,
    y: y + (h - size) / 2 + 2,
    size, font: bold, color: rgb(0.06, 0.10, 0.18),
  });
  page.drawLine({
    start: { x, y: y - 2 }, end: { x: x + w, y: y - 2 },
    thickness: 0.6, color: rgb(0.55, 0.60, 0.70),
  });
}

// A recipient-completed checkbox: a small square at the left of the
// box, marked "X" when the signer checked it, with the field's label
// to its right. Nothing is drawn for an unchecked box's mark, so a
// "no" reads as a clear empty square.
function drawCheckboxBox(
  page: PDFPage,
  x: number, y: number, w: number, h: number,
  checked: boolean,
  label: string,
  bold: PDFFont,
) {
  const box = Math.min(h * 0.7, 14, w * 0.5);
  const bx = x;
  const by = y + (h - box) / 2;
  page.drawRectangle({
    x: bx, y: by, width: box, height: box,
    borderColor: rgb(0.30, 0.34, 0.42), borderWidth: 1,
    color: rgb(1, 1, 1),
  });
  if (checked) {
    const s = box * 1.05;
    page.drawText("X", {
      x: bx + (box - bold.widthOfTextAtSize("X", s)) / 2,
      y: by + (box - s) / 2 + s * 0.18,
      size: s, font: bold, color: rgb(0.06, 0.10, 0.18),
    });
  }
  const lbl = (label || "").trim();
  if (lbl) {
    let size = Math.min(box * 0.92, 11);
    const maxW = w - box - 6;
    let txt = lbl;
    while (size > 6 && bold.widthOfTextAtSize(txt, size) > maxW) {
      if (bold.widthOfTextAtSize(txt + "…", size) > maxW && txt.length > 1) txt = txt.slice(0, -1);
      else size -= 0.5;
    }
    if (txt !== lbl) txt = txt.replace(/…?$/, "…");
    page.drawText(txt, {
      x: bx + box + 5, y: y + (h - size) / 2 + 1,
      size, font: bold, color: rgb(0.18, 0.22, 0.30),
    });
  }
}

async function appendCertificate(
  pdf: PDFDocument,
  envelope: Envelope,
  template: Template,
  events: AuditEvent[],
  helv: PDFFont,
  bold: PDFFont,
  // stub is safe to print inside the embedded COC (no circular digest);
  // full carries pdf_sha256 + signature and is only passed when we're
  // building the standalone COC (a separate file).
  sealStub: SealStub | null,
  sealFull: SealInfo | null,
) {
  let page = pdf.addPage([612, 792]); // US Letter
  const { width: pw } = page.getSize();
  let cursorY = 740;
  const margin = 48;
  const innerW = pw - margin * 2;

  const writeLine = (text: string, opts?: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb> }) => {
    if (cursorY < 60) {
      page = pdf.addPage([612, 792]);
      cursorY = 740;
    }
    page.drawText(text, {
      x: margin, y: cursorY,
      size: opts?.size ?? 10,
      font: opts?.font ?? helv,
      color: opts?.color ?? rgb(0.10, 0.13, 0.20),
      maxWidth: innerW,
    });
    cursorY -= (opts?.size ?? 10) + 4;
  };

  // Header.
  writeLine("Certificate of Completion", { font: bold, size: 22, color: rgb(0.05, 0.08, 0.15) });
  cursorY -= 6;
  writeLine("This certificate documents the electronic-signature event on the attached document.", { color: rgb(0.34, 0.40, 0.50) });
  cursorY -= 10;

  // Document section.
  writeLine("DOCUMENT", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  writeLine(template.title, { font: bold, size: 12 });
  writeLine("SHA-256 (at send):  " + envelope.doc_hash_at_send, { size: 9, color: rgb(0.34, 0.40, 0.50) });
  if (envelope.doc_hash_at_sign) {
    writeLine("SHA-256 (at sign):  " + envelope.doc_hash_at_sign, { size: 9, color: rgb(0.34, 0.40, 0.50) });
    if (envelope.doc_hash_at_sign === envelope.doc_hash_at_send) {
      writeLine("Hashes match — the document was not altered between send and sign.", { color: rgb(0.04, 0.56, 0.41) });
    } else {
      writeLine("WARNING: hashes do not match — document may have changed between send and sign.", { font: bold, color: rgb(0.88, 0.18, 0.28) });
    }
  }
  cursorY -= 6;

  // Signer.
  writeLine("SIGNER", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  writeLine(envelope.recipient_name + "  <" + envelope.recipient_email + ">", { font: bold, size: 11 });
  if (envelope.signed_at) writeLine("Signed at:  " + new Date(envelope.signed_at).toISOString());
  cursorY -= 6;

  // Audit chain.
  writeLine("AUDIT TRAIL  (hash-chained, append-only)", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
  for (const e of events) {
    const who = e.actor_kind + (e.actor_name ? " · " + e.actor_name : "");
    const meta = [e.ip ? "ip " + e.ip : null, e.user_agent ? truncate(e.user_agent, 60) : null].filter(Boolean).join("  ·  ");
    writeLine(humanKind(e.kind) + "  ·  " + new Date(e.created_at).toISOString(), { font: bold, size: 10 });
    writeLine("  " + who + (meta ? "  ·  " + meta : ""), { size: 9, color: rgb(0.34, 0.40, 0.50) });
    writeLine("  hash  " + e.event_hash, { size: 8, color: rgb(0.50, 0.55, 0.65) });
    cursorY -= 2;
  }

  // Cryptographic seal section. Inside the *embedded* COC we can only
  // safely print the key id / fingerprint + a pointer to the sidecar
  // (printing the PDF's own SHA-256 would be circular). The standalone
  // COC gets the full digest + signature because it's a separate file.
  if (sealStub) {
    cursorY -= 6;
    writeLine("CRYPTOGRAPHIC SEAL  (ECDSA P-256)", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
    writeLine("Key id:      " + sealStub.key_id + "  (fingerprint " + sealStub.key_fingerprint + ")", { size: 9, color: rgb(0.34, 0.40, 0.50) });
    if (sealFull) {
      writeLine("Algorithm:   " + sealFull.signature_alg, { size: 9, color: rgb(0.34, 0.40, 0.50) });
      writeLine("PDF SHA-256: " + sealFull.pdf_sha256,    { size: 9, color: rgb(0.34, 0.40, 0.50) });
      writeLine("Sealed at:   " + sealFull.signed_at,     { size: 9, color: rgb(0.34, 0.40, 0.50) });
      writeLine("Signature (base64, raw r||s):", { size: 8, color: rgb(0.34, 0.40, 0.50) });
      for (const chunk of wrapText(sealFull.signature_b64, 86)) {
        writeLine("  " + chunk, { size: 7, color: rgb(0.50, 0.55, 0.65) });
      }
      if (sealFull.tst_b64) {
        cursorY -= 4;
        writeLine("RFC 3161 TRUSTED TIMESTAMP", { font: bold, size: 9, color: rgb(0.34, 0.40, 0.50) });
        writeLine("Authority:   " + (sealFull.tsa_url || "(unspecified)"), { size: 9, color: rgb(0.34, 0.40, 0.50) });
        if (sealFull.tsa_gen_time) {
          writeLine("Attested time: " + sealFull.tsa_gen_time + "  (by the TSA, not by RouteReady)", { size: 9, color: rgb(0.04, 0.40, 0.34) });
        }
        writeLine("The TimeStampToken (base64) is in " + sealStub.seal_path + " as tst_b64; verify with: openssl ts -reply -in tst.tsr -text", { size: 8, color: rgb(0.34, 0.40, 0.50) });
      }
    } else {
      writeLine("The PDF SHA-256, signature, public key, and (if any) RFC 3161 timestamp live next to the sealed PDF at " + sealStub.seal_path + ".", { size: 8, color: rgb(0.34, 0.40, 0.50) });
    }
    writeLine("Public key is also served at GET /public-key on the sealing service.", { size: 8, color: rgb(0.34, 0.40, 0.50) });
  }

  // Footer.
  cursorY -= 8;
  writeLine("Issued by RouteReady  ·  rr-document-sealing/0.9", { size: 8, color: rgb(0.50, 0.55, 0.65) });
  writeLine("Verify the integrity of this record at any time via the dashboard's audit trail.", { size: 8, color: rgb(0.50, 0.55, 0.65) });
}

function wrapText(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

function humanKind(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ─────────────────────────────────────────────────────────────────────────
// Tiny Supabase REST + Storage client
// ─────────────────────────────────────────────────────────────────────────

async function sb<T>(env: Env, path: string): Promise<T[]> {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: "application/json",
    },
  });
  if (!r.ok) throw new Error("supabase_select_failed: " + r.status + " " + (await r.text()));
  return (await r.json()) as T[];
}

async function sbPatch(env: Env, path: string, body: Record<string, unknown>) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("supabase_patch_failed: " + r.status + " " + (await r.text()));
}

async function sbRpc(env: Env, fn: string, params: Record<string, unknown> | null) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params ?? {}),
  });
  if (!r.ok) throw new Error("supabase_rpc_failed: " + r.status + " " + (await r.text()));
}

async function downloadStorage(env: Env, bucket: string, path: string): Promise<ArrayBuffer> {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error("storage_download_failed: " + r.status + " " + (await r.text()));
  return await r.arrayBuffer();
}

async function uploadStorage(env: Env, bucket: string, path: string, bytes: Uint8Array, contentType: string) {
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!r.ok) throw new Error("storage_upload_failed: " + r.status + " " + (await r.text()));
}

// ─────────────────────────────────────────────────────────────────────────

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
