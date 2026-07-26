// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { applyPendingMigrations, ensureMigrationSqlFunctions } from '../services/migration-runner';
import { readMigratedTestDatabaseTemplate } from './migrated-test-database-template';

type MigratedTestDatabaseOptions = {
  excludeFiles?: readonly string[];
  stopBefore?: string;
};

const fallbackTemplateBuffers = new Map<string, Buffer>();
const externalTemplateBuffers = new Map<string, Buffer>();

const externalTemplateEnvironment = {
  databasePath: 'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_PATH',
  databaseSha256: 'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_SHA256',
  migrationSha256: 'NEXUS_MIGRATED_TEST_DATABASE_MIGRATION_SHA256',
  receiptPath: 'NEXUS_MIGRATED_TEST_DATABASE_TEMPLATE_RECEIPT_PATH',
} as const;

function templateKey(options: MigratedTestDatabaseOptions): string {
  return JSON.stringify({
    excludeFiles: [...(options.excludeFiles ?? [])].sort(),
    stopBefore: options.stopBefore ?? null,
  });
}

function isFullMigrationShape(options: MigratedTestDatabaseOptions): boolean {
  return options.excludeFiles === undefined && options.stopBefore === undefined;
}

function configuredExternalTemplate(): {
  databasePath: string;
  databaseSha256: string;
  migrationSha256: string;
  receiptPath: string;
} | null {
  const values = {
    databasePath: process.env[externalTemplateEnvironment.databasePath],
    databaseSha256: process.env[externalTemplateEnvironment.databaseSha256],
    migrationSha256: process.env[externalTemplateEnvironment.migrationSha256],
    receiptPath: process.env[externalTemplateEnvironment.receiptPath],
  };
  const populated = Object.values(values).filter((value) => value !== undefined);
  if (populated.length === 0) return null;
  if (populated.length !== Object.keys(values).length) {
    throw new Error(
      'Migrated test database template environment is incomplete; refusing migration fallback',
    );
  }
  return values as {
    databasePath: string;
    databaseSha256: string;
    migrationSha256: string;
    receiptPath: string;
  };
}

function fullMigrationTemplateBuffer(): Buffer | null {
  const configured = configuredExternalTemplate();
  if (!configured) return null;
  const key = JSON.stringify(configured);
  let buffer = externalTemplateBuffers.get(key);
  if (!buffer) {
    buffer = readMigratedTestDatabaseTemplate({
      databasePath: configured.databasePath,
      expectedDatabaseSha256: configured.databaseSha256,
      expectedMigrationSha256: configured.migrationSha256,
      receiptPath: configured.receiptPath,
    });
    externalTemplateBuffers.set(key, buffer);
  }
  return buffer;
}

function fallbackTemplateBuffer(options: MigratedTestDatabaseOptions): Buffer {
  const key = templateKey(options);
  let templateBuffer = fallbackTemplateBuffers.get(key);
  if (!templateBuffer) {
    const template = new Database(':memory:');
    try {
      template.pragma('foreign_keys = ON');
      applyPendingMigrations(template, {
        excludeFiles: new Set(options.excludeFiles ?? []),
        stopBefore: options.stopBefore,
      });
      templateBuffer = Buffer.from(template.serialize());
      fallbackTemplateBuffers.set(key, templateBuffer);
    } finally {
      template.close();
    }
  }
  return templateBuffer;
}

/**
 * Create a clean copy of one migrated SQLite template per worker and schema
 * shape. The default full schema may be supplied once by the test-tier runner.
 * Exclusions and stop-before shapes always exercise the canonical migration
 * runner locally so focused migration-order/idempotency tests retain their
 * original behavior.
 */
export function createMigratedTestDatabase(
  options: MigratedTestDatabaseOptions = {},
): Database.Database {
  const templateBuffer = (
    isFullMigrationShape(options) ? fullMigrationTemplateBuffer() : null
  ) ?? fallbackTemplateBuffer(options);

  const database = new Database(Buffer.from(templateBuffer));
  database.pragma('foreign_keys = ON');
  ensureMigrationSqlFunctions(database);
  return database;
}
