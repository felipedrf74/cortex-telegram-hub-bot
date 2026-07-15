// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { applyPendingMigrations } from '../services/migration-runner';

let templateBuffer: Buffer | null = null;

/** Create a clean copy of one fully migrated SQLite template per worker. */
export function createMigratedTestDatabase(): Database.Database {
  if (!templateBuffer) {
    const template = new Database(':memory:');
    template.pragma('foreign_keys = ON');
    applyPendingMigrations(template);
    templateBuffer = Buffer.from(template.serialize());
    template.close();
  }

  const database = new Database(Buffer.from(templateBuffer));
  database.pragma('foreign_keys = ON');
  return database;
}
