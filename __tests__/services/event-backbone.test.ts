import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  _setOperatorAlertDeliveryConfigForTests: vi.fn(),
  _setOperatorAlertDeliverySenderForTests: vi.fn(),
  acknowledgeOperatorAlert: vi.fn(),
  deliverOperatorAlert: vi.fn(),
  getOperatorAlertDeliverySummary: vi.fn(),
  listOperatorAlerts: vi.fn(),
  processDueOperatorAlertDeliveries: vi.fn(),
  recordOperatorAlert: vi.fn(),
  resolveOperatorAlert: vi.fn(),
  retryOperatorAlertDelivery: vi.fn(),
}));

vi.mock('../../src/services/chat-history-store', () => ({
  DEFAULT_CHAT_VISIBILITY_SCOPE: 'all',
  claimUserChatMessage: vi.fn(),
  clearChatHistory: vi.fn(),
  findCompletedAssistantForClientMessage: vi.fn(),
  listChatMessages: vi.fn(),
  markMessageLifecycle: vi.fn(),
  repairStuckChatMessages: vi.fn(),
  storeChatMessage: vi.fn(),
  updateAssistantMessage: vi.fn(),
}));

vi.mock('../../src/state/conversation', () => ({
  addToConversation: vi.fn(),
  clearAllConversations: vi.fn(),
  clearConversation: vi.fn(),
  getConversationHistory: vi.fn(),
  getLastAssistantMessage: vi.fn(),
  markConversationLifecycle: vi.fn(),
  syncLastAssistantConversationMessage: vi.fn(),
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
  cancelEvent,
  claimPendingEvents,
  emitDomainEvent,
  ensureEventOutboxTables,
  markEventFailed,
  markEventProcessed,
  processPendingEvents,
  runOutboxTransaction,
} from '../../src/services/event-outbox';
import {
  claimPendingJobs,
  enqueueJob,
  ensureBackgroundJobTables,
  processPendingJobs,
} from '../../src/services/background-job-queue';
import {
  ensureAppSummaryTables,
  getAppSummary,
  projectSummaryReadModelsForUser,
} from '../../src/services/app-summary-read-models';
import { ensureDeltaSyncTables, listDeltaChanges } from '../../src/services/delta-sync';
import { consumeResourceBudget } from '../../src/services/resource-budgets';
import { defaultEventHandlers, defaultJobHandlers, runEventBackboneOnce } from '../../src/services/event-backbone-worker';
import { persistExchange } from '../../src/api/routes/chat-persistence';
import { runEventBackboneCleanup } from '../../src/tools/event-backbone-cleanup';
import { logger } from '../../src/utils/logger';

describe('event backbone foundation', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    ensureEventOutboxTables();
    ensureBackgroundJobTables();
    ensureAppSummaryTables();
  });

  afterEach(() => {
    testDb.close();
  });

  it('emits scoped events idempotently and redacts sensitive payload keys', () => {
    const first = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'content',
      eventType: 'content.idea.created',
      entityType: 'content_topic',
      entityId: 44,
      payload: {
        summary: { status: 'planned' },
        draft: 'private draft text',
        nested: {
          summary: {
            merchant: 'ACME Finance',
            amount: 99.5,
            calendarTitle: 'Drinks with John',
            body: 'long secret',
            vendor: 'Vendor X',
            taxDue: 100,
            category: 'mental_health',
          },
        },
      },
      privacyClassification: 'private_content',
      idempotencyKey: 'content-topic-44',
    });
    const second = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'content',
      eventType: 'content.idea.created',
      entityType: 'content_topic',
      entityId: 44,
      payload: { summary: { status: 'planned' } },
      privacyClassification: 'private_content',
      idempotencyKey: 'content-topic-44',
    });

    expect(second.eventId).toBe(first.eventId);
    expect(second.sequence).toBe(first.sequence);
    expect(first.payload.draft).toBe('[redacted]');
    expect(JSON.stringify(first.payload)).not.toContain('ACME Finance');
    expect(JSON.stringify(first.payload)).not.toContain('Drinks with John');
    expect(JSON.stringify(first.payload)).not.toContain('mental_health');
  });

  it('claims events with a lease and dead-letters after bounded retries', async () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 's-1',
      idempotencyKey: 'training-session-s-1',
      payload: { summary: { status: 'skipped' } },
      privacyClassification: 'health',
    });

    const claimed = claimPendingEvents(1, 'test-worker');
    expect(claimed).toHaveLength(1);
    expect(claimed[0].lockOwner).toBe('test-worker');
    testDb.prepare("UPDATE event_outbox SET status = 'failed', locked_at = NULL, lock_owner = NULL, not_before = datetime('now') WHERE event_id = ?").run(event.eventId);

    for (let i = 0; i < 2; i += 1) {
      testDb.prepare("UPDATE event_outbox SET not_before = datetime('now') WHERE event_id = ?").run(event.eventId);
      await processPendingEvents([{ eventType: '*', handle: () => { throw new Error('boom'); } }], { limit: 1, lockOwner: 'test-worker' });
    }

    const row = testDb.prepare('SELECT status, attempts FROM event_outbox WHERE event_id = ?').get(event.eventId) as any;
    expect(row.status).toBe('dead_letter');
    expect(row.attempts).toBe(3);
  });

  it('rolls back business writes when event emission fails inside the outbox transaction', () => {
    testDb.exec('CREATE TABLE business_rows (id TEXT PRIMARY KEY)');

    expect(() => runOutboxTransaction((emitDomainEvent) => {
      testDb.prepare('INSERT INTO business_rows (id) VALUES (?)').run('business-1');
      emitDomainEvent({
        tenantId: 0,
        userId: 7,
        sourceSkill: 'training',
        eventType: 'training.session.updated',
        entityType: 'training_session',
        entityId: 'bad-scope',
        idempotencyKey: 'bad-scope',
      });
    })).toThrow(/tenantId required/);

    const row = testDb.prepare('SELECT COUNT(*) AS count FROM business_rows').get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('rolls back event writes when the business operation fails after emitting', () => {
    expect(() => runOutboxTransaction((emitDomainEvent) => {
      emitDomainEvent({
        tenantId: 7,
        userId: 7,
        sourceSkill: 'training',
        eventType: 'training.session.updated',
        entityType: 'training_session',
        entityId: 'rollback-event',
        idempotencyKey: 'rollback-event',
      });
      throw new Error('business write failed after emit');
    })).toThrow(/business write failed/);

    const row = testDb.prepare("SELECT COUNT(*) AS count FROM event_outbox WHERE entity_id = 'rollback-event'").get() as { count: number };
    expect(row.count).toBe(0);
  });

  it('does not let late event processed or failed marks overwrite canceled rows', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'secretary',
      eventType: 'secretary.conflict.detected',
      entityType: 'agenda_item',
      entityId: 'cancel-race',
      idempotencyKey: 'cancel-race',
    });
    const claimed = claimPendingEvents(1, 'worker-before-cancel');
    expect(claimed[0].eventId).toBe(event.eventId);
    expect(cancelEvent(event.eventId, 7)).toBe(true);

    markEventProcessed(event.eventId);
    let row = testDb.prepare('SELECT status FROM event_outbox WHERE event_id = ?').get(event.eventId) as { status: string };
    expect(row.status).toBe('canceled');

    const result = markEventFailed(event.eventId, new Error('late worker failure'));
    row = testDb.prepare('SELECT status FROM event_outbox WHERE event_id = ?').get(event.eventId) as { status: string };
    expect(result).toBe('canceled');
    expect(row.status).toBe('canceled');
  });

  it('reclaims stale processing event leases after fifteen minutes', () => {
    const event = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'content',
      eventType: 'content.idea.updated',
      entityType: 'content_topic',
      entityId: 'stale-event',
      idempotencyKey: 'stale-event',
    });
    expect(claimPendingEvents(1, 'stale-event-worker')).toHaveLength(1);
    testDb.prepare("UPDATE event_outbox SET locked_at = datetime('now', '-20 minutes') WHERE event_id = ?").run(event.eventId);

    const reclaimed = claimPendingEvents(1, 'reaper-event-worker');
    expect(reclaimed.map((row) => row.eventId)).toEqual([event.eventId]);
    expect(reclaimed[0].attempts).toBe(2);
    expect(reclaimed[0].lockOwner).toBe('reaper-event-worker');
  });

  it('enqueues jobs idempotently and processes a read-model projection job', async () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      payload: { source: 'test' },
      idempotencyKey: 'project-7',
    });
    const duplicate = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      payload: { source: 'test' },
      idempotencyKey: 'project-7',
    });

    expect(duplicate.jobId).toBe(job.jobId);
    const result = await processPendingJobs(defaultJobHandlers, { limit: 1 });
    expect(result.completed).toBe(1);
    expect(getAppSummary({ tenantId: 7, userId: 7, summaryType: 'home' }).payload.kind).toBe('home');
  });

  it('reclaims stale processing job leases after fifteen minutes', () => {
    const job = enqueueJob({
      tenantId: 7,
      userId: 7,
      jobType: 'project_read_models',
      idempotencyKey: 'stale-job',
    });
    expect(claimPendingJobs(1, 'stale-job-worker')).toHaveLength(1);
    testDb.prepare("UPDATE background_jobs SET locked_at = datetime('now', '-20 minutes') WHERE job_id = ?").run(job.jobId);

    const reclaimed = claimPendingJobs(1, 'reaper-job-worker');
    expect(reclaimed.map((row) => row.jobId)).toEqual([job.jobId]);
    expect(reclaimed[0].attempts).toBe(2);
    expect(reclaimed[0].lockOwner).toBe('reaper-job-worker');
  });

  it('projects bounded summaries without provider/calendar calls', () => {
    testDb.exec(`
      CREATE TABLE fitness_training_plans (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        sport TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE training_sessions (
        id INTEGER PRIMARY KEY,
        plan_id INTEGER NOT NULL,
        session_type TEXT NOT NULL,
        title TEXT NOT NULL,
        duration_minutes INTEGER,
        status TEXT NOT NULL
      );
      CREATE TABLE notification_center_items (
        item_id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        source_skill TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `);
    testDb.prepare("INSERT INTO fitness_training_plans VALUES (1, 7, 'Marathon', 'running', 'Base', 'active', datetime('now'))").run();
    testDb.prepare("INSERT INTO training_sessions VALUES (9, 1, 'running', 'Long run private title', 60, 'pending')").run();
    testDb.prepare("INSERT INTO notification_center_items VALUES ('n1', 7, 7, 'secretary', 'decision_required', 'unread')").run();
    testDb.prepare("INSERT INTO notification_center_items VALUES ('n2', 8, 8, 'secretary', 'decision_required', 'unread')").run();

    const summaries = projectSummaryReadModelsForUser({ tenantId: 7, userId: 7 });
    const home = summaries.find((summary) => summary.summaryType === 'home')!;

    expect(home.payload.pendingDecisionsCount).toBe(1);
    expect(JSON.stringify(home.payload)).not.toContain('Long run private title');
    expect(JSON.stringify(home.payload)).not.toContain('n2');
  });

  it('returns user-scoped delta pages, resetRequired for invalid cursors, and no cross-tenant leakage', () => {
    const userA = emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'secretary',
      eventType: 'secretary.conflict.detected',
      entityType: 'agenda_item',
      entityId: 'a',
      payload: { summary: { text: 'Conflict needs review' } },
      privacyClassification: 'internal',
      idempotencyKey: 'a',
    });
    emitDomainEvent({
      tenantId: 8,
      userId: 8,
      sourceSkill: 'finance',
      eventType: 'finance.expense.created',
      entityType: 'finance_transaction',
      entityId: 'b',
      payload: { summary: { text: 'Other tenant' } },
      privacyClassification: 'financial',
      idempotencyKey: 'b',
    });

    const page = listDeltaChanges({ tenantId: 7, userId: 7, since: '0', limit: 1, deviceId: 'iphone-a' });
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0].eventId).toBe(userA.eventId);
    expect(JSON.stringify(page.changes)).not.toContain('Other tenant');

    const invalid = listDeltaChanges({ tenantId: 7, userId: 7, since: 'not-a-cursor', deviceId: 'iphone-a' });
    expect(invalid.resetRequired).toBe(true);
    expect(invalid.changes).toHaveLength(0);
    const cursorRows = testDb.prepare('SELECT COUNT(*) AS count FROM sync_cursors').get() as { count: number };
    expect(cursorRows.count).toBe(1);
  });

  it('does not advance a device cursor when reset is required', () => {
    emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'reset-a',
      payload: { summary: { status: 'changed' } },
      idempotencyKey: 'reset-a',
    });

    const invalid = listDeltaChanges({ tenantId: 7, userId: 7, since: 'bad', deviceId: 'iphone-reset' });
    const second = listDeltaChanges({ tenantId: 7, userId: 7, since: 'bad', deviceId: 'iphone-reset' });
    const cursorRows = testDb.prepare('SELECT COUNT(*) AS count FROM sync_cursors WHERE device_id = ?').get('iphone-reset') as { count: number };

    expect(invalid.resetRequired).toBe(true);
    expect(second.resetRequired).toBe(true);
    expect(cursorRows.count).toBe(0);
  });

  it('keeps same-tenant user-scoped deltas isolated while allowing tenant-scoped events', () => {
    emitDomainEvent({
      tenantId: 7,
      userId: 71,
      sourceSkill: 'training',
      eventType: 'training.session.updated',
      entityType: 'training_session',
      entityId: 'user-a',
      payload: { summary: { text: 'User A only' } },
      idempotencyKey: 'user-a-only',
    });
    const tenantEvent = emitDomainEvent({
      tenantId: 7,
      userId: null,
      sourceSkill: 'system',
      eventType: 'notification.item.updated',
      entityType: 'tenant_notice',
      entityId: 'tenant',
      payload: { summary: { text: 'Tenant notice' } },
      idempotencyKey: 'tenant-notice',
    });

    const page = listDeltaChanges({ tenantId: 7, userId: 72, since: '0', deviceId: 'iphone-b' });
    expect(page.changes.map((change) => change.eventId)).toEqual([tenantEvent.eventId]);
    expect(JSON.stringify(page.changes)).not.toContain('User A only');
  });

  it('chains event processing into read-model jobs', async () => {
    emitDomainEvent({
      tenantId: 7,
      userId: 7,
      sourceSkill: 'notification',
      eventType: 'notification.intent.created',
      entityType: 'notification_intent',
      entityId: 'intent-1',
      payload: { summary: { sourceSkill: 'training' } },
      privacyClassification: 'internal',
      idempotencyKey: 'intent-1',
    });

    const result = await runEventBackboneOnce();
    expect(result.events.processed).toBe(1);
    expect(result.jobs.completed).toBe(1);
    expect(getAppSummary({ tenantId: 7, userId: 7, summaryType: 'notifications' }).summaryType).toBe('notifications');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ scope: 'event_outbox' }), 'event_outbox_batch');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ scope: 'background_jobs' }), 'background_job_batch');
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ scope: 'event_backbone_worker' }), 'event_backbone_worker_tick');
  });

  it('emits privacy-bounded chat events from chat persistence', () => {
    persistExchange(
      7,
      'msg-user-1',
      'private prompt with a secret calendar detail',
      'msg-assistant-1',
      {
        text: 'assistant answer with private detail',
        timestamp: new Date('2026-05-07T12:00:00.000Z').toISOString(),
        domain: 'secretary',
        routeMethod: 'domain-handler',
      },
      7,
      { requestId: 'req-chat-1', clientMessageId: 'client-1' },
    );

    const event = testDb.prepare(`
      SELECT event_type, source_skill, payload_json, privacy_classification, request_id
      FROM event_outbox
      WHERE event_type = 'chat.message.created'
    `).get() as any;

    expect(event.source_skill).toBe('chat');
    expect(event.privacy_classification).toBe('private_content');
    expect(event.request_id).toBe('req-chat-1');
    expect(event.payload_json).toContain('"textLength"');
    expect(event.payload_json).not.toContain('secret calendar detail');
    expect(event.payload_json).not.toContain('assistant answer');
  });

  it('enforces tenant/user-scoped resource budgets', () => {
    expect(consumeResourceBudget({ tenantId: 7, userId: 7, budgetKey: 'sync_changes', limit: 2, windowSeconds: 60 }).allowed).toBe(true);
    expect(consumeResourceBudget({ tenantId: 7, userId: 7, budgetKey: 'sync_changes', limit: 2, windowSeconds: 60 }).allowed).toBe(true);
    expect(consumeResourceBudget({ tenantId: 7, userId: 7, budgetKey: 'sync_changes', limit: 2, windowSeconds: 60 }).allowed).toBe(false);
    expect(consumeResourceBudget({ tenantId: 8, userId: 8, budgetKey: 'sync_changes', limit: 2, windowSeconds: 60 }).allowed).toBe(true);
  });

  it('keeps resource budget counters bounded under parallel callers', async () => {
    const attempts = await Promise.all(Array.from({ length: 100 }, () => Promise.resolve()
      .then(() => consumeResourceBudget({ tenantId: 7, userId: 7, budgetKey: 'parallel_budget', limit: 10, windowSeconds: 60 }))));
    const row = testDb.prepare("SELECT count FROM resource_budget_counters WHERE tenant_id = 7 AND user_id = 7 AND budget_key = 'parallel_budget'").get() as { count: number };
    expect(row.count).toBeLessThanOrEqual(10);
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ budgetKey: 'parallel_budget' }), 'resource_budget_exceeded');
  });

  it('cleans only eligible processed backbone rows in apply mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-backbone-cleanup-'));
    const dbPath = join(dir, 'cleanup.db');
    const db = new Database(dbPath);
    try {
      ensureEventOutboxTables(db);
      ensureBackgroundJobTables(db);
      const oldProcessed = emitDomainEvent({
        tenantId: 7,
        userId: 7,
        sourceSkill: 'training',
        eventType: 'training.plan.updated',
        entityType: 'training_plan',
        entityId: 'old',
        payload: { summary: { text: 'old processed' } },
        idempotencyKey: 'old-processed',
      }, db);
      const oldDeadLetter = emitDomainEvent({
        tenantId: 7,
        userId: 7,
        sourceSkill: 'training',
        eventType: 'training.plan.updated',
        entityType: 'training_plan',
        entityId: 'dead',
        payload: { summary: { text: 'dead letter' } },
        idempotencyKey: 'old-dead-letter',
      }, db);
      db.prepare("UPDATE event_outbox SET status = 'processed', processed_at = datetime('now', '-45 days') WHERE event_id = ?").run(oldProcessed.eventId);
      db.prepare("UPDATE event_outbox SET status = 'dead_letter', processed_at = datetime('now', '-45 days') WHERE event_id = ?").run(oldDeadLetter.eventId);
    } finally {
      db.close();
    }

    const dryRun = runEventBackboneCleanup({ dbPath, retentionDays: 30, protectNewest: 0 });
    const applied = runEventBackboneCleanup({ dbPath, retentionDays: 30, protectNewest: 0, apply: true });
    const verifyDb = new Database(dbPath);
    try {
      const remaining = verifyDb.prepare('SELECT status FROM event_outbox ORDER BY entity_id').all() as Array<{ status: string }>;
      expect(dryRun.targets.find((target) => target.table === 'event_outbox')?.candidates).toBe(1);
      expect(applied.targets.find((target) => target.table === 'event_outbox')?.deleted).toBe(1);
      expect(remaining.map((row) => row.status)).toEqual(['dead_letter']);
    } finally {
      verifyDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not delete active sync cursors before the offline-device retention window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-backbone-sync-cleanup-'));
    const dbPath = join(dir, 'cleanup.db');
    const db = new Database(dbPath);
    try {
      ensureDeltaSyncTables(db);
      db.prepare(`
        INSERT INTO sync_cursors (
          cursor_id, tenant_id, user_id, device_id, cursor_value, last_seen_at
        ) VALUES ('cursor-old', 7, 7, 'iphone-a', 10, datetime('now', '-45 days'))
      `).run();
    } finally {
      db.close();
    }

    const applied = runEventBackboneCleanup({ dbPath, retentionDays: 30, protectNewest: 0, apply: true });
    const verifyDb = new Database(dbPath);
    try {
      const remaining = verifyDb.prepare('SELECT COUNT(*) AS count FROM sync_cursors').get() as { count: number };
      expect(applied.targets.find((target) => target.table === 'sync_cursors')?.deleted).toBe(0);
      expect(remaining.count).toBe(1);
    } finally {
      verifyDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves processed events at or after the oldest active sync cursor', () => {
    const dir = mkdtempSync(join(tmpdir(), 'event-backbone-retention-floor-'));
    const dbPath = join(dir, 'cleanup.db');
    const db = new Database(dbPath);
    try {
      ensureEventOutboxTables(db);
      ensureDeltaSyncTables(db);
      for (let i = 1; i <= 12; i += 1) {
        const event = emitDomainEvent({
          tenantId: 7,
          userId: 7,
          sourceSkill: 'training',
          eventType: 'training.session.updated',
          entityType: 'training_session',
          entityId: `e-${i}`,
          payload: { summary: { status: 'processed' } },
          idempotencyKey: `retention-${i}`,
        }, db);
        db.prepare("UPDATE event_outbox SET status = 'processed', processed_at = datetime('now', '-45 days') WHERE event_id = ?").run(event.eventId);
      }
      db.prepare(`
        INSERT INTO sync_cursors (
          cursor_id, tenant_id, user_id, device_id, cursor_value, last_seen_at
        ) VALUES ('cursor-active', 7, 7, 'iphone-active', 10, datetime('now'))
      `).run();
    } finally {
      db.close();
    }

    const applied = runEventBackboneCleanup({ dbPath, retentionDays: 1, protectNewest: 0, apply: true });
    const verifyDb = new Database(dbPath);
    try {
      const minRemaining = verifyDb.prepare('SELECT MIN(sequence) AS min FROM event_outbox').get() as { min: number };
      expect(applied.targets.find((target) => target.table === 'event_outbox')?.deleted).toBe(9);
      expect(minRemaining.min).toBe(10);
    } finally {
      verifyDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
