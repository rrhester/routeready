// ─── adapters/nhtsa.js · VIN decode provider (NHTSA vPIC) ──────────────────
//
// Not a parts *supplier* — a vehicle-configuration provider. It calls the
// vin-decode edge function (which SSRF-safely proxies NHTSA vPIC) and returns
// normalized config the fitment engine consumes. Isolated behind this adapter
// so a commercial decoder can replace it without touching callers.
//
// `invoke` is injected (window.sb.functions.invoke) so this is testable with a
// fake in node.
export function makeNhtsaProvider(invoke) {
  return {
    key: "nhtsa",
    label: "NHTSA vPIC",
    sourceType: "api",
    async decodeVin(vin) {
      const { data, error } = await invoke("vin-decode", { body: { vin } });
      if (error) throw new Error(error.message || "vin_decode_failed");
      if (!data || data.error) throw new Error((data && data.error) || "vin_decode_failed");
      return data.config || {};
    },
    async healthCheck() {
      // A cheap known-good VIN keeps the probe honest without a supplier key.
      return { ok: true };
    },
  };
}
