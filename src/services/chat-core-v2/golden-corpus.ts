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

/**
 * Sources that count as real human evidence (a real production failure or an
 * operator/reviewer label), as opposed to hand-authored regression fixtures.
 */
export const REAL_EVIDENCE_CORPUS_SOURCES: ReadonlySet<ChatCoreV2GoldenCorpusSource> = new Set([
  'real_failure',
  'operator_labeled',
  'operator_seed',
]);

/**
 * Minimum real-evidence floor (WP-09 / B4).
 *
 * The Phase 2 recall@8 gate requires a peer-reviewed, predominantly-real corpus
 * (the golden-corpus spec: "built from real hallucination/context failures plus
 * reviewer labels. A synthetic-only corpus is not acceptable"). A corpus that
 * carries only a handful of real-evidence items among hundreds of hand-authored
 * fixtures is still a synthetic baseline, not a gate corpus. The `synthetic_only`
 * issue therefore fires unless BOTH hold:
 *   - at least DEFAULT_MIN_REAL_EVIDENCE_ITEMS real-evidence items, AND
 *   - real-evidence items are at least DEFAULT_MIN_REAL_EVIDENCE_SHARE of the corpus.
 *
 * Defensible thresholds: 20 items + 10% share. A genuine >=200-turn real corpus
 * built per spec is overwhelmingly real-evidence, so it clears these easily; the
 * current 263-item seed (7 real_failure items = ~2.7%) is correctly flagged as
 * NOT yet a real gate corpus. These are floors, not the gate: the real gate also
 * needs peer-review sign-off, which is a data/process step out of code scope.
 */
export const DEFAULT_MIN_REAL_EVIDENCE_ITEMS = 20;
export const DEFAULT_MIN_REAL_EVIDENCE_SHARE = 0.1;

export interface ValidateGoldenCorpusOptions {
  /** Absolute floor on real-evidence items. Default DEFAULT_MIN_REAL_EVIDENCE_ITEMS. */
  minRealEvidenceItems?: number;
  /** Floor on real-evidence share (0..1). Default DEFAULT_MIN_REAL_EVIDENCE_SHARE. */
  minRealEvidenceShare?: number;
}

export function countRealEvidenceItems(corpus: ChatCoreV2GoldenCorpus): number {
  return corpus.items.filter((item) => REAL_EVIDENCE_CORPUS_SOURCES.has(item.source)).length;
}

export function validateGoldenCorpus(
  corpus: ChatCoreV2GoldenCorpus,
  minimumItems = 200,
  options: ValidateGoldenCorpusOptions = {},
): ChatCoreV2GoldenCorpusIssue[] {
  const minRealEvidenceItems = options.minRealEvidenceItems ?? DEFAULT_MIN_REAL_EVIDENCE_ITEMS;
  const minRealEvidenceShare = options.minRealEvidenceShare ?? DEFAULT_MIN_REAL_EVIDENCE_SHARE;

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

  // WP-09: a real gate corpus must carry a MINIMUM count AND share of real
  // evidence — not merely >=1. Below either floor it is still synthetic-only.
  const realEvidenceItems = countRealEvidenceItems(corpus);
  const realEvidenceShare = corpus.items.length === 0 ? 0 : realEvidenceItems / corpus.items.length;
  if (realEvidenceItems < minRealEvidenceItems || realEvidenceShare < minRealEvidenceShare) {
    issues.push('synthetic_only');
  }

  return [...new Set(issues)];
}

function hasAllLanguages(items: ChatCoreV2GoldenCorpusItem[]): boolean {
  const languages = new Set(items.map((item) => item.language));
  return languages.has('en') && languages.has('pt-BR') && languages.has('pt-PT') && languages.has('mixed');
}
