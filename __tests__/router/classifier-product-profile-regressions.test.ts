import { describe, expect, it } from 'vitest';

import { keywordMatch } from '../../src/router/classifier';
import { PRODUCT_PROFILE_ROUTING_CASES } from '../fixtures/product-profile-routing-regressions';

describe('legacy classifier product-profile regressions', () => {
  it.each(PRODUCT_PROFILE_ROUTING_CASES)(
    'routes %s to %s',
    (message, expectedDomain) => {
      expect(keywordMatch(message)).toBe(expectedDomain);
    },
  );
});
