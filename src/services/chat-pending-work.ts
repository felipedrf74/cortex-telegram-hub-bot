// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { cancelPendingChatActions } from './chat-action-state';
import { cancelPendingChatActionRuns } from './chat-action-run-store';
import {
  clearPendingChatConfirmation,
  getPendingChatConfirmation,
} from './chat-pending-confirmations';
import { clearPendingChatCoreV2CommandsForScope } from './chat-core-v2/pending-commands';
import { cancelChatLegacyTimeoutContinuationsForScope } from './chat-legacy-timeout-continuation';
import {
  findDecisionByRelatedEntity,
  performDecisionAction,
} from './decision-center';
import { getDb } from './database';
import { logger } from '../utils/logger';

export interface CancelAllPendingChatWorkResult {
  chatPendingActions: number;
  chatActionRuns: number;
  chatPendingConfirmation: boolean;
  chatCoreV2Commands: number;
  chatBackgroundContinuations: number;
  decisionDismissed: boolean;
  errors?: Array<{ store: string; message: string }>;
}

export async function cancelAllPendingChatWork(input: {
  userId: number;
  tenantId: number;
  conversationId: string;
  nowIso?: string;
}): Promise<CancelAllPendingChatWorkResult> {
  const now = input.nowIso ? new Date(input.nowIso) : new Date();
  const errors: Array<{ store: string; message: string }> = [];
  const safe = async <T>(store: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ store, message });
      logger.warn({
        err,
        userId: input.userId,
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        store,
      }, 'Failed to clear one pending chat work store during cancellation');
      return fallback;
    }
  };

  const pendingConfirmation = await safe(
    'chat-pending-confirmations.get',
    null,
    () => getPendingChatConfirmation(input.userId, input.tenantId, now),
  );
  const pendingActionIds = await safe(
    'chat_pending_actions.list',
    [] as string[],
    () => listActiveChatPendingActionIds({ ...input, conversationId: null }),
  );
  let decisionDismissed = false;
  if (pendingConfirmation) {
    decisionDismissed = await safe(
      'decision-center.dismiss',
      false,
      () => dismissChatConfirmationDecision(input, pendingConfirmation.id),
    ) || decisionDismissed;
  }
  for (const pendingActionId of pendingActionIds) {
    decisionDismissed = await safe(
      'decision-center.dismiss',
      false,
      () => dismissChatConfirmationDecision(input, pendingActionId),
    ) || decisionDismissed;
  }

  const chatPendingActions = await safe('chat_pending_actions.cancel', 0, () => cancelPendingChatActions({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: null,
    nowIso: input.nowIso,
  }));
  const chatActionRuns = await safe('chat_action_runs.cancel', 0, () => cancelPendingChatActionRuns({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: null,
    nowIso: input.nowIso,
  }));
  const chatPendingConfirmation = await safe(
    'chat-pending-confirmations.clear',
    false,
    () => clearPendingChatConfirmation(input.userId, input.tenantId),
  );
  const chatCoreV2Commands = await safe('chat_core_v2_pending_commands.clear', 0, () => clearPendingChatCoreV2CommandsForScope({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: null,
  }));
  const chatBackgroundContinuations = await safe(
    'chat_legacy_timeout_continuations.cancel',
    0,
    () => cancelChatLegacyTimeoutContinuationsForScope({
      userId: input.userId,
      tenantId: input.tenantId,
    }),
  );

  const result: CancelAllPendingChatWorkResult = {
    chatPendingActions,
    chatActionRuns,
    chatPendingConfirmation,
    chatCoreV2Commands,
    chatBackgroundContinuations,
    decisionDismissed,
  };
  if (errors.length > 0) result.errors = errors;
  return result;
}

function listActiveChatPendingActionIds(input: {
  userId: number;
  tenantId: number;
  conversationId?: string | null;
}): string[] {
  const conversationClause = input.conversationId ? 'AND conversation_id = ?' : '';
  const params: Array<number | string> = [input.userId, input.tenantId];
  if (input.conversationId) params.push(input.conversationId);
  const rows = getDb().prepare(`
    SELECT id
    FROM chat_pending_actions
    WHERE user_id = ?
      AND tenant_id = ?
      ${conversationClause}
      AND status IN ('needs_input', 'needs_confirmation', 'executable', 'needs_user_followup')
      AND cancellation_state = 'active'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 50
  `).all(...params) as Array<{ id?: string }>;
  return rows.map((row) => String(row.id || '')).filter(Boolean);
}

async function dismissChatConfirmationDecision(input: {
  userId: number;
  tenantId: number;
}, pendingId: string): Promise<boolean> {
  const decision = findDecisionByRelatedEntity(
    input.userId,
    input.tenantId,
    'chat_confirmation',
    pendingId,
  );
  if (!decision) return false;
  const result = await performDecisionAction(
    decision.decisionId,
    'dismiss',
    input.userId,
    input.tenantId,
    {
      idempotencyKey: `chat-cancel:${pendingId}`,
      payload: { reason: 'not_relevant' },
      channel: 'chat',
      expectedVersion: decision.recordVersion,
      contextVersion: decision.contextVersion,
    },
  );
  return result.item.status === 'dismissed';
}
