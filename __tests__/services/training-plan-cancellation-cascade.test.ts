import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
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
import { cancelTrainingPlanCrossSkillDependents } from '../../src/services/training-plan-cancellation-cascade';

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
});
