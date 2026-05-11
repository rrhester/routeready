// document-verify · public envelope verification
//
// Backs the /verify/<signing_token> page. Given an envelope's signing
// token (32 random bytes — the capability), returns everything a third
// party needs to independently verify the record:
//   • envelope metadata + the full audit timeline (hashes included)
//   • whether the hash chain still verifies (document_chain_ok_by_token)
//   • the cryptographic seal sidecar (public key, ECDSA signature over
//     the sealed PDF's SHA-256, RFC 3161 TimeStampToken) if present
//   • short-lived signed URLs for the sealed PDF + Certificate of
//     Completion so the page can re-hash the PDF and offer downloads
//
// No bearer/apikey required — deployed --no-verify-jwt. The token is
// the auth. We deliberately do NOT expose recipient IP / user-agent on
// the public response (those stay in the dashboard audit view); the
// sealed PDF's Certificate-of-Completion pages carry them if a verifier
// needs that level of detail.
//
// Input: GET ?token=<hex>   or   POST { token: "<hex>" }
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected).
import { serviceClient } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin":  "*",
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  let token: string | null = null;
  if (req.method === "GET") {
    token = new URL(req.url).searchParams.get("token");
  } else if (req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as { token?: string };
    token = body?.token ?? null;
  } else {
    return json({ error: "method_not_allowed" }, 405);
  }
  token = (token || "").trim();
  if (!token || !/^[a-f0-9]{16,128}$/i.test(token)) {
    return json({ found: false, error: "bad_token" }, 400);
  }

  const supa = serviceClient();

  const { data: env, error: envErr } = await supa
    .from("document_envelopes")
    .select(
      "id, status, recipient_name, recipient_email, sent_at, viewed_at, signed_at, declined_at, voided_at, expires_at, doc_hash_at_send, doc_hash_at_sign, signed_pdf_path, certificate_pdf_path, seal_path, document_templates(title)",
    )
    .eq("signing_token", token)
    .maybeSingle();
  if (envErr) return json({ found: false, error: "lookup_failed" }, 500);
  if (!env)   return json({ found: false });

  const envelopeId = env.id as string;

  const [{ data: events }, { data: chainOk }] = await Promise.all([
    supa
      .from("document_events")
      .select("id, kind, actor_kind, actor_name, actor_email, event_data, prev_event_hash, event_hash, created_at")
      .eq("envelope_id", envelopeId)
      .order("id"),
    supa.rpc("document_chain_ok_by_token", { p_signing_token: token }),
  ]);

  // Pull the seal sidecar JSON (if the worker produced one).
  let seal: unknown = null;
  if (env.seal_path) {
    const { data: blob } = await supa.storage.from("documents").download(env.seal_path as string);
    if (blob) {
      try { seal = JSON.parse(await blob.text()); } catch { /* ignore malformed sidecar */ }
    }
  }

  // Short-lived signed URLs for the artifacts.
  const sign = async (p: string | null | undefined) => {
    if (!p) return null;
    const { data } = await supa.storage.from("documents").createSignedUrl(p, 60 * 10);
    return data?.signedUrl ?? null;
  };
  const [signedPdfUrl, certPdfUrl] = await Promise.all([
    sign(env.signed_pdf_path as string | null),
    sign(env.certificate_pdf_path as string | null),
  ]);

  const tpl = env.document_templates as { title?: string } | null;

  return json({
    found: true,
    envelope: {
      id:               envelopeId,
      status:           env.status,
      document_title:   tpl?.title ?? null,
      recipient_name:   env.recipient_name,
      recipient_email:  env.recipient_email,
      sent_at:          env.sent_at,
      viewed_at:        env.viewed_at,
      signed_at:        env.signed_at,
      declined_at:      env.declined_at,
      voided_at:        env.voided_at,
      expires_at:       env.expires_at,
      doc_hash_at_send: env.doc_hash_at_send,
      doc_hash_at_sign: env.doc_hash_at_sign,
    },
    events: (events ?? []).map((e) => ({
      id:              e.id,
      kind:            e.kind,
      actor_kind:      e.actor_kind,
      actor_name:      e.actor_name,
      actor_email:     e.actor_email,
      event_data:      e.event_data,
      prev_event_hash: e.prev_event_hash,
      event_hash:      e.event_hash,
      created_at:      e.created_at,
    })),
    chain_ok: chainOk === true ? true : (chainOk === false ? false : null),
    seal,
    signed_pdf_url:      signedPdfUrl,
    certificate_pdf_url: certPdfUrl,
  });
});
