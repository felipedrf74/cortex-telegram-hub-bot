// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 12 — per-domain projections of the compiled manifest vocabulary.
 *
 * The four legacy routing surfaces keep their own decision logic (precedence
 * tiers, intent-kind classification, thresholds, safety filters) but, when
 * their surface flag is on, source their DOMAIN VOCABULARY evidence from the
 * shared compiled manifest instead of inline regexes. This module is that
 * projection: "does the manifest vocabulary for domain D match this text?".
 *
 * Deliberately NOT projected from the manifest (code-owned forever):
 *   - safety filters (unsafe-access, finance restricted actions),
 *   - intent-kind matchers (scheduling / action / destructive / read-question),
 *   - sub-domain discriminators the manifest cannot express (e.g. the
 *     chat-core-v2 tasks-vs-secretary split, registry calendar/reminder/mail
 *     granularity) — those stay inline at their surface.
 *
 * Matching mirrors resolveIntent: each matcher is tested against the raw text
 * AND the accent-folded text, so accent-free vocabulary still matches
 * accented input.
 */

import {
  foldIntentText,
  getCompiledIntentVocabulary,
  type CompiledCapabilityVocabulary,
} from './vocabulary';
import { resolveIntent } from './intent-resolver';

/**
 * Decisive-evidence bar shared by surfaces that must not act on weak
 * fragment-union hits: a domain qualifies when the resolver saw at least this
 * raw score (an example-utterance match alone scores 5; four independent
 * matcher hits also qualify). M12 parity measurement showed scores of 1–3 are
 * ambiguous across surfaces (the same score maps to both match and no-match
 * legacy outcomes), while >=4 tracked corpus-correct domains.
 */
export const MANIFEST_DECISIVE_EVIDENCE_MIN_SCORE = 4;

/** Per-domain best resolver rawScore for the text (absent = no evidence). */
export function manifestDomainScores(text: string): Map<string, number> {
  const scores = new Map<string, number>();
  for (const candidate of resolveIntent(text)) {
    const existing = scores.get(candidate.domain);
    if (existing === undefined || candidate.rawScore > existing) {
      scores.set(candidate.domain, candidate.rawScore);
    }
  }
  return scores;
}

/** Domains whose resolver evidence meets the decisive bar. */
export function manifestDecisiveDomains(text: string): Set<string> {
  const decisive = new Set<string>();
  for (const [domain, score] of manifestDomainScores(text)) {
    if (score >= MANIFEST_DECISIVE_EVIDENCE_MIN_SCORE) decisive.add(domain);
  }
  return decisive;
}

/** All matchers (locale terms + fragments) for one legacy runtime domain. */
function matchersForDomain(domain: string): CompiledCapabilityVocabulary[] {
  return getCompiledIntentVocabulary().filter((entry) => entry.domain === domain);
}

/**
 * True when any compiled manifest matcher for `domain` matches the text
 * (raw or accent-folded — same evidence rule as resolveIntent).
 */
export function manifestDomainMatches(domain: string, text: string): boolean {
  const raw = text ?? '';
  const folded = foldIntentText(raw);
  for (const entry of matchersForDomain(domain)) {
    for (const matcher of entry.matchers) {
      if (matcher.regex.test(raw) || matcher.regex.test(folded)) return true;
    }
  }
  return false;
}

/** Set of legacy runtime domains with at least one vocabulary match. */
export function manifestMatchedDomains(text: string): Set<string> {
  const raw = text ?? '';
  const folded = foldIntentText(raw);
  const matched = new Set<string>();
  for (const entry of getCompiledIntentVocabulary()) {
    if (matched.has(entry.domain)) continue;
    for (const matcher of entry.matchers) {
      if (matcher.regex.test(raw) || matcher.regex.test(folded)) {
        matched.add(entry.domain);
        break;
      }
    }
  }
  return matched;
}

/**
 * Locale-tier projection: only `locale:*` matchers (the manifest's simple
 * per-language keyword terms) count; `fragment:*` matchers (verbatim complex
 * regexes lifted from the richer surfaces) are excluded. The chat-core-v2
 * shadow surface consumes this tier because its legacy vocabulary was exactly
 * the per-language keyword lists the manifest locales were extracted from —
 * projecting the full fragment union there measurably over-matches.
 */
export function manifestDomainMatchesLocaleTier(domain: string, text: string): boolean {
  const raw = text ?? '';
  const folded = foldIntentText(raw);
  for (const entry of matchersForDomain(domain)) {
    for (const matcher of entry.matchers) {
      if (!matcher.label.startsWith('locale:')) continue;
      if (matcher.regex.test(raw) || matcher.regex.test(folded)) return true;
    }
  }
  return false;
}
