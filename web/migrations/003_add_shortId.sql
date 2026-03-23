-- Add shortId column for tunnel subdomain (_t-{shortId}.9remote.cc)
ALTER TABLE sessions ADD COLUMN shortId TEXT;
