// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getDecisionItem, performDecisionAction } from '../../decision-center';
import { resolveDecisionChoice } from '../../decision-center/action-resolution';
import {
  claimActionRunForStepExecution,
  reconciliationPendingResult,
  replayDuplicateClaimedActionRun,
  updateClaimedActionRun,
  withProviderWriteTimeout,
  type ClaimedActionRun,
} from '../../chat/executor/helpers';

interface DecisionChatMutationCommand {
  schemaVersion: 1;
  commandType: 'decision_mutation';
  decisionId: string;
  actionId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  expectedVersion?: number;
  contextVersion?: string;
}

type DecisionChatMutationExecutionCommand = DecisionChatMutationCommand & {
  reconciliationAttemptId: string;
};

export async function executeDecisionCenterStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const decisionId = typeof args.decisionId === 'string' ? args.decisionId.trim() : '';
  if (!decisionId) return { step, status: 'blocked', error: 'decision_id_required' };
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  if (claim && !claim.acquired && claim.row.status === 'verified_pending') {
    const pending = parsePendingDecisionCommand(claim.row.request_json);
    if (pending && pending.decisionId === decisionId && pending.idempotencyKey === step.idempotencyKey) {
      return executeDecisionMutation(pending, step, claim, input);
    }
  }
  const replay = replayDuplicateClaimedActionRun(claim, step);
  if (replay) return replay;
  try {
    const mutation = step.action === 'decision_dismiss'
      || step.action === 'decision_snooze'
      || step.action === 'decision_follow_up'
      || step.action === 'decision_choose';

    if (mutation) {
      // Exact scoped read first: presentation aliases and concurrency versions
      // must come from the current server item, never from chat/model payload.
      const current = getDecisionItem(decisionId, input.userId, input.tenantId);
      if (!current) return blockedDecisionStep(step, claim, 'decision_not_found');

      let actionId: string;
      let payload: Record<string, unknown>;
      if (step.action === 'decision_dismiss') {
        actionId = 'dismiss';
        payload = {};
      } else if (step.action === 'decision_snooze') {
        actionId = 'snooze';
        payload = snoozePayload(args);
      } else if (step.action === 'decision_follow_up') {
        actionId = 'snooze';
        payload = {
          followUp: typeof args.followUp === 'string' && args.followUp.trim()
            ? args.followUp.trim()
            : 'next week',
        };
      } else {
        const choice = typeof args.choice === 'string' ? args.choice : typeof args.actionId === 'string' ? args.actionId : '';
        if (!choice) return blockedDecisionStep(step, claim, 'decision_choice_required');
        const resolution = resolveDecisionChoice(current, choice);
        if (!resolution.ok) return blockedDecisionStep(step, claim, resolution.code.toLowerCase());
        actionId = resolution.value.actionId;
        // The option payload is authoritative. Deliberately ignore args.payload:
        // it can be model/client-authored and may target state the user did not review.
        payload = resolution.value.payload;
      }

      return executeDecisionMutation({
        schemaVersion: 1,
        commandType: 'decision_mutation',
        decisionId,
        actionId,
        idempotencyKey: step.idempotencyKey,
        payload,
        ...(Number.isSafeInteger(current.recordVersion) && current.recordVersion > 0
          ? { expectedVersion: current.recordVersion }
          : {}),
        ...(typeof current.contextVersion === 'string' && current.contextVersion.trim()
          ? { contextVersion: current.contextVersion }
          : {}),
      }, step, claim, input);
    }
    const result = getDecisionItem(decisionId, input.userId, input.tenantId);
    const readBack = getDecisionItem(decisionId, input.userId, input.tenantId);
    const verified = Boolean(readBack);
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const payload = { result, item: readBack, verified };
    if (!updateClaimedActionRun(claim, status, { result: payload, providerObjectId: decisionId, verification: { verified } })) {
      return reconciliationPendingResult(step, status);
    }
    return { step, status, result: payload, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', {
      expectedStatuses: ['executing'],
      error: { code: 'decision_action_failed' },
    });
    return { step, status: 'failed', error: 'decision_action_failed' };
  }
}

