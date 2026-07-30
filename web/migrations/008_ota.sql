-- Self-hosted OTA updates (Expo Updates protocol v1).
-- Stores published update groups + a per-channel pointer to the active build.

CREATE TABLE IF NOT EXISTS otaUpdateGroup (
  id              TEXT PRIMARY KEY,
  buildNumber     INTEGER NOT NULL,
  runtimeVersion  TEXT NOT NULL,
  platform        TEXT NOT NULL CHECK (platform IN ('ios','android')),
  channel         TEXT NOT NULL,
  message         TEXT DEFAULT '',
  launchAssetKey  TEXT NOT NULL,
  assets          TEXT NOT NULL,        -- JSON array
  expoConfig      TEXT DEFAULT '{}',    -- JSON object
  manifestJson    TEXT NOT NULL,        -- JSON object (unsigned, for inspection)
  manifestString  TEXT NOT NULL,        -- exact bytes the signature covers
  signature       TEXT DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  publishedBy     TEXT DEFAULT '',
  publishedAt     TEXT,
  createdAt       TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_otaGroup_build ON otaUpdateGroup(buildNumber DESC);
CREATE INDEX IF NOT EXISTS idx_otaGroup_filter ON otaUpdateGroup(channel, runtimeVersion, platform, status);

-- One pointer per (channel, runtimeVersion, platform) — the build a device on
-- that channel receives. Single active row enforced in app code on publish.
CREATE TABLE IF NOT EXISTS otaChannelPointer (
  channel               TEXT NOT NULL,
  runtimeVersion        TEXT NOT NULL,
  platform              TEXT NOT NULL CHECK (platform IN ('ios','android')),
  currentUpdateGroupId  TEXT,
  updatedAt             TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel, runtimeVersion, platform)
);

-- Grant OTA permissions by appending, never replacing: permissions are editable
-- from /admin/modes, so a hardcoded array would silently revert those edits.
-- The NOT LIKE guard keeps this idempotent on re-run.
UPDATE modes
  SET permissions = json_insert(permissions, '$[#]', 'ota.view')
  WHERE id IN ('superAdmin', 'viewer')
    AND permissions NOT LIKE '%"ota.view"%';

UPDATE modes
  SET permissions = json_insert(permissions, '$[#]', 'ota.manage')
  WHERE id = 'superAdmin'
    AND permissions NOT LIKE '%"ota.manage"%';
