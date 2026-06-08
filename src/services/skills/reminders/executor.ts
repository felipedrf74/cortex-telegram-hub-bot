// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { claimChatActionRunForExecution, updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import {
  reconciliationPendingResult,
  replayDuplicateClaimedActionRun,
  updateClaimedActionRun,
} from '../../chat/executor/helpers';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getActiveReminders, setReminder } from '../../../state/reminders';

export async function executeReminderSetStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as Record<string, unknown>;
  const message = String(args.message || '').trim();
  const remindAt = String(args.remindAt || args.remind_at || '').trim();
  const timezone = typeof args.timezone === 'string' && args.timezone.trim()
    ? args.timezone.trim()
    : input.timezone;
  if (!message || !remindAt) {
    return { step, status: 'blocked', error: 'reminder_message_and_time_required' };
  }

  const claim = persistRuns
    ? claimChatActionRunForExecution({
      userId: input.userId,
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      messageId: input.messageId,
      normalizedActionHash: step.idempotencyKey,
      provider: 'nexus',
      actionType: step.action,
      risk: step.risk,
      request: step.args,
      nowIso: plan.createdAt,
    })
    : null;
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;

  try {
    const reminder = setReminder(input.userId, {
      message,
      remind_at: remindAt,
      recurring: typeof args.recurring === 'string' ? args.recurring : undefined,
      timezone,
    }, {
      tenantId: input.tenantId,
      timezone,
    });
    const readBack = getActiveReminders(input.userId, input.tenantId)
      .find((candidate) => Number(candidate.id) === Number(reminder.id));
    const verified = Boolean(readBack)
      && String(readBack?.message || '') === message
      && String(readBack?.remind_at || '') === String(reminder.remind_at || remindAt);
    const result = {
      reminder: readBack ?? reminder,
      verified,
    };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(reminder.id),
      verification: {
        verified,
        expected: step.verification.expectedFields,
        actual: {
          message: readBack?.message ?? reminder.message,
          remindAt: readBack?.remind_at ?? reminder.remind_at,
          timezone: readBack?.timezone ?? reminder.timezone,
        },
      },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'reminder_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'reminder_create_failed' };
  }
}
