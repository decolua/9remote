-- Add publicIp and localIp for same-network detection
ALTER TABLE sessions ADD COLUMN publicIp TEXT;
ALTER TABLE sessions ADD COLUMN localIp TEXT;
