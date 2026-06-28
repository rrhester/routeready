// ADP/HRIS status + sync + disconnect for the caller's DSP, via Finch. JWT-gated;
// browser-called through supabase.functions.invoke → needs CORS. Body:
//   { action: "status" }      → { connected, provider, last_synced_at, employee_count, configured }
//   { action: "sync" }        → pull the roster from Finch, upsert finch_employees → { synced }
//   { action: "disconnect" }  → revoke at Finch (best-effort) + drop the connection
import { serviceClient, jsonResponse } from "../_shared/supabase.ts";
import { decryptSecret, getDirectory, getEmployment, disconnect, isConfigured } from "../_shared/finch.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, authorization, apikey, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, { status: 405, headers: CORS });

  const supa = serviceClient();
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(jwt);
  if (!user) return jsonResponse({ error: "unauthorized" }, { status: 401, headers: CORS });
  const { data: appUser } = await supa.from("app_users").select("dsp_id").eq("id", user.id).single();
  if (!appUser?.dsp_id) return jsonResponse({ error: "no_dsp" }, { status: 403, headers: CORS });
  const dspId = appUser.dsp_id;

  const { action } = await req.json().catch(() => ({ action: "status" }));

  const { data: conn } = await supa.from("finch_connections")
    .select("provider_id, provider_name, status, last_synced_at, employee_count, access_token_enc, access_token_iv")
    .eq("dsp_id", dspId).maybeSingle();

  // ── status ──
  if (action === "status" || !action) {
    return jsonResponse({
      connected: !!conn,
      configured: isConfigured(),
      provider_id: conn?.provider_id || null,
      provider_name: conn?.provider_name || null,
      status: conn?.status || null,
      last_synced_at: conn?.last_synced_at || null,
      employee_count: conn?.employee_count || 0,
    }, { headers: CORS });
  }

  if (!conn) return jsonResponse({ error: "not_connected" }, { status: 409, headers: CORS });

  // ── disconnect ──
  if (action === "disconnect") {
    try {
      const token = await decryptSecret(conn.access_token_enc, conn.access_token_iv);
      await disconnect(token);
    } catch (_) { /* best-effort */ }
    await supa.from("finch_employees").delete().eq("dsp_id", dspId);
    await supa.from("finch_connections").delete().eq("dsp_id", dspId);
    return jsonResponse({ ok: true }, { headers: CORS });
  }

  // ── sync ──
  if (action === "sync") {
    let token: string;
    try {
      token = await decryptSecret(conn.access_token_enc, conn.access_token_iv);
    } catch (_) {
      return jsonResponse({ error: "token_unreadable" }, { status: 500, headers: CORS });
    }
    try {
      const directory = await getDirectory(token);
      const ids = directory.map((d) => d.id).filter(Boolean);
      const employment = await getEmployment(token, ids);

      const rows = directory.map((d) => {
        const emp = employment.get(d.id) || {};
        const empObj = (emp.employment as Record<string, unknown>) || {};
        return {
          dsp_id: dspId,
          finch_individual_id: d.id,
          first_name: d.first_name ?? (emp.first_name as string) ?? null,
          last_name: d.last_name ?? (emp.last_name as string) ?? null,
          email: ((emp.emails as Array<{ data?: string }>)?.[0]?.data) ?? null,
          department: d.department?.name ?? (emp.department as { name?: string })?.name ?? null,
          manager_name: null, // directory exposes manager id only; left for the mapping pass
          title: (emp.title as string) ?? null,
          employment_status: (empObj.subtype as string) ?? (empObj.type as string) ?? null,
          is_active: d.is_active ?? (emp.is_active as boolean) ?? null,
          start_date: (emp.start_date as string) ?? null,
          raw: { directory: d, employment: emp },
          synced_at: new Date().toISOString(),
        };
      });

      if (rows.length) {
        // Upsert in chunks so a large roster doesn't exceed payload limits.
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await supa.from("finch_employees")
            .upsert(rows.slice(i, i + 500), { onConflict: "dsp_id,finch_individual_id" });
          if (error) throw new Error(error.message);
        }
      }

      await supa.from("finch_connections").update({
        status: "connected",
        last_synced_at: new Date().toISOString(),
        last_sync_status: "ok",
        last_error: null,
        employee_count: rows.length,
        updated_at: new Date().toISOString(),
      }).eq("dsp_id", dspId);

      return jsonResponse({ synced: rows.length }, { headers: CORS });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await supa.from("finch_connections").update({
        status: "error", last_sync_status: "error", last_error: msg, updated_at: new Date().toISOString(),
      }).eq("dsp_id", dspId);
      return jsonResponse({ error: "sync_failed", message: msg }, { status: 502, headers: CORS });
    }
  }

  return jsonResponse({ error: "unknown_action" }, { status: 400, headers: CORS });
});
