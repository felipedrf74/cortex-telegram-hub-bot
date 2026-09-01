import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../src/services/chat/types';

const mocks = vi.hoisted(() => ({
  getDecisionItem: vi.fn(),
  performDecisionAction: vi.fn(),
  updateChatActionRun: vi.fn(),
  claimActionRunForStepExecution: vi.fn(() => null),
  reconciliationPendingResult: vi.fn((step: ChatPlanStep, status: string) => ({
    step,
    status: 'verified_pending',
    error: `reconciliation_${status}`,
  })),
  replayDuplicateClaimedActionRun: vi.fn((..._args: unknown[]): any => null),
  updateClaimedActionRun: vi.fn(() => true),
  withProviderWriteTimeout: vi.fn(async (operation: Promise<unknown>) => operation),
}));

vi.mock('../../src/services/decision-center', () => ({
  getDecisionItem: (...args: unknown[]) => mocks.getDecisionItem(...args),
  performDecisionAction: (...args: unknown[]) => mocks.performDecisionAction(...args),
}));

vi.mock('../../src/services/chat-action-run-store', () => ({
  updateChatActionRun: (...args: unknown[]) => mocks.updateChatActionRun(...args),
}));

vi.mock('../../src/services/chat/executor/helpers', () => ({
  claimActionRunForStepExecution: (...args: unknown[]) => mocks.claimActionRunForStepExecution(...args),
  reconciliationPendingResult: (...args: unknown[]) => mocks.reconciliationPendingResult(...args as [ChatPlanStep, string]),
  replayDuplicateClaimedActionRun: (...args: unknown[]) => mocks.replayDuplicateClaimedActionRun(...args),
  updateClaimedActionRun: (...args: unknown[]) => mocks.updateClaimedActionRun(...args),
  withProviderWriteTimeout: (...args: unknown[]) => mocks.withProviderWriteTimeout(...args as [Promise<unknown>]),
}));

import { executeDecisionCenterStep } from '../../src/services/skills/decision_center/executor';

const CURRENT_ITEM = {
  decisionId: 'dc_1',
  recordVersion: 7,
  contextVersion: 'ctx_7',
  options: [
    {
      optionId: 'slot_early',
      actionId: 'choose_another_time',
      actionPayload: {
        startAt: '2026-10-26T09:00:00.000Z',
        endAt: '2026-10-26T10:00:00.000Z',
      },
    },
    {
      optionId: 'keep_current',
      actionId: 'keep_existing_commitment',
    },
  ],
  actions: [
    { id: 'choose_another_time' },
    { id: 'keep_existing_commitment' },
    { id: 'dismiss' },
    { id: 'snooze' },
  ],
};

const INPUT: ChatPlannerInput = {
  text: 'choose A',
  userId: 7,
  tenantId: 11,
  conversationId: 'conversation_1',
  messageId: 'message_1',
  channel: 'ios',
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
};

const PLAN: ChatActionPlan = {
  schemaVersion: 1,
  userId: '7',
  tenantId: '11',
  conversationId: 'conversation_1',
  messageId: 'message_1',
  locale: 'en-US',
  timezone: 'Europe/Lisbon',
  channel: 'ios',
  createdAt: '2026-08-30T09:00:00.000Z',
  planner: 'deterministic',
  steps: [],
  requiresConfirmation: false,
  confidence: 1,
};

function step(action: ChatPlanStep['action'], args: Record<string, unknown>): ChatPlanStep {
  return {
    stepId: `step_${action}`,
    skill: 'decision_center',
    type: action,
    action,
    risk: 'safe_write',
    args: { decisionId: 'dc_1', ...args },
    requiredArgsPresent: true,
    idempotencyKey: `idem_${action}`,
    verification: { required: true, method: 'local_read_back' },
  };
}

