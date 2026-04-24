import { describe, expect, it } from 'vitest';
import { isLikelyEmail, safeJsonArray, safeJsonObject } from '../../src/portal/validation';

describe('portal validation helpers', () => {
  it('defensively parses JSON arrays from persisted text', () => {
    expect(safeJsonArray(null)).toEqual([]);
    expect(safeJsonArray('')).toEqual([]);
    expect(safeJsonArray('not json')).toEqual([]);
    expect(safeJsonArray('{"a":1}')).toEqual([]);
    expect(safeJsonArray('[1,"two"]')).toEqual([1, 'two']);
  });

  it('defensively parses JSON objects from persisted text', () => {
    expect(safeJsonObject(undefined)).toEqual({});
    expect(safeJsonObject('not json')).toEqual({});
    expect(safeJsonObject('[1,2]')).toEqual({});
    expect(safeJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('rejects obviously invalid founder emails without overreaching into full RFC validation', () => {
    expect(isLikelyEmail('founder@nexushub.me')).toBe(true);
    expect(isLikelyEmail(' founder@nexushub.me ')).toBe(true);
    expect(isLikelyEmail('notanemail')).toBe(false);
    expect(isLikelyEmail('x@')).toBe(false);
    expect(isLikelyEmail('x@example')).toBe(false);
    expect(isLikelyEmail('a b@example.com')).toBe(false);
    expect(isLikelyEmail('a@@example.com')).toBe(false);
  });
});
