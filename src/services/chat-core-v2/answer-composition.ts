// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Locale } from './response-contracts';

export const COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION = 'composed_answer_draft@1.0.0';

export type AnswerCompositionMode =
  | 'templated'
  | 'model_constrained'
  | 'background_model'
  | 'cloud_allowlist';

export interface AnswerCompositionModeBudget {
  mode: AnswerCompositionMode;
  targetMinShare: number;
  targetMaxShare: number;
}

export const ANSWER_COMPOSITION_MODE_BUDGETS: AnswerCompositionModeBudget[] = [
  { mode: 'templated', targetMinShare: 0.60, targetMaxShare: 0.80 },
  { mode: 'model_constrained', targetMinShare: 0.15, targetMaxShare: 0.35 },
  { mode: 'background_model', targetMinShare: 0, targetMaxShare: 0.05 },
  { mode: 'cloud_allowlist', targetMinShare: 0, targetMaxShare: 0.02 },
];

export type FactualClaimSupport = 'supported' | 'assumption' | 'clarification_needed';

export interface EvidenceBoundFactualClaim {
  claimId: string;
  text: string;
  evidenceIds: string[];
  support: FactualClaimSupport;
}

export interface ComposedAnswerDraft {
  schemaVersion: typeof COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION;
  mode: AnswerCompositionMode;
  locale: ChatCoreV2Locale;
  text: string;
  factualClaims: EvidenceBoundFactualClaim[];
  reasonCodes: string[];
}

export type ComposedAnswerDraftIssue =
  | 'invalid_schema_version'
  | 'model_unbounded_prohibited'
  | 'empty_text'
  | 'unsupported_factual_claim';

export function validateComposedAnswerDraft(draft: ComposedAnswerDraft): ComposedAnswerDraftIssue[] {
  const issues: ComposedAnswerDraftIssue[] = [];
  if (draft.schemaVersion !== COMPOSED_ANSWER_DRAFT_SCHEMA_VERSION) {
    issues.push('invalid_schema_version');
  }
  if ((draft.mode as string) === 'model_unbounded') {
    issues.push('model_unbounded_prohibited');
  }
  if (draft.text.trim() === '') {
    issues.push('empty_text');
  }
  for (const claim of draft.factualClaims) {
    if (claim.support === 'supported' && claim.evidenceIds.length === 0) {
      issues.push('unsupported_factual_claim');
      break;
    }
  }
  return issues;
}
