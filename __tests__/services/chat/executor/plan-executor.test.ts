// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * M16 (multi-step upgrade) — plan-executor topological execution tests.
 *
 * Covers:
 *  - continue-on-independent-failure: a failed step blocks ONLY its
 *    dependents; independent branches keep executing (bounded sequential);
 *  - honest partial composition: mixed outcomes enumerate done/failed/
 *    blocked with per-branch reasons and never claim success for a blocked
 *    step;
 *  - M1/ADV-3 grant interaction: continue-on-failure never allows more
 *    destructive executions than previewed steps — the authorization
 *    context carries exactly one grant per previewed risky step;
 *  - multi-step confirmation previews enumerate the interpreted step list
 *    and disclose segment overflow.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/utils/logger', () => ({
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

// Persistence is exercised elsewhere (chat-action-planner-multi-step) —
// these tests focus on the execution loop, so persistence is inert.
vi.mock('../../../../src/services/chat/executor/run-persistence', () => ({
  persistPlanStatus: vi.fn(),
  persistStepStatus: vi.fn(),
  requeuePartialSuccessPendingParents: vi.fn(),
  rowToConfirmedStep: vi.fn(() => null),
}));

vi.mock('../../../../src/services/chat/executor/reliability', () => ({
  executeStepWithReliability: vi.fn(),
}));

import { executeChatActionPlan } from '../../../../src/services/chat/executor/plan-executor';
import { executeStepWithReliability } from '../../../../src/services/chat/executor/reliability';
import { getCurrentChatToolAuthorizationContext } from '../../../../src/services/chat-tool-authorization';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from '../../../../src/services/chat/types';

const executeStepMock = vi.mocked(executeStepWithReliability);

const INPUT: ChatPlannerInput = {
  text: 'synthetic multi-step',
  userId: 77,
  tenantId: 77,
  conversationId: 'conv-m16',
  messageId: 'msg-m16',
  channel: 'ios',
  locale: 'en-US',
  timezone: 'UTC',
  nowIso: '2026-07-20T12:00:00.000Z',
  persistRuns: false,
};

function makeStep(overrides: Partial<ChatPlanStep>): ChatPlanStep {
  return {
    stepId: 'step_x',
    skill: 'tasks',
    type: 'create_task',
    action: 'create_task',
    risk: 'safe_write',
    provider: 'nexus',
    args: {},
    requiredArgsPresent: true,
    idempotencyKey: `idem-${overrides.stepId ?? 'x'}`,
    verification: { required: false, method: 'none' },
    ...overrides,
  } as ChatPlanStep;
}

function makePlan(steps: ChatPlanStep[], overrides: Partial<ChatActionPlan> = {}): ChatActionPlan {
  return {
    schemaVersion: 1,
    userId: '77',
    tenantId: '77',
    conversationId: 'conv-m16',
    messageId: 'msg-m16',
    locale: 'en-US',
    timezone: 'UTC',
    channel: 'ios',
    createdAt: '2026-07-20T12:00:00.000Z',
    planner: 'mixed',
    steps,
    requiresConfirmation: false,
    confidence: 0.9,
    ...overrides,
  };
}

function scriptStepStatuses(statuses: Record<string, ChatStepExecutionResult['status']>): void {
  executeStepMock.mockImplementation(async (step) => {
    const status = statuses[step.stepId] ?? 'verified_success';
    return {
      step,
      status,
      ...(status === 'verified_success' ? { result: { task: { id: `id-${step.stepId}` } } } : {}),
      ...(status === 'failed' ? { error: 'task_create_failed' } : {}),
    };
  });
}

