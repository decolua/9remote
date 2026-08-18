-- idx_apiKey/idx_temp_keys_api_key duplicate the UNIQUE auto-indexes on the
-- same columns (EXPLAIN confirms queries use sqlite_autoindex) — pure write
-- amplification on every INSERT/UPDATE.
DROP INDEX IF EXISTS idx_apiKey;
DROP INDEX IF EXISTS idx_temp_keys_api_key;

-- Cover the admin session list ORDER BY lastAccessAt (was full scan + temp sort).
CREATE INDEX IF NOT EXISTS idx_sessions_lastAccess ON sessions(lastAccessAt);
