// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * One-shot release migrator.
 *
 * Containerized releases run this as a dedicated Compose service after the
 * pre-migration backup and before the application containers start. Keeping it
 * separate from application boot is what makes the ordering enforceable: the
 * application refuses to serve when `MIGRATIONS_MODE=external` unless both the
 * SQL ledger and exact release data-maintenance receipt are complete. Schema
 * migration and governed idempotent data maintenance can therefore run only
 * here, against a database that was just backed up.
 *
 * It is idempotent — a re-run with no SQL pending re-verifies the immutable
 * maintenance receipt — because the poller may retry a release whose migrator
 * already ran.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config';
import { logger } from '../utils/logger';
import { runReleaseDataMaintenanceForMigrator } from '../services/database-bootstrap';
import {
  assertReleaseDataMaintenanceComplete,
  releaseDataMaintenanceIdentityFromEnvironment,
  type ReleaseDataMaintenanceIdentity,
} from '../services/release-data-maintenance';
import {
  applyMigrationFile,
  applyPendingMigrations,
  ensureMigrationSqlFunctions,
  loadReleaseMigrationPlan,
  pendingMigrationFiles,
  readGovernedMigrationSource,
} from '../services/migration-runner';

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

interface MigratorResult {
  databasePath: string;
  pendingBefore: string[];
  appliedCount: number;
  pendingAfter: string[];
}

const RELEASE_MIGRATOR_BUSY_TIMEOUT_MS = 30_000;
const RELEASE_MIGRATOR_LOCK_POLL_MS = 100;
const releaseMigratorWaitCell = new Int32Array(new SharedArrayBuffer(4));

function isSqliteContention(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : '';
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED'
    || /database (?:is )?locked/i.test(message);
}

function ensureWalJournalMode(database: Database.Database): void {
  const deadline = Date.now() + RELEASE_MIGRATOR_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      const journalMode = String(database.pragma('journal_mode', { simple: true })).toUpperCase();
      if (journalMode === 'WAL') return;
      const selectedMode = String(
        database.pragma('journal_mode = WAL', { simple: true }),
      ).toUpperCase();
      if (selectedMode === 'WAL') return;
    } catch (error) {
      if (!isSqliteContention(error)) throw error;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('release migrator could not enter WAL journal mode before timeout');
    }
    // SQLite can return SQLITE_BUSY immediately (or return the unchanged mode)
    // while negotiating journal mode without invoking the connection busy
    // handler. This one-shot runs outside the request path, so a short
    // synchronous poll is deliberate.
    Atomics.wait(
      releaseMigratorWaitCell,
      0,
      0,
      Math.min(RELEASE_MIGRATOR_LOCK_POLL_MS, remaining),
    );
  }
}

