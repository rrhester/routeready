// Tremendous reward provider.
//
// API docs: https://developers.tremendous.com/
// Cost model: Tremendous itself charges $0 platform fee — you pay only
// the face value of the reward you send.  Sandbox mode is fully free
// (no real cards issued) and you can develop end-to-end against
// testflight.tremendous.com with a free API key.
//
// Env vars consumed:
//   TREMENDOUS_API_KEY        — required.  Sandbox key from
//                               https://testflight.tremendous.com/rewards/api
//                               OR production key from app.tremendous.com.
//   TREMENDOUS_ENV            — "sandbox" | "production".  Defaults to
//                               "sandbox" so a stray production key
//                               can't accidentally bill an org.
//   TREMENDOUS_FUNDING_SOURCE — required in production; optional in
//                               sandbox (defaults to "BALANCE").  Get
//                               from https://app.tremendous.com/rewards/funding-sources
//   TREMENDOUS_CAMPAIGN_ID    — optional.  If set, every order uses
//                               this campaign's product list, which
//                               supersedes the per-type product map
//                               below.  Recommended for production —
//                               lets you curate the redemption page
//                               (logo, color, products) without a
//                               redeploy.
//
// Delivery: we use delivery.method = "LINK", which returns a hosted
// redemption URL we hand to the driver app.  We never ask Tremendous
// to email the driver — RouteReady owns the notification surface.

import type {
  RewardProvider,
  RewardSendInput,
  RewardSendResult,
  RewardType,
} from "./types.ts";

// Tremendous product ids — these are the live ids from the public
// Tremendous catalog.  In sandbox they return mock claim URLs; in
// production they issue real cards.  If TREMENDOUS_CAMPAIGN_ID is set
// we ignore this map entirely and let Tremendous render the campaign's
// curated catalog instead.
//
// Looked up via GET /products on the Tremendous API.  Source of truth:
// https://developers.tremendous.com/docs/reward-options
const PRODUCT_IDS: Record<RewardType, string[]> = {
  amazon:     ["OKMHM2X2OHYV"],            // Amazon.com Gift Card
  visa:       ["Q24BD9EZ332JT"],            // Visa Reward Card
  walmart:    ["FYVW2RP10VR1"],             // Walmart Gift Card
  gas_card:   ["FYVW2RP10VR1", "OKMHM2X2OHYV"], // Walmart + Amazon (no Tremendous "gas-only" SKU; both stations + commerce)
  restaurant: ["G65JOA9P9CK7", "EQS47Z0OL58F"], // DoorDash + Uber Eats
  // "general" → broadest catalog.  Driver picks at redemption time.
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

export class TremendousRewardProvider implements RewardProvider {
  slug = "tremendous";
  mode: "sandbox" | "production";
  private apiKey: string;
  private baseUrl: string;
  private fundingSource: string;
  private campaignId: string | null;

  constructor() {
    const key = Deno.env.get("TREMENDOUS_API_KEY");
    if (!key) throw new Error("TREMENDOUS_API_KEY not set");
    this.apiKey = key;

    const env = (Deno.env.get("TREMENDOUS_ENV") || "sandbox").toLowerCase();
    this.mode = env === "production" ? "production" : "sandbox";
    this.baseUrl = this.mode === "production"
      ? "https://api.tremendous.com/api/v2"
      : "https://testflight.tremendous.com/api/v2";

    this.fundingSource = Deno.env.get("TREMENDOUS_FUNDING_SOURCE") || "BALANCE";
    this.campaignId    = Deno.env.get("TREMENDOUS_CAMPAIGN_ID") || null;
  }

  async send(input: RewardSendInput): Promise<RewardSendResult> {
    // Tremendous expects amounts as decimal dollars, not cents.
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
      // custom_fields are surfaced on the redemption page if the
      // campaign exposes them; otherwise Tremendous ignores them.
      reward.custom_fields = [{ id: "note", value: input.message.slice(0, 280) }];
    }

    const body = {
      external_id: input.externalId,
      payment: { funding_source_id: this.fundingSource },
      reward,
    };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/orders`, {
        method: "POST",
        headers: {
          "authorization": `Bearer ${this.apiKey}`,
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
      raw: {
        order_id: orderId,
        mode: this.mode,
      },
    };
  }
}
