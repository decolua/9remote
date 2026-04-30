-- Admin auth + role-based modes
CREATE TABLE IF NOT EXISTS modes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  permissions TEXT NOT NULL,
  createdAt   TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS admins (
  id           TEXT PRIMARY KEY,
  username     TEXT UNIQUE NOT NULL,
  passwordHash TEXT NOT NULL,
  modeId       TEXT NOT NULL,
  createdAt    TEXT DEFAULT CURRENT_TIMESTAMP,
  lastLoginAt  TEXT,
  FOREIGN KEY (modeId) REFERENCES modes(id)
);

INSERT OR IGNORE INTO modes (id, name, permissions) VALUES
  ('superAdmin', 'Super Admin', '["session.view","session.delete","mode.view","mode.manage","admin.view","admin.manage"]'),
  ('viewer',     'Viewer',      '["session.view","mode.view","admin.view"]');

INSERT OR IGNORE INTO admins (id, username, passwordHash, modeId) VALUES
  ('admin_default', 'anhvh', '$2b$10$rlQBz3URpmS0GS9mX1L2Vus7yVvW.0x1RvpjuBC0aTa9v/KvExOya', 'superAdmin');
