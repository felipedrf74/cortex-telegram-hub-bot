-- Down for 258: drop only the archive table. The live identity column was
-- never modified by the up migration, so nothing else needs restoring.

DROP TABLE IF EXISTS telegram_identity_archive;
