// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Wave-3 rank 8 — Chat Core v2 canary turn log (INERT, canary-only measurement
 * scaffold).
 *
 * DMV invariants proven here:
 *  - CANARY-ONLY INERTNESS: `maybeRecordCanaryTurn` writes NOTHING in
 *    off / shadow / on / absent, and writes NOTHING for a non-cohort tenant or a
 *    kill-switch-demoted (killed) tenant even under canary;
 *  - REAL under canary+cohort: it writes exactly ONE safe-scalar row;
 *  - PRIVACY: the persisted row carries no raw message/prompt/answer text;
 *  - TENANT + USER scoping: rows isolate per tenant;
 *  - FIRE-AND-FORGET: `recordCanaryTurn` never throws on a closed db.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import {
  ensureChatCoreV2CanaryTurnLogTable,
  recordCanaryTurn,
  maybeRecordCanaryTurn,
  CHAT_CORE_V2_CANARY_TURN_LOG_VERSION,
  type CanaryTurnLogRow,
} from '../../src/services/chat-core-v2/canary-turn-log';
import {
  setChatCoreV2RuntimeOverride,
  _resetChatCoreV2RuntimeOverridesForTests,
} from '../../src/services/chat-core-v2/activation-flags';

type Env = Record<string, string | undefined>;

const NOW = new Date('2026-05-30T12:00:00.000Z');

const ALL_FOUR_NON_CANARY_MODES: Array<Env['CHAT_CORE_V2_ORCHESTRATOR_MODE']> = [
  'off',
  'shadow',
  'on',
  undefined /* absent => parses to 'off' */,
];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureChatCoreV2CanaryTurnLogTable(db);
  return db;
}

function rowCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM chat_v2_canary_turn_log').get() as { n: number }).n;
}

const BASE_ROW: CanaryTurnLogRow = {
  tenantId: 'tenant-a',
  userId: 'user-1',
  turnId: 'turn-1',
  routePath: '/api/v1/chat/message',
  routeMethod: 'POST',
  reasoningTier: 'fast',
  confidence: 0.91,
  locale: 'en',
  recordedAt: NOW,
};

// A cohort env where tenant-a IS served under canary (in cohort, not killed).
const CANARY_COHORT_ENV: Env = {
  CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
  CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a, tenant-c',
};

beforeEach(() => {
  _resetChatCoreV2RuntimeOverridesForTests();
});
afterEach(() => {
  _resetChatCoreV2RuntimeOverridesForTests();
});

describe('canary-turn-log — CANARY-ONLY INERTNESS (load-bearing)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  for (const mode of ALL_FOUR_NON_CANARY_MODES) {
    const label = mode ?? 'absent';
    it(`writes NOTHING in mode=${label} even for a cohort tenant`, () => {
      const env: Env = {
        CHAT_CORE_V2_ORCHESTRATOR_MODE: mode,
        CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-a',
      };
      const wrote = maybeRecordCanaryTurn(BASE_ROW, { env, db });
      expect(wrote).toBe(false);
      expect(rowCount(db)).toBe(0); // the load-bearing assertion.
    });
  }

  it('writes NOTHING under canary for a NON-cohort tenant', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: 'tenant-c', // tenant-a NOT listed
    };
    const wrote = maybeRecordCanaryTurn(BASE_ROW, { env, db });
    expect(wrote).toBe(false);
    expect(rowCount(db)).toBe(0);
  });

  it('writes NOTHING under canary for an EMPTY cohort', () => {
    const env: Env = {
      CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
      CHAT_CORE_V2_CANARY_ENABLED_TENANT_IDS: '',
    };
    expect(maybeRecordCanaryTurn(BASE_ROW, { env, db })).toBe(false);
    expect(rowCount(db)).toBe(0);
  });

  it('writes NOTHING for a KILLED (kill-switch-demoted) cohort tenant under canary', () => {
    // Per-tenant master kill-switch forces tenant-a off even though canary+cohort.
    setChatCoreV2RuntimeOverride('tenant-a', { mode: 'off' });
    const wrote = maybeRecordCanaryTurn(BASE_ROW, { env: CANARY_COHORT_ENV, db });
    expect(wrote).toBe(false);
    expect(rowCount(db)).toBe(0);
  });
});

