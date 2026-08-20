-- Down for 293: drop the additive control table.
-- Safe: the original four switches live in hybrid_commerce_runtime_control and
-- are untouched. Dropping this table reverts to pre-293 behavior, where the
-- subscription and storefront surfaces had no DB switch at all.

DROP TABLE IF EXISTS hybrid_commerce_runtime_control_ext;
