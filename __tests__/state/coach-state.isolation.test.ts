import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CoachRecommendation } from '../../src/services/garmin-coach';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
}));

import { deleteCoachState, loadCoachState, pruneExpiredCoachStates, saveCoachState } from '../../src/state/coach-state';

const INVALID_USER_IDS = [0, -1, null, undefined, Number.NaN, '0', '1', Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1] as const;
const VALID_USER_IDS = [1, 2, 100, Number.MAX_SAFE_INTEGER] as const;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;
const NOW_MS = 1_778_000_000_000;
const TTL_MS = 60_000;

const recommendation: CoachRecommendation = {
  eventId: 'evt-1',
  source: 'google',
  action: 'KEEP',
  originalTitle: 'Easy run',
  newTitle: null,
  newStart: null,
  newEnd: null,
  summary: 'Keep the session as planned',
  reason: 'Recovery supports the plan',
};

function createSchema(): void {
  testDb.exec(`
    CREATE TABLE coach_states (
      user_id INTEGER PRIMARY KEY,
      recommendations_json TEXT NOT NULL,
      briefing_summary TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

describe('state/coach-state isolation contract', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('invalid userId %s', (userId) => {
    it('saveCoachState rejects', () => {
      expect(() => saveCoachState(userId as number, [recommendation], 'briefing', NOW_MS, TTL_MS))
        .toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('loadCoachState rejects', () => {
      expect(() => loadCoachState(userId as number, NOW_MS)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('deleteCoachState rejects', () => {
      expect(() => deleteCoachState(userId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  describe.each(VALID_USER_IDS)('valid userId %s', (userId) => {
    it('round-trips without leaking to another user', () => {
      const otherUserId = userId === Number.MAX_SAFE_INTEGER ? 1 : userId + 10;

      saveCoachState(userId, [recommendation], `briefing-${userId}`, NOW_MS, TTL_MS);
      expect(loadCoachState(userId, NOW_MS + 1)?.briefingSummary).toBe(`briefing-${userId}`);
      expect(loadCoachState(otherUserId, NOW_MS + 1)).toBeNull();
    });
  });

  it('user A cannot read user B state', () => {
    saveCoachState(1, [recommendation], 'A briefing', NOW_MS, TTL_MS);
    saveCoachState(2, [recommendation], 'B briefing', NOW_MS, TTL_MS);

    expect(loadCoachState(1, NOW_MS + 1)?.briefingSummary).toBe('A briefing');
    expect(loadCoachState(2, NOW_MS + 1)?.briefingSummary).toBe('B briefing');
  });

  it('delete is idempotent and does not affect other users', () => {
    saveCoachState(1, [recommendation], 'A briefing', NOW_MS, TTL_MS);
    saveCoachState(2, [recommendation], 'B briefing', NOW_MS, TTL_MS);

    deleteCoachState(1);
    deleteCoachState(1);

    expect(loadCoachState(1, NOW_MS + 1)).toBeNull();
    expect(loadCoachState(2, NOW_MS + 1)?.briefingSummary).toBe('B briefing');
  });

  it('prune removes expired rows without crossing user scope for active rows', () => {
    saveCoachState(1, [recommendation], 'expired', NOW_MS, 1);
    saveCoachState(2, [recommendation], 'active', NOW_MS, TTL_MS);

    expect(pruneExpiredCoachStates(NOW_MS + 2)).toBe(1);
    expect(loadCoachState(1, NOW_MS + 2)).toBeNull();
    expect(loadCoachState(2, NOW_MS + 2)?.briefingSummary).toBe('active');
  });
});
