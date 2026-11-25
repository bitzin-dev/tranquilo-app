-- Accounts with email sign-in links. See lib/auth.ts.
--
-- A user row is created only when a sign-in link is used, so an address that
-- was merely typed into the form never becomes an account. Link and session
-- tokens are stored only as SHA-256 hashes; the plaintext lives in the email
-- and the session cookie. Requests for links are budgeted in
-- visitor_fetch_state under an "auth-email:" key prefix, so there is no rate
-- table here. Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email          TEXT        NOT NULL UNIQUE CHECK (email = lower(btrim(email))),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS auth_links (
  token_hash  TEXT        PRIMARY KEY,
  email       TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS auth_links_expires_idx ON auth_links (expires_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT        PRIMARY KEY,
  user_id       BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- Verify:
--   SELECT count(*) AS users FROM users;
--   SELECT count(*) FILTER (WHERE expires_at > now()) AS live_sessions FROM sessions;
