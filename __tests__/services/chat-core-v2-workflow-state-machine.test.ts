import { describe, expect, it } from 'vitest';

import {
  applyWorkflowTransition,
  evaluateWorkflowTransition,
  isTerminalWorkflowStatus,
  listAllowedWorkflowEvents,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 workflow state machine', () => {
  it('supports the normal preview-confirm-execute-verify path', () => {
    const previewed = applyWorkflowTransition('draft', 'preview_created');
    const awaitingConfirmation = applyWorkflowTransition(previewed, 'user_confirmation_requested');
    const queued = applyWorkflowTransition(awaitingConfirmation, 'user_confirmed');
    const running = applyWorkflowTransition(queued, 'started');
    const verifying = applyWorkflowTransition(running, 'verification_started');
    const completed = applyWorkflowTransition(verifying, 'verification_succeeded', {
      verificationMode: 'immediate_read_back',
    });

    expect(completed).toBe('completed');
  });

  it('routes human-review workflows through review approval before queueing', () => {
    expect(evaluateWorkflowTransition('previewed', 'user_confirmed', {
      requiresHumanReview: true,
    })).toEqual({
      allowed: false,
      stateMachineVersion: 'chat_core_v2_workflow_state_machine@1.0.0',
      from: 'previewed',
      event: 'user_confirmed',
      reason: 'human_review_required',
    });

    expect(applyWorkflowTransition('previewed', 'human_review_requested')).toBe('awaiting_human_review');
    expect(applyWorkflowTransition('awaiting_human_review', 'human_review_approved')).toBe('queued');
  });

  it('supports external-provider waits, retries, and timeout states', () => {
    const waiting = applyWorkflowTransition('running', 'external_wait_started');
    const retrying = applyWorkflowTransition(waiting, 'retry_scheduled');
    const runningAgain = applyWorkflowTransition(retrying, 'retry_started');
    const timedOut = applyWorkflowTransition(runningAgain, 'timed_out');

    expect(waiting).toBe('waiting_external_provider');
    expect(retrying).toBe('retrying');
    expect(runningAgain).toBe('running');
    expect(timedOut).toBe('timed_out');
    expect(isTerminalWorkflowStatus(timedOut)).toBe(true);
  });

  it('rejects unsupported transitions and terminal-state changes', () => {
    expect(evaluateWorkflowTransition('draft', 'verification_succeeded')).toMatchObject({
      allowed: false,
      reason: 'unsupported_transition',
    });
    expect(evaluateWorkflowTransition('completed', 'retry_scheduled')).toMatchObject({
      allowed: false,
      reason: 'terminal_state',
    });
    expect(() => applyWorkflowTransition('completed', 'retry_scheduled')).toThrow(/Unsupported Chat Core v2 workflow transition/);
  });

  it('requires explicit verification before immediate-read-back workflows can complete from running', () => {
    expect(evaluateWorkflowTransition('running', 'verification_succeeded', {
      verificationMode: 'immediate_read_back',
    })).toMatchObject({
      allowed: false,
      reason: 'verification_required',
    });

    expect(evaluateWorkflowTransition('running', 'verification_succeeded', {
      verificationMode: 'not_verifiable',
    })).toMatchObject({
      allowed: true,
      to: 'completed',
    });
  });

  it('lists only currently allowed events after policy filters are applied', () => {
    expect(listAllowedWorkflowEvents('previewed')).toContain('user_confirmed');
    expect(listAllowedWorkflowEvents('previewed', { requiresHumanReview: true })).not.toContain('user_confirmed');
    expect(listAllowedWorkflowEvents('completed')).toEqual([]);
  });

  it('marks all final outcomes as terminal', () => {
    for (const status of ['completed', 'partially_completed', 'failed', 'timed_out', 'cancelled', 'expired'] as const) {
      expect(isTerminalWorkflowStatus(status), status).toBe(true);
    }
    expect(isTerminalWorkflowStatus('verification_pending')).toBe(false);
  });
});
