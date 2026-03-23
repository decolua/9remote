-- Update session expiry from 4 hours to 7 days
-- Set default lastAccessAt to CURRENT_TIMESTAMP
-- This migration updates existing sessions and schema defaults

-- Update existing sessions to have 7 days expiry from now
UPDATE sessions SET expiresAt = datetime('now', '+7 days');

-- Set lastAccessAt for existing sessions that don't have it
UPDATE sessions SET lastAccessAt = CURRENT_TIMESTAMP WHERE lastAccessAt IS NULL;
