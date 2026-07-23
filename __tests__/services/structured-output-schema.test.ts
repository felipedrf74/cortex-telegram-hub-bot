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

  it.each([
    [null, 'schema_must_be_object_or_boolean'],
    [{ title: 7 }, 'invalid_schema_metadata'],
    [{ type: [] }, 'invalid_schema_type'],
    [{ type: ['string', 'unknown'] }, 'invalid_schema_type'],
    [{ enum: 'not-an-array' }, 'invalid_schema_enum'],
    [{ enum: [] }, 'invalid_schema_enum'],
    [{ properties: [] }, 'invalid_schema_properties'],
    [{ properties: { answer: [] } }, 'nested_schema_invalid'],
    [{ required: ['answer', 'answer'] }, 'invalid_schema_required'],
    [{ additionalProperties: [] }, 'nested_schema_invalid'],
    [{ items: [] }, 'nested_schema_invalid'],
    [{ allOf: [] }, 'invalid_schema_composition'],
    [{ anyOf: [null] }, 'nested_schema_invalid'],
    [{ not: [] }, 'nested_schema_invalid'],
    [{ minItems: -1 }, 'invalid_schema_bound'],
    [{ minimum: 'zero' }, 'invalid_schema_bound'],
    [{ multipleOf: 0 }, 'invalid_schema_bound'],
    [{ uniqueItems: 'yes' }, 'invalid_schema_unique_items'],
    [{ pattern: 7 }, 'invalid_schema_pattern'],
    [{ pattern: '[' }, 'invalid_schema_pattern'],
  ])('rejects malformed supported-subset schema %#', (candidate, reason) => {
    expect(validateStructuredOutputSchema(candidate)).toEqual({ valid: false, reason });
  });

  it('bounds serialized schema size and recursive complexity', () => {
    expect(validateStructuredOutputSchema({ description: 'x'.repeat(33 * 1024) }))
      .toEqual({ valid: false, reason: 'schema_too_large' });

    let nested: unknown = { type: 'string' };
    for (let depth = 0; depth < 26; depth += 1) nested = { not: nested };
    expect(validateStructuredOutputSchema(nested))
      .toEqual({ valid: false, reason: 'schema_too_complex' });
  });

  it.each([
    ['anything', false, { valid: false, reason: 'boolean_schema_rejected' }],
    ['actual', { const: 'expected' }, { valid: false, reason: 'const_mismatch' }],
    ['actual', { enum: ['expected'] }, { valid: false, reason: 'enum_mismatch' }],
    [Number.NaN, { type: 'number' }, { valid: false, reason: 'type_mismatch' }],
    ['a', { allOf: [{ type: 'string' }, { minLength: 2 }] }, { valid: false, reason: 'all_of_mismatch' }],
    [true, { anyOf: [{ type: 'string' }, { type: 'number' }] }, { valid: false, reason: 'any_of_mismatch' }],
    [1, { oneOf: [{ type: 'number' }, { minimum: 0 }] }, { valid: false, reason: 'one_of_mismatch' }],
    ['blocked', { not: { type: 'string' } }, { valid: false, reason: 'not_schema_mismatch' }],
    ['toolong', { type: 'string', maxLength: 3 }, { valid: false, reason: 'string_too_long' }],
    ['abc', { type: 'string', pattern: '^z' }, { valid: false, reason: 'pattern_mismatch' }],
    [-1, { type: 'number', minimum: 0 }, { valid: false, reason: 'number_below_minimum' }],
    [1, { type: 'number', exclusiveMinimum: 1 }, { valid: false, reason: 'number_below_exclusive_minimum' }],
    [3, { type: 'number', exclusiveMaximum: 3 }, { valid: false, reason: 'number_above_exclusive_maximum' }],
    [3, { type: 'number', multipleOf: 2 }, { valid: false, reason: 'number_not_multiple' }],
    [[], { type: 'array', minItems: 1 }, { valid: false, reason: 'array_too_short' }],
    [[1, 2], { type: 'array', maxItems: 1 }, { valid: false, reason: 'array_too_long' }],
    [{}, { type: 'object', minProperties: 1 }, { valid: false, reason: 'object_too_small' }],
    [{ a: 1, b: 2 }, { type: 'object', maxProperties: 1 }, { valid: false, reason: 'object_too_large' }],
    [{ extra: 'wrong' }, {
      type: 'object',
      additionalProperties: { type: 'number' },
    }, { valid: false, reason: 'type_mismatch' }],
  ])('validates composition and bounded value branch %#', (value, candidateSchema, expected) => {
    expect(validateStructuredOutputValue(value, candidateSchema)).toEqual(expected);
  });

  it('supports boolean schemas, union types, and deep JSON const/enum equality', () => {
    const nested = { answer: ['bounded', { score: 1 }] };

    expect(validateStructuredOutputValue(nested, { const: nested })).toEqual({ valid: true });
    expect(validateStructuredOutputValue(nested, { enum: [nested] })).toEqual({ valid: true });
    expect(validateStructuredOutputValue(null, { type: ['string', 'null'] })).toEqual({ valid: true });
    expect(validateStructuredOutputValue(true, { type: 'boolean' })).toEqual({ valid: true });
    expect(validateStructuredOutputValue('anything', true)).toEqual({ valid: true });
    expect(validateStructuredOutputValue(
      { extra: 3 },
      { type: 'object', additionalProperties: { type: 'number' } },
    )).toEqual({ valid: true });
  });

  it('canonicalizes schema object keys deterministically', () => {
    expect(canonicalizeStructuredOutputSchema({ required: ['x'], type: 'object' }))
      .toBe('{"required":["x"],"type":"object"}');
  });
});
