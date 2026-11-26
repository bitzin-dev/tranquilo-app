// An email goes out while a visitor is crossing the line, not the next
// morning, so there is still a scrape to block. Each crossing alerts once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIREWALL_URL,
  VISITOR_ACTIVE_HOURS_MIN,
  VISITOR_ACTIVE_MIN_ITEMS,
  VISITOR_DAILY_ITEMS_MIN,
  VISITOR_DENIED_COST_MIN,
} from "../lib/items-abuse-alert.ts";
import {
  itemsRateLimitOrRespond,
  quoteRateLimitOrRespond,
} from "../lib/items-rate-limit.ts";
import { makeSql } from "./helpers/pg.ts";

type Sql = Awaited<ReturnType<typeof makeSql>>;

const ROOMY = { capacity: 1e9, refill_per_sec: 1e6, enforce: true };
const TIGHT = { capacity: 100, refill_per_sec: 0.0001, enforce: true };

function res() {
  return {
    statusCode: 200,
    setHeader() {},
    json() {},
  };
}
const from = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

let sql: Sql;
let fetchMock: ReturnType<typeof vi.fn>;

const emails = () =>
  fetchMock.mock.calls.filter(
    ([url]) => url === "https://api.resend.com/emails",
  );
const emailsAbout = (subject: string) =>
  emails().filter(([, init]) =>
    (JSON.parse(init.body as string).subject as string).includes(subject),
  );
const lastEmailText = () =>
  JSON.parse(emails().at(-1)?.[1].body as string).text as string;

beforeEach(async () => {
  vi.stubEnv("ITEMS_CURSOR_SECRET", "test-secret");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("OPS_ALERT_EMAIL", "ops@example.com");
  fetchMock = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  sql = await makeSql([
    "035_visitor_rate_state.sql",
    "060_visitor_budget_events.sql",
    "065_visitor_spent.sql",
  ]);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await sql.$close();
});

const read = (ip: string, cost: number, limits = ROOMY) =>
  itemsRateLimitOrRespond(sql, from(ip), res(), cost, limits);

describe("a visitor served a very large number of items", () => {
  it("is emailed once, at the moment the day's total passes the limit", async () => {
    const step = VISITOR_DAILY_ITEMS_MIN / 4;
    for (let i = 0; i < 3; i++) await read("203.0.113.1", step);
    expect(emails()).toHaveLength(0);
    await read("203.0.113.1", step);
    expect(emails()).toHaveLength(1);
    await read("203.0.113.1", step);
    await read("203.0.113.1", step);
    expect(emails()).toHaveLength(1);
  });

  it("says where to block, since the visitor key carries no address", async () => {
    await read("203.0.113.1", VISITOR_DAILY_ITEMS_MIN);
    const text = lastEmailText();
    expect(text).toContain(FIREWALL_URL);
    expect(text).toContain("/api/items");
    expect(text).toContain(String(VISITOR_DAILY_ITEMS_MIN));
  });

  it("stays quiet for ordinary browsing", async () => {
    for (let i = 0; i < 20; i++) await read("203.0.113.1", 120);
    expect(emails()).toHaveLength(0);
  });
});

describe("a visitor reading steadily across many hours", () => {
  async function visitorKeyFor(ip: string) {
    const { visitorKey } = await import("../lib/visitor-hash.ts");
    return visitorKey(ip, "test-secret") as string;
  }

  it("is emailed once reading has run long enough with real volume", async () => {
    const key = await visitorKeyFor("203.0.113.2");
    await sql.query(
      "INSERT INTO visitor_fetch_state (ip, tokens, capacity, refill_per_sec, last_refill, first_seen, updated_at, spent) " +
        "VALUES ($1, 1e9, 1e9, 1e6, now(), now() - make_interval(hours => $2::int), now(), $3::bigint)",
      [`items:${key}`, VISITOR_ACTIVE_HOURS_MIN, VISITOR_ACTIVE_MIN_ITEMS],
    );
    await read("203.0.113.2", 10);
    expect(emails()).toHaveLength(1);
    await read("203.0.113.2", 10);
    expect(emails()).toHaveLength(1);
  });

  it("ignores a long day with little reading", async () => {
    const key = await visitorKeyFor("203.0.113.2");
    await sql.query(
      "INSERT INTO visitor_fetch_state (ip, tokens, capacity, refill_per_sec, last_refill, first_seen, updated_at, spent) " +
        "VALUES ($1, 1e9, 1e9, 1e6, now(), now() - make_interval(hours => $2::int), now(), $3::bigint)",
      [`items:${key}`, VISITOR_ACTIVE_HOURS_MIN + 8, 200],
    );
    await read("203.0.113.2", 10);
    expect(emails()).toHaveLength(0);
  });

  it("ignores heavy reading in a short span", async () => {
    const key = await visitorKeyFor("203.0.113.2");
    await sql.query(
      "INSERT INTO visitor_fetch_state (ip, tokens, capacity, refill_per_sec, last_refill, first_seen, updated_at, spent) " +
        "VALUES ($1, 1e9, 1e9, 1e6, now(), now() - make_interval(hours => 1), now(), $2::bigint)",
      [`items:${key}`, VISITOR_ACTIVE_MIN_ITEMS],
    );
    await read("203.0.113.2", 10);
    expect(emails()).toHaveLength(0);
  });
});

