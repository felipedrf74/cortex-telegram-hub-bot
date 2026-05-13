// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the C2 workstream: Decision Center surfaces the
 * Secretary reasoning trail via `DecisionApiItem.sourceTrace.reasoningTrail`.
 *
 * The Secretary arbitrator (W-E) writes the trail into
 * `secretary_agenda_items.reasoning_trail_json`. `sourceTraceForRecord`
 * reads it through the owner-scoped getter so cross-tenant leaks are
 * impossible by construction.
 *
 * Plan reference: Wave 1 workstream C2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
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
  buildSkillDecisionFixtureIntent,
  createDecisionIntent,
  ensureDecisionCenterTables,
  getDecisionItem,
} from '../../src/services/decision-center';
import { ensureNotificationTables } from '../../src/services/notification-orchestrator';
import {
  submitSecretarySchedulingIntent,
  type SecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';

const USER_A = 91;
const USER_B = 92;

function ensureFixtureTables(): void {
  testDb.exec(readFileSync('migrations/030_users.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/098_secretary_decision_explanation.sql', 'utf8'));
  ensureNotificationTables();
  ensureDecisionCenterTables();
  for (const id of [USER_A, USER_B]) {
    testDb.prepare(`
      INSERT INTO users (id, telegram_id, first_name, language, timezone, status)
      VALUES (?, ?, ?, 'en-US', 'UTC', 'active')
    `).run(id, id * 100, `User ${id}`);
  }
}

function trainingIntent(intentId: string, ownerUserId: number): SecretarySchedulingIntent {
  return {
    intentId,
    sourceSkill: 'training',
    ownerUserId,
    tenantId: String(ownerUserId),
    title: `Tempo run ${intentId}`,
    requestedDurationMinutes: 60,
    preferredWindows: [{ start: '2026-05-20T08:00:00.000Z', end: '2026-05-20T11:00:00.000Z' }],
    priority: 'medium',
    flexibility: 'flexible',
    goalPhase: 'build',
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-10T10:00:00.000Z'));
  testDb = new Database(':memory:');
  ensureFixtureTables();
});

afterEach(() => {
  vi.useRealTimers();
  testDb.close();
});

describe('C2: Decision Center sourceTrace.reasoningTrail', () => {
  it('populates reasoningTrail when the decision is anchored on a Secretary agenda item', async () => {
    const decision = submitSecretarySchedulingIntent(trainingIntent('intent-c2-1', USER_A));
    expect(decision.reasoningTrail.length).toBeGreaterThan(0);

    // Decision Center filters Secretary decisions where current==recommended
    // (no real reflow). Provide a currentStartAt that DIFFERS from the
    // arbitrator-chosen slot so the decision survives the quality gate and
    // we can verify trail propagation.
    const recommendedStart = decision.selectedSlot!.start;
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', USER_A, {
      relatedEntityId: decision.agendaItem.agendaItemId,
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: `secretary:c2:${decision.agendaItem.agendaItemId}`,
      decisionContext: {
        currentStartAt: '2026-05-20T15:00:00.000Z',
        currentEndAt: '2026-05-20T16:00:00.000Z',
        recommendedStartAt: recommendedStart,
      },
    }));
    expect(created.item).not.toBeNull();
    const apiItem = getDecisionItem(created.item!.decisionId, USER_A, USER_A);
    expect(apiItem).not.toBeNull();
    expect(apiItem!.sourceTrace.reasoningTrail).toBeDefined();
    expect(Array.isArray(apiItem!.sourceTrace.reasoningTrail)).toBe(true);
    expect(apiItem!.sourceTrace.reasoningTrail!.length).toBeGreaterThan(0);
    // The terminal `chosen` marker must survive into the API surface.
    const chosen = apiItem!.sourceTrace.reasoningTrail!.find((n) => n.kind === 'chosen');
    expect(chosen).toBeDefined();
    expect(chosen!.slot).toBeDefined();
  });

  it('omits reasoningTrail for decisions NOT anchored on a Secretary agenda item', async () => {
    // Content decision — no agenda item, so no trail field.
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('content', USER_A, {
      relatedEntityId: 'content-obj-1',
      relatedEntityType: 'content_workflow_object',
      dedupeKey: 'content:c2-no-trail',
    }));
    expect(created.item).not.toBeNull();
    const apiItem = getDecisionItem(created.item!.decisionId, USER_A, USER_A);
    expect(apiItem).not.toBeNull();
    // Either undefined or empty — both signal "no trail".
    expect(apiItem!.sourceTrace.reasoningTrail ?? []).toEqual([]);
  });

  it('PRIVACY: User B cannot fetch User A\'s reasoning trail via cross-tenant decisionId', async () => {
    const decisionA = submitSecretarySchedulingIntent(trainingIntent('intent-c2-priv', USER_A));
    const created = await createDecisionIntent(buildSkillDecisionFixtureIntent('secretary', USER_A, {
      relatedEntityId: decisionA.agendaItem.agendaItemId,
      relatedEntityType: 'secretary_agenda_item',
      dedupeKey: `secretary:c2-priv:${decisionA.agendaItem.agendaItemId}`,
      decisionContext: {
        currentStartAt: '2026-05-20T15:00:00.000Z',
        currentEndAt: '2026-05-20T16:00:00.000Z',
        recommendedStartAt: decisionA.selectedSlot!.start,
      },
    }));
    expect(created.item).not.toBeNull();
    // User B (different ownerUserId + tenantId) must not see User A's decision.
    const leak = getDecisionItem(created.item!.decisionId, USER_B, USER_B);
    expect(leak).toBeNull();
  });
});
