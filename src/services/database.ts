import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase() first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  const dbDir = path.dirname(config.app.databasePath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(config.app.databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
  if (db) {
    db.close();
    logger.info('Database closed');
  }
}
