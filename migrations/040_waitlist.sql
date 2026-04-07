-- Migration 040: Public waitlist for nexushub.me landing page
--
-- Collects email signups from the pre-alpha landing page. Two intent tiers:
--
--   'founder'  — First 100 users who reserved a Founder Deal slot ($79/yr lifetime lock)
--   'general'  — Passive early-access waitlist
--
-- Rows are inserted by the public POST /api/waitlist endpoint (no auth).
-- Approved signups get converted into invite codes via the admin portal,
-- reusing the existing invite_codes infrastructure from TASK-15a.

CREATE TABLE IF NOT EXISTS waitlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,
  intent        TEXT NOT NULL DEFAULT 'general', -- 'founder' | 'general'
  -- Where did they come from? Hero CTA, pricing section, footer, organic landing,
  -- or a UTM-tagged external link. Helps us know which CTAs convert best.
  source        TEXT,
  -- Optional free-text from a "what do you use today?" field — rich qualitative
  -- signal for picking alpha cohorts and prioritizing integrations.
  use_case      TEXT,
  -- UTM params for attribution. All optional. Stored raw so we can reconstruct
  -- any campaign analysis later without re-parsing URLs.
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  -- Funnel state. 'pending' means form submission only. 'approved' means an
  -- admin clicked "Approve → generate invite" in the portal. 'invited' means
  -- the invite code has been sent to their email. 'signed_up' means they
  -- actually redeemed the invite and created an account.
  status        TEXT NOT NULL DEFAULT 'pending',
  -- FK-ish pointer to invite_codes.code once approved. Not a hard FK because
  -- invite_codes may be purged independently.
  invite_code   TEXT,
  -- Network provenance for abuse detection. IP is hashed before storage so we
  -- can detect spam bursts without retaining raw IPs (GDPR-friendlier default).
  ip_hash       TEXT,
  user_agent    TEXT,
  -- Position in the founder queue. NULL for 'general' intent. Auto-assigned
  -- by the insert logic using a COUNT(*) + 1 pattern inside a transaction.
  founder_slot  INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  approved_at   TEXT,
  notes         TEXT
);

-- One email can have at most one waitlist row. If they re-submit with a
-- different intent (e.g., upgrade from 'general' to 'founder'), the endpoint
-- upserts the existing row instead of creating a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist (email);

-- Lookup by status + intent for admin portal filters ("show me all pending
-- founders", "show me everyone who signed up from the pricing CTA")
CREATE INDEX IF NOT EXISTS idx_waitlist_status ON waitlist (status);
CREATE INDEX IF NOT EXISTS idx_waitlist_intent ON waitlist (intent);

-- Lookup by founder_slot for the "how many founder slots left" counter on
-- the landing page. We expose the count via a public GET endpoint.
CREATE INDEX IF NOT EXISTS idx_waitlist_founder_slot ON waitlist (founder_slot) WHERE founder_slot IS NOT NULL;
