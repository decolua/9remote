-- The Ed25519 public half of the agent's host key (hostKey.json), raw-32 base64.
-- Mutating routes verify a signature against it, so knowing the apiKey HEAD --
-- which is public routing data -- is no longer enough to repoint someone's
-- tunnelUrl. NULL means an agent that predates the change: those rows keep
-- accepting unsigned mutations, and gain the check when the agent updates and
-- registers its key.
ALTER TABLE sessions ADD COLUMN hostPublicKey TEXT;
