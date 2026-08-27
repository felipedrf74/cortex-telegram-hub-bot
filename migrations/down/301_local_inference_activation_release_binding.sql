-- SQLite cannot safely drop these columns on the supported migration path.
-- Rollback is intentionally a no-op; older application versions ignore them.
SELECT 1;
