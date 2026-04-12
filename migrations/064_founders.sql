-- Founders list: emails with permanent Pro/Max access.
-- Managed from the admin portal. When a user registers with a
-- founder email, they get an automatic subscription with no expiry.
CREATE TABLE IF NOT EXISTS founders (
  email       TEXT PRIMARY KEY,
  plan        TEXT NOT NULL DEFAULT 'pro',  -- 'pro' or 'max'
  note        TEXT,                          -- admin note (e.g. "Beta tester", "Investor")
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
