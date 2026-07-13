// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrationsForTest, withDatabaseForTestAsync } from '../../src/services/database';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';
import { emitDomainEvent, processPendingEvents } from '../../src/services/event-outbox';

describe('training plan revision activation outbox handling', () => {
  it('queues one idempotent read-model projection and no provider work', async () => {
    const db = new Database(':memory:');
    runMigrationsForTest(db);
    await withDatabaseForTestAsync(db, async () => {
      const event = emitDomainEvent({
        tenantId: 7,
        userId: 7,
        sourceSkill: 'training',
        eventType: 'training.plan_revision.activated.v1',
        entityType: 'training_plan_revision',
        entityId: 'revision-1',
        payload: { action: 'ACTIVATE', contentHash: 'a'.repeat(64) },
        idempotencyKey: 'training.plan_revision.activated:revision-1',
      });
      const result = await processPendingEvents(defaultEventHandlers, { limit: 10, lockOwner: 'revision-test' });
      expect(result).toMatchObject({ processed: 1, failed: 0, deadLetter: 0 });
      expect(db.prepare(`
        SELECT job_type AS jobType, idempotency_key AS idempotencyKey
          FROM background_jobs
      `).get()).toEqual({
        jobType: 'project_read_models',
        idempotencyKey: `project_read_models:${event.eventId}`,
      });
    });
    db.close();
  });
});
