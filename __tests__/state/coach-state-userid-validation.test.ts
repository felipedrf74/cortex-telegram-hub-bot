import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { CoachRecommendation } from '../../src/services/garmin-coach';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import {
  deleteCoachState,
  loadCoachState,
  saveCoachState,
} from '../../src/state/coach-state';

const VALID_USER_ID = 4242;
const NOW_MS = 1_778_000_000_000;
const TTL_MS = 60_000;
const REQUIRED_USER_ID_ERROR = /userId required: must be a positive integer/;
const INVALID_USER_IDS = [0, undefined, null, Number.NaN, -1, Number.POSITIVE_INFINITY] as const;

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

describe('coach-state userId validation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    createSchema();
  });

  afterEach(() => {
    testDb?.close();
  });

  describe.each(INVALID_USER_IDS)('rejects invalid userId %s', (invalidUserId) => {
    it('saveCoachState throws before persistence', () => {
      expect(() => saveCoachState(
        invalidUserId as number,
        [recommendation],
        'briefing',
        NOW_MS,
        TTL_MS,
      )).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('loadCoachState throws before reading', () => {
      expect(() => loadCoachState(invalidUserId as number, NOW_MS)).toThrow(REQUIRED_USER_ID_ERROR);
    });

    it('deleteCoachState throws before deleting', () => {
      expect(() => deleteCoachState(invalidUserId as number)).toThrow(REQUIRED_USER_ID_ERROR);
    });
  });

  it('save/load/delete continue to work for a positive userId', () => {
    saveCoachState(VALID_USER_ID, [recommendation], 'briefing', NOW_MS, TTL_MS);

    const loaded = loadCoachState(VALID_USER_ID, NOW_MS + 1);
    expect(loaded).toEqual({
      recommendations: [recommendation],
      briefingSummary: 'briefing',
      timestamp: NOW_MS,
      expiresAt: NOW_MS + TTL_MS,
    });

    deleteCoachState(VALID_USER_ID);
    expect(loadCoachState(VALID_USER_ID, NOW_MS + 1)).toBeNull();
  });
});
