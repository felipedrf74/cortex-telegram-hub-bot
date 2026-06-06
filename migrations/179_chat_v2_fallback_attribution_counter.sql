-- ChatV2 Phase 7 ramp-down attribution counter (2026-06-01)
--
-- Sidecar to `chat_v2_legacy_fallback_counter`. The existing table remains the
-- broad per-tenant auto-revert gauge; this table adds safe attribution so a
-- fallback spike can be traced to a domain / route-owner / route-method class
-- before legacy is retired. Every field is an internal scalar enum-ish label.
-- There is no raw user text, prompt, response, title, calendar, email, finance,
-- health, or task content in this table.

CREATE TABLE IF NOT EXISTS chat_v2_legacy_fallback_attribution_counter (
  tenant_id       TEXT NOT NULL,
  window_start    TEXT NOT NULL,
  domain          TEXT NOT NULL DEFAULT 'unknown',
  route_owner     TEXT NOT NULL DEFAULT 'unknown',
  route_method    TEXT NOT NULL DEFAULT 'unknown',
  fallback_count  INTEGER NOT NULL DEFAULT 0,
  total_count     INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tenant_id, window_start, domain, route_owner, route_method)
);

CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_fallback_attr_tenant_window
  ON chat_v2_legacy_fallback_attribution_counter(tenant_id, window_start);

CREATE INDEX IF NOT EXISTS idx_chat_v2_legacy_fallback_attr_domain_window
  ON chat_v2_legacy_fallback_attribution_counter(domain, window_start);
