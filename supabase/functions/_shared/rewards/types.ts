// Reward provider interface.
//
// Every provider implementation (mock, tremendous, tango, giftogram, …)
// exposes the same `send` contract.  The send-driver-reward edge
// function resolves a provider via getProvider() in ./index.ts based on
// the REWARD_PROVIDER env var, then calls `send` with a normalized
// payload it built from the dispatcher's request.
//
// Providers are stateless — they take a payload, hit their API, and
// return either a success result (with a claim_url + provider_reward_id)
// or a failure result (with a human-readable reason).  They never
// touch the database; persistence happens in the edge function.

export type RewardType =
  | "amazon"
  | "visa"
  | "walmart"
  | "gas_card"
  | "restaurant"
  | "general";

export interface RewardSendInput {
  /** Order id we generate so providers can dedupe retries. */
  externalId: string;
  /** Reward face value in cents. */
  amountCents: number;
  /** ISO 4217 — currently always "USD". */
  currency: string;
  /** Catalog bucket — provider maps this to its own product id(s). */
  rewardType: RewardType;
  recipient: {
    name: string;
    email?: string | null;
    phone?: string | null;
  };
  sender: {
    name: string;
    dspName: string;
  };
  /** Short note shown to the recipient inside the redemption flow. */
  message?: string | null;
}

export interface RewardSendSuccess {
  ok: true;
  /** Provider slug — stored on the row so we can debug later. */
  provider: string;
  /** Provider's order id. */
  providerRewardId: string;
  /** URL the driver opens to redeem the reward. */
  claimUrl: string;
  /** Any extra fields the provider returned (stored as-is in metadata). */
  raw?: Record<string, unknown>;
}

export interface RewardSendFailure {
  ok: false;
  provider: string;
  /** Short machine-readable code (e.g. "provider_error", "invalid_amount"). */
  code: string;
  /** Human-readable detail safe to surface to dispatchers. */
  message: string;
  raw?: Record<string, unknown>;
}

export type RewardSendResult = RewardSendSuccess | RewardSendFailure;

export interface RewardProvider {
  /** Slug used to identify which provider handled a given reward. */
  slug: string;
  /** "sandbox" | "production" — exposed so we can render a pill in the UI. */
  mode: "sandbox" | "production";
  send(input: RewardSendInput): Promise<RewardSendResult>;
}
