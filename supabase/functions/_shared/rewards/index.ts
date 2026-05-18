// Reward provider factory.
//
// Two ways to resolve a provider:
//
//   1. getProviderForDsp(dspId) — the production path.  Looks up the
//      DSP's OAuth-granted access token in dsp_reward_integrations,
//      refreshes it if expired, and returns a per-DSP provider
//      instance.  Falls back to the mock provider when the DSP hasn't
//      connected yet (so dev / demo flows keep working end-to-end).
//
//   2. getMockProvider() — direct mock instance for cases where a DSP
//      context isn't available yet (preview surfaces, fixtures, …).
//
// Adding a new provider: implement RewardProvider, wire credentials
// onto dsp_reward_integrations (or its own table), and add a branch
// here keyed on the integration row's `provider` slug.

import type { RewardProvider } from "./types.ts";
import { MockRewardProvider } from "./mock.ts";
import { TremendousRewardProvider } from "./tremendous.ts";
import { serviceClient } from "../supabase.ts";

export interface ResolvedProvider {
  provider: RewardProvider;
  /** Set when the resolved provider is backed by a DSP integration. */
  integration?: {
    dsp_id:           string;
    provider:         string;
    funding_source_id: string | null;
    provider_account_id: string | null;
  };
  /** True when we fell back to mock because the DSP isn't connected. */
  fellBackToMock: boolean;
}

export function getMockProvider(): RewardProvider {
  return new MockRewardProvider();
}

/**
 * Resolves the reward provider for a specific DSP.  Handles token
 * refresh when expired; returns mock when the DSP has no integration
 * (so the dashboard's "uncomplicated demo" path still works).
 */
export async function getProviderForDsp(dspId: string): Promise<ResolvedProvider> {
  const admin = serviceClient();
  const { data: row } = await admin
    .from("dsp_reward_integrations")
    .select("dsp_id, provider, access_token, refresh_token, token_expires_at, provider_account_id, funding_source_id")
    .eq("dsp_id", dspId)
    .eq("provider", "tremendous")
    .maybeSingle();

  if (!row || !row.access_token) {
    return { provider: new MockRewardProvider(), fellBackToMock: true };
  }

  // Refresh if expired (or within 60s of expiry — small buffer).
  let accessToken = row.access_token as string;
  if (row.token_expires_at && row.refresh_token) {
    const expiresAt = new Date(row.token_expires_at as string).getTime();
    if (expiresAt - Date.now() < 60_000) {
      const refreshed = await refreshTremendousToken(row.refresh_token as string, dspId);
      if (refreshed) accessToken = refreshed;
    }
  }

  return {
    provider: new TremendousRewardProvider({
      accessToken,
      fundingSourceId: row.funding_source_id as string | null,
    }),
    integration: {
      dsp_id:              row.dsp_id as string,
      provider:            row.provider as string,
      funding_source_id:   row.funding_source_id as string | null,
      provider_account_id: row.provider_account_id as string | null,
    },
    fellBackToMock: false,
  };
}

async function refreshTremendousToken(refreshToken: string, dspId: string): Promise<string | null> {
  const clientId     = Deno.env.get("TREMENDOUS_OAUTH_CLIENT_ID");
  const clientSecret = Deno.env.get("TREMENDOUS_OAUTH_CLIENT_SECRET");
  const tokenUrl     = Deno.env.get("TREMENDOUS_OAUTH_TOKEN_URL") || "https://www.tremendous.com/oauth/token";
  if (!clientId || !clientSecret) return null;

  try {
    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "accept":       "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type:    "refresh_token",
        refresh_token: refreshToken,
        client_id:     clientId,
        client_secret: clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`tremendous token refresh failed for dsp ${dspId}: ${res.status} ${errBody}`);
      await serviceClient()
        .from("dsp_reward_integrations")
        .update({ last_error: `refresh_failed:${res.status}`, last_error_at: new Date().toISOString() })
        .eq("dsp_id", dspId)
        .eq("provider", "tremendous");
      return null;
    }
    const json = await res.json();
    const newAccess  = json?.access_token as string | undefined;
    const newRefresh = json?.refresh_token as string | undefined;
    const expiresIn  = typeof json?.expires_in === "number" ? json.expires_in : null;
    if (!newAccess) return null;

    await serviceClient()
      .from("dsp_reward_integrations")
      .update({
        access_token:     newAccess,
        refresh_token:    newRefresh || refreshToken,
        token_expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
        last_error:       null,
        last_error_at:    null,
      })
      .eq("dsp_id", dspId)
      .eq("provider", "tremendous");
    return newAccess;
  } catch (e) {
    console.warn(`tremendous token refresh network error for dsp ${dspId}`, e);
    return null;
  }
}

export type { RewardProvider, RewardSendInput, RewardSendResult } from "./types.ts";
