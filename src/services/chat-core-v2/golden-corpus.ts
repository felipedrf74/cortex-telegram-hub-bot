// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2Domain } from './types';
import type { ChatCoreV2WriteRiskClass } from './write-risk-policy';

export const CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION = 'chat_core_v2_golden_corpus@1.0.0';

export type ChatCoreV2CorpusLanguage = 'en' | 'pt-BR' | 'pt-PT' | 'mixed';
export type ChatCoreV2GoldenCorpusSource =
  | 'real_failure'
  | 'operator_seed'
  | 'operator_labeled'
  | 'shadow_sample'
  | 'manual_regression'
  | 'regression_seed';

export type ChatCoreV2GoldenCorpusIntent =
  | 'answer'
  | 'read'
  | 'write_preview'
  | 'clarify'
  | 'unsupported'
  | 'escalate';

export interface ChatCoreV2GoldenCorpusItem {
  id: string;
  language: ChatCoreV2CorpusLanguage;
  message: string;
  surface?: 'ios' | 'web' | 'internal';
  expectedDomainIds: ChatCoreV2Domain[];
  expectedCapabilityIds: string[];
  expectedIntent?: ChatCoreV2GoldenCorpusIntent;
  forbiddenClaims: string[];
  evidenceRequirements: string[];
  writeRiskClass?: ChatCoreV2WriteRiskClass;
  source: ChatCoreV2GoldenCorpusSource;
  notes?: string;
}

export interface ChatCoreV2GoldenCorpus {
  schemaVersion: typeof CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION;
  items: ChatCoreV2GoldenCorpusItem[];
}

export type ChatCoreV2GoldenCorpusIssue =
  | 'invalid_schema_version'
  | 'too_few_items'
  | 'missing_language'
  | 'missing_expected_capability'
  | 'missing_evidence_requirement'
  | 'synthetic_only';

export function validateGoldenCorpus(
  corpus: ChatCoreV2GoldenCorpus,
  minimumItems = 200,
): ChatCoreV2GoldenCorpusIssue[] {
  const issues: ChatCoreV2GoldenCorpusIssue[] = [];
  if (corpus.schemaVersion !== CHAT_CORE_V2_GOLDEN_CORPUS_SCHEMA_VERSION) {
    issues.push('invalid_schema_version');
  }
  if (corpus.items.length < minimumItems) issues.push('too_few_items');
  if (!hasAllLanguages(corpus.items)) issues.push('missing_language');
  if (corpus.items.some((item) => item.expectedCapabilityIds.length === 0)) {
    issues.push('missing_expected_capability');
  }
  if (corpus.items.some((item) => item.evidenceRequirements.length === 0)) {
    issues.push('missing_evidence_requirement');
  }
  if (!corpus.items.some((item) => item.source === 'real_failure' || item.source === 'operator_labeled' || item.source === 'operator_seed')) {
    issues.push('synthetic_only');
  }
  return [...new Set(issues)];
}

function hasAllLanguages(items: ChatCoreV2GoldenCorpusItem[]): boolean {
  const languages = new Set(items.map((item) => item.language));
  return languages.has('en') && languages.has('pt-BR') && languages.has('pt-PT') && languages.has('mixed');
}
