// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// WP-15 — background write-command queue tests.
//
// Covers: kill-switch matrix (default-off + per-tenant flip), enqueue return
// shape, jobType runtime guard ('critic' rejected), the FOUR §5.E type-boundary
// conversions (string↔number at enqueue / execute / record-event), lifecycle
// state transitions, processPendingJobs integration (completed / failed /
// dead-letter / APNs called-or-not / stale→completed), the action-gateway
// queued_background variant (+ fallback/shadow unaffected), tenant isolation,
// and the escalation keep-alive=300 (B8).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

const mockSendPushNotification = vi.hoisted(() => vi.fn(async () => ({
  sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] as string[],
})));
vi.mock('../../src/services/apns-sender', () => ({
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
}));

const mockExecuteCommand = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/chat-core-v2/command-executor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/chat-core-v2/command-executor')>();
  return {
    ...actual,
    executeChatCoreV2Command: (...args: unknown[]) => mockExecuteCommand(...args),
  };
});

import {
  enqueueBackgroundChatCommand,
  shouldBackgroundQueueChatCoreV2Command,
  isExecutableBackgroundCommandJobType,
  ChatCoreV2BackgroundCommandEnqueueError,
  canTransitionBackgroundJob,
  CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE,
  buildChatCoreV2QueuedBackgroundResult,
  resolveKeepAliveForRole,
  type ChatCoreV2BackgroundCommandEnqueueRefusal,
} from '../../src/services/chat-core-v2';
import {
  processBackgroundChatCommandJob,
  resolveBackgroundCommandTransition,
  chatCoreV2BackgroundCommandJobHandler,
} from '../../src/services/chat-core-v2/background-command-worker';
import {
  ensureBackgroundJobTables,
  processPendingJobs,
  markJobFailed,
  type JobRecord,
} from '../../src/services/background-job-queue';
import {
  ensureChatCoreV2CommandEventTables,
  getChatV2CommandEventById,
} from '../../src/services/chat-core-v2/command-events';
import {
  setChatCoreV2RuntimeOverride,
  _resetChatCoreV2RuntimeOverridesForTests,
} from '../../src/services/chat-core-v2/activation-flags';
import type { AICommandEnvelope } from '../../src/services/chat-core-v2/types';
import type { ChatCoreV2WriteIntentGuardTelemetry } from '../../src/services/chat-core-v2/action-gateway';

const NOW = new Date('2026-05-30T12:00:00.000Z');

// Env that fully enables enqueue: write execution on + canary mode.
const ENABLED_ENV = {
  CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary',
  CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true',
} as Record<string, string | undefined>;

function taskCreateCommand(overrides: Partial<AICommandEnvelope<Record<string, unknown>>> = {}): AICommandEnvelope<Record<string, unknown>> {
  return {
    commandId: 'cmd_bg_1',
    commandSchemaVersion: 'tasks.create@1.0.0',
    previewSchemaVersion: 'task_preview_card@1.0.0',
    responseSchemaVersion: 'chat_response_v2@1.0.0',
    tenantId: '7',
    userId: '7',
    domain: 'tasks',
    commandType: 'tasks.create',
    origin: 'chat',
    payload: { title: 'Buy milk' },
    basedOn: {
      entityIds: [],
      entityVersions: {},
      contextHash: 'ctx_bg_1',
      createdAt: NOW.toISOString(),
    },
    preconditions: {
      requiredEntityVersions: {},
      requiredPermissionsVersion: 'chat-v2-permissions:7:7:tasks:v1',
      invariants: [],
    },
    authorization: {
      actorUserId: '7',
      tenantId: '7',
      actingSurface: 'ios_chat',
      delegatedScopes: ['tasks:read', 'tasks:write'],
      permissionSnapshotVersion: 'chat-v2-permissions:7:7:tasks:v1',
      authTime: NOW.toISOString(),
    },
    expiresAt: new Date(NOW.getTime() + 10 * 60 * 1000).toISOString(),
    idempotencyKey: 'chat-v2:7:7:tasks.create:cmd_bg_1',
    ...overrides,
  } as AICommandEnvelope<Record<string, unknown>>;
}