export function runReleaseMigrations(
  databasePath: string = config.app.databasePath,
  options: {
    migrationsDirectory?: string;
    dataMaintenanceRunner?: (
      database: Database.Database,
      identity: ReleaseDataMaintenanceIdentity,
    ) => void;
  } = {},
): MigratorResult {
  // Resolve and validate the packaged source before opening SQLite. A missing or
  // empty migrations directory is not evidence that the database is current.
  const source = readGovernedMigrationSource(options);
  const plan = loadReleaseMigrationPlan({ migrationsDirectory: source.migrationsDirectory });
  let releaseIdentity: ReleaseDataMaintenanceIdentity | null = null;

  if (!plan) {
    // No signed plan. This is only ever legitimate for local development and
    // tests; in a release container it means the migrator was invoked without
    // the evidence that says which migrations CI classified as safe.
    //
    // Validate this admission boundary before the no-pending early return. A
    // fully migrated production database must not turn a missing plan into
    // success.
    const optIn = process.env.NEXUS_MIGRATOR_ALLOW_UNPLANNED ?? '';
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'NEXUS_RELEASE_MIGRATION_PLAN is required to migrate in production; '
        + 'refusing to apply migrations no signed release vouched for',
      );
    }
    if (optIn !== 'local-development') {
      throw new Error(
        'NEXUS_RELEASE_MIGRATION_PLAN is absent and NEXUS_MIGRATOR_ALLOW_UNPLANNED is not '
        + 'set to "local-development"; refusing to apply an unplanned migration set',
      );
    }
  } else {
    if (plan.mode === 'rollback') {
      throw new Error(
        'rollback migration plans are verification-only; refusing to run the release migrator',
      );
    }
    releaseIdentity = releaseDataMaintenanceIdentityFromEnvironment();
    if (
      releaseIdentity.releaseId !== plan.identity.releaseId
      || releaseIdentity.sourceSha !== plan.identity.sourceSha
      || releaseIdentity.backendImageDigest !== plan.identity.backendImageDigest
    ) {
      throw new Error('release migration plan identity does not match the exact Compose release identity');
    }
  }

  // The predecessor keeps serving while this one-shot applies the additive
  // migration set. Give an in-flight predecessor write a bounded opportunity
  // to finish instead of inheriting better-sqlite3's shorter default timeout.
  // Install the handler at open time so it also covers WAL-mode negotiation.
  const database = new Database(databasePath, {
    timeout: RELEASE_MIGRATOR_BUSY_TIMEOUT_MS,
  });
  try {
    ensureWalJournalMode(database);
    database.pragma('foreign_keys = ON');
    ensureMigrationSqlFunctions(database);

    const pendingBefore = pendingMigrationFiles(database, {
      migrationsDirectory: source.migrationsDirectory,
      requireCompleteInventory: plan !== null,
      allowedLegacyFiles: plan
        ? new Set(plan.legacyRows.map((entry) => entry.file))
        : undefined,
    });
    if (pendingBefore.length === 0) {
      logger.info({ databasePath }, 'Release migrator: no pending migrations');
    } else if (plan) {
      logger.info(
        { databasePath, pending: pendingBefore.length, first: pendingBefore[0] },
        'Release migrator: applying pending migrations',
      );
      const allowed = new Map(plan.inventory.map((entry) => [entry.file, entry]));
      // Validate the ENTIRE pending set before applying anything. A partial apply
      // followed by a refusal would leave the schema between two releases.
      for (const file of pendingBefore) {
        const entry = allowed.get(file);
        if (!entry) {
          throw new Error(`release migration plan does not authorize ${file}`);
        }
        if (!entry.predecessorCompatible) {
          throw new Error(
            `release migration plan marks ${file} as not predecessor compatible (${entry.kind})`,
          );
        }
        const actual = sha256File(path.join(source.migrationsDirectory, file));
        if (actual !== entry.sha256) {
          throw new Error(`release migration ${file} does not match its signed byte digest`);
        }
      }
      for (const file of pendingBefore) {
        applyMigrationFile(database, file, logger, source.migrationsDirectory);
        logger.info({ migration: file }, 'Migration applied under the signed plan');
      }
    } else {
      logger.info(
        { databasePath, pending: pendingBefore.length, first: pendingBefore[0] },
        'Release migrator: applying pending migrations',
      );
      logger.warn(
        { optIn: 'local-development' },
        'Applying migrations without a signed plan (local development opt-in)',
      );
      applyPendingMigrations(database, {
        logger,
        migrationsDirectory: source.migrationsDirectory,
      });
    }

    const pendingAfter = pendingMigrationFiles(database, {
      migrationsDirectory: source.migrationsDirectory,
      requireCompleteInventory: plan !== null,
      allowedLegacyFiles: plan
        ? new Set(plan.legacyRows.map((entry) => entry.file))
        : undefined,
    });
    if (pendingAfter.length > 0) {
      throw new Error(
        `release migrator finished with ${pendingAfter.length} migration(s) still pending `
        + `(first: ${pendingAfter[0]})`,
      );
    }

    if (plan && releaseIdentity) {
      const maintenanceRunner = options.dataMaintenanceRunner
        ?? runReleaseDataMaintenanceForMigrator;
      maintenanceRunner(database, releaseIdentity);
      // The runner may be injected in focused tests, but the security boundary
      // is not injectable: success always requires the exact durable receipt.
      assertReleaseDataMaintenanceComplete(database, releaseIdentity);
      logger.info(
        { releaseId: releaseIdentity.releaseId },
        'Release data maintenance completed for the exact backend image',
      );
    }

    const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>;
    if (integrity[0]?.integrity_check !== 'ok') {
      throw new Error('release migrator found a database integrity failure after migrating');
    }
    const foreignKeyViolations = database.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length > 0) {
      throw new Error(
        `release migrator found ${foreignKeyViolations.length} foreign-key violation(s) after migrating`,
      );
    }

    return {
      databasePath,
      pendingBefore,
      appliedCount: pendingBefore.length,
      pendingAfter,
    };
  } finally {
    database.close();
  }
}

function main(): void {
  const result = runReleaseMigrations();
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-migrator.v1',
    databasePath: result.databasePath,
    appliedCount: result.appliedCount,
    pendingAfter: result.pendingAfter.length,
  })}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    logger.error({ err: error }, 'Release migrator failed');
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
