// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { applyPendingMigrations } from '../services/migration-runner';

type MigratedTestDatabaseOptions = {
  excludeFiles?: readonly string[];
  stopBefore?: string;
};

const templateBuffers = new Map<string, Buffer>();

function templateKey(options: MigratedTestDatabaseOptions): string {
  return JSON.stringify({
    excludeFiles: [...(options.excludeFiles ?? [])].sort(),
    stopBefore: options.stopBefore ?? null,
  });
}

/**
 * Create a clean copy of one migrated SQLite template per worker and schema
 * shape. Exclusions exist only for focused migration-order/idempotency tests;
 * ordinary tests should use the fully migrated default template.
 */
export function createMigratedTestDatabase(
  options: MigratedTestDatabaseOptions = {},
): Database.Database {
  const key = templateKey(options);
  let templateBuffer = templateBuffers.get(key);
  if (!templateBuffer) {
    const template = new Database(':memory:');
    template.pragma('foreign_keys = ON');
    applyPendingMigrations(template, {
      excludeFiles: new Set(options.excludeFiles ?? []),
      stopBefore: options.stopBefore,
    });
    templateBuffer = Buffer.from(template.serialize());
    templateBuffers.set(key, templateBuffer);
    template.close();
  }

  const database = new Database(Buffer.from(templateBuffer));
  database.pragma('foreign_keys = ON');
  return database;
}
