// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { config } from '../config';
import { seedDefaultSkills } from '../skills/skill-manager';
import { logger } from '../utils/logger';
import { DatabaseConfigProvider, setConfigProvider } from './config-provider';
import {
  getDb,
  initializeDatabaseCore,
  withReleaseMaintenanceDatabase,
} from './database';
import {
  assertFinanceEncryptionConfigured,
  encryptPlaintextFinanceRows,
} from './finance-tracker';
import {
  assertGarminEncryptionConfigured,
  encryptPlaintextGarminTokens,
} from './garmin-session-store';
import { backfillLegacyRefreshTokenHashes } from './ios-auth-session';
import { loadModelOverrides } from './model-config';
import {
  assertOAuthEncryptionConfigured,
  encryptPlaintextOAuthTokens,
  migrateOwnerTokens,
} from './oauth-store';
import { loadPersistedModelOverrides } from './persisted-model-overrides';
import {
  recordReleaseDataMaintenanceCompletion,
  type ReleaseDataMaintenanceIdentity,
} from './release-data-maintenance';
import {
  assertOwnerBootstrapReadyForRuntime,
  backfillTelegramIdentityArchive,
  seedOwnerUser,
} from './user-service';

/**
 * Runtime/data-maintenance orchestration sits above the lean database core.
 * Every service imported here may call getDb(); none is imported back by
 * database.ts. Keeping that dependency direction one-way prevents incomplete
 * database exports from being captured during startup or scoped test mocks.
 */

function runEarlyDataMaintenance({ failClosed }: { failClosed: boolean }): void {
  try {
    const result = backfillLegacyRefreshTokenHashes();
    if (result.hashedRows > 0 || result.clearedPlaintextRows > 0) {
      logger.warn(
        result,
        'iOS auth migration: hashed legacy refresh tokens and cleared plaintext',
      );
    }
  } catch (err) {
    logger.error({ err }, 'iOS auth refresh-token hash backfill failed — investigate before next deploy');
    if (failClosed) throw err;
  }

  // M21 Stage C: archive telegram identities (pragma-guarded, idempotent —
  // see migration 259 header for why this is not SQL).
  try {
    const archive = backfillTelegramIdentityArchive();
    if (archive.archivedRows > 0) {
      logger.info(archive, 'Telegram identity archive backfill copied rows');
    }
  } catch (err) {
    logger.warn({ err }, 'Telegram identity archive backfill failed — investigate before next deploy');
    if (failClosed) throw err;
  }
}

function assertRuntimeDataPrerequisites(): void {
  assertOwnerBootstrapReadyForRuntime();
  assertOAuthEncryptionConfigured();
  assertFinanceEncryptionConfigured();
  assertGarminEncryptionConfigured();
}

