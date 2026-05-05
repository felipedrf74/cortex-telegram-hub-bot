/**
 * CONTENT-UI-O4 (2026-05-04): Canonical 12-stage Content lifecycle.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { app: { timezone: 'Europe/Lisbon' } },
}));

import {
  mapContentTopicStatusToCanonical,
  mapSavedIdeaStatusToCanonical,
  summarizeCanonicalLifecycle,
  CANONICAL_LIFECYCLE_STAGES,
} from '../../src/state/content-lifecycle';
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
      } catch (err) { /* skip */ }
    }
  }
}

const USER = 4001;

describe('content-lifecycle (CONTENT-UI-O4)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    applyMigrations(testDb);
  });
  afterEach(() => { if (testDb) testDb.close(); });

  it('canonical stage list has 12 entries in expected order', () => {
    expect(CANONICAL_LIFECYCLE_STAGES).toHaveLength(12);
    expect(CANONICAL_LIFECYCLE_STAGES[0]).toBe('discovered');
    expect(CANONICAL_LIFECYCLE_STAGES[11]).toBe('rejected');
  });

  // ──────── topic status mapping ────────

  it('maps topic status idea → suggested', () => {
    expect(mapContentTopicStatusToCanonical('idea')).toBe('suggested');
  });
  it('maps topic status planned → suggested', () => {
    expect(mapContentTopicStatusToCanonical('planned')).toBe('suggested');
  });
  it('maps topic status outlined → briefing', () => {
    expect(mapContentTopicStatusToCanonical('outlined')).toBe('briefing');
  });
  it('maps topic status drafting and drafted → drafting', () => {
    expect(mapContentTopicStatusToCanonical('drafting')).toBe('drafting');
    expect(mapContentTopicStatusToCanonical('drafted')).toBe('drafting');
  });
  it('maps topic status reviewed and revised → review', () => {
    expect(mapContentTopicStatusToCanonical('reviewed')).toBe('review');
    expect(mapContentTopicStatusToCanonical('revised')).toBe('review');
  });
  it('maps topic status approved/ready → approved', () => {
    expect(mapContentTopicStatusToCanonical('approved')).toBe('approved');
    expect(mapContentTopicStatusToCanonical('ready')).toBe('approved');
  });
  it('maps topic status scheduled → scheduled', () => {
    expect(mapContentTopicStatusToCanonical('scheduled')).toBe('scheduled');
  });
  it('maps topic status published/repurposed → published', () => {
    expect(mapContentTopicStatusToCanonical('published')).toBe('published');
    expect(mapContentTopicStatusToCanonical('repurposed')).toBe('published');
  });
  it('maps topic status cancelled/rejected → rejected', () => {
    expect(mapContentTopicStatusToCanonical('cancelled')).toBe('rejected');
    expect(mapContentTopicStatusToCanonical('rejected')).toBe('rejected');
  });
  it('maps topic status archived/stale/deferred → archived', () => {
    expect(mapContentTopicStatusToCanonical('archived')).toBe('archived');
    expect(mapContentTopicStatusToCanonical('stale')).toBe('archived');
    expect(mapContentTopicStatusToCanonical('deferred')).toBe('archived');
  });
  it('maps topic status unknown/null → discovered', () => {
    expect(mapContentTopicStatusToCanonical('not-a-known-status')).toBe('discovered');
    expect(mapContentTopicStatusToCanonical(null)).toBe('discovered');
    expect(mapContentTopicStatusToCanonical(undefined)).toBe('discovered');
  });
  it('mapping is case-insensitive', () => {
    expect(mapContentTopicStatusToCanonical('PUBLISHED')).toBe('published');
    expect(mapContentTopicStatusToCanonical('Drafting')).toBe('drafting');
  });

  // ──────── saved_idea mapping ────────

  it('maps saved_idea idea → suggested', () => {
    expect(mapSavedIdeaStatusToCanonical('idea')).toBe('suggested');
  });
  it('maps saved_idea scripted → drafting', () => {
    expect(mapSavedIdeaStatusToCanonical('scripted')).toBe('drafting');
  });
  it('maps saved_idea filmed/editing → review', () => {
    expect(mapSavedIdeaStatusToCanonical('filmed')).toBe('review');
    expect(mapSavedIdeaStatusToCanonical('editing')).toBe('review');
  });

  // ──────── summary integration ────────

  it('returns 12 buckets with zero counts for empty user', () => {
    const summary = summarizeCanonicalLifecycle(USER, USER);
    expect(summary.buckets).toHaveLength(12);
    expect(summary.total).toBe(0);
    expect(summary.hasData).toBe(false);
    expect(summary.buckets.every(b => b.count === 0)).toBe(true);
  });

  it('aggregates topics + radar feedback into canonical buckets', () => {
    // Insert 2 topics (drafting + published)
    testDb.prepare(`
      INSERT INTO content_topics (
        user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
        title, status, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'user_private', 'active', 'T1', 'drafting', 'active', datetime('now'), datetime('now'))
    `).run(USER, USER, USER);
    testDb.prepare(`
      INSERT INTO content_topics (
        user_id, tenant_id, owner_user_id, visibility_scope, scope_status,
        title, status, lifecycle_state, created_at, updated_at
      ) VALUES (?, ?, ?, 'user_private', 'active', 'T2', 'published', 'active', datetime('now'), datetime('now'))
    `).run(USER, USER, USER);

    // 1 accepted + 2 rejected radar feedback (distinct signals)
    recordRadarFeedback(USER, USER, { signalId: 'sig-acc-1', action: 'accept' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-rej-1', action: 'reject' });
    recordRadarFeedback(USER, USER, { signalId: 'sig-rej-2', action: 'reject' });

    const summary = summarizeCanonicalLifecycle(USER, USER);
    const byStage = Object.fromEntries(summary.buckets.map(b => [b.stage, b.count]));
    expect(byStage.drafting).toBe(1);
    expect(byStage.published).toBe(1);
    expect(byStage.accepted).toBe(1);
    expect(byStage.rejected).toBe(2);
    expect(summary.hasData).toBe(true);
  });

  it('returns empty summary for invalid userId', () => {
    const summary = summarizeCanonicalLifecycle(0);
    expect(summary.total).toBe(0);
    expect(summary.tenantId).toBe(0);
    expect(summary.buckets).toHaveLength(12);
  });
});
