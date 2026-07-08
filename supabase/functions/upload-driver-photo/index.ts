// upload-driver-photo · Receives the driver's profile photo from the PWA.
//
// Public endpoint (anon-callable) that validates the driver's session
// token before writing to storage. Stores at "<driver_id>/avatar.<ext>"
// in the public driver-photos bucket so an <img src> can render the
// result without further auth.
//
// Body (multipart/form-data):
//   token : driver session token (same one used elsewhere in the app)
//   photo : the file (image/jpeg, image/png, image/webp, image/heic)
//
// Returns: { photo_url, photo_path }
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, x-client-info, apikey",
  "access-control-allow-methods": "POST, OPTIONS",
};

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB
// HEIC included so iPhone defaults work without converting; we hand
// whatever extension came in and trust the bucket to serve it.
const ALLOWED_MIME: Record<string, string> = {
  "image/jpeg":   "jpg",
  "image/png":    "png",
  "image/webp":   "webp",
  "image/heic":   "heic",
  "image/heif":   "heif",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  let form: FormData;
  try { form = await req.formData(); }
  catch { return jsonRespCors({ error: "invalid_form_data" }, 400); }

  const token = String(form.get("token") ?? "");
  const file  = form.get("photo");
  if (!token) return jsonRespCors({ error: "token_required" }, 400);
  if (!(file instanceof File)) return jsonRespCors({ error: "photo_required" }, 400);
  if (file.size > MAX_BYTES) return jsonRespCors({ error: "file_too_large" }, 413);

  const ext = ALLOWED_MIME[file.type];
  if (!ext) return jsonRespCors({ error: "unsupported_mime: " + file.type }, 415);

  const supa = serviceClient();

  // Validate the driver's session token by hitting the same RPC the
  // rest of the app uses. driver_me throws on bad/revoked tokens.
  const { data: me, error: meErr } = await supa.rpc("driver_me", { p_token: token });
  if (meErr || !me?.id) {
    return jsonRespCors({ error: "invalid_or_expired_token" }, 403);
  }

  const objectPath = `${me.id}/avatar.${ext}`;
  const buf = new Uint8Array(await file.arrayBuffer());

  const { error: upErr } = await supa.storage.from("driver-photos").upload(
    objectPath, buf, { contentType: file.type, upsert: true },
  );
  if (upErr) return jsonRespCors({ error: "upload_failed: " + upErr.message }, 500);

  const { error: setErr } = await supa.rpc("driver_set_photo", {
    p_token: token, p_path: objectPath,
  });
  if (setErr) return jsonRespCors({ error: "set_photo_failed: " + setErr.message }, 500);

  // Private bucket (migration 0446) → hand back a signed URL the client can
  // render directly. The service role bypasses RLS, and the unique token is
  // its own cache-buster. photo_path is always returned so the client can
  // re-sign later via driver_me even if signing hiccups here.
  const { data: signed } = await supa.storage
    .from("driver-photos")
    .createSignedUrl(objectPath, 7 * 24 * 60 * 60);

  return jsonRespCors({ ok: true, photo_url: signed?.signedUrl ?? null, photo_path: objectPath });
});

function jsonRespCors(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });
}
