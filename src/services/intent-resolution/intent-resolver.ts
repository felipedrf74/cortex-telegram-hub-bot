// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 4 — deterministic shadow intent resolver.
 *
 * Resolves a message against the CapabilityManifest routing vocabulary and
 * returns ranked candidates. Purely deterministic (regex evidence counting —
 * no LLM, no I/O, no randomness). Nothing on the live routing path consumes
 * this; the shadow-route hook records its top candidate for divergence
 * telemetry only.
 *
 * Scoring:
 *   +1   per distinct matched vocabulary matcher (locale term or fragment)
 *   +5   when the message normalizes to a seeded example utterance
 *   +0.25 context nudge when the caller's active domain matches (tie-break aid)
 * Ties break on manifest order, keeping the ranking stable across runs.
 */

import {
  foldIntentText,
  getCompiledIntentVocabulary,
  normalizeUtterance,
  type CompiledCapabilityVocabulary,
} from './vocabulary';

export const INTENT_RESOLVER_VERSION = 'manifest-intent-resolver@1.0.0';

const EXAMPLE_MATCH_SCORE = 5;
const MATCHER_SCORE = 1;
const CONTEXT_NUDGE_SCORE = 0.25;

export interface IntentResolutionContext {
  /** Active conversation domain, if any (legacy DomainName space). */
  activeDomain?: string | null;
}

export interface IntentCandidate {
  capabilityId: string;
  domain: string;
  skill: string;
  rawScore: number;
  matchedEvidence: string[];
}

/** Resolve against an explicit compiled vocabulary (test seam / synthetic entries). */
export function resolveIntentAgainst(
  vocabulary: readonly CompiledCapabilityVocabulary[],
  text: string,
  context?: IntentResolutionContext,
): IntentCandidate[] {
  const raw = text ?? '';
  const folded = foldIntentText(raw);
  const normalized = normalizeUtterance(raw);
  const candidates: Array<IntentCandidate & { order: number }> = [];

  for (const entry of vocabulary) {
    const matchedEvidence: string[] = [];
    let rawScore = 0;
    for (const matcher of entry.matchers) {
      if (matcher.regex.test(raw) || matcher.regex.test(folded)) {
        matchedEvidence.push(matcher.label);
        rawScore += MATCHER_SCORE;
      }
    }
    if (normalized.length > 0 && entry.normalizedExamples.includes(normalized)) {
      matchedEvidence.push('example_utterance');
      rawScore += EXAMPLE_MATCH_SCORE;
    }
    if (rawScore === 0) continue;
    if (context?.activeDomain && context.activeDomain === entry.domain) {
      matchedEvidence.push('context:active_domain');
      rawScore += CONTEXT_NUDGE_SCORE;
    }
    candidates.push({
      capabilityId: entry.capabilityId,
      domain: entry.domain,
      skill: entry.skill,
      rawScore,
      matchedEvidence,
      order: entry.order,
    });
  }

  candidates.sort((left, right) => right.rawScore - left.rawScore || left.order - right.order);
  return candidates.map(({ order: _order, ...candidate }) => candidate);
}

/** Resolve against the manifest-backed compiled vocabulary singleton. */
export function resolveIntent(text: string, context?: IntentResolutionContext): IntentCandidate[] {
  return resolveIntentAgainst(getCompiledIntentVocabulary(), text, context);
}