async function executeDecisionMutation(
  command: DecisionChatMutationCommand,
  step: ChatPlanStep,
  claim: ClaimedActionRun | null,
  input: ChatPlannerInput,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const claimExpectedStatuses: ChatActionRunStatus[] | undefined = claim
    ? [claim.acquired ? 'executing' : 'verified_pending']
    : undefined;
  const priorRequestJson = claim?.row.request_json;
  const executionCommand: DecisionChatMutationExecutionCommand = {
    ...command,
    reconciliationAttemptId: randomUUID(),
  };
  if (!updateClaimedActionRun(claim, 'executing', {
    request: executionCommand,
    ...(claimExpectedStatuses ? { expectedStatuses: claimExpectedStatuses } : {}),
    ...(priorRequestJson !== undefined ? { expectedRequestJson: priorRequestJson } : {}),
  })) {
    return reconciliationPendingResult(step, 'executing');
  }
  const executionRequestJson = JSON.stringify(executionCommand);
  const operation = Promise.resolve().then(() => performDecisionAction(
    command.decisionId,
    command.actionId,
    input.userId,
    input.tenantId,
    {
      idempotencyKey: command.idempotencyKey,
      payload: command.payload,
      channel: 'chat',
      ...(command.expectedVersion ? { expectedVersion: command.expectedVersion } : {}),
      ...(command.contextVersion ? { contextVersion: command.contextVersion } : {}),
    },
  ));
  try {
    const performed = await withProviderWriteTimeout(operation);
    return persistDecisionMutationOutcome(
      performed,
      step,
      claim,
      command.decisionId,
      ['executing'],
      executionRequestJson,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'provider_write_timeout') {
      const accepted = updateClaimedActionRun(claim, 'verified_pending', {
        expectedStatuses: ['executing'],
        expectedRequestJson: executionRequestJson,
        result: { decisionId: command.decisionId, verified: false },
        providerObjectId: command.decisionId,
        verification: { verified: false, reconciliationPending: true },
        error: { code: 'decision_action_reconciliation_pending' },
      });
      void operation.then((performed) => {
        persistDecisionMutationOutcome(
          performed,
          step,
          claim,
          command.decisionId,
          ['verified_pending', 'executing'],
          executionRequestJson,
        );
      }).catch(() => {
        if (claim) {
          updateChatActionRun(claim.row.id, 'failed', {
            expectedStatuses: ['verified_pending', 'executing'],
            expectedRequestJson: executionRequestJson,
            providerObjectId: command.decisionId,
            error: { code: 'decision_action_failed_after_timeout' },
          });
        }
      });
      if (!accepted) return reconciliationPendingResult(step, 'verified_pending');
      return {
        step,
        status: 'verified_pending',
        result: { decisionId: command.decisionId, verified: false, reconciliationPending: true },
        error: 'decision_action_reconciliation_pending',
      };
    }
    if (claim) {
      updateChatActionRun(claim.row.id, 'failed', {
        expectedStatuses: ['executing'],
        expectedRequestJson: executionRequestJson,
        providerObjectId: command.decisionId,
        error: { code: 'decision_action_failed' },
      });
    }
    return { step, status: 'failed', error: 'decision_action_failed' };
  }
}

function persistDecisionMutationOutcome(
  performed: Awaited<ReturnType<typeof performDecisionAction>>,
  step: ChatPlanStep,
  claim: ClaimedActionRun | null,
  decisionId: string,
  expectedStatuses: ChatActionRunStatus[],
  expectedRequestJson: string,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const verified = performed.verification.readBackOk;
  const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
  const payload = { result: performed, item: performed.item, verified };
  if (!updateClaimedActionRun(claim, status, {
    expectedStatuses,
    expectedRequestJson,
    result: payload,
    providerObjectId: decisionId,
    verification: { verified },
  })) return reconciliationPendingResult(step, status);
  return { step, status, result: payload, error: verified ? undefined : 'local_read_back_mismatch' };
}

function parsePendingDecisionCommand(value: string): DecisionChatMutationCommand | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (
      parsed.schemaVersion !== 1
      || parsed.commandType !== 'decision_mutation'
      || typeof parsed.decisionId !== 'string'
      || typeof parsed.actionId !== 'string'
      || typeof parsed.idempotencyKey !== 'string'
      || !parsed.payload
      || typeof parsed.payload !== 'object'
      || Array.isArray(parsed.payload)
    ) return null;
    const expectedVersion = parsed.expectedVersion;
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) <= 0)) return null;
    const contextVersion = parsed.contextVersion;
    if (contextVersion !== undefined && (typeof contextVersion !== 'string' || !contextVersion.trim())) return null;
    return {
      schemaVersion: 1,
      commandType: 'decision_mutation',
      decisionId: parsed.decisionId,
      actionId: parsed.actionId,
      idempotencyKey: parsed.idempotencyKey,
      payload: parsed.payload as Record<string, unknown>,
      ...(expectedVersion !== undefined ? { expectedVersion: Number(expectedVersion) } : {}),
      ...(typeof contextVersion === 'string' ? { contextVersion } : {}),
    };
  } catch {
    return null;
  }
}

function snoozePayload(args: Record<string, unknown>): Record<string, unknown> {
  const deferUntil = typeof args.deferUntil === 'string' && args.deferUntil.trim()
    ? args.deferUntil.trim()
    : typeof args.until === 'string' && args.until.trim()
      ? args.until.trim()
      : null;
  if (deferUntil) return { deferUntil };
  if (typeof args.followUp === 'string' && args.followUp.trim()) return { followUp: args.followUp.trim() };
  if (typeof args.minutes === 'number') return { minutes: args.minutes };
  return { minutes: 60 };
}

function blockedDecisionStep(
  step: ChatPlanStep,
  claim: ClaimedActionRun | null,
  error: string,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  if (!updateClaimedActionRun(claim, 'blocked', { error: { code: error } })) {
    return reconciliationPendingResult(step, 'blocked');
  }
  return { step, status: 'blocked', error };
}