describe('Decision Center chat executor', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockClear();
    mocks.claimActionRunForStepExecution.mockReturnValue(null);
    mocks.replayDuplicateClaimedActionRun.mockReturnValue(null);
    mocks.updateClaimedActionRun.mockReturnValue(true);
    mocks.withProviderWriteTimeout.mockImplementation(async (operation: Promise<unknown>) => operation);
    mocks.getDecisionItem.mockReturnValue(CURRENT_ITEM);
    mocks.performDecisionAction.mockImplementation(async (_decisionId: string, actionId: string) => ({
      actionId,
      status: 'succeeded',
      idempotent: false,
      item: { ...CURRENT_ITEM, status: 'actioned' },
      verification: {
        readBackOk: true,
        expectedEffect: {},
        actualEffect: {},
        message: 'verified',
      },
    }));
  });

  it.each([
    ['A', 'choose_another_time', {
      startAt: '2026-10-26T09:00:00.000Z',
      endAt: '2026-10-26T10:00:00.000Z',
    }],
    ['1', 'choose_another_time', {
      startAt: '2026-10-26T09:00:00.000Z',
      endAt: '2026-10-26T10:00:00.000Z',
    }],
    ['B', 'keep_existing_commitment', {}],
    ['2', 'keep_existing_commitment', {}],
  ])('resolves alias %s against the exact current server option', async (choice, actionId, payload) => {
    const selected = step('decision_choose', {
      choice,
      payload: { startAt: 'attacker-authored-retarget' },
    });
    const outcome = await executeDecisionCenterStep(selected, PLAN, INPUT, false);

    expect(outcome.status).toBe('verified_success');
    expect(mocks.getDecisionItem).toHaveBeenCalledWith('dc_1', 7, 11);
    expect(mocks.performDecisionAction).toHaveBeenCalledWith('dc_1', actionId, 7, 11, {
      idempotencyKey: 'idem_decision_choose',
      payload,
      channel: 'chat',
      expectedVersion: 7,
      contextVersion: 'ctx_7',
    });
    expect(mocks.getDecisionItem.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.performDecisionAction.mock.invocationCallOrder[0]);
  });

  it('fails closed when an alias is not declared by the current item', async () => {
    const outcome = await executeDecisionCenterStep(
      step('decision_choose', { choice: 'option_z' }),
      PLAN,
      INPUT,
      false,
    );

    expect(outcome).toMatchObject({ status: 'blocked', error: 'decision_choice_not_available' });
    expect(mocks.performDecisionAction).not.toHaveBeenCalled();
    expect(mocks.updateClaimedActionRun).toHaveBeenCalledWith(null, 'blocked', {
      error: { code: 'decision_choice_not_available' },
    });
  });

  it('routes dismiss through the replay-safe mutation contract and trusts its readback', async () => {
    const outcome = await executeDecisionCenterStep(step('decision_dismiss', {}), PLAN, INPUT, false);

    expect(outcome.status).toBe('verified_success');
    expect(mocks.performDecisionAction).toHaveBeenCalledWith('dc_1', 'dismiss', 7, 11, {
      idempotencyKey: 'idem_decision_dismiss',
      payload: {},
      channel: 'chat',
      expectedVersion: 7,
      contextVersion: 'ctx_7',
    });
    // A dismissed item may leave the active list; verification comes from the
    // action-specific performDecisionAction readback, not a second list read.
    expect(mocks.getDecisionItem).toHaveBeenCalledTimes(1);
  });

  it('routes snooze through the replay-safe contract with the requested absolute time', async () => {
    const until = '2026-09-07T09:00:00+01:00';
    const outcome = await executeDecisionCenterStep(
      step('decision_snooze', { until, minutes: 999 }),
      PLAN,
      INPUT,
      false,
    );

    expect(outcome.status).toBe('verified_success');
    expect(mocks.performDecisionAction).toHaveBeenCalledWith('dc_1', 'snooze', 7, 11, {
      idempotencyKey: 'idem_decision_snooze',
      payload: { deferUntil: until },
      channel: 'chat',
      expectedVersion: 7,
      contextVersion: 'ctx_7',
    });
  });

  it('routes follow-up through the timezone-aware next-week snooze contract', async () => {
    const outcome = await executeDecisionCenterStep(
      step('decision_follow_up', { followUp: 'next week' }),
      PLAN,
      INPUT,
      false,
    );

    expect(outcome.status).toBe('verified_success');
    expect(mocks.performDecisionAction).toHaveBeenCalledWith('dc_1', 'snooze', 7, 11, {
      idempotencyKey: 'idem_decision_follow_up',
      payload: { followUp: 'next week' },
      channel: 'chat',
      expectedVersion: 7,
      contextVersion: 'ctx_7',
    });
  });

  it('never re-executes a duplicate action-run claim that is already in progress', async () => {
    const selected = step('decision_dismiss', {});
    const replayed = {
      step: selected,
      status: 'verified_pending',
      error: 'idempotent_retry_already_in_progress',
      result: { replayed: true, currentStatus: 'executing' },
    };
    mocks.claimActionRunForStepExecution.mockReturnValue({
      acquired: false,
      row: { id: 'run_1', status: 'executing' },
    } as never);
    mocks.replayDuplicateClaimedActionRun.mockReturnValue(replayed);

    const outcome = await executeDecisionCenterStep(selected, PLAN, INPUT, true);

    expect(outcome).toBe(replayed);
    expect(mocks.getDecisionItem).not.toHaveBeenCalled();
    expect(mocks.performDecisionAction).not.toHaveBeenCalled();
  });

  it('records timeouts as reconcilable and promotes the late durable result', async () => {
    const selected = step('decision_dismiss', {});
    let resolveMutation!: (value: unknown) => void;
    mocks.claimActionRunForStepExecution.mockReturnValue({
      acquired: true,
      row: { id: 'run_timeout', status: 'executing', request_json: '{}' },
    } as never);
    mocks.performDecisionAction.mockReturnValueOnce(new Promise((resolve) => {
      resolveMutation = resolve;
    }));
    mocks.withProviderWriteTimeout.mockRejectedValueOnce(new Error('provider_write_timeout'));

    const outcome = await executeDecisionCenterStep(selected, PLAN, INPUT, true);

    expect(outcome).toMatchObject({
      status: 'verified_pending',
      error: 'decision_action_reconciliation_pending',
    });
    expect(mocks.updateClaimedActionRun).toHaveBeenCalledWith(
      expect.anything(),
      'executing',
      expect.objectContaining({ request: expect.objectContaining({
        commandType: 'decision_mutation',
        decisionId: 'dc_1',
        actionId: 'dismiss',
        expectedVersion: 7,
        contextVersion: 'ctx_7',
      }) }),
    );
    expect(mocks.updateClaimedActionRun).toHaveBeenCalledWith(
      expect.anything(),
      'verified_pending',
      expect.objectContaining({ verification: { verified: false, reconciliationPending: true } }),
    );

    resolveMutation({
      actionId: 'dismiss',
      status: 'succeeded',
      idempotent: false,
      item: { ...CURRENT_ITEM, status: 'dismissed' },
      verification: { readBackOk: true, expectedEffect: {}, actualEffect: {}, message: 'verified' },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.updateClaimedActionRun).toHaveBeenCalledWith(
      expect.anything(),
      'verified_success',
      expect.objectContaining({ verification: { verified: true } }),
    );
  });

  it('reconciles a persisted pending command with its original versions', async () => {
    const selected = step('decision_dismiss', {});
    mocks.claimActionRunForStepExecution.mockReturnValue({
      acquired: false,
      row: {
        id: 'run_pending',
        status: 'verified_pending',
        request_json: JSON.stringify({
          schemaVersion: 1,
          commandType: 'decision_mutation',
          decisionId: 'dc_1',
          actionId: 'dismiss',
          idempotencyKey: 'idem_decision_dismiss',
          payload: {},
          expectedVersion: 4,
          contextVersion: 'ctx_original',
        }),
      },
    } as never);

    const outcome = await executeDecisionCenterStep(selected, PLAN, INPUT, true);

    expect(outcome.status).toBe('verified_success');
    expect(mocks.getDecisionItem).not.toHaveBeenCalled();
    expect(mocks.replayDuplicateClaimedActionRun).not.toHaveBeenCalled();
    expect(mocks.performDecisionAction).toHaveBeenCalledWith('dc_1', 'dismiss', 7, 11, {
      idempotencyKey: 'idem_decision_dismiss',
      payload: {},
      channel: 'chat',
      expectedVersion: 4,
      contextVersion: 'ctx_original',
    });
  });

  it('reports partial success when action-specific readback is not verified', async () => {
    mocks.performDecisionAction.mockResolvedValueOnce({
      actionId: 'dismiss',
      status: 'succeeded',
      idempotent: false,
      item: { ...CURRENT_ITEM, status: 'actioned' },
      verification: { readBackOk: false, expectedEffect: {}, actualEffect: {}, message: 'mismatch' },
    });

    const outcome = await executeDecisionCenterStep(step('decision_dismiss', {}), PLAN, INPUT, false);
    expect(outcome).toMatchObject({ status: 'partial_success', error: 'local_read_back_mismatch' });
  });
});