function assertExternalRuntimeStoreReadable(database: Database.Database): void {
  try {
    const columns = database.prepare("PRAGMA table_xinfo('kv_store')").all();
    const indexes = database.prepare("PRAGMA index_list('kv_store')").all();
    const updatedIndex = database.prepare("PRAGMA index_xinfo('idx_kv_store_updated')").all();
    const expectedColumns = [
      { cid: 0, name: 'key', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
      { cid: 1, name: 'value', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0, hidden: 0 },
      {
        cid: 2,
        name: 'updated_at',
        type: 'TEXT',
        notnull: 1,
        dflt_value: "datetime('now')",
        pk: 0,
        hidden: 0,
      },
    ];
    const expectedIndexes = [
      { seq: 0, name: 'idx_kv_store_updated', unique: 0, origin: 'c', partial: 0 },
      { seq: 1, name: 'sqlite_autoindex_kv_store_1', unique: 1, origin: 'pk', partial: 0 },
    ];
    const expectedUpdatedIndex = [
      { seqno: 0, cid: 2, name: 'updated_at', desc: 0, coll: 'BINARY', key: 1 },
      { seqno: 1, cid: -1, name: null, desc: 0, coll: 'BINARY', key: 0 },
    ];
    if (
      JSON.stringify(columns) !== JSON.stringify(expectedColumns)
      || JSON.stringify(indexes) !== JSON.stringify(expectedIndexes)
      || JSON.stringify(updatedIndex) !== JSON.stringify(expectedUpdatedIndex)
    ) {
      throw new Error('kv_store schema differs from migration 028');
    }
  } catch {
    throw new Error(
      'MIGRATIONS_MODE=external requires the migrated kv_store schema; '
      + 'the application cannot create or repair it',
    );
  }
}

function runLateDataMaintenance({ failClosed }: { failClosed: boolean }): void {
  try {
    seedOwnerUser({ failClosed });
    assertOwnerBootstrapReadyForRuntime();
  } catch (err) {
    logger.error({ err }, 'Owner bootstrap initialization failed');
    throw err;
  }

  assertOAuthEncryptionConfigured();
  try {
    const result = encryptPlaintextOAuthTokens();
    if (result.encryptedRows > 0) {
      logger.warn(
        result,
        `OAuth migration: encrypted ${result.encryptedRows} legacy plaintext rows in-place`,
      );
    } else {
      logger.info(result, 'OAuth migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'OAuth plaintext migration failed — investigate before next deploy');
    if (failClosed) throw err;
  }

  try {
    assertFinanceEncryptionConfigured();
    const result = encryptPlaintextFinanceRows();
    if (result.encryptedTransactions > 0 || result.encryptedTaxEvents > 0) {
      logger.warn(result, 'Finance migration: encrypted legacy plaintext finance rows in-place');
    } else {
      logger.info(result, 'Finance migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'Finance plaintext migration failed — investigate before next deploy');
    throw err;
  }

  try {
    assertGarminEncryptionConfigured();
    const result = encryptPlaintextGarminTokens();
    if (result.encryptedSessions > 0 || result.encryptedUserTokens > 0) {
      logger.warn(result, 'Garmin migration: encrypted legacy plaintext token rows in-place');
    } else {
      logger.info(result, 'Garmin migration: all rows already encrypted');
    }
  } catch (err) {
    logger.error({ err }, 'Garmin plaintext migration failed — investigate before next deploy');
    throw err;
  }

  migrateOwnerTokens({ failClosed });

  try {
    seedDefaultSkills();
  } catch (err) {
    logger.error({ err }, 'Default skill data maintenance failed — investigate before next deploy');
    if (failClosed) throw err;
  }
}

/**
 * Run non-SQL release transformations inside the one-shot migrator's existing
 * SQLite connection. One IMMEDIATE transaction covers every transformation and
 * the immutable completion marker; any failure rolls the complete set back.
 */
export function runReleaseDataMaintenanceForMigrator(
  releaseDatabase: Database.Database,
  identity: ReleaseDataMaintenanceIdentity,
): void {
  withReleaseMaintenanceDatabase(releaseDatabase, () => {
    const maintenance = releaseDatabase.transaction(() => {
      runEarlyDataMaintenance({ failClosed: true });
      runLateDataMaintenance({ failClosed: true });
      recordReleaseDataMaintenanceCompletion(releaseDatabase, identity);
    });
    maintenance.immediate();
  });
}

/** Open, migrate/verify, and complete the application runtime bootstrap. */
export function initDatabase(): Database.Database {
  const database = initializeDatabaseCore();
  const applicationMayEnsureRuntimeStore = config.app.migrationsMode === 'boot';

  if (applicationMayEnsureRuntimeStore) {
    runEarlyDataMaintenance({ failClosed: false });
  } else {
    // A release application is verification-only. Prove the settings store is
    // present before either loader runs, then forbid local-development DDL.
    assertExternalRuntimeStoreReadable(database);
  }

  // This is fail-closed: an invalid local-model selector must prevent startup
  // rather than silently falling back to another routing state.
  loadPersistedModelOverrides(() => {
    loadModelOverrides({ ensureStore: applicationMayEnsureRuntimeStore });
  });

  try {
    const dbConfig = new DatabaseConfigProvider(getDb);
    dbConfig.loadPersistedSettings('default', {
      ensureStore: applicationMayEnsureRuntimeStore,
    });
    setConfigProvider(dbConfig);
  } catch (err) {
    if (!applicationMayEnsureRuntimeStore) throw err;
    // Local boot retains the historical best-effort fallback. Release
    // containers never swallow a failed read after external schema proof.
  }

  if (applicationMayEnsureRuntimeStore) {
    runLateDataMaintenance({ failClosed: false });
  } else {
    // Every data mutation ran in the profile-gated one-shot migrator.
    assertRuntimeDataPrerequisites();
  }

  logger.info({ path: config.app.databasePath }, 'Database initialized');
  return database;
}
