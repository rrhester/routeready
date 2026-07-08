# RouteReady design system — the road to world-class consistency

World-class products (Linear, Stripe, Figma) read as *one system*. The single
biggest thing separating RouteReady's UI from that bar is **consistency**: it
defines 284 design tokens but bypasses them with thousands of raw values.

Measured baseline (shipped stylesheets, see `scripts/design-baseline.json`):

| Raw value (should be a token) | Count |
|---|--:|
| Raw hex colors in property values | ~2,900 |
| `!important` overrides | ~3,600 |
| Literal (non-token) font-sizes | ~1,100 |

## The ratchet (enforcement — live now)

`scripts/design-lint.mjs` + `.github/workflows/design-lint.yml` measure those
counts and **fail any PR that increases them.** The debt can now only shrink.
This is the important first step: it stops the inconsistency from growing while
the pay-down happens incrementally.

```
node scripts/design-lint.mjs            # check (what CI runs)
node scripts/design-lint.mjs --update   # lower the baseline after a real reduction
```

## Why we did NOT mass-replace hex → token

Tempting, but unsafe. The current 284 tokens are a **flat pile with duplicate
values and mismatched names** — e.g. muted body-grey `#6b7280` equals
`--rr-route-c-other`, and primary blue `#2563eb` equals `--sidebar-active`.
A blind `#6b7280` → `var(--rr-route-c-other)` swap is pixel-identical *today*
but couples unrelated things: change the route colour later and your body text
changes with it. That makes the system **more** fragile, not world-class.

## The pay-down: a coherent, layered token set

The right migration is to a proper hierarchy, then move usages onto it:

**1. Primitives** — the actual palette, derived from what's already used most:

| Primitive | Value | (today's raw hex it replaces) |
|---|---|---|
| `--rr-blue-600` (primary) | `#2563eb` | 203× |
| `--rr-blue-700` (primary-hover) | `#1d4ed8` | 64× |
| `--rr-ink-900` (headings) | `#111827` | 56× |
| `--rr-slate-900` (sidebar/ink) | `#0f172a` | 121× |
| `--rr-grey-500` (muted text) | `#6b7280` | 66× |
| `--rr-red-600` (danger) | `#dc2626` | 52× |
| `--rr-green-600` (success) | `#16a34a` | 49× |
| `--rr-amber-700` (warning) | `#b45309` | 27× |
| `--rr-canvas` (page bg) | `#f9fafb` | 40× |
| `--rr-surface` (cards) | `#ffffff` | 467× |
| `--rr-border` | `#e5e7eb` | 27× |

**2. Semantic aliases** — components reference these, never a primitive or hex:
`--c-primary`, `--c-primary-hover`, `--c-text`, `--c-text-muted`,
`--c-surface`, `--c-canvas`, `--c-border`, `--c-danger`, `--c-success`,
`--c-warning`.

**3. Migrate incrementally**, one metric / one file at a time, **each batch
verified** with the local Playwright harness (`.claude/skills/verify`) —
screenshot before/after to prove nothing shifts — then `--update` the baseline.

Same idea for `!important` (raise specificity properly or scope, don't add
`!important`) and font-sizes (a type scale: `--fs-xs … --fs-2xl`, several of
which already exist).
