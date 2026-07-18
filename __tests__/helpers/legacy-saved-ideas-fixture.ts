// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { applyPendingMigrations } from '../../src/services/migration-runner';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const LEGACY_IDEA_CUTOVER_MIGRATION =
  '253_content_legacy_idea_note_workspace_parity.sql';

/**
 * Build the only honest fixture shape for retained saved_ideas rows: write the
 * historical row before the canonical cutover, then let migration 253 perform
 * its normal backfill, binding, quarantine, and writer-freeze work.
 *
 * Tests must not temporarily drop the production guard triggers because that
 * can create a post-cutover state the runtime is intentionally unable to
 * produce and would hide readiness/parity failures.
 */
export function createMigratedDatabaseWithLegacySavedIdeas(
  seed: (database: Database.Database) => void,
): Database.Database {
  const database = createMigratedTestDatabase({
    stopBefore: LEGACY_IDEA_CUTOVER_MIGRATION,
  });
  seed(database);
  applyPendingMigrations(database);
  return database;
}
