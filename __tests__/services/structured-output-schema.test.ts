import { describe, expect, it } from 'vitest';

import {
  canonicalizeStructuredOutputSchema,
  validateStructuredOutputSchema,
  validateStructuredOutputValue,
} from '../../src/services/structured-output-schema';

describe('structured output schema boundary', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer', 'scores'],
    properties: {
      answer: { type: 'string', minLength: 1, maxLength: 20 },
      scores: {
        type: 'array',
        minItems: 1,
        maxItems: 2,
        uniqueItems: true,
        items: { type: 'integer', minimum: 0, maximum: 10 },
      },
    },
  } as const;

  it('accepts the supported bounded subset and conforming values', () => {
    expect(validateStructuredOutputSchema(schema)).toEqual({ valid: true });
    expect(validateStructuredOutputValue({ answer: 'ok', scores: [1, 2] }, schema))
      .toEqual({ valid: true });
  });

  it.each([
    [{ answer: '', scores: [1] }, 'string_too_short'],
    [{ answer: 'ok', scores: [11] }, 'number_above_maximum'],
    [{ answer: 'ok', scores: [1, 1] }, 'array_items_not_unique'],
    [{ answer: 'ok', scores: [1], extra: true }, 'additional_property_forbidden'],
    [{ scores: [1] }, 'required_property_missing'],
  ])('rejects non-conforming model output %#', (value, reason) => {
    expect(validateStructuredOutputValue(value, schema)).toEqual({ valid: false, reason });
  });

  it('rejects unsupported or non-JSON schema input before provider dispatch', () => {
    expect(validateStructuredOutputSchema({ type: 'string', format: 'email' }))
      .toEqual({ valid: false, reason: 'unsupported_schema_keyword' });
    expect(validateStructuredOutputSchema({ type: 'string', const: undefined }))
      .toEqual({ valid: false, reason: 'schema_not_json_serializable' });
  });

  it('canonicalizes schema object keys deterministically', () => {
    expect(canonicalizeStructuredOutputSchema({ required: ['x'], type: 'object' }))
      .toBe('{"required":["x"],"type":"object"}');
  });
});
