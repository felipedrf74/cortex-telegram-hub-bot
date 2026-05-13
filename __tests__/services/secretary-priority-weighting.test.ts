// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the C3 workstream: goal-phase dynamic priority
 * weighting in the Secretary arbitrator. Training intent priority shifts
 * with `goalPhase` (build +2, peak +3, taper -2, race -4, deload -3); other
 * skills are unaffected; Finance's deadline boost (+18) dominates phase
 * boost so tax-deadline intents still outrank Training in race week.
 *
 * Plan reference: Wave 1 workstream C3 in
 * /Users/felipedominguez/.claude/plans/graceful-stirring-scone.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATION_083 = path.resolve(
  __dirname,
  '../../migrations/083_secretary_agenda_ledger.sql',
);

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
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
  LOGGER_REDACTION_PATHS: [],
}));

import {
  arbitrateSecretarySchedulingIntents,
  type SecretaryGoalPhase,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';

const TENANT_ID = 'tenant-priority-test';
const OWNER_USER_ID = 42;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
});

afterEach(() => {
  testDb.close();
});

function trainingIntent(intentId: string, goalPhase?: SecretaryGoalPhase | null): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'training',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Training intent ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T11:00:00.000Z' }],
    priority: 'medium',
    flexibility: 'flexible',
    goalPhase,
  };
}

function financeIntent(intentId: string, deadline?: string | null): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'finance',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Finance intent ${intentId}`,
    requestedDurationMinutes: 30,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T11:00:00.000Z' }],
    priority: 'medium',
    flexibility: 'flexible',
    deadline: deadline ?? null,
  };
}

function cookingIntent(intentId: string): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'cooking',
    ownerUserId: OWNER_USER_ID,
    tenantId: TENANT_ID,
    title: `Cooking meal prep ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T11:00:00.000Z' }],
    priority: 'medium',
    flexibility: 'flexible',
  };
}

describe('C3: goal-phase dynamic priority weighting', () => {
  it('schedules Training in build phase (no contention case)', () => {
    const result = arbitrateSecretarySchedulingIntents([trainingIntent('t-build', 'build')]);
    expect(result.decisions[0].status).toBe('scheduled');
  });

  it('Training with no goalPhase still works (graceful default)', () => {
    const result = arbitrateSecretarySchedulingIntents([trainingIntent('t-none')]);
    expect(result.decisions[0].status).toBe('scheduled');
  });

  it('Training with goalPhase=null also works (graceful default)', () => {
    const result = arbitrateSecretarySchedulingIntents([trainingIntent('t-null', null)]);
    expect(result.decisions[0].status).toBe('scheduled');
  });

  it('Finance with deadline outranks Training in race phase (deadline boost dominates)', () => {
    // Training base 12 + race phase -4 = 8
    // Finance base 16 + deadline boost +18 = 34
    // Finance must arbitrate first.
    const result = arbitrateSecretarySchedulingIntents([
      trainingIntent('t-race', 'race'),
      financeIntent('f-deadline', '2026-05-21T17:00:00.000Z'),
    ]);
    expect(result.decisions[0].agendaItem.sourceSkill).toBe('finance');
    expect(result.decisions[1].agendaItem.sourceSkill).toBe('training');
  });

  it('Training in build phase outranks Cooking head-to-head (12+2=14 > 8)', () => {
    const result = arbitrateSecretarySchedulingIntents([
      cookingIntent('c-no-phase'),
      trainingIntent('t-build', 'build'),
    ]);
    expect(result.decisions[0].agendaItem.sourceSkill).toBe('training');
  });

  it('Training in deload phase (12-3=9) still outranks Cooking (8) head-to-head', () => {
    // Phase boost calibration: never flips Training below Cooking baseline.
    const result = arbitrateSecretarySchedulingIntents([
      cookingIntent('c-no-phase'),
      trainingIntent('t-deload', 'deload'),
    ]);
    expect(result.decisions[0].agendaItem.sourceSkill).toBe('training');
  });

  it('goalPhase has no effect on non-training skills', () => {
    const financeWithPhase: SecretarySchedulingIntent = {
      ...financeIntent('f-with-phase'),
      goalPhase: 'race',
    };
    const result = arbitrateSecretarySchedulingIntents([financeWithPhase]);
    expect(result.decisions[0].agendaItem.sourceSkill).toBe('finance');
    expect(result.decisions[0].status).toBe('scheduled');
  });
});
