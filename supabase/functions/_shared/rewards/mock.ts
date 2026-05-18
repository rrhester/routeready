// Mock reward provider.
//
// Used when REWARD_PROVIDER is unset, set to "mock", or when a real
// provider's credentials aren't configured.  Generates a deterministic
// fake provider_reward_id + a placeholder claim URL that lands on a
// static "Mock reward · sandbox" page hosted under the dashboard
// origin.  Lets the whole product be developed and demoed end-to-end
// without spending a cent or touching a third-party API.

import type {
  RewardProvider,
  RewardSendInput,
  RewardSendResult,
} from "./types.ts";

export class MockRewardProvider implements RewardProvider {
  slug = "mock";
  mode: "sandbox" | "production" = "sandbox";

  async send(input: RewardSendInput): Promise<RewardSendResult> {
    // Cheap deterministic id so re-sends with the same externalId are
    // idempotent at the row level — the dashboard would never call us
    // twice for one order but it's still nice to have.
    const id = `mock_${input.externalId.slice(0, 8)}`;
    const claimUrl = `https://gorouteready.com/rewards/claim/${encodeURIComponent(id)}`;
    return {
      ok: true,
      provider: this.slug,
      providerRewardId: id,
      claimUrl,
      raw: {
        provider: "mock",
        note: "Simulated reward — no real value attached.",
        amount_cents: input.amountCents,
        reward_type: input.rewardType,
      },
    };
  }
}
