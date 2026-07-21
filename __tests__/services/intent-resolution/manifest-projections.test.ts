// M12 — per-domain projections of the compiled manifest vocabulary.

import { afterEach, describe, expect, it } from 'vitest';

import {
  compileIntentVocabulary,
  resetIntentVocabularyForTests,
  _setCompiledIntentVocabularyForTests,
} from '../../../src/services/intent-resolution/vocabulary';
import {
  MANIFEST_DECISIVE_EVIDENCE_MIN_SCORE,
  manifestDecisiveDomains,
  manifestDomainMatches,
  manifestDomainMatchesLocaleTier,
  manifestDomainScores,
  manifestMatchedDomains,
} from '../../../src/services/intent-resolution/manifest-projections';

function seedSyntheticVocabulary(): void {
  _setCompiledIntentVocabularyForTests(compileIntentVocabulary([
    {
      id: 'alpha',
      runtimeRouting: { domain: 'alpha_domain', chatOwnerSkill: 'alpha' },
      routingVocabulary: {
        locales: { en: ['alpha', 'alphas?'] },
        regexFragments: ['\\b(quantum\\s+flux)\\b'],
        exampleUtterances: ['the canonical alpha ask'],
      },
    },
    {
      id: 'beta',
      runtimeRouting: { domain: 'beta_domain', chatOwnerSkill: 'beta' },
      routingVocabulary: {
        locales: { pt: ['bét[ao]s?'] },
        regexFragments: [],
      },
    },
  ]));
}

afterEach(() => {
  resetIntentVocabularyForTests();
});

describe('manifest projections', () => {
  it('matches locale terms and fragments in the full projection', () => {
    seedSyntheticVocabulary();
    expect(manifestDomainMatches('alpha_domain', 'give me the alpha summary')).toBe(true);
    expect(manifestDomainMatches('alpha_domain', 'quantum flux please')).toBe(true);
    expect(manifestDomainMatches('alpha_domain', 'nothing to see')).toBe(false);
    expect(manifestMatchedDomains('alpha and bétas')).toEqual(new Set(['alpha_domain', 'beta_domain']));
  });

  it('locale tier excludes fragment-only evidence', () => {
    seedSyntheticVocabulary();
    expect(manifestDomainMatchesLocaleTier('alpha_domain', 'give me the alpha summary')).toBe(true);
    expect(manifestDomainMatchesLocaleTier('alpha_domain', 'quantum flux please')).toBe(false);
  });

  it('matches accent-free vocabulary against accented input via folding', () => {
    seedSyntheticVocabulary();
    // Accented pattern matches its accented form directly.
    expect(manifestDomainMatchesLocaleTier('beta_domain', 'quero as bétas')).toBe(true);
    // Accent-free ASCII vocabulary matches accented input through folding.
    expect(manifestDomainMatchesLocaleTier('alpha_domain', 'álpha por favor')).toBe(true);
  });

  it('scores distinct matchers and treats example utterances as decisive', () => {
    seedSyntheticVocabulary();
    // locale 'alpha' + locale 'alphas?' + fragment => 3 distinct matchers.
    expect(manifestDomainScores('alpha quantum flux').get('alpha_domain')).toBe(3);
    expect(manifestDecisiveDomains('alpha quantum flux').has('alpha_domain')).toBe(false);
    // Example utterance alone crosses the decisive bar.
    const exampleScore = manifestDomainScores('The canonical alpha ask').get('alpha_domain') ?? 0;
    expect(exampleScore).toBeGreaterThanOrEqual(MANIFEST_DECISIVE_EVIDENCE_MIN_SCORE);
    expect(manifestDecisiveDomains('The canonical alpha ask').has('alpha_domain')).toBe(true);
    // Weak single-term evidence is not decisive.
    expect(manifestDecisiveDomains('quero as bétas').has('beta_domain')).toBe(false);
  });

  it('returns nothing with an empty compiled vocabulary', () => {
    _setCompiledIntentVocabularyForTests([]);
    expect(manifestMatchedDomains('create a task about alpha bétas')).toEqual(new Set());
    expect(manifestDomainMatches('alpha_domain', 'alpha')).toBe(false);
    expect(manifestDecisiveDomains('the canonical alpha ask').size).toBe(0);
  });
});
