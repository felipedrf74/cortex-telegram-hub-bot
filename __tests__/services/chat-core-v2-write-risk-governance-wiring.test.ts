// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import {
  assessCommandWriteRisk,
  classifyCommandEscalationReasons,
  classifyCommandWriteRisk,
} from '../../src/services/chat-core-v2/write-risk-policy';
import { assertChatCoreV2ReadbackVerificationContract } from '../../src/services/chat-core-v2/command-executor';
import {
  ensureChatCoreV2HumanReviewTables,
  getChatV2HumanReviewById,
} from '../../src/services/chat-core-v2/human-review-queue';
import {
  chatV2HumanReviewIdForCommand,
  enqueueChatV2HumanReviewForWriteRisk,
  notifyOperatorOfHumanReview,
  _resetChatV2HumanReviewNotificationDedupForTests,
} from '../../src/services/chat-core-v2/human-review-notification';

// ---------------------------------------------------------------------------
// The action gateway test exercises the firewall threading. We mock the command
// preview route so we can drive a finance (Class C), training-plan (Class C),
// restricted (Class C), and an ordinary tasks (Class A) command through the
// gateway without standing up the full resolver.
// ---------------------------------------------------------------------------

const previewByCapability: Record<string, {
  capabilityId: string;
  commandType: string;
  domain: string;
} | undefined> = {
  'restricted-finance': { capabilityId: 'finance.payment_or_tax_action_blocked', commandType: 'finance.execute_restricted', domain: 'finance' },
  'training-plan': { capabilityId: 'training.modify_session_preview', commandType: 'training.plan_rewrite', domain: 'training' },
  'tasks-create': { capabilityId: 'tasks.create', commandType: 'tasks.create', domain: 'tasks' },
};

vi.mock('../../src/services/chat-core-v2/command-preview-route', () => ({
  tryBuildChatCoreV2CommandPreviewRoute: vi.fn((input: { normalizedText: string }) => {
    let key: string | null = null;
    if (input.normalizedText.includes('finance-write')) key = 'restricted-finance';
    else if (input.normalizedText.includes('training-plan-write')) key = 'training-plan';
    else if (input.normalizedText.includes('tasks-write')) key = 'tasks-create';
    if (!key) return null;
    const spec = previewByCapability[key]!;
    return {
      routeVersion: 'test',
      capabilityId: spec.capabilityId,
      routeGuess: { intent: 'create_action', domains: [spec.domain], capabilityIds: [spec.capabilityId] },
      command: {
        commandId: `cmd-${key}`,
        idempotencyKey: `idem-${key}`,
        commandType: spec.commandType,
        domain: spec.domain,
        basedOn: { entityIds: [`${spec.domain}:1`] },
      },
      gateVerdict: { ok: true },
      response: {},
      executionEnabled: true,
    };
  }),
}));

// Force the write-intent probe to detect a mutation for our test strings.
vi.mock('../../src/services/chat-core-v2/shadow-route-classifier', () => ({
  classifyShadowRoute: vi.fn(() => ({
    intent: 'create_action',
    domains: ['tasks'],
    capabilityIds: ['tasks.create'],
  })),
}));

import { runChatCoreV2ActionGateway } from '../../src/services/chat-core-v2/action-gateway';

const enforceEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  CHAT_CORE_V2_ACTION_GATEWAY_MODE: 'enforce',
  CHAT_CORE_V2_LEGACY_WRITE_FALLTHROUGH_BLOCK: 'on',
  CHAT_CORE_V2_WRITE_INTENT_HASH_SECRET: 'test-secret',
  ...overrides,
} as NodeJS.ProcessEnv);

const baseGatewayInput = (normalizedText: string, env: NodeJS.ProcessEnv) => ({
  requestId: 'req-1',
  normalizedText,
  userId: 42,
  tenantId: 84,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  locale: 'en',
  timezone: 'Europe/Lisbon',
  now: new Date('2026-05-30T12:00:00.000Z'),
  env,
});

