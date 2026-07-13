// ─── adapters/base.js · supplier-adapter contract + resilience ─────────────
//
// Every supplier connector implements the SAME interface so the search
// orchestrator can treat them uniformly and one supplier's failure never
// fails the whole search. Supplier-specific logic stays inside its adapter —
// never leaks into the core engine.
//
// The adapter CONTRACT (methods an adapter may implement; all optional except
// `key`/`label`/`sourceType` and at least one of search/lookup):
//   key            string   stable id ('manual','nhtsa','rockauto',…)
//   label          string   human name
//   sourceType     'api'|'feed'|'affiliate_api'|'crawler'|'manual'
//   searchParts(query, vehicle, opts) -> Promise<RawOffer[]>
//   lookupPartNumber(pn, vehicle)     -> Promise<RawOffer[]>
//   getOffer(id)                      -> Promise<RawOffer>
//   checkAvailability(id)             -> Promise<{availability, quantity}>
//   getDeliveryEstimate(id, dest)     -> Promise<{min,max}>
//   getCompatibility(pn, vehicle)     -> Promise<{claim, evidence[]}>
//   normalizeOffer(raw)               -> NormalizedOffer   (→ parts_offer_save shape)
//   healthCheck()                     -> Promise<{ok, latencyMs, error?}>
//
// This module provides the shared resilience primitives adapters wrap their
// network calls in. Pure + injectable clock/sleep so it is testable in node
// (scripts/test-parts-adapters.mjs) with no real timers or network.

// ── Rate limiter · token-bucket, per-adapter ───────────────────────────
export class RateLimiter {
  constructor(perMinute = 60, now = Date.now) {
    this.capacity = Math.max(1, perMinute);
    this.tokens = this.capacity;
    this.refillPerMs = this.capacity / 60000;
    this.last = now();
    this._now = now;
  }
  _refill() {
    const t = this._now();
    this.tokens = Math.min(this.capacity, this.tokens + (t - this.last) * this.refillPerMs);
    this.last = t;
  }
  tryRemove() { this._refill(); if (this.tokens >= 1) { this.tokens -= 1; return true; } return false; }
  // ms until the next token is available (0 if one is ready now).
  msUntilToken() { this._refill(); return this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) / this.refillPerMs); }
}

// ── Circuit breaker · open after N consecutive failures, half-open later ─
export class CircuitBreaker {
  constructor(opts = {}) {
    this.threshold = opts.threshold || 5;
    this.cooldownMs = opts.cooldownMs || 30000;
    this._now = opts.now || Date.now;
    this.failures = 0;
    this.state = "closed"; // closed | open | half_open
    this.openedAt = 0;
  }
  canRequest() {
    if (this.state === "open") {
      if (this._now() - this.openedAt >= this.cooldownMs) { this.state = "half_open"; return true; }
      return false;
    }
    return true;
  }
  onSuccess() { this.failures = 0; this.state = "closed"; }
  onFailure() {
    this.failures += 1;
    if (this.state === "half_open" || this.failures >= this.threshold) {
      this.state = "open"; this.openedAt = this._now();
    }
  }
}

// ── withResilience · timeout + retry(+backoff) around an async fn ───────
// opts: { retries, baseDelayMs, timeoutMs, sleep, now, breaker, onRetry }
// A thrown error after exhausting retries propagates; the caller (orchestrator)
// converts it into a per-source error so other sources still return.
export async function withResilience(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const breaker = opts.breaker;

  if (breaker && !breaker.canRequest()) {
    const err = new Error("circuit_open");
    err.code = "circuit_open";
    throw err;
  }

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const out = await withTimeout(fn, timeoutMs);
      if (breaker) breaker.onSuccess();
      return out;
    } catch (e) {
      lastErr = e;
      if (breaker) breaker.onFailure();
      if (attempt < retries) {
        // Exponential backoff with full jitter, bounded, deterministic-friendly.
        const jitter = typeof opts.jitter === "number" ? opts.jitter : 0.5;
        const delay = Math.round(base * Math.pow(2, attempt) * (1 + jitter));
        if (opts.onRetry) opts.onRetry(attempt + 1, e, delay);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function withTimeout(fn, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; const e = new Error("timeout"); e.code = "timeout"; reject(e); } }, ms);
    Promise.resolve()
      .then(fn)
      .then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
      .catch((e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
  });
}

// ── makeAdapter · wraps a raw adapter with its limiter + breaker so the ──
// orchestrator gets uniform, resilient, health-reporting instances.
export function makeAdapter(spec, cfg = {}) {
  const limiter = new RateLimiter(cfg.rateLimitPerMin || 60, cfg.now);
  const breaker = new CircuitBreaker({ threshold: cfg.breakerThreshold || 5, cooldownMs: cfg.cooldownMs, now: cfg.now });
  const resil = (fn) => withResilience(fn, {
    retries: cfg.retries, timeoutMs: cfg.timeoutMs, sleep: cfg.sleep, breaker,
    onRetry: cfg.onRetry,
  });
  const wrapped = {
    key: spec.key, label: spec.label, sourceType: spec.sourceType,
    _limiter: limiter, _breaker: breaker,
    async searchParts(q, v, o) {
      if (!spec.searchParts) return [];
      if (!limiter.tryRemove()) { const e = new Error("rate_limited"); e.code = "rate_limited"; throw e; }
      return resil(() => spec.searchParts(q, v, o));
    },
    async lookupPartNumber(pn, v) {
      if (!spec.lookupPartNumber) return [];
      if (!limiter.tryRemove()) { const e = new Error("rate_limited"); e.code = "rate_limited"; throw e; }
      return resil(() => spec.lookupPartNumber(pn, v));
    },
    normalizeOffer: spec.normalizeOffer ? (raw) => spec.normalizeOffer(raw) : (raw) => raw,
    async healthCheck() {
      if (!spec.healthCheck) return { ok: breaker.state !== "open", latencyMs: 0, state: breaker.state };
      try {
        const start = (cfg.now || Date.now)();
        const r = await resil(() => spec.healthCheck());
        return { ok: true, latencyMs: (cfg.now || Date.now)() - start, state: breaker.state, ...r };
      } catch (e) {
        return { ok: false, error: e.code || e.message, state: breaker.state };
      }
    },
  };
  return wrapped;
}
