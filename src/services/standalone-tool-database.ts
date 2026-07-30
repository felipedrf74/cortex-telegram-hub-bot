// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { withDatabaseForTestAsync } from './database';

/**
 * Bind a standalone operational tool to its caller-owned SQLite connection.
 *
 * Standalone tools intentionally do not call initDatabase(): that path opens
 * the configured runtime database and performs application boot mutations.
 * The existing scoped database primitive is reused behind this operational
 * adapter so the broad database module does not gain another runtime export
 * that every module-boundary test mock must implement.
 */
export function withStandaloneToolDatabaseAsync<T>(
  standaloneDb: Database.Database,
  callback: () => Promise<T>,
): Promise<T> {
  return withDatabaseForTestAsync(
    standaloneDb,
    callback,
    { requireUninitialized: true },
  );
}
