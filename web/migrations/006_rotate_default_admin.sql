-- Remove committed default admin credential. Recreate manually via:
--   wrangler d1 execute 9remote --command "INSERT INTO admins ... VALUES ('admin_default', 'yourname', '$2b$10$...', 'superAdmin')"
DELETE FROM admins WHERE id = 'admin_default';
