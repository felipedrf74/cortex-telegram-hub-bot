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
  claimPendingEvents,
  emitDomainEvent,
  ensureEventOutboxTables,
  processPendingEvents,
} from '../../src/services/event-outbox';
import {
  enqueueJob,
  ensureBackgroundJobTables,
  processPendingJobs,
} from '../../src/services/background-job-queue';
import {
  ensureAppSummaryTables,
  getAppSummary,
  projectSummaryReadModelsForUser,
} from '../../src/services/app-summary-read-models';
import { listDeltaChanges } from '../../src/services/delta-sync';
import { consumeResourceBudget } from '../../src/services/resource-budgets';
import { defaultEventHandlers, defaultJobHandlers, runEventBackboneOnce } from '../../src/services/event-backbone-worker';
import { persistExchange } from '../../src/api/routes/chat-persistence';
import { runEventBackboneCleanup } from '../../src/tools/event-backbone-cleanup';

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
});
