// Milestone 4 — deterministic manifest intent resolver.
//
// The manifest is iterated GENERICALLY: no capability id is named in the
// example-utterance assertions, which proves the resolver carries no
// hardcoded per-capability behavior.

import { beforeEach, describe, expect, it } from 'vitest';

import { loadCapabilityManifest } from '../../../src/services/capability-manifest';
import {
  resolveIntent,
  resolveIntentAgainst,
} from '../../../src/services/intent-resolution/intent-resolver';
import {
  compileIntentVocabulary,
  getCompiledIntentVocabulary,
  resetIntentVocabularyForTests,
  type IntentVocabularySourceEntry,
} from '../../../src/services/intent-resolution/vocabulary';

describe('manifest intent resolver', () => {
  beforeEach(() => {
    resetIntentVocabularyForTests();
  });

  it('resolves every seeded example utterance to its own capability (generic manifest iteration)', () => {
    const manifest = loadCapabilityManifest();
    const seeded = manifest.capabilities.filter(
      (entry) => (entry.routingVocabulary?.exampleUtterances?.length ?? 0) > 0,
    );
    expect(seeded.length).toBe(manifest.capabilities.length); // every capability is seeded

    for (const entry of seeded) {
      for (const utterance of entry.routingVocabulary!.exampleUtterances!) {
        const candidates = resolveIntent(utterance);
        expect(candidates.length, `${entry.id} :: ${utterance}`).toBeGreaterThan(0);
        expect(candidates[0].capabilityId, `${entry.id} :: ${utterance}`).toBe(entry.id);
        expect(candidates[0].domain).toBe(entry.runtimeRouting.domain);
        expect(candidates[0].rawScore).toBeGreaterThan(0);
        expect(candidates[0].matchedEvidence.length).toBeGreaterThan(0);
      }
    }
  });

  it('is deterministic and ranked by descending score', () => {
    const manifest = loadCapabilityManifest();
    for (const entry of manifest.capabilities) {
      for (const utterance of entry.routingVocabulary?.exampleUtterances ?? []) {
        const first = resolveIntent(utterance);
        const second = resolveIntent(utterance);
        expect(second).toEqual(first);
        for (let i = 1; i < first.length; i++) {
          expect(first[i - 1].rawScore).toBeGreaterThanOrEqual(first[i].rawScore);
        }
      }
    }
  });

  it('makes a synthetic manifest entry resolvable without any code change', () => {
    const synthetic: IntentVocabularySourceEntry = {
      id: 'stargazing',
      runtimeRouting: { domain: 'stargazing', chatOwnerSkill: 'stargazing' },
      chatOwnerSkills: ['stargazing'],
      routingVocabulary: {
        locales: { en: ['telescopes?', 'constellations?', 'meteor\\s+shower'] },
        regexFragments: ['\\b(point|aim)\\b[\\s\\S]{0,40}\\b(telescope|lens)\\b'],
        exampleUtterances: ['where should I point my telescope tonight'],
      },
    };
    const vocabulary = compileIntentVocabulary([
      ...getCompiledIntentVocabularySource(),
      synthetic,
    ]);

    const candidates = resolveIntentAgainst(vocabulary, 'where should I point my telescope tonight');
    expect(candidates[0].capabilityId).toBe('stargazing');
    expect(candidates[0].skill).toBe('stargazing');

    const keywordOnly = resolveIntentAgainst(vocabulary, 'is there a meteor shower this weekend?');
    expect(keywordOnly.some((candidate) => candidate.capabilityId === 'stargazing')).toBe(true);
  });

  it('applies the optional context nudge only as a deterministic tie-break aid', () => {
    const text = 'what should I do next?';
    const without = resolveIntent(text);
    const withContext = resolveIntent(text, { activeDomain: 'cooking' });
    // The nudge never invents candidates.
    expect(withContext.map((c) => c.capabilityId).sort()).toEqual(
      without.map((c) => c.capabilityId).sort(),
    );
  });

  it('compiles the vocabulary once (lazy singleton) and supports explicit reset', () => {
    const first = getCompiledIntentVocabulary();
    expect(getCompiledIntentVocabulary()).toBe(first);
    resetIntentVocabularyForTests();
    const second = getCompiledIntentVocabulary();
    expect(second).not.toBe(first);
    expect(second.map((entry) => entry.capabilityId)).toEqual(first.map((entry) => entry.capabilityId));
  });
});

function getCompiledIntentVocabularySource(): IntentVocabularySourceEntry[] {
  return loadCapabilityManifest().capabilities.map((entry) => ({
    id: entry.id,
    runtimeRouting: entry.runtimeRouting,
    chatOwnerSkills: entry.chatOwnerSkills,
    routingVocabulary: entry.routingVocabulary,
  }));
}
