// webhook-apply · Public applicant intake.
//
// Two callers:
//   1. The /apply page on gorouteready.com submits the form here.
//   2. Indeed / ZipRecruiter / referral form posts (with shared-secret).
//
// The function calls intake_applicant() and, if dsp.metadata.sms.auto_send_screening
// is true and the applicant has a phone, also queues a screening invite.
//
// Abuse posture (project-review PR#57): caller #1 is an anonymous browser
// form, so this endpoint cannot hard-require a secret — which previously
// made it an SMS-pumping surface (any POST queued an SMS to an
// attacker-chosen phone, no limits). Brakes, all server-side:
//   - if APPLY_SHARED_SECRET is set it is REQUIRED (timing-safe compare);
//   - auto-send SMS is deduped per phone (one screening invite per number
//     per 24h, regardless of how many applications are posted);
//   - auto-send is capped per DSP per hour (default 20, override via
//     dsp.metadata.sms.apply_autosend_hourly_cap) — intake still succeeds
//     past the cap, only the SMS is skipped and logged.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APPLY_SHARED_SECRET (optional)
import { serviceClient, jsonResponse, badRequest } from "../_shared/supabase.ts";
import { corsHeaders, timingSafeEqual } from "../_shared/http.ts";

const CORS = corsHeaders("x-apply-secret");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return badRequest("method_not_allowed", 405);

  const expected = Deno.env.get("APPLY_SHARED_SECRET");
  const provided = req.headers.get("x-apply-secret") || "";
  if (expected && !timingSafeEqual(provided, expected)) {
    return badRequest("forbidden", 403);
  }

  const payload = await req.json().catch(() => null);
  if (!payload) return badRequest("invalid_json");

  const supa = serviceClient();
  const { data: applicant, error } = await supa.rpc("intake_applicant", { p_payload: payload });
  if (error) {
    // Stable error code; the raw PG message goes to logs, not the caller.
    console.error("intake_applicant failed:", error.message);
    return new Response(JSON.stringify({ error: "intake_failed" }), {
      status: 400, headers: { "content-type": "application/json", ...CORS },
    });
  }

  // Auto-send screening if the DSP opted in.
  const { data: dsp } = await supa.from("dsps").select("metadata").eq("id", applicant.dsp_id).single();
  const autoSend = dsp?.metadata?.sms?.auto_send_screening !== false;

  if (autoSend && applicant.phone && applicant.status === "applied") {
    // Brake 1 · per-phone dedupe: if ANY outbound SMS went to this number in
    // the last 24h, don't queue another. Kills repeat-pumping to one number
    // and double-invites from applicants who submit twice.
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: recentToPhone } = await supa.from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("to_phone", applicant.phone)
      .eq("direction", "outbound")
      .gte("created_at", dayAgo);
    if ((recentToPhone ?? 0) > 0) {
      console.log("apply_autosend_skipped", JSON.stringify({ reason: "phone_dedupe_24h", dsp_id: applicant.dsp_id }));
      return okResponse(applicant.id);
    }

    // Brake 2 · per-DSP hourly cap on intake-triggered sends. An attacker
    // scripting many numbers hits this ceiling; real hiring bursts can
    // raise it per-DSP in metadata.
    const cap = Number(dsp?.metadata?.sms?.apply_autosend_hourly_cap ?? 20);
    const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
    const { count: lastHour } = await supa.from("sms_messages")
      .select("id", { count: "exact", head: true })
      .eq("dsp_id", applicant.dsp_id)
      .eq("direction", "outbound")
      .not("applicant_id", "is", null)
      .gte("created_at", hourAgo);
    if ((lastHour ?? 0) >= cap) {
      console.error("apply_autosend_skipped", JSON.stringify({ reason: "dsp_hourly_cap", dsp_id: applicant.dsp_id, cap }));
      return okResponse(applicant.id);
    }

    // Use the screening RPC via service client (it'll skip the is_staff
    // gate because security definer + service role bypasses RLS).
    // We can't call it directly though — it checks current_dsp_id which
    // returns null for the service role. So we replicate its essentials
    // here: stamp a token, queue the SMS row.
    const token = crypto.randomUUID().replace(/-/g, "");
    const md = applicant.metadata ?? {};
    md.tokens = { ...(md.tokens ?? {}), screening: token };
    await supa.from("applicants").update({ metadata: md, status: "contacted" }).eq("id", applicant.id);

    const baseUrl = (dsp?.metadata?.public_base_url) ?? "https://gorouteready.com";
    const link = `${baseUrl}/s/${token}`;

    const { data: tpl } = await supa.from("message_templates")
      .select("body").eq("dsp_id", applicant.dsp_id)
      .eq("channel", "sms").eq("key", "applicant.invite_screening")
      .eq("active", true).single();

    if (tpl) {
      const body = tpl.body
        .replace(/\{\{first_name\}\}/g, applicant.first_name ?? applicant.full_name)
        .replace(/\{\{link\}\}/g, link);
      await supa.from("sms_messages").insert({
        dsp_id: applicant.dsp_id, applicant_id: applicant.id,
        direction: "outbound", status: "queued",
        to_phone: applicant.phone, body,
      });
    }
  }

  return okResponse(applicant.id);
});

function okResponse(applicantId: string) {
  return new Response(JSON.stringify({ ok: true, applicant_id: applicantId }), {
    headers: { "content-type": "application/json", ...CORS },
  });
}
