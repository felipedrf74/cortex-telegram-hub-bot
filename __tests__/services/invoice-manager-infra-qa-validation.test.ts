/**
 * QA Validation — Invoice Manager Infrastructure
 *
 * Validates the three new modules introduced in the Invoice Manager NLP feature:
 *   1. Migration 023 — invoice_nlp_rules + invoice_collection_schedule tables
 *   2. Webhook registry edge cases (no-DB fallbacks, JSON parsing)
 *   3. Error monitor process handler idempotency
 *   4. Config webhooks section
 *   5. Portal snapshot new invoice fields
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

function applyMigrations(db: Database.Database): void {
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
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

// ── Mocks ──────────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../src/portal/telemetry', () => ({
  pushEvent: vi.fn(),
}));

import {
  setDbProvider as setWebhookDbProvider,
  registerSubscription,
  getSubscriptions,
  getSubscription,
  getWebhookStats,
  getRecentEvents,
  receiveWebhookEvent,
  verifySignature,
} from '../../src/services/webhook-registry';

import {
  setDbProvider as setErrorDbProvider,
  captureError,
  getErrorTrends,
} from '../../src/services/error-monitor';

import { pushEvent } from '../../src/portal/telemetry';
import { config } from '../../src/config';

// ════════════════════════════════════════════════════════════════════
// 1. MIGRATION 023 — Invoice NLP Rules & Collection Schedule
// ════════════════════════════════════════════════════════════════════

describe('Migration 023 — invoice_nlp_rules & invoice_collection_schedule', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('creates invoice_nlp_rules table with all columns', () => {
    const info = testDb.prepare("PRAGMA table_info('invoice_nlp_rules')").all() as any[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('name');
    expect(cols).toContain('description');
    expect(cols).toContain('vendor_pattern');
    expect(cols).toContain('sender_pattern');
    expect(cols).toContain('subject_patterns');
    expect(cols).toContain('amount_pattern');
    expect(cols).toContain('action');
    expect(cols).toContain('folder_override');
    expect(cols).toContain('confidence_threshold');
    expect(cols).toContain('enabled');
    expect(cols).toContain('priority');
    expect(cols).toContain('match_count');
    expect(cols).toContain('last_matched_at');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('creates invoice_collection_schedule table with all columns', () => {
    const info = testDb.prepare("PRAGMA table_info('invoice_collection_schedule')").all() as any[];
    const cols = info.map(c => c.name);
    expect(cols).toContain('id');
    expect(cols).toContain('collector_type');
    expect(cols).toContain('vendor_name');
    expect(cols).toContain('cron_expression');
    expect(cols).toContain('timezone');
    expect(cols).toContain('enabled');
    expect(cols).toContain('last_run_at');
    expect(cols).toContain('next_run_at');
    expect(cols).toContain('last_result');
    expect(cols).toContain('last_error');
    expect(cols).toContain('run_count');
    expect(cols).toContain('config_json');
    expect(cols).toContain('created_at');
    expect(cols).toContain('updated_at');
  });

  it('has unique index on nlp_rules name', () => {
    const indexes = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invoice_nlp_rules'"
    ).all() as any[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_nlp_rules_name');
  });

  it('has index on nlp_rules enabled+priority', () => {
    const indexes = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invoice_nlp_rules'"
    ).all() as any[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_nlp_rules_enabled');
  });

  it('has unique composite index on collection_schedule (collector_type, vendor_name)', () => {
    const indexes = testDb.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='invoice_collection_schedule'"
    ).all() as any[];
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_collection_schedule_unique');
  });

  it('enforces unique name on invoice_nlp_rules', () => {
    testDb.prepare(
      `INSERT INTO invoice_nlp_rules (name, action) VALUES ('MEO invoices', 'file')`
    ).run();
    expect(() => {
      testDb.prepare(
        `INSERT INTO invoice_nlp_rules (name, action) VALUES ('MEO invoices', 'notify')`
      ).run();
    }).toThrow(/UNIQUE constraint/);
  });

  it('enforces unique (collector_type, vendor_name) on collection schedule', () => {
    testDb.prepare(
      `INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression) VALUES ('email', 'meo', '0 9 1 * *')`
    ).run();
    expect(() => {
      testDb.prepare(
        `INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression) VALUES ('email', 'meo', '0 10 1 * *')`
      ).run();
    }).toThrow(/UNIQUE constraint/);
  });

  it('allows null vendor_name for global collectors', () => {
    const result = testDb.prepare(
      `INSERT INTO invoice_collection_schedule (collector_type, cron_expression) VALUES ('email', '0 9 1 * *')`
    ).run();
    expect(result.lastInsertRowid).toBeGreaterThan(0);
  });

  it('defaults confidence_threshold to 0.7', () => {
    testDb.prepare(
      `INSERT INTO invoice_nlp_rules (name, action) VALUES ('test-rule', 'file')`
    ).run();
    const row = testDb.prepare('SELECT confidence_threshold FROM invoice_nlp_rules WHERE name = ?').get('test-rule') as any;
    expect(row.confidence_threshold).toBe(0.7);
  });

  it('defaults timezone to Europe/Madrid for collection schedule', () => {
    testDb.prepare(
      `INSERT INTO invoice_collection_schedule (collector_type, cron_expression) VALUES ('amazon', '0 10 * * *')`
    ).run();
    const row = testDb.prepare('SELECT timezone FROM invoice_collection_schedule WHERE collector_type = ?').get('amazon') as any;
    expect(row.timezone).toBe('Europe/Madrid');
  });

  it('action field defaults to file', () => {
    testDb.prepare(`INSERT INTO invoice_nlp_rules (name) VALUES ('default-action-rule')`).run();
    const row = testDb.prepare('SELECT action FROM invoice_nlp_rules WHERE name = ?').get('default-action-rule') as any;
    expect(row.action).toBe('file');
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. WEBHOOK REGISTRY — Edge Cases & No-DB Fallbacks
// ════════════════════════════════════════════════════════════════════

describe('Webhook registry — edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setWebhookDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('registerSubscription returns -1 when DB provider throws', () => {
    setWebhookDbProvider(() => { throw new Error('DB gone'); });
    const id = registerSubscription({ provider: 'garmin', endpoint_path: '/a' });
    expect(id).toBe(-1);
  });

  it('getSubscriptions returns [] when DB provider is null', () => {
    setWebhookDbProvider(null as any);
    const subs = getSubscriptions();
    expect(subs).toEqual([]);
  });

  it('getWebhookStats returns zeros when DB provider throws', () => {
    setWebhookDbProvider(() => { throw new Error('DB gone'); });
    const stats = getWebhookStats();
    expect(stats.totalSubscriptions).toBe(0);
    expect(stats.activeSubscriptions).toBe(0);
    expect(stats.eventsToday).toBe(0);
  });

  it('getRecentEvents returns [] when DB is unavailable', () => {
    setWebhookDbProvider(null as any);
    const events = getRecentEvents();
    expect(events).toEqual([]);
  });

  it('receiveWebhookEvent returns -1 when DB is unavailable', async () => {
    setWebhookDbProvider(null as any);
    const eventId = await receiveWebhookEvent({
      provider: 'garmin',
      event_type: 'activity',
      payload: { test: true },
    });
    expect(eventId).toBe(-1);
  });

  it('verifySignature rejects tampered body', () => {
    const secret = 'test-secret';
    const body = '{"original":true}';
    const tamperedBody = '{"original":false}';
    const sig = require('crypto').createHmac('sha256', secret).update(body).digest('hex');

    const valid = verifySignature('custom', tamperedBody, { 'x-webhook-signature': sig }, secret);
    expect(valid).toBe(false);
  });

  it('verifySignature handles non-hex signature gracefully', () => {
    const valid = verifySignature('custom', 'body', { 'x-webhook-signature': 'not-hex-at-all!' }, 'secret');
    expect(valid).toBe(false);
  });

  it('subscription metadata round-trips through JSON correctly', () => {
    const id = registerSubscription({
      provider: 'google_calendar',
      endpoint_path: '/api/webhooks/google_calendar',
      metadata: { calendarId: 'primary', nested: { a: 1, b: [2, 3] } },
    });
    const sub = getSubscription(id);
    expect(sub?.metadata).toEqual({ calendarId: 'primary', nested: { a: 1, b: [2, 3] } });
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. ERROR MONITOR — Edge Cases
// ════════════════════════════════════════════════════════════════════

describe('Error monitor — edge cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
    setErrorDbProvider(() => testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('captureError truncates stack to 4000 chars', () => {
    const longStack = 'x'.repeat(5000);
    captureError({
      level: 'error',
      source: 'bot',
      message: 'Test',
      stack: longStack,
    });
    const row = testDb.prepare('SELECT stack FROM error_log').get() as any;
    expect(row.stack.length).toBe(4000);
  });

  it('captureError handles null context gracefully', () => {
    captureError({
      level: 'warning',
      source: 'api',
      message: 'No context',
    });
    const row = testDb.prepare('SELECT context FROM error_log').get() as any;
    expect(row.context).toBeNull();
  });

  it('getErrorTrends returns empty when DB throws', () => {
    setErrorDbProvider(() => { throw new Error('DB gone'); });
    const trends = getErrorTrends();
    expect(trends.today).toBe(0);
    expect(trends.recent).toEqual([]);
  });

  it('captureError still pushes telemetry even without DB', () => {
    setErrorDbProvider(null as any);
    captureError({ level: 'error', source: 'bot', message: 'No DB' });
    expect(pushEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. CONFIG — Webhooks Section
// ════════════════════════════════════════════════════════════════════

describe('Config — webhooks section', () => {
  it('config.webhooks exists with expected shape', () => {
    expect(config.webhooks).toBeDefined();
    expect(typeof config.webhooks.enabled).toBe('boolean');
    expect(typeof config.webhooks.secret).toBe('string');
    expect(typeof config.webhooks.maxPayloadBytes).toBe('number');
    expect(typeof config.webhooks.eventRetentionDays).toBe('number');
  });

  it('maxPayloadBytes defaults to 1MB (1048576)', () => {
    expect(config.webhooks.maxPayloadBytes).toBe(1048576);
  });

  it('eventRetentionDays defaults to 30', () => {
    expect(config.webhooks.eventRetentionDays).toBe(30);
  });

  it('webhooks.enabled defaults to true', () => {
    expect(config.webhooks.enabled).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. PORTAL — NLP & Schedule snapshot fields
// ════════════════════════════════════════════════════════════════════

describe('Portal snapshot — invoice NLP fields', () => {
  beforeEach(() => {
    testDb = createTestDb();
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  it('invoice_nlp_rules count query works on empty table', () => {
    const row = testDb.prepare('SELECT COUNT(*) as c FROM invoice_nlp_rules').get() as any;
    expect(row.c).toBe(0);
  });

  it('invoice_nlp_rules count reflects inserted rules', () => {
    testDb.prepare(`INSERT INTO invoice_nlp_rules (name, action) VALUES ('rule1', 'file')`).run();
    testDb.prepare(`INSERT INTO invoice_nlp_rules (name, action, enabled) VALUES ('rule2', 'notify', 0)`).run();

    const total = (testDb.prepare('SELECT COUNT(*) as c FROM invoice_nlp_rules').get() as any).c;
    const active = (testDb.prepare('SELECT COUNT(*) as c FROM invoice_nlp_rules WHERE enabled = 1').get() as any).c;
    expect(total).toBe(2);
    expect(active).toBe(1);
  });

  it('collection schedule count query works on empty table', () => {
    const row = testDb.prepare('SELECT COUNT(*) as c FROM invoice_collection_schedule WHERE enabled = 1').get() as any;
    expect(row.c).toBe(0);
  });

  it('collection schedule count reflects enabled collectors', () => {
    testDb.prepare(
      `INSERT INTO invoice_collection_schedule (collector_type, cron_expression, enabled) VALUES ('email', '0 9 1 * *', 1)`
    ).run();
    testDb.prepare(
      `INSERT INTO invoice_collection_schedule (collector_type, vendor_name, cron_expression, enabled) VALUES ('amazon', 'amazon', '0 10 * * *', 0)`
    ).run();

    const active = (testDb.prepare('SELECT COUNT(*) as c FROM invoice_collection_schedule WHERE enabled = 1').get() as any).c;
    expect(active).toBe(1);
  });
});
