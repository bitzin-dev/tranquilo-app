// The shipped /api/img budget: roomy enough that a person scrolling the
// feed never meets it.
import { describe, expect, it } from "vitest";
import { TRANQUILO_CONFIG } from "../lib/config.generated.ts";

const limits = TRANQUILO_CONFIG.img_visitor_rate_limit;
const pageSize = TRANQUILO_CONFIG.feed.page_size;

// Highest per-minute image demand measured from a real fast scroller.
const FAST_SCROLLER_IMAGES_PER_MINUTE = 120;

describe("shipped image rate limit", () => {
  it("absorbs a session opening two feed pages at once", () => {
    expect(limits.capacity).toBeGreaterThanOrEqual(pageSize * 2);
  });

  it("refills faster than a fast scroller requests images", () => {
    expect(limits.refill_per_sec * 60).toBeGreaterThan(
      FAST_SCROLLER_IMAGES_PER_MINUTE,
    );
  });
});