function makeTelemetry(): ChatCoreV2WriteIntentGuardTelemetry {
  return {
    event: 'chat_core_v2_write_intent_guard',
    gatewayVersion: 'test',
    requestId: 'req1',
    userId: 7,
    tenantId: 7,
    messageHash: 'h',
    detectedIntent: 'task_create',
    resolverResult: 'resolved',
    resolvedEntityIds: [],
    policyDecision: 'execute',
    legacyFallbackBlocked: false,
    finalOutcome: 'resolved_execute',
    verificationStatus: 'pending',
    latencyMs: 1,
    reasonCodes: ['task_create_intent'],
    mode: 'enforce',
  };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  ensureBackgroundJobTables(testDb);
  ensureChatCoreV2CommandEventTables(testDb);
  mockSendPushNotification.mockClear();
  mockExecuteCommand.mockReset();
  _resetChatCoreV2RuntimeOverridesForTests();
});

afterEach(() => {
  testDb.close();
  _resetChatCoreV2RuntimeOverridesForTests();
});

// ── Pure keep-alive resolver (B8) ──────────────────────────────────────────
describe('resolveKeepAliveForRole (B8)', () => {
  it('maps escalation_35b to 300 (5m residency)', () => {
    expect(resolveKeepAliveForRole('escalation_35b')).toBe(300);
  });
  it('keeps the 3B planner always-loaded at -1', () => {
    expect(resolveKeepAliveForRole('planner_3b')).toBe(-1);
  });
  it('maps operational_rollback (unload) to 0', () => {
    expect(resolveKeepAliveForRole('operational_rollback')).toBe(0);
  });
  it('defaults unknown roles to -1', () => {
    expect(resolveKeepAliveForRole('not_a_role')).toBe(-1);
  });
});

