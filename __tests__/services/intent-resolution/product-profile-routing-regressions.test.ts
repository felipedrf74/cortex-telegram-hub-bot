import { beforeEach, describe, expect, it } from 'vitest';

import { resolveIntent } from '../../../src/services/intent-resolution/intent-resolver';
import { resetIntentVocabularyForTests } from '../../../src/services/intent-resolution/vocabulary';
import { PRODUCT_PROFILE_ROUTING_CASES } from '../../fixtures/product-profile-routing-regressions';

describe('product-profile routing regressions from governed synthetic staging QA', () => {
  beforeEach(() => {
    resetIntentVocabularyForTests();
  });

  it.each(PRODUCT_PROFILE_ROUTING_CASES)(
    'manifest resolver routes %s to %s/%s',
    (message, expectedDomain, expectedSkill) => {
      expect(resolveIntent(message)[0]).toMatchObject({
        domain: expectedDomain,
        skill: expectedSkill,
      });
    },
  );
});
