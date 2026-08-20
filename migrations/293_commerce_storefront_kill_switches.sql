-- 293: subscription-checkout and storefront kill switches (plan §5).
--
-- Plan §5 names six independent kill switches; 289 shipped four. The two
-- missing ones matter specifically BEFORE a live Stripe key exists (QA6): a
-- subscription catalog item computes `purchasable` from its price id alone,
-- with no switch anywhere in the path, so today the only thing stopping a
-- production subscription checkout is the test-key guard. Install a live key
-- and there would be no way to stop subscription sales without an env edit
-- and a restart.
--
-- Why a second table instead of extending the first: control_key on
-- hybrid_commerce_runtime_control carries a CHECK constraint enumerating its
-- four keys, and SQLite cannot alter a CHECK — widening it means rebuilding
-- the table, which the migration classifier scores as a CONTRACT migration
-- and which therefore halts unattended CD. An additive table is expand-only
-- and predecessor-compatible: older code keeps reading the original four from
-- their original table and is untouched by this one.
--
-- Both switches default DISENGAGED, matching 289: a kill switch that arrives
-- pre-engaged would be an outage, not a safety measure.

CREATE TABLE IF NOT EXISTS hybrid_commerce_runtime_control_ext (
  control_key TEXT PRIMARY KEY CHECK (control_key IN (
    'subscription_checkout', 'storefront'
  )),
  engaged INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
  reason TEXT NOT NULL DEFAULT 'migration_default_disengaged',
  actor_user_id INTEGER,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT OR IGNORE INTO hybrid_commerce_runtime_control_ext (control_key, engaged)
VALUES ('subscription_checkout', 0), ('storefront', 0);
