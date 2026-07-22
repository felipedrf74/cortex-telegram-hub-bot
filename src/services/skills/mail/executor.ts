// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { updateChatActionRun, type ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatActionPlan, ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import {
  claimActionRunForStepExecution,
  reconciliationPendingResult,
  replayDuplicateClaimedActionRun,
  updateClaimedActionRun,
  withProviderWriteTimeout,
} from '../../chat/executor/helpers';
import { getUnreadMailSummaryForUser } from '../../unified-mail-pressure';
import { searchEmailsForUser as searchGmailEmailsForUser } from '../../google-gmail';
import {
  createOutlookDraftForUser,
  isOutlookMailConfiguredForUser,
  searchEmailsForUser as searchOutlookEmailsForUser,
  sendOutlookEmailWithReadBackForUser,
} from '../../outlook-mail';

export async function executeMailUnreadCountStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  try {
    const summary = await getUnreadMailSummaryForUser(input.userId);
    return { step, status: 'verified_success', result: summary };
  } catch {
    return { step, status: 'failed', error: 'mail_unread_failed' };
  }
}

export async function executeMailInboxSummaryStep(
  step: ChatPlanStep,
  input: ChatPlannerInput,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  const args = step.args as any;
  const provider = String(args.provider || step.provider || '').toLowerCase();
  const limit = Math.max(1, Math.min(10, Number(args.limit) || 5));
  const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : 'in:inbox newer_than:14d';
  try {
    if (provider === 'gmail') {
      const messages = await searchGmailEmailsForUser(input.userId, query, limit);
      return { step, status: 'verified_success', result: { provider: 'gmail', messages: messages.map(mailMessageSummary) } };
    }
    if (provider === 'outlook_mail') {
      const messages = await searchOutlookEmailsForUser(input.userId, query, limit);
      return { step, status: 'verified_success', result: { provider: 'outlook_mail', messages: messages.map(mailMessageSummary) } };
    }
    const summary = await getUnreadMailSummaryForUser(input.userId);
    return { step, status: 'verified_success', result: { provider: 'unified', unread: summary } };
  } catch {
    return { step, status: 'failed', error: 'mail_summary_failed' };
  }
}

function normalizeWriteProvider(step: ChatPlanStep): string {
  const args = step.args as Record<string, unknown>;
  const provider = String(args.provider || step.provider || '').trim().toLowerCase();
  return provider === 'outlook' ? 'outlook_mail' : provider;
}

function validRecipientList(value: string): boolean {
  const recipients = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return recipients.length > 0
    && recipients.every((recipient) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient));
}

export async function executeMailWriteStep(
  step: ChatPlanStep,
  plan: ChatActionPlan,
  input: ChatPlannerInput,
  persistRuns: boolean,
  confirmed: boolean,
): Promise<{ step: ChatPlanStep; status: ChatActionRunStatus; result?: unknown; error?: string }> {
  if (!confirmed) return { step, status: 'needs_confirmation', error: 'mail_write_confirmation_required' };

  const args = step.args as Record<string, unknown>;
  const recipient = typeof args.recipient === 'string' ? args.recipient.trim() : '';
  const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
  const body = typeof args.body === 'string' ? args.body.trim() : '';
  if (!validRecipientList(recipient) || !subject || !body) {
    return { step, status: 'blocked', error: 'mail_write_fields_invalid' };
  }
  if (Array.isArray(args.attachments) && args.attachments.length > 0) {
    return { step, status: 'blocked', error: 'mail_attachments_not_supported' };
  }

  const provider = normalizeWriteProvider(step);
  if (provider === 'gmail' || provider === 'google') {
    return { step, status: 'blocked', error: 'gmail_write_scope_unavailable' };
  }
  if (provider !== 'outlook_mail') {
    return { step, status: 'blocked', error: 'mail_write_provider_unsupported' };
  }
  if (!isOutlookMailConfiguredForUser(input.userId)) {
    return { step, status: 'blocked', error: 'outlook_mail_not_connected' };
  }

  const claim = claimActionRunForStepExecution(step, plan, input, persistRuns);
  const duplicate = replayDuplicateClaimedActionRun(claim, step);
  if (duplicate) return duplicate;
  try {
    const write = {
      to: recipient,
      subject,
      body,
      source: 'chat_action_planner',
    };
    const receipt = await withProviderWriteTimeout((signal) => (
      step.action === 'draft_email'
        ? createOutlookDraftForUser(input.userId, write, { signal })
        : sendOutlookEmailWithReadBackForUser(input.userId, write, { signal })
    ));
    const verified = receipt.verified === true
      && receipt.state === (step.action === 'draft_email' ? 'draft' : 'sent');
    const status: ChatActionRunStatus = verified ? 'verified_success' : 'partial_success';
    const result = {
      provider: receipt.provider,
      messageId: receipt.messageId,
      state: receipt.state,
      verified,
      verificationError: receipt.verificationError ?? null,
    };
    if (!updateClaimedActionRun(claim, status, {
      result,
      providerObjectId: receipt.messageId,
      verification: {
        verified,
        method: 'provider_read_back',
        expected: step.verification.expectedFields,
        error: receipt.verificationError ?? null,
      },
    })) return reconciliationPendingResult(step, status);
    return {
      step,
      status,
      result,
      error: verified ? undefined : 'mail_provider_read_back_mismatch',
    };
  } catch {
    if (claim) {
      updateChatActionRun(claim.row.id, 'failed', {
        error: { message: 'mail_write_failed' },
      });
    }
    return { step, status: 'failed', error: 'mail_write_failed' };
  }
}

export function mailMessageSummary(message: any): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    date: message.date,
    snippet: message.snippet ? String(message.snippet).slice(0, 180) : undefined,
  };
}
