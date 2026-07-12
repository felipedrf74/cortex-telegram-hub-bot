/**
 * Coach Phase Memory — Tests
 *
 * Pins the read/write contract for the persistent coach narrative
 * state: round-trip of phase + narrative + optional lineage fields,
 * null for fresh users, and prompt-formatter shape for the LLM
 * system-prompt insertion point.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({ getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  applyMigrationFileForTest: vi.fn(),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  filterAlreadyAppliedAddColumnStatements: vi.fn((sql: string) => sql),
  runMigrationsForTest: vi.fn(),
  stripWrappingTransactionStatements: vi.fn((sql: string) => sql),
  withDatabaseForTest: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));
vi.mock('../../src/config', () => ({
  config: { anthropic: { apiKey: 'test' }, app: { timezone: 'Europe/Lisbon' } },
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, filename TEXT UNIQUE, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (!db.prepare('SELECT 1 FROM _migrations WHERE filename = ?').get(file)) {
      try {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
      } catch { /* skip deps */ }
    }
  }
}

import {
  writeCoachPhaseMemory,
  getCurrentCoachPhase,
  formatCoachPhaseForPrompt,
} from '../../src/services/coach-phase-memory';
import { clearTenantScopeAnomaliesForTests } from '../../src/services/tenant-scope-observability';

describe('coach-phase-memory', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('journal_mode = WAL');
    applyMigrations(testDb);
    clearTenantScopeAnomaliesForTests();
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (1, 111, 'Owner', 'owner', 'active', 0, 0, 0)
    `).run();
  });

  afterEach(() => {
    testDb?.close();
  });

  it('returns null when no phase memory has been written yet', () => {
    expect(getCurrentCoachPhase(1)).toBeNull();
  });

  it('round-trips phase + narrative + optional lineage fields', () => {
    const id = writeCoachPhaseMemory(1, {
      phase: 'build',
      weekInPhase: 3,
      phaseTotalWeeks: 6,
      narrative: 'Progressing from aerobic base into specific intensity; expect mid-week soreness.',
      adherenceTrend: 'improving',
      recentDeloadDates: ['2026-03-25'],
      activeConcern: null,
      nextExpectedShift: 'Deload end of week 4 if adherence ≥ 80%.',
      writtenAt: '2026-04-10T09:00:00Z',
    });
    expect(id).toBeGreaterThan(0);

    const read = getCurrentCoachPhase(1);
    expect(read).not.toBeNull();
    expect(read!.phase).toBe('build');
    expect(read!.weekInPhase).toBe(3);
    expect(read!.phaseTotalWeeks).toBe(6);
    expect(read!.adherenceTrend).toBe('improving');
    expect(read!.recentDeloadDates).toEqual(['2026-03-25']);
    expect(read!.activeConcern).toBeNull();
    expect(read!.nextExpectedShift).toContain('Deload');
  });

  it('latest write wins — append-only history, reader returns the newest', () => {
    writeCoachPhaseMemory(1, {
      phase: 'base',
      narrative: 'Early base block, volume rising.',
      writtenAt: '2026-03-01T09:00:00Z',
    });
    writeCoachPhaseMemory(1, {
      phase: 'build',
      narrative: 'Moved into build — week 1.',
      writtenAt: '2026-04-01T09:00:00Z',
    });

    const latest = getCurrentCoachPhase(1);
    expect(latest!.phase).toBe('build');
    expect(latest!.narrative).toContain('build');
  });

  it('isolates phase memory per user', () => {
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, tier, status, daily_message_limit, daily_token_limit, daily_cost_limit_usd)
      VALUES (2, 222, 'Tenant B', 'user', 'active', 0, 0, 0)
    `).run();

    writeCoachPhaseMemory(1, {
      phase: 'taper',
      narrative: 'User 1 is tapering into race week.',
      writtenAt: '2026-04-15T09:00:00Z',
    });
    writeCoachPhaseMemory(2, {
      phase: 'recovery',
      narrative: 'User 2 is in post-race recovery.',
      writtenAt: '2026-04-15T09:00:00Z',
    });

    expect(getCurrentCoachPhase(1)!.phase).toBe('taper');
    expect(getCurrentCoachPhase(2)!.phase).toBe('recovery');
  });

  it('refuses to persist for invalid tenant scope', () => {
    const id = writeCoachPhaseMemory(0, {
      phase: 'build',
      narrative: 'Should not be written — userId=0 is invalid scope.',
      writtenAt: '2026-04-10T09:00:00Z',
    });
    expect(id).toBe(-1);
    expect(getCurrentCoachPhase(0)).toBeNull();
  });

  describe('formatCoachPhaseForPrompt', () => {
    it('returns empty string for null memory so callers can concat safely', () => {
      expect(formatCoachPhaseForPrompt(null)).toBe('');
    });

    it('includes phase, adherence trend, deloads, and narrative in a compact line', () => {
      const text = formatCoachPhaseForPrompt({
        phase: 'build',
        weekInPhase: 3,
        phaseTotalWeeks: 6,
        narrative: 'Building specific intensity.',
        adherenceTrend: 'improving',
        recentDeloadDates: ['2026-03-25', '2026-03-04'],
        writtenAt: '2026-04-10T09:00:00Z',
      });
      expect(text).toContain('build (week 3 of 6)');
      expect(text).toContain('Adherence trend: improving');
      expect(text).toContain('2026-03-25');
      expect(text).toContain('Building specific intensity');
      // Keep compact — must not blow past ~500 chars
      expect(text.length).toBeLessThan(500);
    });

    it('omits optional sections when memory lacks them', () => {
      const text = formatCoachPhaseForPrompt({
        phase: 'base',
        narrative: 'Early base block.',
        writtenAt: '2026-03-01T09:00:00Z',
      });
      expect(text).toContain('Macro phase: base.');
      expect(text).toContain('Early base block');
      expect(text).not.toContain('Active concern');
      expect(text).not.toContain('Adherence trend');
    });
  });
});
