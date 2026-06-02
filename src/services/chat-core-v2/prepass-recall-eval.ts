// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Read-only recall@k measurement for the deterministic Layer-1 prepass
 * candidate selection, evaluated over a LABELED corpus.
 *
 * recall@k = fraction of labeled turns whose ground-truth capability appears in
 * the prepass top-k candidate set (the prepass caps candidates at
 * CHAT_CORE_V2_PREPASS_MAX_CANDIDATES = 8, so recall@8 covers the full set).
 *
 * This is the measurement primitive for the Phase 2 "recall@8" gate. It does
 * NOT by itself satisfy the gate, which requires a peer-reviewed labeled corpus
 * (the synthetic/seed corpus is a baseline, not the real corpus). Pure
 * function: no IO, no provider calls, and no ground-truth leakage — candidate
 * capabilities are derived only from the message text.
 */

import { selectPrepassCandidateCapabilities } from './prepass-candidate-selection';
import type {
  ChatCoreV2CorpusLanguage,
  ChatCoreV2GoldenCorpus,
  ChatCoreV2GoldenCorpusItem,
} from './golden-corpus';

export const CHAT_CORE_V2_PREPASS_RECALL_EVAL_VERSION = 'chat_core_v2_prepass_recall_eval@1.0.0';
export const CHAT_CORE_V2_PREPASS_RECALL_LANGUAGE_TARGETS: Readonly<Record<ChatCoreV2CorpusLanguage, number>> = {
  en: 0.98,
  'pt-BR': 0.97,
  'pt-PT': 0.92,
  mixed: 0.90,
};
export const CHAT_CORE_V2_PREPASS_RECALL_LANGUAGES: readonly ChatCoreV2CorpusLanguage[] = [
  'en',
  'pt-BR',
  'pt-PT',
  'mixed',
];

export interface PrepassRecallEvalItem {
  message: string;
  expectedCapabilityIds: string[];
  language?: ChatCoreV2CorpusLanguage;
}

export interface PrepassRecallMiss {
  expectedCapabilityIds: string[];
  candidateCapabilityIds: string[];
  language?: ChatCoreV2CorpusLanguage;
  /** Synthetic/labeled-corpus message only (test fixtures), capped for review. */
  message: string;
}

export interface PrepassRecallLanguageBucket {
  total: number;
  scored: number;
  hits: number;
  recallAtK: number;
}

export interface PrepassRecallAtKResult {
  version: string;
  k: number;
  total: number;
  /** Items that carried at least one ground-truth capability. */
  scored: number;
  hits: number;
  /** hits / scored (0 when nothing was scorable). */
  recallAtK: number;
  /** Per-language recall, used by the Phase 2 gate. */
  byLanguage: Partial<Record<ChatCoreV2CorpusLanguage, PrepassRecallLanguageBucket>>;
  misses: PrepassRecallMiss[];
}

export type PrepassCandidateProducer = (message: string) => string[];

const defaultPrepassCandidateProducer: PrepassCandidateProducer = (message) =>
  selectPrepassCandidateCapabilities({ message }).candidateCapabilityIds;

const MAX_RECORDED_MISSES = 50;
const MAX_MISS_MESSAGE_CHARS = 200;

export function evaluatePrepassRecallAtK(
  items: PrepassRecallEvalItem[],
  k = 8,
  produce: PrepassCandidateProducer = defaultPrepassCandidateProducer,
): PrepassRecallAtKResult {
  const safeK = Math.max(1, Math.trunc(k));
  let scored = 0;
  let hits = 0;
  const misses: PrepassRecallMiss[] = [];
  const byLanguage: Partial<Record<ChatCoreV2CorpusLanguage, MutablePrepassRecallLanguageBucket>> = {};

  for (const item of items) {
    const language = normalizeCorpusLanguage(item.language);
    if (language) {
      byLanguage[language] ??= { total: 0, scored: 0, hits: 0 };
      byLanguage[language].total += 1;
    }
    const expected = (item.expectedCapabilityIds ?? []).filter(
      (id) => typeof id === 'string' && id.trim().length > 0,
    );
    if (expected.length === 0) continue;
    scored += 1;
    if (language) byLanguage[language]!.scored += 1;

    const topK = produce(item.message).slice(0, safeK);
    const hit = expected.some((id) => topK.includes(id));
    if (hit) {
      hits += 1;
      if (language) byLanguage[language]!.hits += 1;
    } else if (misses.length < MAX_RECORDED_MISSES) {
      misses.push({
        expectedCapabilityIds: expected,
        candidateCapabilityIds: topK,
        language,
        message: item.message.slice(0, MAX_MISS_MESSAGE_CHARS),
      });
    }
  }

  return {
    version: CHAT_CORE_V2_PREPASS_RECALL_EVAL_VERSION,
    k: safeK,
    total: items.length,
    scored,
    hits,
    recallAtK: scored === 0 ? 0 : hits / scored,
    byLanguage: finalizeLanguageBuckets(byLanguage),
    misses,
  };
}

export function evaluateGoldenCorpusPrepassRecallAtK(
  corpus: ChatCoreV2GoldenCorpus,
  k = 8,
  produce?: PrepassCandidateProducer,
): PrepassRecallAtKResult {
  const items: PrepassRecallEvalItem[] = corpus.items.map((item: ChatCoreV2GoldenCorpusItem) => ({
    message: item.message,
    expectedCapabilityIds: item.expectedCapabilityIds,
    language: item.language,
  }));
  return evaluatePrepassRecallAtK(items, k, produce);
}

type MutablePrepassRecallLanguageBucket = Omit<PrepassRecallLanguageBucket, 'recallAtK'>;

function normalizeCorpusLanguage(value: unknown): ChatCoreV2CorpusLanguage | undefined {
  return value === 'en' || value === 'pt-BR' || value === 'pt-PT' || value === 'mixed'
    ? value
    : undefined;
}

function finalizeLanguageBuckets(
  buckets: Partial<Record<ChatCoreV2CorpusLanguage, MutablePrepassRecallLanguageBucket>>,
): Partial<Record<ChatCoreV2CorpusLanguage, PrepassRecallLanguageBucket>> {
  const result: Partial<Record<ChatCoreV2CorpusLanguage, PrepassRecallLanguageBucket>> = {};
  for (const language of Object.keys(buckets) as ChatCoreV2CorpusLanguage[]) {
    const bucket = buckets[language];
    if (!bucket) continue;
    result[language] = {
      ...bucket,
      recallAtK: bucket.scored === 0 ? 0 : bucket.hits / bucket.scored,
    };
  }
  return result;
}