// ── Kill-switch matrix ──────────────────────────────────────────────────────
describe('enqueueBackgroundChatCommand kill-switch (default-off + per-tenant)', () => {
  function enqueue(env: Record<string, string | undefined>, tenantId = 7) {
    return enqueueBackgroundChatCommand({
      tenantId,
      userId: tenantId,
      jobType: 'composer',
      capabilityId: 'tasks.create',
      command: taskCreateCommand({ tenantId: String(tenantId), userId: String(tenantId) }),
      turnId: 'turn_1',
      env,
      db: testDb,
    });
  }

  function refusal(fn: () => unknown): ChatCoreV2BackgroundCommandEnqueueRefusal {
    try { fn(); } catch (err) {
      expect(err).toBeInstanceOf(ChatCoreV2BackgroundCommandEnqueueError);
      return (err as ChatCoreV2BackgroundCommandEnqueueError).refusal;
    }
    throw new Error('expected enqueue to throw');
  }

  it('is INERT by default — no env => write_execution_disabled, no row enqueued', () => {
    expect(refusal(() => enqueue({}))).toBe('write_execution_disabled');
    const count = testDb.prepare('SELECT COUNT(*) AS c FROM background_jobs').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('refuses when write execution is off even in canary mode', () => {
    expect(refusal(() => enqueue({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'canary' }))).toBe('write_execution_disabled');
  });

  it('refuses when mode is shadow even with write execution on', () => {
    expect(refusal(() => enqueue({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'shadow', CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true' }))).toBe('mode_not_canary_or_on');
  });

  it('refuses when mode is off even with write execution on', () => {
    expect(refusal(() => enqueue({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'off', CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true' }))).toBe('write_execution_disabled');
  });

  it('ENQUEUES when write execution on AND mode canary', () => {
    const job = enqueue({ ...ENABLED_ENV });
    expect(job.jobType).toBe(CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE);
    const count = testDb.prepare('SELECT COUNT(*) AS c FROM background_jobs').get() as { c: number };
    expect(count.c).toBe(1);
  });

  it('ENQUEUES when write execution on AND mode on', () => {
    const job = enqueue({ CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on', CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true' });
    expect(job.jobType).toBe(CHAT_CORE_V2_BACKGROUND_COMMAND_JOB_TYPE);
  });

  it('a WP-07 per-tenant override flip STOPS enqueue for that tenant', () => {
    // Tenant 7 flipped to 'off' via the runtime override Map; tenant 8 untouched.
    setChatCoreV2RuntimeOverride('7', { mode: 'off' });
    expect(refusal(() => enqueue({ ...ENABLED_ENV }, 7))).toBe('tenant_kill_switch');
    // No row for tenant 7.
    const c7 = testDb.prepare('SELECT COUNT(*) AS c FROM background_jobs WHERE tenant_id = 7').get() as { c: number };
    expect(c7.c).toBe(0);
    // Tenant 8 (no override) still enqueues — tenant isolation.
    const job8 = enqueue({ ...ENABLED_ENV }, 8);
    expect(job8.tenantId).toBe(8);
  });

  it("a per-tenant 'shadow' override also stops enqueue (demotion)", () => {
    setChatCoreV2RuntimeOverride('7', { mode: 'shadow' });
    expect(refusal(() => enqueue({ ...ENABLED_ENV }, 7))).toBe('tenant_kill_switch');
  });
});

// ── jobType runtime guard (§5.E) ────────────────────────────────────────────
describe('jobType runtime guard', () => {
  it("accepts the two executable chat-command jobTypes", () => {
    expect(isExecutableBackgroundCommandJobType('planner_escalation')).toBe(true);
    expect(isExecutableBackgroundCommandJobType('composer')).toBe(true);
  });

  it("REJECTS 'critic' at runtime even though it is a valid ChatCoreV2BackgroundJobType", () => {
    expect(isExecutableBackgroundCommandJobType('critic')).toBe(false);
    expect(isExecutableBackgroundCommandJobType('script_generation')).toBe(false);
    expect(isExecutableBackgroundCommandJobType('plan_repair')).toBe(false);
  });

  it("enqueue refuses 'critic' with invalid_job_type and writes no row", () => {
    let refusal: ChatCoreV2BackgroundCommandEnqueueRefusal | undefined;
    try {
      enqueueBackgroundChatCommand({
        tenantId: 7, userId: 7, jobType: 'critic', capabilityId: 'tasks.create',
        command: taskCreateCommand(), turnId: 't', env: { ...ENABLED_ENV }, db: testDb,
      });
    } catch (err) {
      refusal = (err as ChatCoreV2BackgroundCommandEnqueueError).refusal;
    }
    expect(refusal).toBe('invalid_job_type');
    const count = testDb.prepare('SELECT COUNT(*) AS c FROM background_jobs').get() as { c: number };
    expect(count.c).toBe(0);
  });

  it('enqueue refuses an unexecutable command type', () => {
    let refusal: ChatCoreV2BackgroundCommandEnqueueRefusal | undefined;
    try {
      enqueueBackgroundChatCommand({
        tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.update',
        command: taskCreateCommand({ commandType: 'tasks.update' }), turnId: 't', env: { ...ENABLED_ENV }, db: testDb,
      });
    } catch (err) {
      refusal = (err as ChatCoreV2BackgroundCommandEnqueueError).refusal;
    }
    expect(refusal).toBe('unexecutable_command_type');
  });
});

// ── §5.E FOUR type-boundary conversions ─────────────────────────────────────
describe('§5.E type-boundary conversions (string↔number at all four crossings)', () => {
  it('crossing 1+2: enqueue persists STRING ids in payload, NUMBER ids on the queue row', () => {
    const job = enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.create',
      command: taskCreateCommand(), turnId: 'turn_1', env: { ...ENABLED_ENV }, db: testDb,
    });
    // Queue row stores NUMBER ids (JobInput.tenantId is number, isValidTenantUserId).
    expect(job.tenantId).toBe(7);
    expect(typeof job.tenantId).toBe('number');
    expect(job.userId).toBe(7);
    expect(typeof job.userId).toBe('number');
    // Payload carries STRING ids (ChatCoreV2BackgroundJob convention).
    const payload = job.payload as Record<string, unknown>;
    expect(payload.tenantId).toBe('7');
    expect(typeof payload.tenantId).toBe('string');
    expect(payload.userId).toBe('7');
    expect(typeof payload.userId).toBe('string');
  });

  it('crossing 3: the worker calls executeChatCoreV2Command with NUMBER ids', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    const job = enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.create',
      command: taskCreateCommand(), turnId: 'turn_1', env: { ...ENABLED_ENV }, db: testDb,
    });
    const claimed = claimOne();
    await processBackgroundChatCommandJob(claimed, { now: NOW });
    const arg = mockExecuteCommand.mock.calls[0][0] as { userId: unknown; tenantId: unknown };
    expect(arg.userId).toBe(7);
    expect(typeof arg.userId).toBe('number');
    expect(arg.tenantId).toBe(7);
    expect(typeof arg.tenantId).toBe('number');
    void job;
  });

  it('crossing 4: recordChatV2CommandEvent persists STRING ids', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.create',
      command: taskCreateCommand(), turnId: 'turn_1', env: { ...ENABLED_ENV }, db: testDb,
    });
    await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    const event = getChatV2CommandEventById('cmd_bg_1:background_execution_completed', testDb);
    expect(event).not.toBeNull();
    expect(event!.tenantId).toBe('7');
    expect(typeof event!.tenantId).toBe('string');
    expect(event!.userId).toBe('7');
    expect(typeof event!.userId).toBe('string');
  });
});

// ── Lifecycle transitions ───────────────────────────────────────────────────
describe('lifecycle state transitions', () => {
  it('running→completed/failed and pending→expired are valid; pending→completed and terminal→* invalid', () => {
    expect(canTransitionBackgroundJob('running', 'completed')).toBe(true);
    expect(canTransitionBackgroundJob('running', 'failed')).toBe(true);
    expect(canTransitionBackgroundJob('pending', 'expired')).toBe(true);
    // The lifecycle machine forbids a direct pending→completed edge.
    expect(canTransitionBackgroundJob('pending', 'completed')).toBe(false);
    expect(canTransitionBackgroundJob('completed', 'running')).toBe(false);
  });

  it('resolveBackgroundCommandTransition holds at the source on an invalid edge', () => {
    expect(resolveBackgroundCommandTransition('running', 'completed')).toBe('completed');
    expect(resolveBackgroundCommandTransition('completed', 'running')).toBe('completed');
  });
});

// ── Worker integration (completed / failed / dead-letter / APNs / stale) ─────
function claimOne(): JobRecord {
  // Mirror claimPendingJobs but inline so the test owns the lifecycle.
  const row = testDb.prepare(`
    UPDATE background_jobs SET status='processing', attempts=attempts+1, locked_at=datetime('now'), started_at=COALESCE(started_at, datetime('now'))
    WHERE job_id = (SELECT job_id FROM background_jobs WHERE status IN ('pending','failed') ORDER BY created_at ASC LIMIT 1)
    RETURNING *
  `).get() as Record<string, unknown> | undefined;
  if (!row) throw new Error('no claimable job');
  return {
    jobId: String(row.job_id),
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    jobType: String(row.job_type),
    payload: JSON.parse(String(row.payload_json)),
    priority: Number(row.priority),
    status: row.status as JobRecord['status'],
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    notBefore: String(row.not_before),
    lockedAt: row.locked_at as string | null,
    lockOwner: row.lock_owner as string | null,
    idempotencyKey: String(row.idempotency_key),
    correlationId: row.correlation_id as string | null,
    causationEventId: row.causation_event_id as string | null,
    createdAt: String(row.created_at),
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    lastError: row.last_error as string | null,
  };
}

describe('processBackgroundChatCommandJob integration', () => {
  function enqueueJobFor(jobType: 'composer' | 'planner_escalation', notificationPolicy: 'apns' | 'silent' = 'apns') {
    return enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType, capabilityId: 'tasks.create',
      command: taskCreateCommand(), turnId: 'turn_1', notificationPolicy,
      env: { ...ENABLED_ENV }, db: testDb,
    });
  }

  it('verified execution → execution_completed event + APNs pushed', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'Task created', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('composer');
    const result = await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    expect(result.outcome).toBe('verified');
    expect(result.finalState).toBe('completed');
    expect(result.apnsPushed).toBe(true);
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    const apnsArgs = mockSendPushNotification.mock.calls[0];
    expect(apnsArgs[0]).toBe(7); // NUMBER userId at the APNs boundary
    expect((apnsArgs[1] as { collapseId: string }).collapseId).toBe('chat_core_v2_command:cmd_bg_1');
    expect(getChatV2CommandEventById('cmd_bg_1:background_execution_completed', testDb)).not.toBeNull();
  });

  it('does NOT push APNs when notificationPolicy is silent', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'Task created', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('composer', 'silent');
    const result = await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    expect(result.apnsPushed).toBe(false);
    expect(mockSendPushNotification).not.toHaveBeenCalled();
  });

  it('failed execution → command_failed event, APNs still pushed, then THROWS for retry', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: false, status: 'failed', reason: 'execution_failed', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true } });
    enqueueJobFor('composer');
    await expect(processBackgroundChatCommandJob(claimOne(), { now: NOW })).rejects.toThrow(/background_command_failed/);
    expect(getChatV2CommandEventById('cmd_bg_1:background_command_failed', testDb)).not.toBeNull();
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
  });

  it('STALE envelope → SKIP execution and mark COMPLETED (not failed), no executor call', async () => {
    const stale = taskCreateCommand({ expiresAt: new Date(NOW.getTime() - 1000).toISOString() });
    enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.create',
      command: stale, turnId: 'turn_1', env: { ...ENABLED_ENV }, db: testDb,
    });
    const result = await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    expect(result.outcome).toBe('stale_completed');
    // Lifecycle terminal is EXPIRED (valid pending→expired edge); the QUEUE row
    // is marked completed (no retry, no failure).
    expect(result.finalState).toBe('expired');
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(mockSendPushNotification).not.toHaveBeenCalled();
    expect(getChatV2CommandEventById('cmd_bg_1:background_stale_rejected', testDb)).not.toBeNull();
  });

  it('escalation_35b path asserts keep-alive=300 (B8)', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('planner_escalation');
    const result = await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    expect(result.escalationKeepAliveSeconds).toBe(300);
    const event = getChatV2CommandEventById('cmd_bg_1:background_execution_completed', testDb);
    expect(event!.metadata.escalationKeepAliveSeconds).toBe(300);
  });

  it('composer path does NOT pin the 35B residency', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('composer');
    const result = await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    expect(result.escalationKeepAliveSeconds).toBeUndefined();
  });

  it('processPendingJobs drives the registered handler to completion', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('composer');
    const summary = await processPendingJobs([chatCoreV2BackgroundCommandJobHandler], { db: testDb });
    expect(summary.completed).toBe(1);
    const status = testDb.prepare('SELECT status FROM background_jobs LIMIT 1').get() as { status: string };
    expect(status.status).toBe('completed');
  });

  it('processPendingJobs marks a STALE job completed (not failed) via the queue', async () => {
    // Absolute past date so staleness is unambiguous against the real wall clock
    // (processPendingJobs' handler uses new Date(), not the test NOW).
    const stale = taskCreateCommand({ expiresAt: '2000-01-01T00:00:00.000Z' });
    enqueueBackgroundChatCommand({
      tenantId: 7, userId: 7, jobType: 'composer', capabilityId: 'tasks.create',
      command: stale, turnId: 'turn_1', env: { ...ENABLED_ENV }, db: testDb,
    });
    const summary = await processPendingJobs([chatCoreV2BackgroundCommandJobHandler], { db: testDb });
    expect(summary.completed).toBe(1);
    expect(summary.failed).toBe(0);
    const status = testDb.prepare('SELECT status FROM background_jobs LIMIT 1').get() as { status: string };
    expect(status.status).toBe('completed');
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it('processPendingJobs marks a failing job failed, then dead-letters after max attempts', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: false, status: 'failed', reason: 'execution_failed', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true } });
    enqueueJobFor('composer');
    // First pass → failed (attempt 1 of 3).
    const first = await processPendingJobs([chatCoreV2BackgroundCommandJobHandler], { db: testDb });
    expect(first.failed + first.deadLetter).toBe(1);
    // Force dead-letter by exhausting attempts directly.
    const jobId = (testDb.prepare('SELECT job_id FROM background_jobs LIMIT 1').get() as { job_id: string }).job_id;
    testDb.prepare("UPDATE background_jobs SET attempts = max_attempts, status='failed', not_before=datetime('now','-1 minute') WHERE job_id = ?").run(jobId);
    const status = markJobFailed(jobId, new Error('boom'), testDb);
    expect(status).toBe('dead_letter');
  });

  it('isolates tenants: a job for tenant 7 records events scoped to tenant 7 only', async () => {
    mockExecuteCommand.mockResolvedValue({ ok: true, status: 'verified', commandId: 'cmd_bg_1', executorVersion: 'v', gateVerdict: { ok: true }, response: { text: 'done', cards: [], reasonCodes: [], schemaVersion: 'v', kind: 'command_result', locale: 'en' } });
    enqueueJobFor('composer');
    await processBackgroundChatCommandJob(claimOne(), { now: NOW });
    const events = testDb.prepare('SELECT DISTINCT tenant_id FROM chat_v2_command_events').all() as { tenant_id: string }[];
    expect(events).toEqual([{ tenant_id: '7' }]);
  });
});