describe('canary-turn-log — REAL under canary+cohort (gate is wired, not dead)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => db.close());

  it('writes exactly ONE safe-scalar row under canary for a cohort tenant', () => {
    const wrote = maybeRecordCanaryTurn(BASE_ROW, { env: CANARY_COHORT_ENV, db });
    expect(wrote).toBe(true);
    expect(rowCount(db)).toBe(1);

    const row = db
      .prepare(
        `SELECT tenant_id, user_id, turn_id, route_path, route_method, reasoning_tier,
                confidence, locale, recorded_at, expires_at
         FROM chat_v2_canary_turn_log`,
      )
      .get() as Record<string, unknown>;

    expect(row.tenant_id).toBe('tenant-a');
    expect(row.user_id).toBe('user-1');
    expect(row.turn_id).toBe('turn-1');
    expect(row.route_path).toBe('/api/v1/chat/message');
    expect(row.route_method).toBe('POST');
    expect(row.reasoning_tier).toBe('fast');
    expect(row.confidence).toBeCloseTo(0.91, 10);
    expect(row.locale).toBe('en');
    expect(row.recorded_at).toBe(NOW.toISOString());
    // expires_at is recorded_at + 90 days.
    expect(row.expires_at).toBe(new Date(NOW.getTime() + 90 * 86_400_000).toISOString());
  });

  it('PRIVACY: the persisted row contains no raw message/prompt/answer text', () => {
    // The input type has no message field; even if a route-ish string is passed,
    // only safe-scalar columns exist and none equal user text.
    maybeRecordCanaryTurn(
      { ...BASE_ROW, turnId: 'turn-priv', confidence: 0.5 },
      { env: CANARY_COHORT_ENV, db },
    );
    const row = db.prepare('SELECT * FROM chat_v2_canary_turn_log WHERE turn_id = ?').get('turn-priv') as Record<
      string,
      unknown
    >;
    const SECRET_USER_TEXT = 'my bank password is hunter2 transfer 5000 to account 9999';
    for (const value of Object.values(row)) {
      if (typeof value === 'string') {
        expect(value).not.toContain('password');
        expect(value).not.toContain(SECRET_USER_TEXT);
      }
    }
    // The only columns are the safe-scalar set — assert the shape explicitly.
    expect(Object.keys(row).sort()).toEqual(
      [
        'confidence',
        'expires_at',
        'id',
        'locale',
        'recorded_at',
        'reasoning_tier',
        'route_method',
        'route_path',
        'tenant_id',
        'turn_id',
        'user_id',
      ].sort(),
    );
  });

  it('clamps an out-of-range confidence into [0,1] and normalizes locale to a bucket', () => {
    maybeRecordCanaryTurn(
      { ...BASE_ROW, turnId: 'turn-clamp', confidence: 4.2, locale: 'pt_br' },
      { env: CANARY_COHORT_ENV, db },
    );
    const row = db
      .prepare('SELECT confidence, locale FROM chat_v2_canary_turn_log WHERE turn_id = ?')
      .get('turn-clamp') as { confidence: number; locale: string };
    expect(row.confidence).toBe(1);
    expect(row.locale).toBe('pt-BR');
  });

  it('TENANT isolation: tenant-c row is scoped to tenant-c only', () => {
    maybeRecordCanaryTurn(BASE_ROW, { env: CANARY_COHORT_ENV, db }); // tenant-a
    maybeRecordCanaryTurn(
      { ...BASE_ROW, tenantId: 'tenant-c', userId: 'user-9', turnId: 'turn-c' },
      { env: CANARY_COHORT_ENV, db },
    );
    expect(rowCount(db)).toBe(2);
    const aCount = (
      db.prepare('SELECT COUNT(*) AS n FROM chat_v2_canary_turn_log WHERE tenant_id = ?').get('tenant-a') as {
        n: number;
      }
    ).n;
    const cCount = (
      db.prepare('SELECT COUNT(*) AS n FROM chat_v2_canary_turn_log WHERE tenant_id = ?').get('tenant-c') as {
        n: number;
      }
    ).n;
    expect(aCount).toBe(1);
    expect(cCount).toBe(1);
  });
});

describe('canary-turn-log — fire-and-forget (never throws)', () => {
  it('recordCanaryTurn returns false (does NOT throw) on a closed db', () => {
    const db = new Database(':memory:');
    ensureChatCoreV2CanaryTurnLogTable(db);
    db.close();
    let result: boolean | undefined;
    expect(() => {
      result = recordCanaryTurn(db, BASE_ROW);
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('exposes a version constant', () => {
    expect(CHAT_CORE_V2_CANARY_TURN_LOG_VERSION).toMatch(/^chat_core_v2_canary_turn_log@/);
  });
});