describe('M16 plan-executor topological execution', () => {
  beforeEach(() => {
    executeStepMock.mockReset();
  });

  it("runs 'A and B and C' as independent branches: B fails, A and C still complete, summary is honest", async () => {
    scriptStepStatuses({ step_1: 'verified_success', step_2: 'failed', step_3: 'verified_success' });
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'alpha' } }),
      makeStep({ stepId: 'step_2', args: { title: 'beta' } }),
      makeStep({ stepId: 'step_3', args: { title: 'gamma' } }),
    ]);

    const response = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });

    expect(executeStepMock).toHaveBeenCalledTimes(3);
    expect(response.metadata.actionStatus).toBe('partial_success');
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 2,
      failed: 1,
      blocked: 0,
    });
    // Honest per-branch enumeration; no success claim for the failed step.
    expect(response.text).toContain('2 of 3');
    expect(response.text).toContain('“alpha” — done and verified');
    expect(response.text).toContain('“beta” — failed');
    expect(response.text).toContain('“gamma” — done and verified');
  });

  it('blocks ONLY dependents of a failed step and reports the dependency reason', async () => {
    scriptStepStatuses({ step_1: 'failed', step_2: 'verified_success', step_3: 'verified_success' });
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'alpha' } }),
      // step_2 depends on step_1 -> blocked without executing.
      makeStep({ stepId: 'step_2', args: { title: 'beta' }, dependsOnStepIds: ['step_1'] }),
      // step_3 is independent -> executes.
      makeStep({ stepId: 'step_3', args: { title: 'gamma' } }),
    ]);

    const response = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });

    expect(executeStepMock.mock.calls.map(([step]) => step.stepId)).toEqual(['step_1', 'step_3']);
    expect(response.metadata.multiStepSummary).toMatchObject({
      totalSteps: 3,
      succeeded: 1,
      failed: 1,
      blocked: 1,
      perStep: [
        { stepId: 'step_1', status: 'failed' },
        { stepId: 'step_2', status: 'blocked', error: 'dependency_failed' },
        { stepId: 'step_3', status: 'verified_success' },
      ],
    });
    expect(response.metadata.actionStatus).toBe('partial_success');
    expect(response.text).toContain('not run (it depended on a step that failed)');
  });

  it('keeps the all-failure path a plain failure (no partial claim)', async () => {
    scriptStepStatuses({ step_1: 'failed' });
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'alpha' } }),
      makeStep({ stepId: 'step_2', args: { title: 'beta' }, dependsOnStepIds: ['step_1'] }),
    ]);

    const response = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });

    expect(response.metadata.actionStatus).toBe('failed');
    expect(response.metadata.multiStepSummary).toMatchObject({ succeeded: 0, failed: 1, blocked: 1 });
  });

  it('M1/ADV-3 interaction: grants stay capped at the previewed risky steps under continue-on-failure', async () => {
    const observedGrantCounts: Array<number | null> = [];
    const destructiveExecutions: string[] = [];
    executeStepMock.mockImplementation(async (step) => {
      const context = getCurrentChatToolAuthorizationContext();
      observedGrantCounts.push(context?.confirmedDestructiveTargets?.length ?? null);
      if (step.risk === 'destructive') destructiveExecutions.push(step.stepId);
      if (step.stepId === 'step_2') return { step, status: 'failed', error: 'task_create_failed' };
      return { step, status: 'verified_success', result: {} };
    });

    const plan = makePlan([
      makeStep({ stepId: 'step_1', action: 'delete_task', type: 'delete_task', risk: 'destructive', args: { taskId: 'task-1' } }),
      makeStep({ stepId: 'step_2', args: { title: 'beta' } }),
      makeStep({ stepId: 'step_3', skill: 'secretary_calendar', action: 'delete_event', type: 'delete_event', risk: 'destructive', args: { eventId: 'evt-9' } }),
    ], { requiresConfirmation: true });

    const response = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });

    // The safe-write failure did not stop the independent destructive step,
    // and every execution ran inside an authorization context carrying
    // EXACTLY one grant per previewed risky step (2 destructive steps ->
    // 2 grants) — never a turn-wide blank check.
    expect(destructiveExecutions).toEqual(['step_1', 'step_3']);
    expect(observedGrantCounts).toEqual([2, 2, 2]);
    expect(destructiveExecutions.length).toBeLessThanOrEqual(2);
    expect(response.metadata.actionStatus).toBe('partial_success');
  });

  it('previews multi-step confirmations with the interpreted step list', async () => {
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'Buy milk' } }),
      makeStep({ stepId: 'step_2', action: 'complete_task', type: 'complete_task', args: { taskId: { $ref: 'step_1.result.task.id' } }, dependsOnStepIds: ['step_1'] }),
    ], { requiresConfirmation: true });

    const response = await executeChatActionPlan(plan, INPUT, {} as never, {});

    expect(executeStepMock).not.toHaveBeenCalled();
    expect(response.metadata.actionStatus).toBe('needs_confirmation');
    expect(response.text).toContain('I understood 2 steps:');
    expect(response.text).toContain('1. Create task “Buy milk”');
    expect(response.text).toContain('2. Complete the task created in the earlier step');
  });

  it('discloses segment overflow in the preview and in the executed answer', async () => {
    scriptStepStatuses({});
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'one' } }),
      makeStep({ stepId: 'step_2', args: { title: 'two' } }),
    ], { requiresConfirmation: true, multiStepOverflowCount: 2 });

    const preview = await executeChatActionPlan(plan, INPUT, {} as never, {});
    expect(preview.text).toContain("I found 4 requests; I'm only handling the first 2");

    const executed = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });
    expect(executed.metadata.actionStatus).toBe('verified_success');
    expect(executed.text).toContain("I found 4 requests; I'm only handling the first 2");
  });

  it('localizes the multi-step preview (PT)', async () => {
    const plan = makePlan([
      makeStep({ stepId: 'step_1', args: { title: 'comprar leite' } }),
      makeStep({ stepId: 'step_2', args: { title: 'ligar à mãe' } }),
    ], { requiresConfirmation: true, locale: 'pt-BR' });

    const response = await executeChatActionPlan(plan, { ...INPUT, locale: 'pt-BR' }, {} as never, {});

    expect(response.metadata.actionStatus).toBe('needs_confirmation');
    expect(response.text).toContain('Interpretei 2 passos:');
    expect(response.text).toContain('1. Criar a tarefa “comprar leite”');
  });

  it('still stops the whole run when a step needs a mid-run user decision', async () => {
    executeStepMock.mockImplementation(async (step) => (
      step.stepId === 'step_1'
        ? { step, status: 'needs_confirmation', error: 'calendar_conflict' }
        : { step, status: 'verified_success', result: {} }
    ));
    const plan = makePlan([
      makeStep({ stepId: 'step_1', skill: 'secretary_calendar', action: 'schedule_event', type: 'schedule_event', args: { title: 'standup' } }),
      makeStep({ stepId: 'step_2', args: { title: 'beta' } }),
    ]);

    const response = await executeChatActionPlan(plan, INPUT, {} as never, { confirmed: true });

    expect(executeStepMock.mock.calls.map(([step]) => step.stepId)).toEqual(['step_1']);
    expect(response.metadata.actionStatus).toBe('needs_confirmation');
  });
});
