// Reward provider factory.
//
// The send-driver-reward edge function calls getProvider() once per
// invocation.  Resolution order:
//
//   1. REWARD_PROVIDER env var.  Recognised values: "mock" (default),
//      "tremendous".
//   2. If a real provider is selected but its required env vars are
//      missing, we log a warning and fall back to mock — never silently
//      send nothing.  Operators see the "Mock" pill in the dashboard
//      so this is visible.
//
// Adding a provider: implement RewardProvider in a new file under this
// directory, add a case below, and document its env vars at the top
// of the implementation file.

import type { RewardProvider } from "./types.ts";
import { MockRewardProvider } from "./mock.ts";
import { TremendousRewardProvider } from "./tremendous.ts";

export function getProvider(): RewardProvider {
  const slug = (Deno.env.get("REWARD_PROVIDER") || "mock").toLowerCase();

  if (slug === "tremendous") {
    try {
      return new TremendousRewardProvider();
    } catch (e) {
      console.warn(`tremendous provider unavailable, falling back to mock: ${(e as Error).message}`);
      return new MockRewardProvider();
    }
  }

  return new MockRewardProvider();
}

export type { RewardProvider, RewardSendInput, RewardSendResult } from "./types.ts";
