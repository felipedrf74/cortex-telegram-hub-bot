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
