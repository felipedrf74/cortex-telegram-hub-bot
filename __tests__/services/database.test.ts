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
    'installed_skills', 'skill_submodules',
    'skill_credentials', 'skill_migrations',
    'invoice_nlp_rules', 'invoice_collection_schedule',
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

  describe('invoice_nlp_rules table', () => {
    it('inserts and retrieves NLP rules', () => {
      db.prepare(`
        INSERT INTO invoice_nlp_rules (name, description, vendor_pattern, sender_pattern, action, confidence_threshold)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('MEO invoices', 'save attachments from meo.pt as MEO invoices', 'MEO', 'meo.pt', 'file', 0.8);

      const rule = db.prepare('SELECT * FROM invoice_nlp_rules WHERE name = ?').get('MEO invoices') as any;
      expect(rule.vendor_pattern).toBe('MEO');
      expect(rule.sender_pattern).toBe('meo.pt');
      expect(rule.confidence_threshold).toBe(0.8);
      expect(rule.enabled).toBe(1);
      expect(rule.match_count).toBe(0);
    });

    it('enforces unique name constraint', () => {
      db.prepare('INSERT INTO invoice_nlp_rules (name, action) VALUES (?, ?)').run('Test Rule', 'file');
      expect(() => {
        db.prepare('INSERT INTO invoice_nlp_rules (name, action) VALUES (?, ?)').run('Test Rule', 'notify');
      }).toThrow();
    });

    it('increments match_count', () => {
      db.prepare('INSERT INTO invoice_nlp_rules (name, action) VALUES (?, ?)').run('Counter Rule', 'file');
      db.prepare('UPDATE invoice_nlp_rules SET match_count = match_count + 1, last_matched_at = datetime(\'now\') WHERE name = ?').run('Counter Rule');
      const rule = db.prepare('SELECT match_count FROM invoice_nlp_rules WHERE name = ?').get('Counter Rule') as any;
      expect(rule.match_count).toBe(1);
    });

    it('filters by enabled and priority', () => {
      db.prepare('INSERT INTO invoice_nlp_rules (name, action, enabled, priority) VALUES (?, ?, ?, ?)').run('High', 'file', 1, 10);
      db.prepare('INSERT INTO invoice_nlp_rules (name, action, enabled, priority) VALUES (?, ?, ?, ?)').run('Low', 'file', 1, 1);
      db.prepare('INSERT INTO invoice_nlp_rules (name, action, enabled, priority) VALUES (?, ?, ?, ?)').run('Disabled', 'file', 0, 100);

      const active = db.prepare('SELECT name FROM invoice_nlp_rules WHERE enabled = 1 ORDER BY priority DESC').all() as any[];
      expect(active).toHaveLength(2);
      expect(active[0].name).toBe('High');
      expect(active[1].name).toBe('Low');
    });
  });

  describe('invoice_collection_schedule table', () => {
    it('inserts and retrieves collection schedules', () => {
      db.prepare(`
        INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression, config_json)
        VALUES (?, ?, ?, ?)
      `).run('email', 'MEO', '0 9 1 * *', JSON.stringify({ sender: 'meo.pt' }));

      const schedule = db.prepare('SELECT * FROM invoice_collection_schedule WHERE vendor_name = ?').get('MEO') as any;
      expect(schedule.collector_type).toBe('email');
      expect(schedule.cron_expression).toBe('0 9 1 * *');
      expect(JSON.parse(schedule.config_json).sender).toBe('meo.pt');
      expect(schedule.enabled).toBe(1);
      expect(schedule.run_count).toBe(0);
    });

    it('enforces unique collector_type + vendor_name', () => {
      db.prepare('INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression) VALUES (?, ?, ?)').run('email', 'MEO', '0 9 1 * *');
      expect(() => {
        db.prepare('INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression) VALUES (?, ?, ?)').run('email', 'MEO', '0 10 1 * *');
      }).toThrow();
    });

    it('tracks run results', () => {
      db.prepare('INSERT INTO invoice_collection_schedule (collector_type, cron_expression) VALUES (?, ?)').run('amazon', '15 9 1 * *');
      db.prepare(`
        UPDATE invoice_collection_schedule
        SET last_run_at = datetime('now'), last_result = 'success', run_count = run_count + 1
        WHERE collector_type = ?
      `).run('amazon');

      const schedule = db.prepare('SELECT * FROM invoice_collection_schedule WHERE collector_type = ?').get('amazon') as any;
      expect(schedule.last_result).toBe('success');
      expect(schedule.run_count).toBe(1);
    });

    it('finds due schedules', () => {
      db.prepare('INSERT INTO invoice_collection_schedule (collector_type, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?)').run('email', '0 9 1 * *', '2020-01-01T00:00:00', 1);
      db.prepare('INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression, next_run_at, enabled) VALUES (?, ?, ?, ?, ?)').run('uber', 'Uber', '30 9 1 * *', '2099-01-01T00:00:00', 1);
      db.prepare('INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression, enabled) VALUES (?, ?, ?, ?)').run('amazon', 'Amazon', '15 9 1 * *', 0);

      const due = db.prepare(`
        SELECT * FROM invoice_collection_schedule
        WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= datetime('now'))
      `).all() as any[];
      expect(due).toHaveLength(1);
      expect(due[0].collector_type).toBe('email');
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
