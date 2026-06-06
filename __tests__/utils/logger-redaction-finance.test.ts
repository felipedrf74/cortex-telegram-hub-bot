import { describe, expect, it } from 'vitest';

import { LOGGER_REDACTION_PATHS } from '../../src/utils/logger';

describe('logger finance redaction paths', () => {
  it('redacts finance PII and sensitive monetary fields at top-level, request body, and error mirrors', () => {
    const paths = new Set<string>(LOGGER_REDACTION_PATHS as unknown as string[]);
    for (const field of [
      'amount',
      'category',
      'merchant',
      'vendor',
      'taxDue',
      'tax_due',
      'gross_income',
      'destinationEmail',
    ]) {
      expect(paths.has(field)).toBe(true);
      expect(paths.has(`body.${field}`)).toBe(true);
      expect(paths.has(`err.${field}`)).toBe(true);
      expect(paths.has(`err.response.data.${field}`)).toBe(true);
    }
  });
});
