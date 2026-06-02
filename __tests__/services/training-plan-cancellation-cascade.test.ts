import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

import { setDbProvider } from '../../src/services/intelligence-bus';
import {
  getSecretaryAgendaItemById,
  submitSecretarySchedulingIntent,
} from '../../src/services/secretary-scheduling-arbitrator';
import { setSkillMemory } from '../../src/services/skill-memory';
import {
  buildTrainingPlanIntentPrefixPattern,
  cancelTrainingPlanCrossSkillDependents,
  findSecretaryAgendaCalendarEventsForPlan,
} from '../../src/services/training-plan-cancellation-cascade';

describe('training-plan-cancellation cascade', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
    setDbProvider(() => testDb as any);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('cancels matching Secretary agenda items, emits a tenant-scoped signal, and stales downstream memories', () => {
    const decision = submitSecretarySchedulingIntent({
      intentId: 'training:44:2:321',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 321,
      sourceEntityType: 'training_session',
      ownerUserId: 12,
      tenantId: 12,
      title: 'Tempo Run',
      requestedDurationMinutes: 45,
      preferredWindows: [{
        start: '2026-05-04T07:00:00.000Z',
        end: '2026-05-04T08:00:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    submitSecretarySchedulingIntent({
      intentId: 'training:45:2:999',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 999,
      sourceEntityType: 'training_session',
      ownerUserId: 12,
      tenantId: 12,
      title: 'Other Plan',
      requestedDurationMinutes: 45,
      preferredWindows: [{
        start: '2026-05-05T07:00:00.000Z',
        end: '2026-05-05T08:00:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    for (const skillId of ['cooking', 'secretary', 'chat']) {
      setSkillMemory({
        tenantId: 12,
        userId: 12,
        skillId,
        memoryType: 'cross_skill_signal',
        scope: 'user_private',
        memoryKey: `${skillId}_training_plan_v2`,
        memoryValue: 'Context tied to the soon-to-be-canceled Training plan.',
        source: 'training',
        relatedSkillVersion: 'training-plan-v2',
      });
    }

    const result = cancelTrainingPlanCrossSkillDependents({
      userId: 12,
      tenantId: 12,
      planId: 44,
      planVersion: 2,
      sessionIds: [321],
      reason: 'training_plan_canceled',
    });

    expect(result).toEqual({
      canceledAgendaItems: 1,
      staleMemories: 3,
      signalId: expect.any(Number),
    });
    expect(getSecretaryAgendaItemById({
      agendaItemId: decision.agendaItem.agendaItemId,
      ownerUserId: 12,
      tenantId: 12,
    })?.lifecycleState).toBe('canceled');

    const otherAgenda = testDb.prepare(`
      SELECT lifecycle_state
        FROM secretary_agenda_items
       WHERE source_intent_id = 'training:45:2:999'
    `).get() as { lifecycle_state: string };
    expect(otherAgenda.lifecycle_state).toBe('scheduled');

    const signal = testDb.prepare(`
      SELECT tenant_id, user_id, source_agent, signal_type, payload
        FROM agent_signals
       WHERE signal_type = 'training_plan_canceled'
    `).get() as any;
    expect(signal).toMatchObject({
      tenant_id: 12,
      user_id: 12,
      source_agent: 'training.cancel',
      signal_type: 'training_plan_canceled',
    });
    expect(JSON.parse(signal.payload)).toMatchObject({
      plan_id: 44,
      plan_version: 2,
      session_ids: [321],
      canceled_agenda_items: 1,
      stale_memories: 3,
    });

    const staleRows = testDb.prepare(`
      SELECT skill_id, status, freshness_status
        FROM skill_memories
       WHERE related_skill_version = 'training-plan-v2'
       ORDER BY skill_id
    `).all() as Array<{ skill_id: string; status: string; freshness_status: string }>;
    expect(staleRows).toEqual([
      { skill_id: 'chat', status: 'stale', freshness_status: 'stale' },
      { skill_id: 'cooking', status: 'stale', freshness_status: 'stale' },
      { skill_id: 'secretary', status: 'stale', freshness_status: 'stale' },
    ]);
  });

  // 2026-05-25 bug-fix coverage — Bug #1 cancel orphans
  // -----------------------------------------------------
  // Pin the broadened cascade match: agenda rows written under an
  // older `plan_version` (because the plan was regenerated since the
  // row landed) must still be canceled when the user cancels the plan.
  // Pre-fix, the cascade only matched the current version's
  // session ids, leaving prior-version rows orphaned.

  it('R-2026-05-25 Bug #1 — cancels prior plan_version agenda rows for the same plan_id (orphans fix)', () => {
    const olderVersionDecision = submitSecretarySchedulingIntent({
      intentId: 'training:88:1:701', // plan_version=1, session_id=701
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 701,
      sourceEntityType: 'training_session',
      ownerUserId: 21,
      tenantId: 21,
      title: 'Old V1 Tempo',
      requestedDurationMinutes: 45,
      preferredWindows: [{
        start: '2026-05-04T07:00:00.000Z',
        end: '2026-05-04T08:00:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    const currentVersionDecision = submitSecretarySchedulingIntent({
      intentId: 'training:88:2:805', // plan_version=2, session_id=805
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 805,
      sourceEntityType: 'training_session',
      ownerUserId: 21,
      tenantId: 21,
      title: 'New V2 Long Run',
      requestedDurationMinutes: 90,
      preferredWindows: [{
        start: '2026-05-04T09:00:00.000Z',
        end: '2026-05-04T10:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    // Simulate the FK-cascade reality: by the time `cancel` runs,
    // only the current version's session ids exist (805). The old
    // session 701 has been removed during regeneration. Cancel must
    // STILL find and cancel the v1 agenda row via the plan_id-scoped
    // LIKE match — that's the regression this test pins.
    const result = cancelTrainingPlanCrossSkillDependents({
      userId: 21,
      tenantId: 21,
      planId: 88,
      planVersion: 2,
      sessionIds: [805], // only the current-version session id
      reason: 'training_plan_canceled',
    });

    expect(result.canceledAgendaItems).toBe(2);
    expect(getSecretaryAgendaItemById({
      agendaItemId: olderVersionDecision.agendaItem.agendaItemId,
      ownerUserId: 21,
      tenantId: 21,
    })?.lifecycleState).toBe('canceled');
    expect(getSecretaryAgendaItemById({
      agendaItemId: currentVersionDecision.agendaItem.agendaItemId,
      ownerUserId: 21,
      tenantId: 21,
    })?.lifecycleState).toBe('canceled');
  });

  it('R-2026-05-25 Bug #1 — does NOT cancel rows from a different plan_id', () => {
    submitSecretarySchedulingIntent({
      intentId: 'training:90:1:601', // plan 90 — should NOT be touched
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 601,
      sourceEntityType: 'training_session',
      ownerUserId: 31,
      tenantId: 31,
      title: 'Other Plan Run',
      requestedDurationMinutes: 30,
      preferredWindows: [{
        start: '2026-05-06T07:00:00.000Z',
        end: '2026-05-06T07:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    const targetDecision = submitSecretarySchedulingIntent({
      intentId: 'training:91:1:701',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 701,
      sourceEntityType: 'training_session',
      ownerUserId: 31,
      tenantId: 31,
      title: 'Target Run',
      requestedDurationMinutes: 30,
      preferredWindows: [{
        start: '2026-05-07T07:00:00.000Z',
        end: '2026-05-07T07:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    const result = cancelTrainingPlanCrossSkillDependents({
      userId: 31,
      tenantId: 31,
      planId: 91, // cancelling plan 91 only
      planVersion: 1,
      sessionIds: [701],
      reason: 'training_plan_canceled',
    });

    expect(result.canceledAgendaItems).toBe(1);
    // Plan 91's agenda is canceled
    expect(getSecretaryAgendaItemById({
      agendaItemId: targetDecision.agendaItem.agendaItemId,
      ownerUserId: 31,
      tenantId: 31,
    })?.lifecycleState).toBe('canceled');
    // Plan 90's agenda is untouched
    const otherPlan = testDb.prepare(`
      SELECT lifecycle_state
        FROM secretary_agenda_items
       WHERE source_intent_id = 'training:90:1:601'
    `).get() as { lifecycle_state: string };
    expect(otherPlan.lifecycle_state).toBe('scheduled');
  });

  it('R-2026-05-25 Bug #1 — buildTrainingPlanIntentPrefixPattern shape is `training:${planId}:%`', () => {
    expect(buildTrainingPlanIntentPrefixPattern(88)).toBe('training:88:%');
    expect(buildTrainingPlanIntentPrefixPattern(7)).toBe('training:7:%');
  });

  it('R-2026-05-25 Bug #1 — findSecretaryAgendaCalendarEventsForPlan returns provider events for any plan_version', () => {
    // Two intent rows for the same plan across two plan_versions.
    // Both need to be reachable by the helper.
    const v1 = submitSecretarySchedulingIntent({
      intentId: 'training:55:1:111',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 111,
      sourceEntityType: 'training_session',
      ownerUserId: 41,
      tenantId: 41,
      title: 'V1 session',
      requestedDurationMinutes: 30,
      preferredWindows: [{
        start: '2026-05-04T07:00:00.000Z',
        end: '2026-05-04T07:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    const v2 = submitSecretarySchedulingIntent({
      intentId: 'training:55:2:222',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 222,
      sourceEntityType: 'training_session',
      ownerUserId: 41,
      tenantId: 41,
      title: 'V2 session',
      requestedDurationMinutes: 30,
      preferredWindows: [{
        start: '2026-05-05T07:00:00.000Z',
        end: '2026-05-05T07:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    // Backfill provider_event_id values to simulate post-sync state.
    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?, provider_source = 'google', provider_sync_state = 'synced'
       WHERE agenda_item_id = ?
    `).run('google-evt-v1', v1.agendaItem.agendaItemId);

    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?, provider_source = 'outlook', provider_sync_state = 'synced'
       WHERE agenda_item_id = ?
    `).run('outlook-evt-v2', v2.agendaItem.agendaItemId);

    const events = findSecretaryAgendaCalendarEventsForPlan(55, 41, 41);
    expect(events).toEqual(expect.arrayContaining([
      { calendar_event_id: 'google-evt-v1', calendar_source: 'google' },
      { calendar_event_id: 'outlook-evt-v2', calendar_source: 'outlook' },
    ]));
    expect(events.length).toBe(2);
  });

  it('R-2026-05-25 Bug #1 — findSecretaryAgendaCalendarEventsForPlan skips already-deleted provider rows', () => {
    const decision = submitSecretarySchedulingIntent({
      intentId: 'training:60:1:333',
      sourceSkill: 'training',
      sourceAction: 'schedule_training_session',
      sourceEntityId: 333,
      sourceEntityType: 'training_session',
      ownerUserId: 51,
      tenantId: 51,
      title: 'Already deleted',
      requestedDurationMinutes: 30,
      preferredWindows: [{
        start: '2026-05-04T07:00:00.000Z',
        end: '2026-05-04T07:30:00.000Z',
        hard: true,
      }],
      priority: 'high',
      flexibility: 'fixed',
    }, { now: '2026-05-01T00:00:00.000Z' });

    testDb.prepare(`
      UPDATE secretary_agenda_items
         SET provider_event_id = ?, provider_source = 'google', provider_sync_state = 'deleted'
       WHERE agenda_item_id = ?
    `).run('google-evt-stale', decision.agendaItem.agendaItemId);

    const events = findSecretaryAgendaCalendarEventsForPlan(60, 51, 51);
    expect(events).toEqual([]); // already deleted upstream — skipped
  });
});
