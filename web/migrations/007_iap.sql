-- Anonymous IAP accounts + receipts + entitlements
-- Account is created on first app open (no login). Restore merges via originalTransactionId/purchaseToken.

CREATE TABLE IF NOT EXISTS iap_accounts (
  id        TEXT PRIMARY KEY,
  createdAt TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS iap_device_links (
  accountId TEXT NOT NULL,
  deviceId  TEXT NOT NULL,
  platform  TEXT NOT NULL,
  linkedAt  TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (accountId, deviceId),
  FOREIGN KEY (accountId) REFERENCES iap_accounts(id)
);

CREATE TABLE IF NOT EXISTS iap_receipts (
  id         TEXT PRIMARY KEY,
  accountId  TEXT NOT NULL,
  platform   TEXT NOT NULL,
  productId  TEXT NOT NULL,
  rawReceipt TEXT,
  status     TEXT NOT NULL,
  verifiedAt TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (accountId) REFERENCES iap_accounts(id)
);
CREATE INDEX IF NOT EXISTS idx_receipts_account ON iap_receipts(accountId);

CREATE TABLE IF NOT EXISTS iap_entitlements (
  accountId           TEXT PRIMARY KEY,
  plan                TEXT NOT NULL,
  status              TEXT NOT NULL,
  expiresAt           TEXT,
  originalPurchaseDate TEXT,
  updatedAt           TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (accountId) REFERENCES iap_accounts(id)
);
