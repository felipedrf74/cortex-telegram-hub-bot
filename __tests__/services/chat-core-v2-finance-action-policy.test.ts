import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION,
  evaluateChatCoreV2FinanceActionPolicy,
  getChatCoreV2Capability,
  listChatCoreV2CapabilitiesByDomain,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 finance action policy', () => {
  it('attaches the versioned finance policy to every finance capability', () => {
    for (const capability of listChatCoreV2CapabilitiesByDomain('finance')) {
      expect(capability.domainSafetyPolicyVersion, capability.capabilityId)
        .toBe(CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION);
    }
  });

  it('keeps restricted finance actions non-model-visible and non-executable', () => {
    const capability = getChatCoreV2Capability('finance.payment_or_tax_action_blocked');

    expect(capability?.risk).toBe('restricted');
    expect(capability?.support.preview).toBe('blocked');
    expect(capability?.support.execute).toBe('blocked');
    expect(capability?.confirmationPolicy).toBe('never_execute');
    expect(capability?.modelVisible).toBe(false);
    expect(capability?.domainSafetyPolicyVersion).toBe(CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION);
  });

  it('allows aggregate finance summary reads without raw transaction rows', () => {
    const verdict = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.read_summary',
      operation: 'read',
      usesAggregateContextOnly: true,
      includesRawTransactionRows: false,
    });

    expect(verdict).toMatchObject({
      ok: true,
      decision: 'allowed',
      maxAllowedOperation: 'read',
      reasons: ['aggregate_read_allowed'],
      policyVersion: CHAT_CORE_V2_FINANCE_ACTION_POLICY_VERSION,
    });
  });

  it('blocks raw finance context in summary reads', () => {
    const verdict = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.read_summary',
      operation: 'read',
      usesAggregateContextOnly: false,
      includesRawTransactionRows: true,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('blocked');
    expect(verdict.reasons).toEqual(['raw_finance_context_blocked']);
  });

  it('requires cited source rows before explaining a specific finance item', () => {
    const missingCitation = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.explain_item',
      operation: 'read',
    });
    const cited = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.explain_item',
      operation: 'read',
      hasSourceCitations: true,
    });

    expect(missingCitation.decision).toBe('needs_clarification');
    expect(missingCitation.reasons).toEqual(['missing_source_citation']);
    expect(cited.ok).toBe(true);
    expect(cited.reasons).toEqual(['cited_item_read_allowed']);
  });

  it('allows cited reminder and classification previews but blocks execution', () => {
    const preview = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.classify_preview',
      operation: 'preview',
      hasSourceCitations: true,
      changesCategory: true,
    });
    const execute = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.classify_preview',
      operation: 'execute',
      hasSourceCitations: true,
      changesCategory: true,
    });

    expect(preview.ok).toBe(true);
    expect(preview.maxAllowedOperation).toBe('preview');
    expect(preview.reasons).toEqual(['safe_preview_allowed']);
    expect(execute.ok).toBe(false);
    expect(execute.decision).toBe('blocked');
    expect(execute.reasons).toEqual(['ledger_mutation_blocked']);
  });

  it('blocks payment, tax, and raw payment-detail actions even before execution', () => {
    const verdict = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.execute_restricted',
      operation: 'preview',
      initiatesPayment: true,
      changesTaxState: true,
      includesRawTaxOrPaymentDetails: true,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('blocked');
    expect(verdict.reasons).toEqual([
      'restricted_finance_action',
      'payment_or_tax_execution_blocked',
      'raw_tax_or_payment_details_blocked',
    ]);
  });

  it('allows authenticated fiscal bundle sends through the dedicated action class', () => {
    const verdict = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.send_bundle',
      operation: 'execute',
      hasSourceCitations: true,
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.reasons).toEqual(['authenticated_bundle_send_allowed']);
  });

  it('routes multi-item finance previews to manual review', () => {
    const verdict = evaluateChatCoreV2FinanceActionPolicy({
      actionClass: 'finance.prepare_reminder',
      operation: 'preview',
      hasSourceCitations: true,
      affectedItemCount: 3,
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.decision).toBe('requires_human_review');
    expect(verdict.maxAllowedOperation).toBe('manual_review');
    expect(verdict.humanReviewReason).toBe('restricted_finance');
    expect(verdict.reasons).toEqual(['batch_finance_review_required']);
  });
});
