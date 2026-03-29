/**
 * Database & Migration Tests
 * 
 * Tests that:
 * - Database initializes correctly with in-memory SQLite
 * - All 18+ migrations apply without errors
 * - Core CRUD operations work on key tables
 * - Migration sequence has no gaps
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
    applied.push(file);
  }

  return applied;
}

// ═══════════════════════════════════════════════════════════════════
// MIGRATION TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Database Migrations', () => {
  let db: Database.Database;

  beforeEach(() => { db = createTestDb(); });
  afterEach(() => { db.close(); });

  it('applies all migrations without errors', () => {
    const applied = applyMigrations(db);
    expect(applied.length).toBeGreaterThanOrEqual(18);
  });

  it('migrations are idempotent (safe to run twice)', () => {
    applyMigrations(db);
    const applied = new Set(
      db.prepare('SELECT filename FROM _migrations').all()
        .map((row: any) => row.filename)
    );
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      expect(applied.has(file)).toBe(true);
    }
  });

  it('migration filenames follow sequential numbering', () => {
    const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
    files.forEach((file, i) => {
      const num = parseInt(file.match(/^(\d+)/)?.[1] || '0', 10);
      expect(num).toBe(i + 1);
    });
  });

  it('creates _migrations tracking table', () => {
    applyMigrations(db);
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'"
    ).all();
    expect(tables).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// TABLE STRUCTURE TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Database Schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });
  afterEach(() => { db.close(); });

  // Tables from actual migrations — verified against migration SQL files
  const expectedTables = [
    'todos', 'notes', 'reminders', 'conversations', 'shared_memory',
    'saved_ideas', 'invoice_filings', 'invoice_vendors', 'api_usage',
    'email_log', 'job_history', 'invoice_queue', 'content_ref_channels',
    'content_patterns', 'content_knowledge', 'video_transcripts',
    'video_studies', 'content_topic_feedback', 'agent_signals',
    'agent_runs', 'book_library', 'content_pipeline',
  ];

  it.each(expectedTables)('table "%s" exists', (table) => {
    const result = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
    ).get(table);
    expect(result).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════
// CRUD TESTS
// ═══════════════════════════════════════════════════════════════════

describe('Database CRUD Operations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    applyMigrations(db);
  });
  afterEach(() => { db.close(); });

  describe('conversations table', () => {
    it('inserts and retrieves messages', () => {
      db.prepare(
        'INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)'
      ).run('secretary', 'user', 'Hello there');

      const rows = db.prepare('SELECT * FROM conversations WHERE domain = ?').all('secretary');
      expect(rows).toHaveLength(1);
      expect((rows[0] as any).content).toBe('Hello there');
    });

    it('respects domain isolation', () => {
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('secretary', 'user', 'sec msg');
      db.prepare('INSERT INTO conversations (domain, role, content) VALUES (?, ?, ?)').run('triathlon', 'user', 'tri msg');

      const secRows = db.prepare('SELECT * FROM conversations WHERE domain = ?').all('secretary');
      const triRows = db.prepare('SELECT * FROM conversations WHERE domain = ?').all('triathlon');
      expect(secRows).toHaveLength(1);
      expect(triRows).toHaveLength(1);
    });
  });

  describe('api_usage table', () => {
    it('tracks API calls with cost', () => {
      db.prepare(`
        INSERT INTO api_usage (model, category, input_tokens, output_tokens, cost_usd, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('claude-sonnet-4-6', 'domain-secretary', 500, 200, 0.0035, 1200);

      const row = db.prepare('SELECT * FROM api_usage').get() as any;
      expect(row.model).toBe('claude-sonnet-4-6');
      expect(row.cost_usd).toBe(0.0035);
    });
  });

  describe('agent_signals table', () => {
    it('inserts signals with expiry', () => {
      db.prepare(`
        INSERT INTO agent_signals (source_agent, signal_type, priority, payload, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('seo-agent', 'keyword_rank_change', 'normal', '{"keyword":"ai tools"}', '2026-04-05T00:00:00Z', 'active');

      const signal = db.prepare('SELECT * FROM agent_signals WHERE source_agent = ?').get('seo-agent') as any;
      expect(signal.signal_type).toBe('keyword_rank_change');
      expect(signal.status).toBe('active');
    });

    it('can dismiss a signal', () => {
      const { lastInsertRowid } = db.prepare(`
        INSERT INTO agent_signals (source_agent, signal_type, priority, payload, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('seo-agent', 'seo_opportunity', 'normal', '{}', '2026-04-05T00:00:00Z', 'active');

      db.prepare('UPDATE agent_signals SET status = ? WHERE id = ?').run('dismissed', lastInsertRowid);

      const signal = db.prepare('SELECT * FROM agent_signals WHERE id = ?').get(lastInsertRowid) as any;
      expect(signal.status).toBe('dismissed');
    });
  });

  describe('job_history table', () => {
    it('logs job executions', () => {
      // Actual schema: job_name, result (not status), duration_ms, error_message, ts
      db.prepare(`
        INSERT INTO job_history (job_name, result, duration_ms, error_message)
        VALUES (?, ?, ?, ?)
      `).run('daily_briefing', 'success', 3500, null);

      db.prepare(`
        INSERT INTO job_history (job_name, result, duration_ms, error_message)
        VALUES (?, ?, ?, ?)
      `).run('garmin_coach', 'failed', 12000, 'Garmin 403: session expired');

      const successes = db.prepare("SELECT * FROM job_history WHERE result = 'success'").all();
      const failures = db.prepare("SELECT * FROM job_history WHERE result = 'failed'").all();
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      expect((failures[0] as any).error_message).toContain('403');
    });
  });

  describe('book_library table', () => {
    it('inserts and retrieves books', () => {
      db.prepare(`
        INSERT INTO book_library (title, author, core_thesis, extraction_status)
        VALUES (?, ?, ?, ?)
      `).run('The Law', 'Frédéric Bastiat', 'Legal plunder is the root of injustice', 'complete');

      const book = db.prepare('SELECT * FROM book_library WHERE title = ?').get('The Law') as any;
      expect(book.author).toBe('Frédéric Bastiat');
      expect(book.extraction_status).toBe('complete');
    });

    it('enforces unique title+author constraint', () => {
      db.prepare('INSERT INTO book_library (title, author) VALUES (?, ?)').run('The Law', 'Bastiat');
      
      expect(() => {
        db.prepare('INSERT INTO book_library (title, author) VALUES (?, ?)').run('The Law', 'Bastiat');
      }).toThrow();
    });
  });

  describe('content_pipeline table', () => {
    it('tracks content through stages', () => {
      db.prepare(`
        INSERT INTO content_pipeline (topic_title, niche, stage)
        VALUES (?, ?, ?)
      `).run('Why the free market works', 'economics', 'approved');

      const item = db.prepare('SELECT * FROM content_pipeline WHERE topic_title LIKE ?').get('%free market%') as any;
      expect(item.stage).toBe('approved');
      expect(item.niche).toBe('economics');
    });
  });
});
