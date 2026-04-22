-- Migration 077: Tenant invitations.
--
-- Adds the multi-member invite flow on top of migration 076's
-- tenants + tenant_members tables. Without this, every tenant is
-- trivially single-member (the owner themselves via the solo-tenant
-- backfill) and tenant_members is decorative.
--
-- Flow:
--
--   1. A tenant_admin calls POST /workspace/invites with { email,
--      role }. The service inserts a `tenant_invites` row with a
--      random `invite_code`, status 'pending', created_by = actor.
--
--   2. The invitee (any user with a matching email in `users.email`)
--      hits GET /workspace/my-invites and sees the pending row.
--
--   3. They POST /workspace/my-invites/:code/accept. The service
--      writes a `tenant_members` row with the invite's role, marks
--      the invite 'accepted', sets accepted_at + accepted_by.
--
--   4. Subsequent GET /workspace/tenants by that user now returns
--      the new tenant in their switcher.
--
-- Revocation: tenant_admin can DELETE /workspace/invites/:id to
-- mark status='revoked'. The row stays for audit; accept-by-code
-- rejects revoked rows.
--
-- Uniqueness:
--   - invite_code is unique across the whole table (probe resistance).
--   - (tenant_id, email) is UNIQUE where status='pending' — you
--     can't have two pending invites for the same email at the same
--     tenant. Accepted/revoked rows are allowed to coexist for audit
--     history, which is why the partial index is used instead of a
--     plain UNIQUE constraint.
--
-- Backward-safety: strictly additive. No existing table touched.
-- Rollback: DROP TABLE IF EXISTS tenant_invites + delete the
-- _migrations row; tenant-invite-service degrades to "no invites
-- configured" with a try/catch.

CREATE TABLE IF NOT EXISTS tenant_invites (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id     INTEGER NOT NULL,
  email         TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'tenant_member'
                  CHECK(role IN ('tenant_admin','tenant_member','tenant_viewer')),
  invite_code   TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK(status IN ('pending','accepted','revoked','expired')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  created_by    INTEGER NOT NULL,                 -- users.id of the inviter
  expires_at    TEXT,                             -- optional; null = never
  accepted_at   TEXT,
  accepted_by   INTEGER,                          -- users.id
  revoked_at    TEXT,
  revoked_by    INTEGER,
  FOREIGN KEY (tenant_id)  REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (accepted_by) REFERENCES users(id),
  FOREIGN KEY (revoked_by)  REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_tenant
  ON tenant_invites (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_invites_email
  ON tenant_invites (email, status);

-- Partial unique: at most one pending invite per (tenant, email).
-- Prevents "admin spams invite 10 times, invitee sees 10 rows".
-- SQLite supports partial indexes (WHERE clause) natively.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_invites_unique_pending
  ON tenant_invites (tenant_id, email)
  WHERE status = 'pending';