// ── shouldBackgroundQueueChatCoreV2Command (route predicate) ─────────────────
describe('shouldBackgroundQueueChatCoreV2Command (default-off route predicate)', () => {
  it('is false with the default env (inert)', () => {
    expect(shouldBackgroundQueueChatCoreV2Command({ tenantId: 7, jobType: 'composer', env: {} })).toBe(false);
  });
  it('is true only when write execution on + canary/on + not killed + executable jobType', () => {
    expect(shouldBackgroundQueueChatCoreV2Command({ tenantId: 7, jobType: 'composer', env: { ...ENABLED_ENV } })).toBe(true);
    expect(shouldBackgroundQueueChatCoreV2Command({ tenantId: 7, jobType: 'critic', env: { ...ENABLED_ENV } })).toBe(false);
  });
  it('is false when this tenant is per-tenant-killed', () => {
    setChatCoreV2RuntimeOverride('7', { mode: 'off' });
    expect(shouldBackgroundQueueChatCoreV2Command({ tenantId: 7, jobType: 'composer', env: { ...ENABLED_ENV } })).toBe(false);
  });
});

// ── Action-gateway queued_background variant ────────────────────────────────
describe('buildChatCoreV2QueuedBackgroundResult (additive gateway variant)', () => {
  it('converts a resolved_execute into queued_background without re-running the firewall', () => {
    const resolved = {
      kind: 'resolved_execute' as const,
      command: taskCreateCommand(),
      preview: { command: taskCreateCommand(), capabilityId: 'tasks.create' } as never,
      writeRiskPolicy: { riskClass: 'A' as const, requires3BCritic: false, requires35BOrBackground: false, escalationReasons: [] },
      telemetry: makeTelemetry(),
    };
    const queued = buildChatCoreV2QueuedBackgroundResult(resolved, 'job_123');
    expect(queued.kind).toBe('queued_background');
    expect(queued.jobId).toBe('job_123');
    expect(queued.command).toBe(resolved.command);
    expect(queued.telemetry.finalOutcome).toBe('queued_background');
    expect(queued.telemetry.verificationStatus).toBe('pending');
    expect(queued.telemetry.reasonCodes).toContain('queued_background');
  });
});
