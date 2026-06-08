// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { HumanReviewReason } from './types';

export const CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION = 'chat_core_v2_finance_action_policy@1.0.0';

export type FinanceActionClass =
  | 'finance.read_summary'
  | 'finance.explain_item'
  | 'finance.prepare_reminder'
  | 'finance.classify_preview'
  | 'finance.manual_review'
  | 'finance.send_bundle'
  | 'finance.execute_restricted';

export type FinanceActionOperation = 'read' | 'preview' | 'execute';

export type FinanceActionDecision =
  | 'allowed'
  | 'needs_clarification'
  | 'requires_human_review'
  | 'blocked';

export type FinanceActionReason =
  | 'aggregate_read_allowed'
  | 'cited_item_read_allowed'
  | 'safe_preview_allowed'
  | 'authenticated_bundle_send_allowed'
  | 'execution_not_enabled'
  | 'restricted_finance_action'
  | 'payment_or_tax_execution_blocked'
  | 'ledger_mutation_blocked'
  | 'raw_finance_context_blocked'
  | 'raw_tax_or_payment_details_blocked'
  | 'missing_source_citation'
  | 'manual_review_required'
  | 'batch_finance_review_required';

export interface FinanceActionPolicyInput {
  actionClass: FinanceActionClass;
  operation: FinanceActionOperation;
  usesAggregateContextOnly?: boolean;
  includesRawTransactionRows?: boolean;
  includesRawTaxOrPaymentDetails?: boolean;
  hasSourceCitations?: boolean;
  initiatesPayment?: boolean;
  changesTaxState?: boolean;
  mutatesLedger?: boolean;
  changesCategory?: boolean;
  affectedItemCount?: number;
}

export interface FinanceActionPolicyVerdict {
  ok: boolean;
  decision: FinanceActionDecision;
  policyVersion: string;
  maxAllowedOperation: 'read' | 'preview' | 'manual_review';
  reasons: FinanceActionReason[];
  humanReviewReason?: HumanReviewReason;
}

export function evaluateChatCoreV2FinanceActionPolicy(
  input: FinanceActionPolicyInput,
): FinanceActionPolicyVerdict {
  const hardBlocks = blockingReasons(input);
  if (hardBlocks.length > 0) {
    return verdict('blocked', hardBlocks);
  }

  if (input.actionClass === 'finance.send_bundle') {
    if (input.operation === 'execute' && input.hasSourceCitations === true) {
      return verdict('allowed', ['authenticated_bundle_send_allowed']);
    }
    return verdict('needs_clarification', ['missing_source_citation']);
  }

  if (input.operation === 'execute') {
    return verdict('blocked', ['execution_not_enabled']);
  }

  if (input.actionClass === 'finance.manual_review') {
    return verdict('requires_human_review', ['manual_review_required'], 'restricted_finance');
  }

  if ((input.affectedItemCount ?? 1) > 1) {
    return verdict('requires_human_review', ['batch_finance_review_required'], 'restricted_finance');
  }

  if (input.operation === 'read') {
    return evaluateRead(input);
  }

  return evaluatePreview(input);
}

function evaluateRead(input: FinanceActionPolicyInput): FinanceActionPolicyVerdict {
  if (input.actionClass === 'finance.read_summary') {
    if (input.usesAggregateContextOnly === true && input.includesRawTransactionRows !== true) {
      return verdict('allowed', ['aggregate_read_allowed']);
    }
    return verdict('blocked', ['raw_finance_context_blocked']);
  }

  if (input.actionClass === 'finance.explain_item') {
    if (input.hasSourceCitations === true) {
      return verdict('allowed', ['cited_item_read_allowed']);
    }
    return verdict('needs_clarification', ['missing_source_citation']);
  }

  return verdict('needs_clarification', ['missing_source_citation']);
}

function evaluatePreview(input: FinanceActionPolicyInput): FinanceActionPolicyVerdict {
  if (
    input.actionClass !== 'finance.prepare_reminder'
    && input.actionClass !== 'finance.classify_preview'
  ) {
    return verdict('requires_human_review', ['manual_review_required'], 'restricted_finance');
  }

  if (input.hasSourceCitations !== true) {
    return verdict('needs_clarification', ['missing_source_citation']);
  }

  return verdict('allowed', ['safe_preview_allowed']);
}

function blockingReasons(input: FinanceActionPolicyInput): FinanceActionReason[] {
  const reasons: FinanceActionReason[] = [];

  if (input.actionClass === 'finance.execute_restricted') {
    reasons.push('restricted_finance_action');
  }
  if (input.initiatesPayment || input.changesTaxState) {
    reasons.push('payment_or_tax_execution_blocked');
  }
  if (input.mutatesLedger || (input.changesCategory && input.operation === 'execute')) {
    reasons.push('ledger_mutation_blocked');
  }
  if (input.includesRawTaxOrPaymentDetails) {
    reasons.push('raw_tax_or_payment_details_blocked');
  }

  return reasons;
}

function verdict(
  decision: FinanceActionDecision,
  reasons: FinanceActionReason[],
  humanReviewReason?: HumanReviewReason,
): FinanceActionPolicyVerdict {
  return {
    ok: decision === 'allowed',
    decision,
    policyVersion: CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION,
    maxAllowedOperation: maxAllowedOperationFor(decision, reasons),
    reasons,
    humanReviewReason,
  };
}

function maxAllowedOperationFor(
  decision: FinanceActionDecision,
  reasons: FinanceActionReason[],
): FinanceActionPolicyVerdict['maxAllowedOperation'] {
  if (decision === 'requires_human_review') return 'manual_review';
  if (decision === 'allowed' && (
    reasons.includes('aggregate_read_allowed')
    || reasons.includes('cited_item_read_allowed')
  )) {
    return 'read';
  }
  return 'preview';
}