describe("a visitor kept hammering after being refused", () => {
  it("is emailed once, as refusals add up to the limit", async () => {
    await read("203.0.113.3", 60, TIGHT);
    const refusals = Math.ceil(VISITOR_DENIED_COST_MIN / 60);
    for (let i = 0; i < refusals - 1; i++) await read("203.0.113.3", 60, TIGHT);
    expect(emailsAbout("keeps hitting")).toHaveLength(0);
    await read("203.0.113.3", 60, TIGHT);
    expect(emailsAbout("keeps hitting")).toHaveLength(1);
    for (let i = 0; i < 10; i++) await read("203.0.113.3", 60, TIGHT);
    expect(emailsAbout("keeps hitting")).toHaveLength(1);
  });
});

describe("a visitor refused while reading like a person", () => {
  const refuse = (ip: string, limits = TIGHT) => read(ip, 60, limits);
  const spendHeavily = async (ip: string) => {
    const { visitorKey } = await import("../lib/visitor-hash.ts");
    await sql.query(
      "INSERT INTO visitor_fetch_state (ip, tokens, capacity, refill_per_sec, last_refill, updated_at, spent) " +
        "VALUES ($1, 0, 100, 0.0001, now(), now(), $2::bigint)",
      [`items:${visitorKey(ip, "test-secret")}`, VISITOR_DAILY_ITEMS_MIN],
    );
  };

  it("is emailed at the first refusal, and not again that day", async () => {
    await refuse("203.0.113.6");
    expect(emailsAbout("was refused")).toHaveLength(0);
    await refuse("203.0.113.6");
    expect(emailsAbout("was refused")).toHaveLength(1);
    for (let i = 0; i < 5; i++) await refuse("203.0.113.6");
    expect(emailsAbout("was refused")).toHaveLength(1);
  });

  it("reports what was served, what was refused and when to retry", async () => {
    await refuse("203.0.113.6");
    await refuse("203.0.113.6");
    const text = JSON.parse(emailsAbout("was refused")[0][1].body as string)
      .text as string;
    expect(text).toContain("60 items served");
    expect(text).toContain("refused 60");
    expect(text).toMatch(/retry in \d+ ?s/i);
    expect(text).not.toContain("203.0.113.6");
  });

  it("is left to the heavy-reader alert when the day's volume is already high", async () => {
    await spendHeavily("203.0.113.7");
    await refuse("203.0.113.7");
    expect(emailsAbout("was refused")).toHaveLength(0);
  });

  it("is not emailed while the limit only logs", async () => {
    await refuse("203.0.113.8", { ...TIGHT, enforce: false });
    await refuse("203.0.113.8", { ...TIGHT, enforce: false });
    expect(emailsAbout("was refused")).toHaveLength(0);
  });

  it("covers the print quote budget too", async () => {
    const quote = { capacity: 1, refill_per_sec: 0.0001, enforce: true };
    const ask = () =>
      quoteRateLimitOrRespond(sql, from("203.0.113.9"), res(), quote);
    await ask();
    await ask();
    expect(emailsAbout("was refused")).toHaveLength(1);
    expect(lastEmailText()).toMatch(/quote/i);
  });

  it("is not held back by the cap on heavy-reader emails", async () => {
    for (let i = 0; i < 8; i++) {
      await read(`198.51.100.${i}`, VISITOR_DAILY_ITEMS_MIN);
    }
    expect(emailsAbout("heavily").length).toBeLessThanOrEqual(3);
    await refuse("203.0.113.10");
    await refuse("203.0.113.10");
    expect(emailsAbout("was refused")).toHaveLength(1);
  });

  it("still sends the 429 when the email cannot be sent", async () => {
    fetchMock.mockRejectedValue(new Error("resend down"));
    await refuse("203.0.113.11");
    expect(await refuse("203.0.113.11")).toBe(true);
  });
});

describe("limits on the alerts themselves", () => {
  it("caps emails per hour when many visitors cross at once", async () => {
    for (let i = 0; i < 8; i++) {
      await read(`198.51.100.${i}`, VISITOR_DAILY_ITEMS_MIN);
    }
    expect(emails().length).toBeGreaterThan(0);
    expect(emails().length).toBeLessThanOrEqual(3);
  });

  it("never fails or delays the request when the email cannot be sent", async () => {
    fetchMock.mockRejectedValue(new Error("resend down"));
    const limited = await read("203.0.113.4", VISITOR_DAILY_ITEMS_MIN);
    expect(limited).toBe(false);
  });

  it("sends nothing when no recipient is configured", async () => {
    vi.stubEnv("OPS_ALERT_EMAIL", "");
    vi.stubEnv("SUBMIT_NOTIFY_EMAIL", "");
    await read("203.0.113.5", VISITOR_DAILY_ITEMS_MIN);
    expect(emails()).toHaveLength(0);
  });
});
