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
