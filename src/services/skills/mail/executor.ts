// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatActionRunStatus } from '../../chat-action-run-store';
import type { ChatPlannerInput, ChatPlanStep } from '../../chat/types';
import { getUnreadMailSummaryForUser } from '../../unified-mail-pressure';
import { searchEmailsForUser as searchGmailEmailsForUser } from '../../google-gmail';
import { searchEmailsForUser as searchOutlookEmailsForUser } from '../../outlook-mail';

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

export function mailMessageSummary(message: any): Record<string, unknown> {
  return {
    id: message.id,
    from: message.from,
    subject: message.subject,
    date: message.date,
    snippet: message.snippet ? String(message.snippet).slice(0, 180) : undefined,
  };
}
