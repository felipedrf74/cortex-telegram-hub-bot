// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import { SQLiteStorage, setStorageProvider, clearStorageProvider } from './storage-provider';

let db: Database.Database;
let storage: SQLiteStorage | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  // Initialize via StorageProvider — single connection, shared via raw()
  storage = new SQLiteStorage();
  storage.open(config.app.databasePath);
  setStorageProvider(storage);

  // Expose raw driver for backward compatibility (state files use getDb())
  db = storage.raw();

  runMigrations();

  // Load persisted model overrides from kv_store (after migrations create the table)
  try {
    const { loadModelOverrides } = require('./model-config');
    loadModelOverrides();
  } catch { /* model-config not yet available — non-critical */ }

  // Load persisted settings overrides from kv_store
  try {
    const { DatabaseConfigProvider, setConfigProvider } = require('./config-provider');
    const dbConfig = new DatabaseConfigProvider();
    dbConfig.loadPersistedSettings();
    setConfigProvider(dbConfig);
  } catch { /* config-provider not yet available — non-critical */ }

  // Seed owner user from TELEGRAM_ALLOWED_USER_IDS or OWNER_TELEGRAM_ID
  try {
    const { seedOwnerUser } = require('./user-service');
    seedOwnerUser();
  } catch { /* user-service not yet available — non-critical */ }

  // Migrate owner's OAuth tokens from .env to per-user storage
  try {
    const { migrateOwnerTokens } = require('./oauth-store');
    migrateOwnerTokens();
  } catch { /* oauth-store not yet available — non-critical */ }

  // Seed default skills into installed_skills table (idempotent)
  try {
    const { seedDefaultSkills } = require('../skills/skill-manager');
    seedDefaultSkills();
  } catch { /* skill-manager not yet available — non-critical */ }

  logger.info({ path: config.app.databasePath }, 'Database initialized');
  return db;
}

function runMigrations(): void {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  if (!fs.existsSync(migrationsDir)) {
    logger.warn('Migrations directory not found');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  // Lint: warn on numeric prefix collisions. Apply order between two files
  // sharing the same prefix is filesystem-sort-dependent (locale, OS), so
  // collisions are silent timebombs for cross-environment schema drift.
  // We log loudly here so future devs (and AI agents in the factory) get
  // a flag the moment they introduce one. See audit P0-5.
  const prefixMap = new Map<string, string[]>();
  for (const f of files) {
    const m = f.match(/^(\d{3})_/);
    if (m) {
      const prefix = m[1];
      const list = prefixMap.get(prefix) ?? [];
      list.push(f);
      prefixMap.set(prefix, list);
    }
  }
  const collisions = [...prefixMap.entries()].filter(([, list]) => list.length > 1);
  if (collisions.length > 0) {
    for (const [prefix, list] of collisions) {
      logger.warn(
        { prefix, files: list },
        `Migration prefix collision: ${list.length} files share prefix ${prefix}. Apply order is locale-dependent. Future migrations should use unique prefixes (e.g. ${prefix}a_, ${prefix}b_) or timestamp prefixes (YYYYMMDD_).`,
      );
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db.prepare('SELECT filename FROM _migrations').all()
      .map((row: any) => row.filename)
  );

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    logger.info({ migration: file }, 'Migration applied');
  }
}

export function closeDatabase(): void {
  if (storage) {
    storage.close();
    clearStorageProvider();
    storage = null;
  }
  logger.info('Database closed');
}
