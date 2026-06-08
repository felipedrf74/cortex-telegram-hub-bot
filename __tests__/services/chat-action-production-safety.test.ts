import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
const NOW = '2026-05-16T12:00:00+01:00';

let testDb: Database.Database;
let previousReadBackTimeout: string | undefined;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (applied) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(file);
  }
}

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
}));

vi.mock('../../src/api/routes/training-plan-calendar-sync', () => ({
  previewTrainingSessionReflow: vi.fn(),
  confirmTrainingSessionReflow: vi.fn(),
}));

import {
  buildChatActionPlan,
  executeChatActionPlan,
  parseLlmPlannerJson,
  type ChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat';
import {
  getActivePendingChatAction,
  getPendingChatActionById,
  listChatActionTelemetryForScope,
  recordChatActionTelemetry,
  rememberRecentChatEntity,
  resetChatActionStateForTests,
  resolveRecentChatEntity,
  upsertPendingChatAction,
} from '../../src/services/chat-action-state';
import { getChatActionRun } from '../../src/services/chat-action-run-store';
import { getUserConnections } from '../../src/services/oauth-store';
import { getOrCreateNotificationProfile, updateNotificationProfile } from '../../src/services/notification-orchestrator';
import { clearPendingChatConfirmation, getPendingChatConfirmation, trackPendingChatConfirmation } from '../../src/services/chat-pending-confirmations';
import { addTransaction, calculateAndStoreTax, getTaxEvents } from '../../src/services/finance-tracker';

const tenantA = 7101;
const userA = 8101;
const tenantB = 7202;
const userB = 8202;

function input(overrides: Partial<ChatPlannerInput> = {}): ChatPlannerInput {
  return {
    text: 'Create a Google Calendar event called release review tomorrow at 10',
    userId: userA,
    tenantId: tenantA,
    conversationId: 'conv-prod-safety',
    messageId: 'msg-prod-safety',
    channel: 'api',
    locale: 'en-US',
    timezone: 'Europe/Lisbon',
    nowIso: NOW,
    ...overrides,
  };
}

function calendarPlan(messageId = 'msg-calendar-idempotency'): ChatActionPlan {
  const plan = parseLlmPlannerJson(JSON.stringify({
    confidence: 0.99,
    steps: [{
      skill: 'secretary_calendar',
      action: 'schedule_event',
      args: {
        title: 'release review',
        provider: 'google_calendar',
        startDateTime: '2026-05-17T10:00:00+01:00',
        endDateTime: '2026-05-17T11:00:00+01:00',
        timezone: 'Europe/Lisbon',
      },
      missingFields: [],
    }],
  }), input({ messageId }));
  if (!plan) throw new Error('calendar test plan failed to parse');
  return plan;
}

function makeCalendarDeps(options: {
  hasGoogle?: boolean;
  createEvent?: ReturnType<typeof vi.fn>;
  getEventsForSources?: ReturnType<typeof vi.fn>;
} = {}) {
  const events: any[] = [];
  const createEvent = options.createEvent ?? vi.fn(async (data: any, source: 'google' | 'outlook') => {
    const event = {
      id: `evt-${events.length + 1}`,
      summary: data.title,
      start: data.start,
      end: data.end,
      source,
    };
    events.push(event);
    return event;
  });
  const getEventsForSources = options.getEventsForSources ?? vi.fn(async () => [...events]);
  return {
    events,
    deps: {
      calendar: {
        createEvent,
        getEventsForSources,
        hasGoogle: vi.fn(() => options.hasGoogle ?? true),
        hasOutlook: vi.fn(() => true),
      },
      taskProviderForUser: vi.fn(() => ({}) as any),
    },
  };
}

function makeTaskDeps(options: {
  createTask?: ReturnType<typeof vi.fn>;
  getTask?: ReturnType<typeof vi.fn>;
} = {}) {
  const tasks = new Map<string, any>();
  let counter = 0;
  const defaultList = { id: 'tasks', displayName: 'Tasks', name: 'Tasks' };
  const createTask = options.createTask ?? vi.fn(async (_listId: string, _listName: string, data: any) => {
    const task = { id: `task-${++counter}`, title: data.title, subject: data.title, listId: 'tasks' };
    tasks.set(task.id, task);
    return { success: true, data: task };
  });
  const getTask = options.getTask ?? vi.fn(async (_listId: string, taskId: string) => ({
    success: tasks.has(taskId),
    data: tasks.get(taskId) ?? null,
  }));
  return {
    tasks,
    deps: {
      calendar: makeCalendarDeps().deps.calendar,
      taskProviderForUser: vi.fn(() => ({
        getLists: vi.fn(async () => ({ success: true, data: [defaultList] })),
        getDefaultList: vi.fn(async () => defaultList),
        createTask,
        getTask,
      }) as any),
    },
  };
}

function expectNoSecretLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toMatch(/access_token|refresh_token|oauth|secret-token|raw-provider-secret|tenantB-secret|stack trace/i);
}

