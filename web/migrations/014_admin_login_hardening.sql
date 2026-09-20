-- Durable lockout for admin login. The in-memory limiter in rateLimit.js only
-- holds inside one isolate for 60s; these rows survive isolate churn and edge
-- locations, which is what an attacker hopping IPs cannot dodge. Key prefix
-- picks the dimension: 'ip:<addr>' can lock (attacker only locks their own IP),
-- 'user:<name>' only counts — it drives a per-account delay, never a hard lock,
-- so nobody can lock the operator out by spamming wrong passwords.
CREATE TABLE IF NOT EXISTS adminLoginLocks (
  key         TEXT PRIMARY KEY,
  fails       INTEGER NOT NULL DEFAULT 0,
  lockedUntil TEXT,
  updatedAt   TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Every admin login attempt, success included: with a single operator any
-- failure is worth seeing, and a success that wasn't them is the loudest
-- signal of all.
CREATE TABLE IF NOT EXISTS adminLoginLog (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip         TEXT NOT NULL,
  ok         INTEGER NOT NULL DEFAULT 0,
  reason     TEXT NOT NULL DEFAULT '',
  createdAt  TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_adminLoginLog_createdAt ON adminLoginLog(createdAt);

-- Grant log-viewing permissions by appending, never replacing.
UPDATE modes
  SET permissions = json_insert(permissions, '$[#]', 'log.view')
  WHERE id IN ('superAdmin', 'viewer')
    AND permissions NOT LIKE '%"log.view"%';
