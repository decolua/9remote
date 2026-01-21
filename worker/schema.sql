CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machineId TEXT NOT NULL,
  apiKey TEXT NOT NULL UNIQUE,
  tunnelUrl TEXT,
  createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
  expiresAt DATETIME DEFAULT (datetime('now', '+4 hours')),
  lastAccessAt DATETIME
);

CREATE INDEX idx_apiKey ON sessions(apiKey);
CREATE INDEX idx_machineId ON sessions(machineId);
CREATE INDEX idx_expiresAt ON sessions(expiresAt);

CREATE TABLE temp_keys (
  temp_key TEXT PRIMARY KEY,
  api_key TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_temp_keys_expires ON temp_keys(expires_at);
CREATE INDEX idx_temp_keys_api_key ON temp_keys(api_key);
