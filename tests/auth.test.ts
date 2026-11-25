// Magic-link sign-in: link tokens, sessions, the session cookie and the
// per-email request budget. See lib/auth.ts.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authBudgetOrRespond,
  clearedSessionCookie,
  consumeLoginLink,
  createLoginLink,
  emailBucketKey,
  endSession,
  normalizeEmail,
  resolveSession,
  SESSION_COOKIE,
  sessionCookie,
  sessionTokenFromCookie,
  signInUrl,
  startSession,
} from "../lib/auth.ts";
import { makeSql } from "./helpers/pg.ts";

const FILES = [
  "035_visitor_rate_state.sql",
  "065_visitor_spent.sql",
  "067_user_accounts.sql",
];
const SECRET = "test-secret";

type Sql = {
  query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  $close(): Promise<void>;
};

let sql: Sql;

beforeEach(async () => {
  sql = await makeSql(FILES);
});

afterEach(async () => {
  await sql.$close();
});

function fakeRes() {
  return {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

async function allText(table: string): Promise<string> {
  return JSON.stringify(await sql.query(`SELECT * FROM ${table}`));
}

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Mel@Example.ORG ")).toBe("mel@example.org");
  });
});

describe("login links", () => {
  it("signs in once with a fresh link", async () => {
    const token = await createLoginLink(sql, "mel@example.org");
    const first = await consumeLoginLink(sql, token);
    expect(first?.email).toBe("mel@example.org");
    expect(await consumeLoginLink(sql, token)).toBeNull();
  });

  it("stores only a hash of the link token", async () => {
    const token = await createLoginLink(sql, "mel@example.org");
    expect(await allText("auth_links")).not.toContain(token);
  });

  it("refuses an expired link", async () => {
    const token = await createLoginLink(sql, "mel@example.org");
    await sql.query(
      "UPDATE auth_links SET expires_at = now() - interval '1 second'",
    );
    expect(await consumeLoginLink(sql, token)).toBeNull();
  });

  it("refuses an unknown or malformed token", async () => {
    expect(await consumeLoginLink(sql, "not-a-token")).toBeNull();
    expect(await consumeLoginLink(sql, "")).toBeNull();
  });

  it("creates the account on first sign-in and reuses it after", async () => {
    const a = await consumeLoginLink(
      sql,
      await createLoginLink(sql, "Mel@Example.org"),
    );
    const b = await consumeLoginLink(
      sql,
      await createLoginLink(sql, "mel@example.org"),
    );
    expect(a?.userId).toBe(b?.userId);
    const users = await sql.query("SELECT email FROM users");
    expect(users).toEqual([{ email: "mel@example.org" }]);
  });

  it("does not create an account until a link is used", async () => {
    await createLoginLink(sql, "mel@example.org");
    expect(await sql.query("SELECT id FROM users")).toEqual([]);
  });
});

describe("sessions", () => {
  async function signedIn() {
    const link = await consumeLoginLink(
      sql,
      await createLoginLink(sql, "mel@example.org"),
    );
    if (!link) throw new Error("sign-in failed");
    return { userId: link.userId, token: await startSession(sql, link.userId) };
  }

  it("resolves a live session to its user", async () => {
    const { userId, token } = await signedIn();
    expect(await resolveSession(sql, token)).toEqual({
      userId,
      email: "mel@example.org",
    });
  });

  it("stores only a hash of the session token", async () => {
    const { token } = await signedIn();
    expect(await allText("sessions")).not.toContain(token);
  });

  it("does not resolve an expired session", async () => {
    const { token } = await signedIn();
    await sql.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second'",
    );
    expect(await resolveSession(sql, token)).toBeNull();
  });

  it("does not resolve an ended session", async () => {
    const { token } = await signedIn();
    await endSession(sql, token);
    expect(await resolveSession(sql, token)).toBeNull();
  });

  it("does not resolve a missing or unknown token", async () => {
    expect(await resolveSession(sql, null)).toBeNull();
    expect(await resolveSession(sql, "nope")).toBeNull();
  });
});

describe("session cookie", () => {
  it("is HttpOnly, Secure, SameSite=Lax and site-wide", () => {
    const cookie = sessionCookie("abc");
    expect(cookie.startsWith(`${SESSION_COOKIE}=abc;`)).toBe(true);
    expect(cookie).toMatch(/; HttpOnly/);
    expect(cookie).toMatch(/; Secure/);
    expect(cookie).toMatch(/; SameSite=Lax/);
    expect(cookie).toMatch(/; Path=\//);
    expect(cookie).toMatch(/; Max-Age=\d+/);
  });

  it("clears with an expired cookie of the same name and path", () => {
    const cookie = clearedSessionCookie();
    expect(cookie.startsWith(`${SESSION_COOKIE}=;`)).toBe(true);
    expect(cookie).toMatch(/; Max-Age=0/);
    expect(cookie).toMatch(/; Path=\//);
  });

  it("reads the session token among other cookies", () => {
    expect(sessionTokenFromCookie(`a=1; ${SESSION_COOKIE}=tok_123; b=2`)).toBe(
      "tok_123",
    );
    expect(sessionTokenFromCookie("a=1")).toBeNull();
    expect(sessionTokenFromCookie(undefined)).toBeNull();
  });
});

describe("signInUrl", () => {
  it("builds the link on the configured origin, never a request's host", () => {
    const url = new URL(signInUrl("tok", "https://tranquilo.art"));
    expect(url.origin).toBe("https://tranquilo.art");
    expect(url.searchParams.get("signin")).toBe("tok");
  });
});

describe("per-email request budget", () => {
  it("keys the bucket without the email in it", () => {
    const key = emailBucketKey("mel@example.org", SECRET);
    expect(key).not.toContain("mel");
    expect(key).toBe(emailBucketKey(" MEL@example.org", SECRET));
    expect(key).not.toBe(emailBucketKey("other@example.org", SECRET));
  });

  it("refuses an email once its burst is spent, and not another email", async () => {
    const req = { headers: {} };
    let refusedAt = -1;
    for (let i = 0; i < 50 && refusedAt < 0; i++) {
      const res = fakeRes();
      if (await authBudgetOrRespond(sql, req, "mel@example.org", res, SECRET)) {
        expect(res.statusCode).toBe(429);
        refusedAt = i;
      }
    }
    expect(refusedAt).toBeGreaterThan(0);
    const other = fakeRes();
    expect(
      await authBudgetOrRespond(sql, req, "other@example.org", other, SECRET),
    ).toBe(false);
  });
});
