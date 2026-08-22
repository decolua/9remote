-- The agent's X25519 public key (raw-32 base64), the one clients seal the key
-- TAIL to. Separate from hostPublicKey because Ed25519 signs and X25519
-- receives -- one algorithm cannot do both. A single fp2, computed over the
-- pair, anchors them together, so the user still reads two characters.
-- NULL for a session registered before sealing existed: those clients send the
-- tail as they did before.
ALTER TABLE sessions ADD COLUMN hostX25519Key TEXT;
