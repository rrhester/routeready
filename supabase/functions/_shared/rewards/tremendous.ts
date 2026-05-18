// Tremendous reward provider.
//
// API docs: https://developers.tremendous.com/
//
// Credentials are passed in via the constructor — there are no env
// vars to read here, because every DSP brings their own OAuth-granted
// access token (see migration 0303 + tremendous-oauth-callback).  The
// edge function looks the DSP's row up in dsp_reward_integrations
// and instantiates this class per request.
//
// What's still env-driven:
//   TREMENDOUS_API_BASE — defaults to production
//                         (https://api.tremendous.com/api/v2); flip
//                         to https://testflight.tremendous.com/api/v2
//                         for sandbox testing.
//
// Delivery: we use delivery.method = "LINK", which returns a hosted
// redemption URL we hand to the driver app.

import type {
  RewardProvider,
  RewardSendInput,
  RewardSendResult,
  RewardType,
} from "./types.ts";

const DEFAULT_API_BASE = "https://api.tremendous.com/api/v2";

// Tremendous product ids — live ids from the public catalog.  Each
// DSP's connected account decides which of these are actually
// available based on their account settings.  Adjust freely; the
// caller's account either accepts them or returns a clean error we
// surface back as failure_reason.
const PRODUCT_IDS: Record<RewardType, string[]> = {
  amazon:     ["OKMHM2X2OHYV"],
  visa:       ["Q24BD9EZ332JT"],
  walmart:    ["FYVW2RP10VR1"],
  gas_card:   ["FYVW2RP10VR1", "OKMHM2X2OHYV"],
  restaurant: ["G65JOA9P9CK7", "EQS47Z0OL58F"],
  general:    ["OKMHM2X2OHYV", "Q24BD9EZ332JT", "FYVW2RP10VR1", "G65JOA9P9CK7"],
};

interface TremendousOrderResponse {
  order?: {
    id?: string;
    rewards?: Array<{
      id?: string;
      delivery?: { link?: string; status?: string };
    }>;
  };
  errors?: { message?: string; payload?: unknown };
}

export interface TremendousProviderOpts {
  accessToken:      string;
  fundingSourceId?: string | null;
  /** Optional Tremendous campaign id; takes precedence over the per-type product map. */
  campaignId?:      string | null;
  /** "sandbox" | "production"; affects the surfaced mode pill only. */
  mode?:            "sandbox" | "production";
  /** Override API base for sandbox.  Defaults to TREMENDOUS_API_BASE env or production URL. */
  apiBase?:         string;
}

export class TremendousRewardProvider implements RewardProvider {
  slug = "tremendous";
  mode: "sandbox" | "production";
  private accessToken: string;
  private fundingSourceId: string | null;
  private campaignId:      string | null;
  private apiBase:         string;

  constructor(opts: TremendousProviderOpts) {
    if (!opts.accessToken) throw new Error("tremendous_access_token_required");
    this.accessToken     = opts.accessToken;
    this.fundingSourceId = opts.fundingSourceId || null;
    this.campaignId      = opts.campaignId      || null;
    this.apiBase         = (opts.apiBase || Deno.env.get("TREMENDOUS_API_BASE") || DEFAULT_API_BASE).replace(/\/$/, "");
    this.mode            = opts.mode || (this.apiBase.includes("testflight") ? "sandbox" : "production");
  }

  async send(input: RewardSendInput): Promise<RewardSendResult> {
    const value = +(input.amountCents / 100).toFixed(2);

    const reward: Record<string, unknown> = {
      value: { denomination: value, currency_code: input.currency || "USD" },
      recipient: { name: input.recipient.name },
      delivery: { method: "LINK" },
    };

    if (this.campaignId) {
      reward.campaign_id = this.campaignId;
    } else {
      reward.products = PRODUCT_IDS[input.rewardType] || PRODUCT_IDS.general;
    }

    if (input.message) {
      reward.custom_fields = [{ id: "note", value: input.message.slice(0, 280) }];
    }

    const body: Record<string, unknown> = {
      external_id: input.externalId,
      reward,
    };
    if (this.fundingSourceId) {
      body.payment = { funding_source_id: this.fundingSourceId };
    }

    let res: Response;
    try {
      res = await fetch(`${this.apiBase}/orders`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.accessToken}`,
          "content-type": "application/json",
          "accept":       "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return {
        ok: false,
        provider: this.slug,
        code: "network_error",
        message: `Could not reach Tremendous: ${(e as Error).message || "fetch failed"}`,
      };
    }

    let json: TremendousOrderResponse = {};
    try { json = await res.json() as TremendousOrderResponse; } catch { /* leave empty */ }

    if (!res.ok) {
      const detail = json?.errors?.message || `HTTP ${res.status}`;
      return {
        ok: false,
        provider: this.slug,
        code: `tremendous_${res.status}`,
        message: detail,
        raw: json as unknown as Record<string, unknown>,
      };
    }

    const orderId = json?.order?.id;
    const rewardEntry = json?.order?.rewards?.[0];
    const claimUrl = rewardEntry?.delivery?.link;

    if (!orderId || !claimUrl) {
      return {
        ok: false,
        provider: this.slug,
        code: "tremendous_missing_link",
        message: "Tremendous accepted the order but did not return a claim link.",
        raw: json as unknown as Record<string, unknown>,
      };
    }

    return {
      ok: true,
      provider: this.slug,
      providerRewardId: rewardEntry?.id || orderId,
      claimUrl,
      raw: { order_id: orderId, mode: this.mode },
    };
  }
}
