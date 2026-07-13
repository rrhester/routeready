#!/usr/bin/env node
// Tests for dashboard/parts/adapters/base.js — the supplier-adapter resilience
// primitives (rate limiter, circuit breaker, retry/backoff/timeout wrapper).
// Run: node scripts/test-parts-adapters.mjs (also part of `npm test`).

import assert from "node:assert/strict";
import {
  RateLimiter, CircuitBreaker, withResilience, makeAdapter,
} from "../dashboard/parts/adapters/base.js";

let passed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; })
    .catch((e) => { console.error(`✗ ${name}\n  ${e.message}`); process.exitCode = 1; });
}

// A controllable clock so timing is deterministic (no real timers).
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    // sleep that just advances the clock — makes backoff instant + testable.
    sleep: (ms) => { t += ms; return Promise.resolve(); },
  };
}

await t("RateLimiter allows up to capacity, then refills over time", () => {
  const clk = fakeClock();
  const rl = new RateLimiter(60, clk.now); // 60/min = 1/sec
  let allowed = 0;
  for (let i = 0; i < 60; i++) if (rl.tryRemove()) allowed++;
  assert.equal(allowed, 60);
  assert.equal(rl.tryRemove(), false);        // bucket empty
  assert.ok(rl.msUntilToken() > 0);
  clk.advance(1000);                          // 1s → +1 token
  assert.equal(rl.tryRemove(), true);
});

await t("withResilience retries then succeeds, counting attempts", async () => {
  const clk = fakeClock();
  let calls = 0;
  const out = await withResilience(async () => { calls++; if (calls < 3) throw new Error("flaky"); return "ok"; },
    { retries: 3, baseDelayMs: 10, jitter: 0, sleep: clk.sleep });
  assert.equal(out, "ok");
  assert.equal(calls, 3);
});

await t("withResilience gives up after exhausting retries and throws last error", async () => {
  const clk = fakeClock();
  let calls = 0;
  await assert.rejects(
    () => withResilience(async () => { calls++; throw new Error("down"); }, { retries: 2, baseDelayMs: 5, jitter: 0, sleep: clk.sleep }),
    /down/);
  assert.equal(calls, 3); // initial + 2 retries
});

await t("withResilience enforces a timeout", async () => {
  await assert.rejects(
    () => withResilience(() => new Promise(() => {}), { retries: 0, timeoutMs: 5 }),
    (e) => e.code === "timeout");
});

await t("CircuitBreaker opens after threshold and half-opens after cooldown", () => {
  const clk = fakeClock();
  const cb = new CircuitBreaker({ threshold: 3, cooldownMs: 1000, now: clk.now });
  assert.ok(cb.canRequest());
  cb.onFailure(); cb.onFailure(); cb.onFailure();
  assert.equal(cb.state, "open");
  assert.equal(cb.canRequest(), false);       // blocked while open
  clk.advance(1000);
  assert.equal(cb.canRequest(), true);         // half-open after cooldown
  assert.equal(cb.state, "half_open");
  cb.onSuccess();
  assert.equal(cb.state, "closed");            // recovery closes it
});

await t("withResilience short-circuits when the breaker is open", async () => {
  const clk = fakeClock();
  const cb = new CircuitBreaker({ threshold: 1, cooldownMs: 1000, now: clk.now });
  cb.onFailure(); // open it
  await assert.rejects(
    () => withResilience(async () => "never", { breaker: cb, retries: 0, sleep: clk.sleep }),
    (e) => e.code === "circuit_open");
});

await t("makeAdapter enforces rate limit and reports health", async () => {
  const clk = fakeClock();
  const spec = {
    key: "x", label: "X", sourceType: "api",
    async searchParts() { return [{ id: 1 }]; },
    async healthCheck() { return { ok: true }; },
  };
  const a = makeAdapter(spec, { rateLimitPerMin: 1, now: clk.now, sleep: clk.sleep });
  const first = await a.searchParts("q", {});
  assert.deepEqual(first, [{ id: 1 }]);
  await assert.rejects(() => a.searchParts("q", {}), (e) => e.code === "rate_limited");
  const h = await a.healthCheck();
  assert.equal(h.ok, true);
});

await t("makeAdapter one failing adapter does not throw synchronously (isolatable)", async () => {
  const clk = fakeClock();
  const bad = makeAdapter({ key: "b", label: "B", sourceType: "api", async searchParts() { throw new Error("boom"); } },
    { retries: 0, now: clk.now, sleep: clk.sleep });
  // The orchestrator catches per-adapter; here we just prove it rejects cleanly.
  await assert.rejects(() => bad.searchParts("q", {}), /boom/);
});

// Print after the microtask queue drains.
await Promise.resolve();
setTimeout(() => console.log(`✓ parts-adapters: ${passed} tests passed`), 0);
