-- Cloudflare TURN keys, managed from the admin UI. One row per key (an account
-- can hold several). Last-used is the round-robin cursor: the credential
-- endpoint picks the oldest, so keys rotate without a counter to keep in sync.
CREATE TABLE IF NOT EXISTS turnKeys (
  id         TEXT PRIMARY KEY,
  keyId      TEXT NOT NULL,
  secret     TEXT NOT NULL,
  label      TEXT DEFAULT '',
  scope      TEXT NOT NULL DEFAULT 'both',
  enabled    INTEGER NOT NULL DEFAULT 1,
  lastUsedAt TEXT,
  createdAt  TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Grant TURN permissions by appending, never replacing: permissions are editable
-- from the admin UI, so a plain UPDATE would clobber an operator's edits.
UPDATE modes
  SET permissions = json_insert(permissions, '$[#]', 'turn.view')
  WHERE id IN ('superAdmin', 'viewer')
    AND permissions NOT LIKE '%"turn.view"%';

UPDATE modes
  SET permissions = json_insert(permissions, '$[#]', 'turn.manage')
  WHERE id = 'superAdmin'
    AND permissions NOT LIKE '%"turn.manage"%';
