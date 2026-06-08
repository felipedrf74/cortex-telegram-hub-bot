// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { CalendarSource } from '../../unified-calendar';
import {
  claimChatActionRun,
  claimChatActionRunForExecution,
  updateChatActionRun,
  type ChatActionRunRow,
  type ChatActionRunStatus,
} from '../../chat-action-run-store';
import type {
  ChatActionPlan,
  ChatPlannerInput,
  ChatPlanStep,
  ChatStepExecutionResult,
} from '../types';

const DEFAULT_PROVIDER_READ_BACK_TIMEOUT_MS = 3_500;
const DEFAULT_PROVIDER_WRITE_TIMEOUT_MS = 10_000;

export type ClaimedActionRun = ReturnType<typeof claimChatActionRunForExecution>;

export function updateClaimedActionRun(
  claim: ClaimedActionRun | null,
  status: ChatActionRunStatus,
  update?: Parameters<typeof updateChatActionRun>[2],
): boolean {
  if (!claim) return true;
  const row = updateChatActionRun(claim.row.id, status, update);
  return row !== null;
}

export function reconciliationPendingResult(step: ChatPlanStep, attemptedStatus: ChatActionRunStatus): ChatStepExecutionResult {
  return {
    step,
    status: 'verified_pending',
    error: 'action_run_reconciliation_pending',
    result: {
      verified: false,
      attemptedStatus,
      reason: 'terminal_run_state_rejected_late_update',
    },
    runUpdateAccepted: false,
  };
}

export function replayDuplicateClaimedActionRun(claim: ClaimedActionRun | null, step: ChatPlanStep): ChatStepExecutionResult | null {
  if (!claim || claim.acquired) return null;
  const row = claim.row;
  const result = parseStoredRunResult(row);
  if (row.status === 'verified_success') {
    return { step, status: 'verified_success', result };
  }
  if (row.status === 'partial_success') {
    return { step, status: 'partial_success', result, error: 'idempotent_retry_existing_partial_success' };
  }
  if (row.status === 'verified_pending') {
    return { step, status: 'verified_pending', result, error: 'idempotent_retry_existing_verified_pending' };
  }
  if (row.status === 'failed' || row.status === 'blocked') {
    return { step, status: row.status, result, error: `idempotent_retry_existing_${row.status}` };
  }
  if (row.status === 'cancelled') {
    return { step, status: 'blocked', result, error: 'idempotent_retry_existing_cancelled' };
  }
  if (row.status === 'executing' || row.status === 'verifying' || row.status === 'planned') {
    return {
      step,
      status: 'verified_pending',
      result: {
        ...result,
        currentStatus: row.status,
      },
      error: 'idempotent_retry_already_in_progress',
    };
  }
  if (row.status === 'needs_confirmation') {
    return {
      step,
      status: 'verified_pending',
      result: {
        ...result,
        currentStatus: row.status,
      },
      error: 'idempotent_retry_confirmation_not_claimed',
    };
  }
  return null;
}

export function parseStoredRunResult(row: ChatActionRunRow): Record<string, unknown> {
  const parsed = (() => {
    try {
      const value = row.result_json ? JSON.parse(row.result_json) : {};
      return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  })();
  return {
    ...parsed,
    replayed: true,
    providerObjectId: row.provider_object_id ?? parsed.providerObjectId ?? null,
    previousStatus: row.status,
  };
}

export function getProviderReadBackTimeoutMs(): number {
  const raw = process.env.CHAT_PROVIDER_READ_BACK_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_READ_BACK_TIMEOUT_MS;
}

export function getProviderWriteTimeoutMs(): number {
  const raw = process.env.CHAT_PROVIDER_WRITE_TIMEOUT_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PROVIDER_WRITE_TIMEOUT_MS;
}

export async function withProviderWriteTimeout<T>(
  operation: ((signal: AbortSignal) => Promise<T> | T) | Promise<T> | T,
  timeoutMs = getProviderWriteTimeoutMs(),
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  try {
    const promise = typeof operation === 'function'
      ? Promise.resolve((operation as (signal: AbortSignal) => Promise<T> | T)(controller.signal))
      : Promise.resolve(operation);
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('provider_write_timeout'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function withProviderReadBackTimeout<T>(operation: Promise<T>, timeoutMs = getProviderReadBackTimeoutMs()): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider_read_back_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function calendarSourceFromProvider(provider: unknown): CalendarSource | null {
  if (provider === 'google' || provider === 'google_calendar') return 'google';
  if (provider === 'outlook' || provider === 'outlook_calendar') return 'outlook';
  return null;
}

export function claimActionRunForStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): ReturnType<typeof claimChatActionRun> | null {
  if (!persistRuns) return null;
  return claimChatActionRun({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: step.provider,
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  });
}

export function claimActionRunForStepExecution(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): ReturnType<typeof claimChatActionRun> | null {
  if (!persistRuns) return null;
  return claimChatActionRunForExecution({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    normalizedActionHash: step.idempotencyKey,
    provider: step.provider,
    actionType: step.action,
    risk: step.risk,
    request: step.args,
    nowIso: plan.createdAt,
  });
}
