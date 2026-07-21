// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 4 — shadow routing-vocabulary compiler.
 *
 * Compiles the CapabilityManifest `routingVocabulary` blocks into reusable
 * matchers exactly ONCE (lazy singleton). Nothing on the live routing path
 * consumes this module; it exists for the deterministic shadow intent
 * resolver and its divergence telemetry.
 *
 * Design constraints (binding):
 *   - No per-call regex construction: matchers are compiled at first use and
 *     cached until resetIntentVocabularyForTests() clears them.
 *   - Purely deterministic: no LLM calls, no I/O beyond the manifest read the
 *     rest of the process already performs.
 *   - Generic over the manifest: capabilities are iterated, never named.
 */

import {
  loadCapabilityManifest,
  type CapabilityManifestEntry,
  type CapabilityRoutingVocabulary,
} from '../capability-manifest';

export interface CompiledVocabularyMatcher {
  /** Stable evidence label, e.g. `locale:pt:tarefas?` or `fragment:3`. */
  label: string;
  regex: RegExp;
}

export interface CompiledCapabilityVocabulary {
  capabilityId: string;
  domain: string;
  /** Owning Chat skill (runtimeRouting.chatOwnerSkill, else first owner skill, else the id). */
  skill: string;
  /** Manifest position — deterministic tie-breaker for equal scores. */
  order: number;
  matchers: CompiledVocabularyMatcher[];
  /** Normalized (trimmed, lowercased, whitespace-collapsed) example utterances. */
  normalizedExamples: string[];
}

/**
 * Minimal manifest-entry surface the compiler needs. Tests can feed synthetic
 * entries through compileIntentVocabulary without building a full manifest.
 */
export type IntentVocabularySourceEntry = Pick<CapabilityManifestEntry, 'id'> & {
  runtimeRouting: { domain: string; chatOwnerSkill: string | null };
  chatOwnerSkills?: string[];
  routingVocabulary?: CapabilityRoutingVocabulary;
};

export function normalizeUtterance(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Accent-fold + lowercase so accent-free vocabulary (registry surface) still matches accented text. */
export function foldIntentText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/** Pure compile step — no caching. Used by the singleton and by tests with synthetic entries. */
export function compileIntentVocabulary(
  entries: readonly IntentVocabularySourceEntry[],
): CompiledCapabilityVocabulary[] {
  const compiled: CompiledCapabilityVocabulary[] = [];
  entries.forEach((entry, order) => {
    const vocabulary = entry.routingVocabulary;
    if (!vocabulary) return;
    const matchers: CompiledVocabularyMatcher[] = [];
    for (const [locale, terms] of Object.entries(vocabulary.locales)) {
      for (const term of terms ?? []) {
        matchers.push({ label: `locale:${locale}:${term}`, regex: new RegExp(`\\b(?:${term})\\b`, 'i') });
      }
    }
    (vocabulary.regexFragments ?? []).forEach((fragment, index) => {
      matchers.push({ label: `fragment:${index}`, regex: new RegExp(fragment, 'i') });
    });
    compiled.push({
      capabilityId: entry.id,
      domain: entry.runtimeRouting.domain,
      skill: entry.runtimeRouting.chatOwnerSkill ?? entry.chatOwnerSkills?.[0] ?? entry.id,
      order,
      matchers,
      normalizedExamples: (vocabulary.exampleUtterances ?? []).map(normalizeUtterance),
    });
  });
  return compiled;
}

let cached: CompiledCapabilityVocabulary[] | null = null;

/** Lazy singleton over the CapabilityManifest — compiled once per process. */
export function getCompiledIntentVocabulary(): CompiledCapabilityVocabulary[] {
  if (!cached) cached = compileIntentVocabulary(loadCapabilityManifest().capabilities);
  return cached;
}

export function resetIntentVocabularyForTests(): void {
  cached = null;
}
