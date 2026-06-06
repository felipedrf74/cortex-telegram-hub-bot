// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { NexusAnswerContract, NexusChatLanguage } from './chat-answer-contract';
import {
  applyChatResponseQualityGate,
  type ChatResponseQualityGateResult,
} from './chat-response-quality-gate';
import { textClaimsUnverifiedAction } from './chat-success-claim-policy';

export const NEXUS_COMPOSED_ANSWER_DRAFT_VERSION = 'nexus_composed_answer_draft.v1';
export const NEXUS_FINAL_ANSWER_COMPOSER_VERSION = 'nexus_final_answer_composer.v1';

export type NexusAnswerCompositionMode =
  | 'templated'
  | 'model_constrained'
  | 'background_model'
  | 'cloud_allowlist';

export type NexusFactualClaimSupport = 'supported' | 'assumption' | 'unsupported';

export interface NexusAnswerFactualClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  support: NexusFactualClaimSupport;
}

export interface NexusComposedAnswerDraft {
  schemaVersion: typeof NEXUS_COMPOSED_ANSWER_DRAFT_VERSION;
  mode: NexusAnswerCompositionMode;
  language: NexusChatLanguage;
  text: string;
  factualClaims: NexusAnswerFactualClaim[];
  reasonCodes: string[];
}

export type NexusFinalAnswerIssue =
  | 'empty_response'
  | 'composer_language_mismatch'
  | 'unsupported_factual_claim'
  | 'unverified_success_claim';

export interface NexusFinalAnswerCompositionResult {
  ok: boolean;
  text: string;
  contract: NexusAnswerContract;
  issues: NexusFinalAnswerIssue[];
  quality: ChatResponseQualityGateResult;
  composerVersion: typeof NEXUS_FINAL_ANSWER_COMPOSER_VERSION;
}

export function buildNexusComposedAnswerDraft(input: {
  text: string;
  contract: NexusAnswerContract;
  mode?: NexusAnswerCompositionMode;
  factualClaims?: NexusAnswerFactualClaim[];
  reasonCodes?: string[];
}): NexusComposedAnswerDraft {
  return {
    schemaVersion: NEXUS_COMPOSED_ANSWER_DRAFT_VERSION,
    mode: input.mode ?? 'model_constrained',
    language: input.contract.language,
    text: String(input.text ?? ''),
    factualClaims: input.factualClaims ?? [],
    reasonCodes: input.reasonCodes ?? ['chat_answer_contract'],
  };
}

export function validateNexusComposedAnswerDraft(
  draft: NexusComposedAnswerDraft,
  contract: NexusAnswerContract,
): NexusFinalAnswerIssue[] {
  const issues = new Set<NexusFinalAnswerIssue>();
  if (!draft.text.trim()) issues.add('empty_response');
  if (draft.language !== contract.language) issues.add('composer_language_mismatch');
  if (
    textClaimsUnverifiedAction(draft.text)
    && contract.verificationStatus !== 'verified'
    && contract.verificationStatus !== 'partial_failure'
  ) {
    issues.add('unverified_success_claim');
  }
  for (const claim of draft.factualClaims) {
    if (claim.support === 'supported' && claim.evidenceIds.length === 0) {
      issues.add('unsupported_factual_claim');
    }
  }
  return [...issues];
}

export function composeNexusFinalAnswer(input: {
  draft: NexusComposedAnswerDraft;
  contract: NexusAnswerContract;
  qualityGateEnabled?: boolean;
}): NexusFinalAnswerCompositionResult {
  const draftIssues = validateNexusComposedAnswerDraft(input.draft, input.contract);
  const mustRunSafetyGate = draftIssues.includes('unverified_success_claim');
  const quality = input.qualityGateEnabled === false && !mustRunSafetyGate
    ? {
        status: 'pass' as const,
        text: input.draft.text,
        contract: input.contract,
        issues: [],
        score: 1,
      }
    : applyChatResponseQualityGate({
        text: input.draft.text,
        contract: input.contract,
      });
  const issues = [...new Set<NexusFinalAnswerIssue>([
    ...draftIssues,
    ...(quality.issues.filter(isFinalAnswerIssue)),
  ])];
  return {
    ok: issues.length === 0 && quality.status !== 'blocked',
    text: quality.text,
    contract: quality.contract,
    issues,
    quality,
    composerVersion: NEXUS_FINAL_ANSWER_COMPOSER_VERSION,
  };
}

function isFinalAnswerIssue(issue: string): issue is NexusFinalAnswerIssue {
  return issue === 'empty_response'
    || issue === 'unverified_success_claim'
    || issue === 'unsupported_factual_claim'
    || issue === 'composer_language_mismatch';
}