describe('WP-10 write-risk classification (pure)', () => {
  it('classifies finance writes as Class C regardless of capability risk', () => {
    expect(classifyCommandWriteRisk('finance.execute_restricted', 'finance', 'low')).toBe('C');
    expect(classifyCommandWriteRisk('finance.transfer', 'finance', 'medium')).toBe('C');
  });

  it('classifies a training PLAN write as Class C, but a non-plan training write is not', () => {
    expect(classifyCommandWriteRisk('training.plan_rewrite', 'training', 'low')).toBe('C');
    expect(classifyCommandWriteRisk('training.generate_plan', 'training', 'medium')).toBe('C');
    // A single-session modify is not auto-promoted to C by the training domain alone.
    expect(classifyCommandWriteRisk('training.modify_session', 'training', 'low')).toBe('A');
  });

  it('classifies a restricted capability as Class C', () => {
    expect(classifyCommandWriteRisk('content.publish', 'content', 'restricted')).toBe('C');
  });

  it('classifies a high-risk capability as Class B', () => {
    expect(classifyCommandWriteRisk('content.publish', 'content', 'high')).toBe('B');
  });

  it('classifies everything else as Class A', () => {
    expect(classifyCommandWriteRisk('tasks.create', 'tasks', 'low')).toBe('A');
    expect(classifyCommandWriteRisk('notifications.snooze', 'notifications', 'medium')).toBe('A');
    expect(classifyCommandWriteRisk('cooking.grocery_item', 'cooking', 'low')).toBe('A');
  });

  it('emits escalation reasons for finance and training-plan writes only', () => {
    expect(classifyCommandEscalationReasons('finance.execute_restricted', 'finance', 'low'))
      .toEqual(['financial_mutation']);
    expect(classifyCommandEscalationReasons('training.plan_rewrite', 'training', 'low'))
      .toEqual(['training_plan_over_7_days']);
    expect(classifyCommandEscalationReasons('tasks.create', 'tasks', 'low')).toEqual([]);
  });

  it('assessCommandWriteRisk composes class + policy + escalation', () => {
    const finance = assessCommandWriteRisk({ commandType: 'finance.x', domain: 'finance', capability: 'low' });
    expect(finance.riskClass).toBe('C');
    expect(finance.policy.requires3BCritic).toBe(true);
    expect(finance.requires35BOrBackground).toBe(true);

    const high = assessCommandWriteRisk({ commandType: 'content.publish', domain: 'content', capability: 'high' });
    expect(high.riskClass).toBe('B');
    expect(high.policy.requires3BCritic).toBe(true);
    expect(high.requires35BOrBackground).toBe(false);

    const tasks = assessCommandWriteRisk({ commandType: 'tasks.create', domain: 'tasks', capability: 'low' });
    expect(tasks.riskClass).toBe('A');
    expect(tasks.policy.requires3BCritic).toBe(false);
    expect(tasks.requires35BOrBackground).toBe(false);
  });
});

describe('WP-10 action-gateway write-risk threading (firewall preserved)', () => {
  it('downgrades a Class-C (finance) resolved write to unsupported_write with no execute envelope', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput('finance-write please', enforceEnv({ CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true' })),
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('unsupported_write');
    if (result.kind !== 'unsupported_write') throw new Error('expected unsupported_write');
    expect(result.reason).toBe('write_risk_class_c_requires_human_review');
    expect(result.writeRiskPolicy?.riskClass).toBe('C');
    expect(result.writeRiskPolicy?.requires35BOrBackground).toBe(true);
    expect(result.telemetry.writeRiskClass).toBe('C');
    expect(result.humanReview).toEqual(expect.objectContaining({
      commandId: 'cmd-restricted-finance',
      tenantId: '84',
      userId: '42',
      domain: 'finance',
      reason: 'restricted_finance',
      sensitivity: 'financial',
      redactedSummary: expect.stringContaining('cmd-restricted-finance'),
      metadata: expect.objectContaining({
        capabilityId: 'finance.payment_or_tax_action_blocked',
        commandType: 'finance.execute_restricted',
        riskClass: 'C',
      }),
    }));
    expect(JSON.stringify(result.humanReview)).not.toContain('finance-write please');
    // No `command`/`preview` execute envelope leaks on an unsupported_write.
    expect('command' in result).toBe(false);
    expect('preview' in result).toBe(false);
  });

  it('downgrades a Class-C (training plan) resolved write to unsupported_write', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput('training-plan-write please', enforceEnv({ CHAT_CORE_V2_ALLOW_WRITE_EXECUTION: 'true' })),
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('unsupported_write');
    if (result.kind !== 'unsupported_write') throw new Error('expected unsupported_write');
    expect(result.writeRiskPolicy?.riskClass).toBe('C');
    expect(result.writeRiskPolicy?.escalationReasons).toContain('training_plan_over_7_days');
    expect(result.humanReview).toEqual(expect.objectContaining({
      commandId: 'cmd-training-plan',
      domain: 'training',
      reason: 'training_plan_rewrite',
      sensitivity: 'health_adjacent',
    }));
  });

  it('marks a Class-A tasks write as not requiring the 3B critic and resolves a preview', () => {
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput('tasks-write please', enforceEnv()),
      shouldAutoExecute: () => false,
    });

    expect(result.kind).toBe('resolved_preview');
    if (result.kind !== 'resolved_preview') throw new Error('expected resolved_preview');
    expect(result.writeRiskPolicy.riskClass).toBe('A');
    expect(result.writeRiskPolicy.requires3BCritic).toBe(false);
  });
});

