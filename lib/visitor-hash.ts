// Pseudonymous visitor key for rate-limit buckets and denial counters, so no
// raw IP address is stored. A keyed hash of the address and the UTC date:
// stable within a day (a bucket keeps counting), unlinkable across days, and
// not reversible by trying every IPv4 address without the key.
//
// The key is derived from ITEMS_CURSOR_SECRET under its own label, so
// rotating that secret also rotates every visitor key. Without a secret, a
// production/AWS runtime falls back to an unkeyed hash of the same inputs so
// limiting still applies (reversible by brute force; a warning is logged
// once). Elsewhere, such as local dev and tests, callers get null and skip
// the budget.

import { createHash, createHmac } from "node:crypto";

const KEY_LABEL = "visitor-hash-v1";
const UNKEYED_LABEL = "visitor-hash-v1-unkeyed";
const KEY_LENGTH = 16;

let warnedUnkeyed = false;

function failsSafeWithoutSecret(): boolean {
  return (
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME) ||
    process.env.VERCEL_ENV === "production"
  );
}

export function visitorKey(
  ip: string | null,
  secret: string | undefined = process.env.ITEMS_CURSOR_SECRET,
  now: Date = new Date(),
): string | null {
  if (!ip) return null;
  const day = now.toISOString().slice(0, 10);
  if (secret) {
    const key = createHmac("sha256", secret).update(KEY_LABEL).digest();
    return createHmac("sha256", key)
      .update(`${day}|${ip}`)
      .digest("hex")
      .slice(0, KEY_LENGTH);
  }
  if (!failsSafeWithoutSecret()) return null;
  if (!warnedUnkeyed) {
    warnedUnkeyed = true;
    console.warn(
      "ITEMS_CURSOR_SECRET is not set; rate limits are keyed by an unkeyed IP hash",
    );
  }
  return createHash("sha256")
    .update(`${UNKEYED_LABEL}|${day}|${ip}`)
    .digest("hex")
    .slice(0, KEY_LENGTH);
}
