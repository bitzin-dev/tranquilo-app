// Email sign-in links and sessions for /api/auth. See sql/067_user_accounts.sql.
//
// A link token and a session token are each 32 random bytes, stored only as a
// SHA-256 hash. Using a link creates the account if it does not exist yet, in
// the same statement that marks the link used, so a link signs in once.

import { createHash, createHmac, randomBytes } from "node:crypto";
import { TRANQUILO_CONFIG } from "./config.generated.ts";
import type { QuerySql } from "./img-store.ts";
import { clientIp } from "./img-visitor-rate-limit.ts";
import { ACQUIRE_SQL } from "./items-rate-limit.ts";
import { visitorKey } from "./visitor-hash.ts";

export const SESSION_COOKIE = "tq_session";
const TOKEN_BYTES = 32;
const EMAIL_KEY_LABEL = "auth-email-v1";
const EMAIL_TIMEOUT_MS = 8000;

export interface SessionUser {
  userId: number;
  email: string;
}

interface RequestWithHeaders {
  headers?: Record<string, string | string[] | undefined>;
}

interface AuthResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}

function authConfig() {
  return TRANQUILO_CONFIG.auth as {
    enabled: boolean;
    site_origin: string;
    link_ttl_minutes: number;
    session_ttl_days: number;
  };
}

export function authEnabled(): boolean {
  return authConfig().enabled === true;
}

export function siteOrigin(): string {
  return process.env.AUTH_SITE_ORIGIN || authConfig().site_origin;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function createLoginLink(
  sql: QuerySql,
  email: string,
): Promise<string> {
  const token = mintToken();
  await sql.query(
    "INSERT INTO auth_links (token_hash, email, expires_at) " +
      "VALUES ($1, $2, now() + make_interval(mins => $3::int))",
    [hashToken(token), normalizeEmail(email), authConfig().link_ttl_minutes],
  );
  return token;
}

const CONSUME_SQL =
  "WITH link AS (" +
  "  UPDATE auth_links SET used_at = now() " +
  "  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() " +
  "  RETURNING email" +
  ") " +
  "INSERT INTO users (email, last_login_at) SELECT email, now() FROM link " +
  "ON CONFLICT (email) DO UPDATE SET last_login_at = now() " +
  "RETURNING id, email";

export async function consumeLoginLink(
  sql: QuerySql,
  token: unknown,
): Promise<SessionUser | null> {
  if (typeof token !== "string" || !token) return null;
  const rows = (await sql.query(CONSUME_SQL, [hashToken(token)])) as {
    id: string | number;
    email: string;
  }[];
  if (!rows.length) return null;
  return { userId: Number(rows[0].id), email: rows[0].email };
}

export async function startSession(
  sql: QuerySql,
  userId: number,
): Promise<string> {
  const token = mintToken();
  await sql.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) " +
      "VALUES ($1, $2, now() + make_interval(days => $3::int))",
    [hashToken(token), userId, authConfig().session_ttl_days],
  );
  return token;
}

export async function resolveSession(
  sql: QuerySql,
  token: string | null,
): Promise<SessionUser | null> {
  if (!token) return null;
  const rows = (await sql.query(
    "SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id " +
      "WHERE s.token_hash = $1 AND s.expires_at > now()",
    [hashToken(token)],
  )) as { id: string | number; email: string }[];
  if (!rows.length) return null;
  return { userId: Number(rows[0].id), email: rows[0].email };
}

export async function endSession(sql: QuerySql, token: string): Promise<void> {
  await sql.query("DELETE FROM sessions WHERE token_hash = $1", [
    hashToken(token),
  ]);
}

export function sessionCookie(token: string): string {
  const maxAge = authConfig().session_ttl_days * 86400;
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function sessionTokenFromCookie(
  header: string | undefined,
): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return part.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

export function signInUrl(
  token: string,
  origin: string = siteOrigin(),
): string {
  const url = new URL("/", origin);
  url.searchParams.set("signin", token);
  return url.toString();
}

export function emailBucketKey(email: string, secret: string): string {
  const key = createHmac("sha256", secret).update(EMAIL_KEY_LABEL).digest();
  const digest = createHmac("sha256", key)
    .update(normalizeEmail(email))
    .digest("hex")
    .slice(0, 16);
  return `auth-email:${digest}`;
}

async function spend(
  sql: QuerySql,
  key: string,
  limits: { capacity: number; refill_per_sec: number },
): Promise<boolean> {
  const rows = (await sql.query(ACQUIRE_SQL, [
    key,
    1,
    limits.capacity,
    limits.refill_per_sec,
  ])) as unknown[];
  return rows.length > 0;
}

// True when the response has been sent and the caller must return. Fails
// closed: every request that passes sends an email.
export async function authBudgetOrRespond(
  sql: QuerySql,
  req: RequestWithHeaders,
  email: string,
  res: AuthResponse,
  secret: string | undefined = process.env.ITEMS_CURSOR_SECRET,
): Promise<boolean> {
  if (!secret) {
    res.statusCode = 503;
    res.json({ error: "Sign-in is unavailable" });
    return true;
  }
  const emailLimits = TRANQUILO_CONFIG.auth_email_rate_limit;
  const visitorLimits = TRANQUILO_CONFIG.auth_visitor_rate_limit;
  let allowed: boolean;
  try {
    const visitor = visitorKey(clientIp(req), secret);
    allowed =
      (!visitor ||
        (await spend(sql, `auth-visitor:${visitor}`, visitorLimits))) &&
      (await spend(sql, emailBucketKey(email, secret), emailLimits));
  } catch (_err) {
    res.statusCode = 503;
    res.setHeader("Retry-After", "5");
    res.json({ error: "Sign-in is unavailable" });
    return true;
  }
  if (allowed) return false;
  const retryAfter = Math.max(1, Math.ceil(1 / emailLimits.refill_per_sec));
  res.statusCode = 429;
  res.setHeader("Retry-After", String(retryAfter));
  res.json({ error: "Too many requests", retryAfter });
  return true;
}

export async function sendSignInEmail(
  apiKey: string,
  to: string,
  url: string,
): Promise<boolean> {
  const from =
    process.env.RESEND_FROM_EMAIL || "Tranquilo <onboarding@resend.dev>";
  const minutes = authConfig().link_ttl_minutes;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Your Tranquilo sign-in link",
        text:
          `Sign in to Tranquilo:\n\n${url}\n\n` +
          `This link works once and expires in ${minutes} minutes. ` +
          "If you didn't ask for it, you can ignore this email.",
      }),
      signal: AbortSignal.timeout(EMAIL_TIMEOUT_MS),
    });
    return res.ok;
  } catch (_err) {
    return false;
  }
}
