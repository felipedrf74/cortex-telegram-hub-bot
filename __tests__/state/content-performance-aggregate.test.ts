/**
 * CONTENT-UI-O3 (2026-05-04): Content Performance aggregate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import { getContentPerformanceAggregate } from '../../src/state/content-performance-aggregate';
import { recordRadarFeedback } from '../../src/state/content-radar-feedback';

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY,
    filename TEXT UNIQUE,
    applied_at TEXT DEFAULT (datetime('now'))
  )`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch (err) { /* skip dep failures */ }
    }
  }
}

const USER_A = 3001;
const USER_B = 3002;

function insertTopic(
  userId: number,
  tenantId: number,
  status: string,
  scheduledDate: string | null = null,
  daysAgo = 0,
): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_topics (
      user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      title, status, scheduled_date, lifecycle_state,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'user_private', 'active', ?, ?, ?, 'active', ${dateExpr}, ${dateExpr})
  `).run(userId, tenantId, userId, `Topic for ${userId}-${status}-${Math.random()}`, status, scheduledDate);
}

function insertScript(userId: number, tenantId: number, daysAgo = 0): void {
  const dateExpr = daysAgo === 0 ? "datetime('now')" : `datetime('now', '-${daysAgo} days')`;
  testDb.prepare(`
    INSERT INTO content_scripts (
      user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
      topic, format, script_text, created_at
    ) VALUES (?, ?, ?, 'user_private', 'active', ?, 'youtube', 'script body', ${dateExpr})
  `).run(userId, tenantId, userId, `Script for ${userId}-${Math.random()}`);
}

describe('content-performance-aggregate (CONTENT-UI-O3)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('returns the empty aggregate for a user with no data', () => {
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(0);
    expect(a.scripts.total).toBe(0);
    expect(a.ideas.total).toBe(0);
    expect(a.radarFeedback.total).toBe(0);
    expect(a.highlights).toEqual([]);
  });

  it('counts topics by status', () => {
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'planned');
    insertTopic(USER_A, USER_A, 'drafting');
    insertTopic(USER_A, USER_A, 'published');
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.total).toBe(4);
    expect(a.topics.byStatus.planned).toBe(2);
    expect(a.topics.byStatus.drafting).toBe(1);
    expect(a.topics.byStatus.published).toBe(1);
  });

  it('counts publishedLast30d but excludes older publishes', () => {
    insertTopic(USER_A, USER_A, 'published', null, 5);   // within 30d
    insertTopic(USER_A, USER_A, 'published', null, 50);  // older — outside window
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.topics.publishedLast30d).toBe(1);
  });

  it('aggregates radar feedback by action', () => {
    recordRadarFeedback(USER_A, USER_A, { signalId: 's1', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's2', action: 'accept', signalTopic: 'AI workflows' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's3', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's4', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's5', action: 'reject', signalTopic: 'Crypto trading' });
    recordRadarFeedback(USER_A, USER_A, { signalId: 's6', action: 'save', signalTopic: 'Saved A' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.radarFeedback.total).toBe(6);
    expect(a.radarFeedback.byAction.accept).toBe(2);
    expect(a.radarFeedback.byAction.reject).toBe(3);
    expect(a.radarFeedback.byAction.save).toBe(1);
    expect(a.radarFeedback.topAcceptedTopics[0].topic).toBe('AI workflows');
    expect(a.radarFeedback.topAcceptedTopics[0].count).toBe(2);
    expect(a.radarFeedback.topRejectedTopics[0].topic).toBe('Crypto trading');
    expect(a.radarFeedback.topRejectedTopics[0].count).toBe(3);
  });

  it('warning fires when rejects exceed 2x accepts and reject count >= 5', () => {
    for (let i = 0; i < 6; i++) {
      recordRadarFeedback(USER_A, USER_A, { signalId: `r-${i}`, action: 'reject' });
    }
    recordRadarFeedback(USER_A, USER_A, { signalId: 'a-1', action: 'accept' });
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.some(w => w.toLowerCase().includes('under-fitting'))).toBe(true);
  });

  it('warning fires when topics exist but no scripts and no published', () => {
    for (let i = 0; i < 6; i++) {
      insertTopic(USER_A, USER_A, 'planned');
    }
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.warnings.length).toBeGreaterThanOrEqual(1);
    // Either the "no published" or "no scripts" warning
    expect(a.warnings.some(w => /no topics published|no scripts/i.test(w))).toBe(true);
  });

  it('counts scripts using the real content_scripts schema without updated_at', () => {
    insertScript(USER_A, USER_A, 2);
    insertScript(USER_A, USER_A, 45);
    const a = getContentPerformanceAggregate(USER_A, USER_A);
    expect(a.scripts.total).toBe(2);
    expect(a.scripts.last30d).toBe(1);
  });

  it('User A aggregate is invisible to User B', () => {
    insertTopic(USER_A, USER_A, 'published');
    recordRadarFeedback(USER_A, USER_A, { signalId: 'sa', action: 'accept' });
    const b = getContentPerformanceAggregate(USER_B, USER_B);
    expect(b.topics.total).toBe(0);
    expect(b.radarFeedback.total).toBe(0);
  });

  it('returns empty aggregate for invalid userId', () => {
    const a = getContentPerformanceAggregate(0);
    expect(a.topics.total).toBe(0);
    expect(a.tenantId).toBe(0);
  });
});
