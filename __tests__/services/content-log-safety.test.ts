// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  contentLogFingerprint,
  safeContentLogErrorFields,
} from '../../src/services/content-log-safety';

describe('content log safety', () => {
  it('retains bounded machine identifiers without exposing messages or stacks', () => {
    const error = Object.assign(new Error('private provider response'), {
      name: 'Provider Error With Spaces',
      code: 'UPSTREAM_PRIVATE_FAILURE',
      stack: 'private stack',
    });

    expect(safeContentLogErrorFields(error)).toEqual({
      errorName: 'Provider_Error_With_Spaces',
      errorCode: 'UPSTREAM_PRIVATE_FAILURE',
      errorFingerprint: contentLogFingerprint('private provider response'),
    });
    const serialized = JSON.stringify(safeContentLogErrorFields(error));
    expect(serialized).not.toContain('private provider response');
    expect(serialized).not.toContain('private stack');
  });

  it('fingerprints private inputs deterministically without echoing them', () => {
    const privateInput = 'https://youtube.com/watch?v=private-user-video';
    const fingerprint = contentLogFingerprint(privateInput);

    expect(fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprint).toBe(contentLogFingerprint(privateInput));
    expect(fingerprint).not.toContain('private-user-video');
  });

  it('drops provider fields that are not already bounded machine codes', () => {
    expect(safeContentLogErrorFields(Object.assign(new Error('private response'), {
      code: 'customer secret copied into code',
    }))).toEqual({
      errorName: 'Error',
      errorFingerprint: contentLogFingerprint('private response'),
    });
    expect(safeContentLogErrorFields(Object.assign(new Error('private response'), {
      code: 'X'.repeat(81),
    }))).toEqual({
      errorName: 'Error',
      errorFingerprint: contentLogFingerprint('private response'),
    });
  });
});
