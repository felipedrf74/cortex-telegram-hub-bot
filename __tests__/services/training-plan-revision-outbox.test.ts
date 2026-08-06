// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { withDatabaseForTestAsync } from '../../src/services/database';
import { defaultEventHandlers } from '../../src/services/event-backbone-worker';
import { emitDomainEvent, processPendingEvents } from '../../src/services/event-outbox';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

describe('training plan revision activation outbox handling', () => {
  it('queues one idempotent read-model projection and no provider work', async () => {
    const db = createMigratedTestDatabase();
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
      // Scoped by job_type (Phase 1B de-fragilization): the previous bare
      // `.get()` matched whatever row happened to insert first, so any new
      // router branch that enqueues another job type would break this test
      // for ordering reasons rather than behavioural ones.
      expect(db.prepare(`
        SELECT job_type AS jobType, idempotency_key AS idempotencyKey
          FROM background_jobs
         WHERE job_type = 'project_read_models'
      `).get()).toEqual({
        jobType: 'project_read_models',
        idempotencyKey: `project_read_models:${event.eventId}`,
      });
      // An activation event must never trigger the calendar-sync branch —
      // calendar work is requested only by the dedicated
      // training.plan_calendar_sync.requested.v1 event.
      expect(db.prepare(`
        SELECT COUNT(*) AS count
          FROM background_jobs
         WHERE job_type = 'training_plan_calendar_sync'
      `).get()).toEqual({ count: 0 });
    });
    db.close();
  });
});
