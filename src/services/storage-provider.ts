// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Storage Provider Interface
 *
 * Abstracts database interactions behind a common interface so different
 * backends (SQLite, PostgreSQL, in-memory) can be swapped without changing
 * the state/service layer.
 *
 * Current implementation: SQLiteStorage wrapping better-sqlite3.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

// ─── Core Types ─────────────────────────────────────────────────────

export interface PreparedStatement<T = any> {
  run(...params: any[]): Database.RunResult;
  get(...params: any[]): T | undefined;
  all(...params: any[]): T[];
}

// ─── Provider Interface ─────────────────────────────────────────────

export interface StorageProvider {
  /** Provider identifier (e.g., 'sqlite', 'postgres') */
  readonly name: string;

  /** Whether the provider is currently initialized and usable */
  readonly initialized: boolean;

  /**
   * Prepare a SQL statement for execution.
   * Returns a reusable prepared statement with run/get/all methods.
   */
  prepare<T = any>(sql: string): PreparedStatement<T>;

  /**
   * Execute raw SQL (e.g., multi-statement migrations, DDL).
   * Does not return results — use prepare() for queries.
   */
  exec(sql: string): void;

  /**
   * Execute a function inside a transaction.
   * Automatically commits on success, rolls back on error.
   */
  transaction<T>(fn: () => T): T;

  /**
   * Set a database pragma. Returns the pragma value.
   */
  pragma(statement: string): any;

  /** Close the database connection. */
  close(): void;
}

// ─── SQLite Implementation ──────────────────────────────────────────

export class SQLiteStorage implements StorageProvider {
  readonly name = 'sqlite';
  private db: Database.Database | null = null;

  get initialized(): boolean {
    return this.db !== null;
  }

  /**
   * Open a SQLite database at the given path.
   * Creates parent directories if needed. Enables WAL mode and foreign keys.
   */
  open(dbPath: string): void {
    const dir = path.dirname(dbPath);
    if (dbPath !== ':memory:' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    const journalMode = resolveSqliteJournalMode();
    this.db.pragma(`journal_mode = ${journalMode}`);
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('cache_size = -65536');
    this.db.pragma('mmap_size = 268435456');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('wal_autocheckpoint = 1000');
    // Wait up to 5s for write locks to release before throwing SQLITE_BUSY.
    // Default is 0 (immediate fail) which is fine at 1 user but causes
    // sporadic write failures under any concurrent load.
    this.db.pragma('busy_timeout = 5000');

    logger.info({ path: dbPath, journalMode }, 'SQLiteStorage opened');
  }

  prepare<T = any>(sql: string): PreparedStatement<T> {
    return this.requireDb().prepare(sql);
  }

  exec(sql: string): void {
    this.requireDb().exec(sql);
  }

  transaction<T>(fn: () => T): T {
    const trx = this.requireDb().transaction(fn);
    return trx();
  }

  pragma(statement: string): any {
    return this.requireDb().pragma(statement);
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      logger.info('SQLiteStorage closed');
    }
  }

  /**
   * Get the underlying better-sqlite3 instance.
   * Escape hatch for code that needs the raw driver (e.g., migrations).
   * Prefer using the StorageProvider interface methods when possible.
   */
  raw(): Database.Database {
    return this.requireDb();
  }

  private requireDb(): Database.Database {
    if (!this.db) {
      throw new Error('SQLiteStorage not initialized. Call open() first.');
    }
    return this.db;
  }
}

function resolveSqliteJournalMode(): 'WAL' | 'DELETE' | 'TRUNCATE' | 'PERSIST' | 'MEMORY' | 'OFF' {
  const raw = String(process.env.SQLITE_JOURNAL_MODE || 'WAL').trim().toUpperCase();
  switch (raw) {
    case 'DELETE':
    case 'TRUNCATE':
    case 'PERSIST':
    case 'MEMORY':
    case 'OFF':
    case 'WAL':
      return raw;
    default:
      logger.warn({ requested: raw }, 'Invalid SQLITE_JOURNAL_MODE; falling back to WAL');
      return 'WAL';
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _storage: StorageProvider | null = null;

/**
 * Get the current StorageProvider instance.
 * Throws if not initialized — call setStorageProvider() first.
 */
export function getStorage(): StorageProvider {
  if (!_storage) {
    throw new Error('StorageProvider not initialized. Call setStorageProvider() first.');
  }
  return _storage;
}

/**
 * Set the active StorageProvider.
 * Called once during app startup after opening the database.
 */
export function setStorageProvider(provider: StorageProvider): void {
  _storage = provider;
}

/**
 * Clear the StorageProvider singleton (for tests).
 */
export function clearStorageProvider(): void {
  _storage = null;
}