describe('WP-10 ALLOW_WRITE_EXECUTION gate blocks ONLY execution (firewall intact)', () => {
  it('with execution DISABLED, an auto-executable write still resolves a PREVIEW (firewall preview path intact)', () => {
    // Execution gate off (default). A resolvable Class-A write that wants to
    // auto-execute is downgraded to a preview — NOT to no_write_intent, and the
    // command is still resolved through the firewall.
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput('tasks-write please', enforceEnv()),
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('resolved_preview');
    if (result.kind !== 'resolved_preview') throw new Error('expected resolved_preview');
    expect(result.command.commandId).toBe('cmd-tasks-create');
    expect(result.telemetry.writeExecutionGateBlocked).toBe(true);
    expect(result.telemetry.finalOutcome).toBe('resolved_preview');
    expect(result.telemetry.reasonCodes).toContain('write_execution_disabled');
  });

  it('with explicit full mode, the same write resolves an EXECUTE envelope', () => {
    // allowWriteExecution is resolved through resolveChatCoreV2ActivationConfig
    // (WP-00.5/WP-18). Mode=on is an explicit promotion action and defaults
    // write execution on; an explicit CHAT_CORE_V2_ALLOW_WRITE_EXECUTION=false
    // still narrows it back to preview.
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput('tasks-write please', enforceEnv({
        CHAT_CORE_V2_ORCHESTRATOR_MODE: 'on',
      })),
      shouldAutoExecute: () => true,
    });

    expect(result.kind).toBe('resolved_execute');
    if (result.kind !== 'resolved_execute') throw new Error('expected resolved_execute');
    expect(result.telemetry.writeExecutionGateBlocked).toBe(false);
    expect(result.telemetry.finalOutcome).toBe('resolved_execute');
  });

  it('the execution gate does NOT disable the firewall: a negated write is still blocked when execution is disabled', () => {
    // Execution gate off; a negated/hypothetical write must still be caught by
    // the firewall (unsupported_write), not silently passed through.
    const result = runChatCoreV2ActionGateway({
      ...baseGatewayInput("Don't mark comprar suplementos task as done", enforceEnv()),
    });

    expect(result.kind).toBe('unsupported_write');
    if (result.kind !== 'unsupported_write') throw new Error('expected unsupported_write');
    expect(result.reason).toBe('write_intent_negated_or_hypothetical');
    expect(result.telemetry.legacyFallbackBlocked).toBe(true);
  });
});

describe('WP-10 command-executor read-back verification contract', () => {
  it('asserts requiresReadbackVerification holds for every executable sync command', () => {
    expect(assertChatCoreV2ReadbackVerificationContract()).toBe(true);
  });
});

