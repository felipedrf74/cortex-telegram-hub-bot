// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import { describe, expect, it } from 'vitest';
import { hashEmail, normalizeEmailForIdentity } from '../../src/utils/identity';

describe('identity utilities', () => {
  it('normalizes ASCII email casing and surrounding whitespace before hashing', () => {
    const expected = crypto.createHash('sha256').update('felipe@example.com', 'utf8').digest('hex');

    expect(hashEmail('  Felipe@Example.COM  ')).toBe(expected);
    expect(normalizeEmailForIdentity('  Felipe@Example.COM  ')).toBe('felipe@example.com');
  });

  it('uses a single Unicode normalization order across audit and email logs', () => {
    const left = hashEmail('\tİREM@example.com ');
    const right = crypto.createHash('sha256').update('i̇rem@example.com', 'utf8').digest('hex');

    expect(left).toBe(right);
  });

  it('supports deterministic truncation for compact log correlation keys', () => {
    expect(hashEmail('person@example.com', 16)).toBe(hashEmail('person@example.com').slice(0, 16));
  });

  it('returns different hashes for different normalized inputs', () => {
    expect(hashEmail('a@example.com')).not.toBe(hashEmail('b@example.com'));
  });
});