describe('chat action production safety: tenant isolation, idempotency, retries, provider failures', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetChatActionStateForTests();
    testDb = createTestDb();
    applyMigrations(testDb);
    previousReadBackTimeout = process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
  });

  afterEach(() => {
    if (previousReadBackTimeout === undefined) delete process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
    else process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS = previousReadBackTimeout;
    testDb?.close();
  });

  describe('tenant isolation', () => {
    it('prevents cross-tenant pending action reads, continuations, resource resolution, telemetry reads, provider status reads, notification preference reads, and stale-conversation reuse', async () => {
      const sharedConversationId = 'conv-shared-stale';
      const pendingB = upsertPendingChatAction({
        userId: userB,
        tenantId: tenantB,
        conversationId: sharedConversationId,
        skill: 'training',
        action: 'training_plan_create',
        collectedSlots: { sport: 'running', goal: '10k', durationWeeks: 12 },
        missingSlots: ['weeklyVolumeKm', 'startDate'],
        riskClass: 'R1',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        originatingSurface: 'api',
        nowIso: NOW,
      });

      expect(getPendingChatActionById({
        userId: userA,
        tenantId: tenantA,
        pendingActionId: pendingB.id,
        nowIso: NOW,
      })).toBeNull();
      expect(getActivePendingChatAction({
        userId: userA,
        tenantId: tenantA,
        conversationId: sharedConversationId,
        skill: 'training',
        nowIso: NOW,
      })).toBeNull();

      const crossTenantContinuation = await buildChatActionPlan(input({
        text: 'It is 20 km a week',
        conversationId: sharedConversationId,
        messageId: 'msg-cross-tenant-continuation',
      }));
      const continuationStep = crossTenantContinuation?.steps[0];
      expect(continuationStep?.requiredArgsPresent).not.toBe(true);
      expect((continuationStep?.args as Record<string, unknown> | undefined)?.goal).not.toBe('10k');

      rememberRecentChatEntity({
        userId: userB,
        tenantId: tenantB,
        conversationId: sharedConversationId,
        node: {
          entityId: 'task-b-secret',
          entityType: 'task',
          provider: 'nexus',
          surface: 'chat',
          userVisibleLabel: 'Tenant B task',
          createdOrViewedAt: NOW,
          lastVerifiedAt: NOW,
          allowedFollowupActions: ['complete_task'],
          confidence: 0.99,
          expiresAt: '2026-05-16T13:00:00+01:00',
          sourceTurnId: 'msg-b',
        },
      });
      expect(resolveRecentChatEntity({
        userId: userA,
        tenantId: tenantA,
        conversationId: sharedConversationId,
        entityType: 'task',
        action: 'complete_task',
        nowIso: NOW,
      })).toMatchObject({ status: 'none', candidates: [] });

      recordChatActionTelemetry({
        userId: userB,
        tenantId: tenantB,
        conversationId: sharedConversationId,
        messageId: 'msg-telemetry-b',
        planner: 'deterministic',
        status: 'failed',
        skill: 'secretary_calendar',
        action: 'schedule_event',
        telemetry: {
          routeTier: 'tier0_deterministic',
          candidates: [],
          calibratedScore: 0.8,
          threshold: 0.7,
          failureReason: 'provider_create_failed',
          outcome: 'failed',
        },
        nowIso: NOW,
      });
      recordChatActionTelemetry({
        userId: userA,
        tenantId: tenantA,
        conversationId: sharedConversationId,
        messageId: 'msg-telemetry-a',
        planner: 'deterministic',
        status: 'blocked',
        skill: 'tasks',
        action: 'create_task',
        telemetry: {
          routeTier: 'tier0_deterministic',
          candidates: [],
          calibratedScore: 0.8,
          threshold: 0.7,
          failureReason: 'task_provider_not_writable',
          outcome: 'blocked',
        },
        nowIso: NOW,
      });
      const scopedTelemetry = listChatActionTelemetryForScope({
        userId: userA,
        tenantId: tenantA,
        conversationId: sharedConversationId,
      });
      expect(scopedTelemetry).toHaveLength(1);
      expect(scopedTelemetry[0]).toMatchObject({ userId: userA, tenantId: tenantA, messageId: 'msg-telemetry-a' });

      testDb.prepare(`
        INSERT INTO user_oauth_tokens (user_id, provider, access_token, refresh_token, token_type, expires_at, scopes, created_at, updated_at)
        VALUES (?, 'google', 'encrypted-a', 'encrypted-r', 'Bearer', ?, ?, ?, ?)
      `).run(userB, '2026-05-16T13:00:00+01:00', JSON.stringify(['https://www.googleapis.com/auth/calendar']), NOW, NOW);
      expect(getUserConnections(userA).map((connection) => connection.provider)).not.toContain('google');
      expect(getUserConnections(userB).map((connection) => connection.provider)).toContain('google');

      updateNotificationProfile(userB, tenantB, { pushEnabled: false, skillPreferences: { training: false } });
      const profileA = getOrCreateNotificationProfile(userA, tenantA);
      const profileB = getOrCreateNotificationProfile(userB, tenantB);
      expect(profileA.pushEnabled).toBe(true);
      expect(profileA.skillPreferences.training).toBe(true);
      expect(profileB.pushEnabled).toBe(false);
      expect(profileB.skillPreferences.training).toBe(false);
    });
  });

  describe('idempotency and retries', () => {
    it('deduplicates same-message calendar and task creates after verified success', async () => {
      const calendar = makeCalendarDeps();
      const plan = calendarPlan('msg-calendar-dupe');
      const request = input({ messageId: 'msg-calendar-dupe' });

      const first = await executeChatActionPlan(plan, request, calendar.deps, { confirmed: true });
      const second = await executeChatActionPlan(plan, request, calendar.deps, { confirmed: true });

      expect(first.metadata.actionStatus).toBe('verified_success');
      expect(second.metadata.actionStatus).toBe('verified_success');
      expect(second.text).toMatch(/already handled|did not create a duplicate/i);
      expect(calendar.deps.calendar.createEvent).toHaveBeenCalledTimes(1);
      expect(calendar.events).toHaveLength(1);

      const taskDeps = makeTaskDeps();
      const taskPlan = parseLlmPlannerJson(JSON.stringify({
        confidence: 0.99,
        steps: [{
          skill: 'tasks',
          action: 'create_task',
          args: { title: 'Release checklist' },
          missingFields: [],
        }],
      }), input({ messageId: 'msg-task-dupe' }));
      if (!taskPlan) throw new Error('task test plan failed to parse');
      const taskRequest = input({ messageId: 'msg-task-dupe', text: 'Create a task called Release checklist' });

      const taskFirst = await executeChatActionPlan(taskPlan, taskRequest, taskDeps.deps, { confirmed: true });
      const taskSecond = await executeChatActionPlan(taskPlan, taskRequest, taskDeps.deps, { confirmed: true });
      expect(taskFirst.metadata.actionStatus).toBe('verified_success');
      expect(taskSecond.metadata.actionStatus).toBe('verified_success');
      expect(taskSecond.text).toMatch(/already handled|did not create a duplicate/i);
      expect(taskDeps.deps.taskProviderForUser().createTask).toHaveBeenCalledTimes(1);
      expect(taskDeps.tasks.size).toBe(1);
    });

    it('does not duplicate provider writes after provider success plus verifier failure or timeout', async () => {
      const mismatch = makeCalendarDeps({
        getEventsForSources: vi.fn(async () => []),
      });
      const mismatchPlan = calendarPlan('msg-calendar-verifier-failure');
      const mismatchRequest = input({ messageId: 'msg-calendar-verifier-failure' });

      const firstMismatch = await executeChatActionPlan(mismatchPlan, mismatchRequest, mismatch.deps, { confirmed: true });
      const secondMismatch = await executeChatActionPlan(mismatchPlan, mismatchRequest, mismatch.deps, { confirmed: true });
      expect(firstMismatch.metadata.actionStatus).toBe('partial_success');
      expect(secondMismatch.metadata.actionStatus).toBe('partial_success');
      expect(mismatch.deps.calendar.createEvent).toHaveBeenCalledTimes(1);

      process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS = '5';
      const timeout = makeCalendarDeps({
        getEventsForSources: vi.fn(async () => new Promise(() => undefined)),
      });
      const timeoutPlan = calendarPlan('msg-calendar-readback-timeout');
      const timeoutRequest = input({ messageId: 'msg-calendar-readback-timeout' });
      const firstTimeout = await executeChatActionPlan(timeoutPlan, timeoutRequest, timeout.deps, { confirmed: true });
      const secondTimeout = await executeChatActionPlan(timeoutPlan, timeoutRequest, timeout.deps, { confirmed: true });

      expect(firstTimeout.metadata.actionStatus).toBe('partial_success');
      expect(secondTimeout.metadata.actionStatus).toBe('partial_success');
      expect(timeout.deps.calendar.createEvent).toHaveBeenCalledTimes(1);
    });

    it('keeps confirmation tokens single-use, pending continuation idempotent, and financial/send-email retries non-duplicating', async () => {
      const pending = trackPendingChatConfirmation({
        userId: userA,
        tenantId: tenantA,
        actionSummary: 'Delete the selected event',
        involvedSkills: ['secretary'],
        reasonCodes: ['destructive_action'],
        now: new Date(NOW),
      });
      expect(getPendingChatConfirmation(userA, tenantA, new Date(NOW))?.id).toBe(pending.id);
      expect(clearPendingChatConfirmation(userA, tenantA)).toBe(true);
      expect(clearPendingChatConfirmation(userA, tenantA)).toBe(false);

      const firstPending = upsertPendingChatAction({
        userId: userA,
        tenantId: tenantA,
        conversationId: 'conv-pending-idempotent',
        skill: 'training',
        action: 'training_plan_create',
        collectedSlots: { sport: 'running' },
        missingSlots: ['weeklyVolumeKm'],
        riskClass: 'R1',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        originatingSurface: 'api',
        nowIso: NOW,
      });
      const secondPending = upsertPendingChatAction({
        userId: userA,
        tenantId: tenantA,
        conversationId: 'conv-pending-idempotent',
        skill: 'training',
        action: 'training_plan_create',
        collectedSlots: { sport: 'running', weeklyVolumeKm: 20 },
        missingSlots: [],
        riskClass: 'R1',
        locale: 'en-US',
        timezone: 'Europe/Lisbon',
        originatingSurface: 'api',
        nowIso: NOW,
      });
      expect(secondPending.id).toBe(firstPending.id);
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM chat_pending_actions WHERE user_id = ? AND tenant_id = ? AND conversation_id = ?').get(userA, tenantA, 'conv-pending-idempotent')).toMatchObject({ count: 1 });

      addTransaction(userA, '2026-05-01', 'income', 5000, { currency: 'EUR', tenantId: tenantA });
      calculateAndStoreTax(userA, '2026-05', { tenantId: tenantA });
      const paymentPlan = parseLlmPlannerJson(JSON.stringify({
        confidence: 0.99,
        steps: [{
          skill: 'finance',
          action: 'finance_payment_action',
          args: { action: 'mark_tax_paid', month: '2026-05' },
          missingFields: [],
        }],
      }), input({ messageId: 'msg-payment-dupe' }));
      if (!paymentPlan) throw new Error('payment test plan failed to parse');
      const paymentRequest = input({ messageId: 'msg-payment-dupe', text: 'Mark my May tax payment as paid' });
      const paymentFirst = await executeChatActionPlan(paymentPlan, paymentRequest, makeCalendarDeps().deps, { confirmed: true });
      const paymentSecond = await executeChatActionPlan(paymentPlan, paymentRequest, makeCalendarDeps().deps, { confirmed: true });
      expect(paymentFirst.metadata.actionStatus).toBe('verified_success');
      expect(paymentSecond.metadata.actionStatus).toBe('verified_success');
      expect(paymentSecond.text).toMatch(/already handled|did not create a duplicate/i);
      expect(getTaxEvents(userA, { year: 2026, tenantId: tenantA }).filter((event) => event.month === '2026-05')).toHaveLength(1);
      expect(getTaxEvents(userA, { year: 2026, tenantId: tenantA }).find((event) => event.month === '2026-05')).toMatchObject({ status: 'paid' });

      const sendEmailPlan = parseLlmPlannerJson(JSON.stringify({
        confidence: 0.99,
        steps: [{
          skill: 'mail',
          action: 'send_email',
          args: { recipient: 'ana@example.com', subject: 'Release', body: 'Ready' },
          missingFields: [],
        }],
      }), input({ messageId: 'msg-send-email-dupe' }));
      if (!sendEmailPlan) throw new Error('send email test plan failed to parse');
      const sendEmailRequest = input({ messageId: 'msg-send-email-dupe', text: 'Send Ana the release email' });
      const emailFirst = await executeChatActionPlan(sendEmailPlan, sendEmailRequest, makeCalendarDeps().deps);
      const emailSecond = await executeChatActionPlan(sendEmailPlan, sendEmailRequest, makeCalendarDeps().deps);
      expect(emailFirst.metadata.actionStatus).toBe('needs_confirmation');
      expect(emailSecond.metadata.actionStatus).toBe('needs_confirmation');
      expect(testDb.prepare('SELECT COUNT(*) AS count FROM chat_action_runs WHERE user_id = ? AND tenant_id = ? AND action_type = ?').get(userA, tenantA, 'send_email')).toMatchObject({ count: 1 });
    });
  });

  describe('provider failures', () => {
    it.each([
      ['expired token', new Error('401 expired access_token=raw-provider-secret')],
      ['permission denied', new Error('403 permission denied refresh_token=raw-provider-secret')],
      ['rate limit', new Error('429 rate limit oauth=raw-provider-secret')],
      ['timeout', new Error('provider_write_timeout stack trace raw-provider-secret')],
      ['provider 500', new Error('500 internal provider error raw-provider-secret')],
    ])('fails safely for calendar provider failure: %s', async (_label, error) => {
      const provider = makeCalendarDeps({
        createEvent: vi.fn(async () => {
          throw error;
        }),
      });
      const response = await executeChatActionPlan(calendarPlan(`msg-provider-${String(_label).replace(/\s+/g, '-')}`), input({
        messageId: `msg-provider-${String(_label).replace(/\s+/g, '-')}`,
      }), provider.deps, { confirmed: true });

      expect(response.metadata.actionStatus).toBe('failed');
      expect(response.text).toMatch(/could not complete|nothing was confirmed/i);
      expect(provider.deps.calendar.createEvent).toHaveBeenCalledTimes(1);
      expectNoSecretLeak(response);
      const telemetry = listChatActionTelemetryForScope({
        userId: userA,
        tenantId: tenantA,
        messageId: `msg-provider-${String(_label).replace(/\s+/g, '-')}`,
      });
      expect(telemetry).toHaveLength(1);
      expect(telemetry[0]?.failureReason).toBe('provider_create_failed');
      expectNoSecretLeak(telemetry);
    });

    it('blocks disconnected providers without calling the provider and records safe telemetry', async () => {
      const provider = makeCalendarDeps({ hasGoogle: false });
      const response = await executeChatActionPlan(calendarPlan('msg-disconnected-provider'), input({
        messageId: 'msg-disconnected-provider',
      }), provider.deps, { confirmed: true });

      expect(response.metadata.actionStatus).toBe('blocked');
      expect(response.text).toMatch(/not connected/i);
      expect(provider.deps.calendar.createEvent).not.toHaveBeenCalled();
      const telemetry = listChatActionTelemetryForScope({ userId: userA, tenantId: tenantA, messageId: 'msg-disconnected-provider' });
      expect(telemetry[0]?.failureReason).toBe('google_calendar_not_connected_for_write');
      expectNoSecretLeak(response);
      expectNoSecretLeak(telemetry);
    });

    it('handles malformed provider responses and verifier failures without silent success or raw error leakage', async () => {
      const malformedTask = makeTaskDeps({
        createTask: vi.fn(async () => ({ success: true, data: {} })),
      });
      const taskPlan = parseLlmPlannerJson(JSON.stringify({
        confidence: 0.99,
        steps: [{
          skill: 'tasks',
          action: 'create_task',
          args: { title: 'Malformed task response' },
          missingFields: [],
        }],
      }), input({ messageId: 'msg-malformed-task' }));
      if (!taskPlan) throw new Error('malformed task plan failed to parse');
      const taskResponse = await executeChatActionPlan(taskPlan, input({
        messageId: 'msg-malformed-task',
        text: 'Create a task called Malformed task response',
      }), malformedTask.deps, { confirmed: true });
      expect(taskResponse.metadata.actionStatus).toBe('failed');
      expect(taskResponse.text).toMatch(/could not complete|nothing was confirmed/i);
      expectNoSecretLeak(taskResponse);
      expect(listChatActionTelemetryForScope({ userId: userA, tenantId: tenantA, messageId: 'msg-malformed-task' })[0]?.failureReason).toBe('task_create_failed');

      const verifierFailure = makeCalendarDeps({
        getEventsForSources: vi.fn(async () => []),
      });
      const calendarResponse = await executeChatActionPlan(calendarPlan('msg-verifier-cannot-confirm'), input({
        messageId: 'msg-verifier-cannot-confirm',
      }), verifierFailure.deps, { confirmed: true });
      expect(calendarResponse.metadata.actionStatus).toBe('partial_success');
      expect(calendarResponse.text).toMatch(/could not verify|will not claim full success/i);
      expectNoSecretLeak(calendarResponse);
      expect(listChatActionTelemetryForScope({ userId: userA, tenantId: tenantA, messageId: 'msg-verifier-cannot-confirm' })[0]?.failureReason).toBe('provider_read_back_mismatch');
    });
  });
});
