// Canonical JSON + SHA-256 for the idempotency contract (SPEC §8).

import { createHash } from "node:crypto";

/** Deterministic JSON: object keys sorted, undefined values dropped. */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(",")}}`;
}

export function inputsHash(input: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalize(input))
    .digest("hex");
  return `sha256:${digest}`;
}
