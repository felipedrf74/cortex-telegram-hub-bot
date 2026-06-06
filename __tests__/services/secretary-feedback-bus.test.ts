// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the W-B workstream: in-process SecretaryFeedbackBus.
 * The arbitrator emits feedback after every decision (single + batch); each
 * registered consumer runs in try/catch so one bad handler cannot break
 * arbitration.
 *
 * Plan reference: Wave 1 workstream W-B.
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

// `vi.mock` factories are hoisted above any top-level `const`/`let`. Using a
// plain `const loggerWarnSpy = vi.fn()` here triggers a TDZ ReferenceError
// because the hoisted factory runs first. `vi.hoisted` co-hoists the spy.
const { loggerWarnSpy } = vi.hoisted(() => ({
  loggerWarnSpy: vi.fn(),
}));
vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: loggerWarnSpy,
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  arbitrateSecretarySchedulingIntents,
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
  type SecretarySourceSkillFeedback,
} from '../../src/services/secretary-scheduling-arbitrator';
import {
  _resetSecretaryFeedbackBusForTests,
  _secretaryFeedbackBusConsumerCount,
  registerSecretaryFeedbackConsumer,
} from '../../src/services/secretary-feedback-bus';

const TENANT_ID = 'tenant-bus-test';
const OWNER_USER_ID = 42;

beforeEach(() => {
  testDb = new Database(':memory:');
  testDb.exec(fs.readFileSync(MIGRATION_083, 'utf8'));
  _resetSecretaryFeedbackBusForTests();
  loggerWarnSpy.mockClear();
});

afterEach(() => {
  testDb.close();
  _resetSecretaryFeedbackBusForTests();
});

function trainingIntent(intentId: string): SecretarySchedulingIntent {
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
  };
}

describe('W-B: SecretaryFeedbackBus', () => {
  it('registers and unregisters consumers idempotently', () => {
    expect(_secretaryFeedbackBusConsumerCount()).toBe(0);
    const unregister = registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'test-handler',
      handler: () => {},
    });
    expect(_secretaryFeedbackBusConsumerCount()).toBe(1);
    // Re-registering same (sourceSkill, handlerId) replaces, not adds
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'test-handler',
      handler: () => {},
    });
    expect(_secretaryFeedbackBusConsumerCount()).toBe(1);
    unregister();
    expect(_secretaryFeedbackBusConsumerCount()).toBe(0);
  });

  it('emits feedback to matching consumer after submit', () => {
    const seen: SecretarySourceSkillFeedback[] = [];
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'capture-training',
      handler: (fb) => { seen.push(fb); },
    });
    submitSecretarySchedulingIntent(trainingIntent('t-1'));
    expect(seen.length).toBe(1);
    expect(seen[0].sourceSkill).toBe('training');
    expect(seen[0].sourceIntentId).toBe('t-1');
  });

  it('does NOT emit to consumers of a different sourceSkill', () => {
    const seen: SecretarySourceSkillFeedback[] = [];
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'cooking',
      handlerId: 'capture-cooking',
      handler: (fb) => { seen.push(fb); },
    });
    submitSecretarySchedulingIntent(trainingIntent('t-no-cooking'));
    expect(seen.length).toBe(0);
  });

  it('one bad sync consumer does NOT break arbitration', () => {
    const goodSeen: SecretarySourceSkillFeedback[] = [];
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'bad-consumer',
      handler: () => { throw new Error('I am a bad consumer'); },
    });
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'good-consumer',
      handler: (fb) => { goodSeen.push(fb); },
    });
    // Arbitration must complete despite the bad handler throwing
    const decision = submitSecretarySchedulingIntent(trainingIntent('t-bad-good'));
    expect(decision.status).toBe('scheduled');
    expect(goodSeen.length).toBe(1);
    // Bad consumer's throw was caught and logged
    expect(loggerWarnSpy).toHaveBeenCalled();
  });

  it('emits feedback per-decision in batch arbitration (not deferred to end)', () => {
    const events: string[] = [];
    registerSecretaryFeedbackConsumer({
      sourceSkill: 'training',
      handlerId: 'order-watcher',
      handler: (fb) => { events.push(fb.sourceIntentId); },
    });
    arbitrateSecretarySchedulingIntents([
      trainingIntent('batch-1'),
      trainingIntent('batch-2'),
    ]);
    expect(events.length).toBe(2);
    // Both intents emitted; ordering by arbitration priority is fine
    expect(events.sort()).toEqual(['batch-1', 'batch-2']);
  });
});