describe('WP-10 human-review enqueue (deterministic id, upsert)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatCoreV2HumanReviewTables(db);
    _resetChatV2HumanReviewNotificationDedupForTests();
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
  });

  const reviewInput = (overrides: Record<string, unknown> = {}) => ({
    commandId: 'cmd-finance-1',
    turnId: 'turn-1',
    tenantId: 'tenant-1',
    userId: 'user-1',
    domain: 'finance' as const,
    reason: 'restricted_finance' as const,
    sensitivity: 'financial' as const,
    redactedSummary: 'finance.execute_restricted cmd-finance-1',
    requestedAt: '2026-05-30T12:00:00.000Z',
    ...overrides,
  });

  it('enqueues with a deterministic reviewId hvr:${commandId}', async () => {
    const result = await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });

    expect(result.reviewId).toBe('hvr:cmd-finance-1');
    expect(chatV2HumanReviewIdForCommand('cmd-finance-1')).toBe('hvr:cmd-finance-1');
    expect(result.newlyEnqueued).toBe(true);
    expect(getChatV2HumanReviewById('hvr:cmd-finance-1', db)?.status).toBe('pending');
  });

  it('upserts on the same commandId (one row, second enqueue is not newly-enqueued)', async () => {
    await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });
    const second = await enqueueChatV2HumanReviewForWriteRisk(
      reviewInput({ redactedSummary: 'finance.execute_restricted cmd-finance-1 (retry)' }),
      { db },
    );

    const count = db.prepare('SELECT COUNT(*) AS count FROM chat_v2_human_reviews WHERE review_id = ?')
      .get('hvr:cmd-finance-1') as { count: number };
    expect(count.count).toBe(1);
    expect(second.newlyEnqueued).toBe(false);
    expect(getChatV2HumanReviewById('hvr:cmd-finance-1', db)?.redactedSummary)
      .toBe('finance.execute_restricted cmd-finance-1 (retry)');
  });
});

describe('WP-10 operator notification (exactly once, non-fatal, no PII)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    ensureChatCoreV2HumanReviewTables(db);
    _resetChatV2HumanReviewNotificationDedupForTests();
    process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'https://pager.example.com/hook';
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
  });

  const reviewInput = (overrides: Record<string, unknown> = {}) => ({
    commandId: 'cmd-finance-2',
    turnId: 'turn-2',
    tenantId: 'tenant-secret-99',
    userId: 'user-secret-77',
    domain: 'finance' as const,
    reason: 'restricted_finance' as const,
    sensitivity: 'financial' as const,
    redactedSummary: 'finance.execute_restricted cmd-finance-2',
    requestedAt: '2026-05-30T12:00:00.000Z',
    ...overrides,
  });

  it('fires the operator notification EXACTLY ONCE per newly-enqueued review (none on upsert)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    const first = await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });
    const second = await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });

    expect(first.notified).toBe(true);
    expect(second.notified).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('notification carries ONLY redacted_summary/domain/reason/reviewId — NO payload PII', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));

    expect(body).toMatchObject({
      event: 'chat_core_v2_human_review_enqueued',
      reviewId: 'hvr:cmd-finance-2',
      domain: 'finance',
      reason: 'restricted_finance',
      redactedSummary: 'finance.execute_restricted cmd-finance-2',
    });
    // No raw tenant/user id, no message text, no payload fields.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('tenant-secret-99');
    expect(serialized).not.toContain('user-secret-77');
    expect(serialized).not.toContain('turn-2');
    expect(body).not.toHaveProperty('tenantId');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('payload');
  });

  it('is non-fatal when the pager transport throws (enqueue still succeeds)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await enqueueChatV2HumanReviewForWriteRisk(reviewInput(), { db });

    expect(result.newlyEnqueued).toBe(true);
    expect(result.notified).toBe(true); // a dispatch was attempted (and swallowed)
    expect(getChatV2HumanReviewById('hvr:cmd-finance-2', db)?.status).toBe('pending');
  });

  it('does not page over a non-https endpoint (https-only guard)', async () => {
    process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL = 'http://pager.example.com/hook';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await notifyOperatorOfHumanReview({
      reviewId: 'hvr:cmd-finance-2',
      domain: 'finance',
      reason: 'restricted_finance',
      redactedSummary: 'finance.execute_restricted cmd-finance-2',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op (no throw, no fetch) when the pager URL is absent', async () => {
    delete process.env.CHAT_CORE_V2_PAGER_WEBHOOK_URL;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );

    await expect(notifyOperatorOfHumanReview({
      reviewId: 'hvr:x',
      domain: 'finance',
      reason: 'restricted_finance',
      redactedSummary: 'finance.x x',
    })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
