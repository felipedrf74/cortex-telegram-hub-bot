// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { DateTime } from 'luxon';
import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getMonthlySummary, getPreferredCurrencyForUser, getTaxEvents, markTaxPaid, updateTransactionCategory } from '../../finance-tracker';
import { getTaskProviderForUser } from '../../task-store/task-router';
import { executeTaskCreateStep } from '../tasks/executor';
import { claimActionRunForStepExecution, reconciliationPendingResult, replayDuplicateClaimedActionRun, updateClaimedActionRun } from '../../chat/executor/helpers';

export function executeFinanceSummaryStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const month = String((step.args as any).month || DateTime.now().setZone(input.timezone).toFormat('yyyy-MM'));
  try {
    const summary = getMonthlySummary(input.userId, month, { tenantId: input.tenantId });
    const currency = getPreferredCurrencyForUser(input.userId);
    return { step, status: 'verified_success', result: { month, summary, currency } };
  } catch {
    return { step, status: 'failed', error: 'finance_summary_failed' };
  }
}

export async function executeFinanceReminderStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  taskProviderForUser: typeof getTaskProviderForUser,
  persistRuns: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  if (typeof args.dueDate !== 'string' || !args.dueDate.trim()) {
    return { step, status: 'blocked', error: 'finance_reminder_due_date_required' };
  }
  const reminderStep: ChatPlanStep = {
    ...step,
    skill: 'tasks',
    action: 'create_task',
    type: 'create_task',
    risk: 'safe_write',
    args: {
      title: String(args.title || 'Finance reminder'),
      list: null,
      dueDateTime: args.dueDate,
      notes: 'Created from Finance chat action.',
    },
    verification: { required: true, method: 'local_read_back', expectedFields: { title: String(args.title || 'Finance reminder') } },
  };
  return executeTaskCreateStep(reminderStep, plan, input, taskProviderForUser, persistRuns);
}

export function executeFinanceCategorizeReceiptStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const transactionId = Number(args.transactionId ?? args.receiptId);
  const category = typeof args.category === 'string' ? args.category.trim() : '';
  if (!Number.isInteger(transactionId) || transactionId <= 0 || !category) {
    return { step, status: 'blocked', error: 'finance_categorization_requires_transaction_and_category' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const updated = updateTransactionCategory(input.userId, transactionId, category, {
      subcategory: typeof args.subcategory === 'string' ? args.subcategory : null,
      tenantId: input.tenantId,
    });
    if (!updated) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_transaction_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_transaction_not_found_or_unauthorized' };
    }
    const verified = updated.category === category;
    const result = { transactionId, category: updated.category, subcategory: updated.subcategory, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: String(transactionId),
      verification: { verified, expected: { transactionId, category } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'finance_categorization_failed' };
  }
}

export function executeFinancePaymentActionStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
): { step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string } {
  const args = step.args as any;
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  const month = typeof args.month === 'string' ? args.month.trim() : '';
  if (!['mark_tax_paid', 'mark_paid'].includes(action)) {
    return { step, status: 'blocked', error: 'external_financial_payment_not_enabled_for_chat' };
  }
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return { step, status: 'blocked', error: 'finance_payment_month_required' };
  }
  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const ok = markTaxPaid(input.userId, month, { tenantId: input.tenantId });
    if (!ok) {
      if (claim) updateChatActionRun(claim.row.id, 'blocked', { error: { reason: 'finance_tax_event_not_found_or_unauthorized' } });
      return { step, status: 'blocked', error: 'finance_tax_event_not_found_or_unauthorized' };
    }
    const year = Number(month.slice(0, 4));
    const readBack = getTaxEvents(input.userId, { year, limit: 24, tenantId: input.tenantId }).find((event) => event.month === month);
    const verified = readBack?.status === 'paid';
    const result = { month, status: readBack?.status ?? null, verified };
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: `finance_tax_event:${month}`,
      verification: { verified, expected: { month, status: 'paid' } },
    })) return reconciliationPendingResult(step, status);
    return { step, status, result, error: verified ? undefined : 'local_read_back_mismatch' };
  } catch (err) {
    if (claim) updateChatActionRun(claim.row.id, 'failed', { error: { message: err instanceof Error ? err.message : String(err) } });
    return { step, status: 'failed', error: 'finance_payment_action_failed' };
  }
}
