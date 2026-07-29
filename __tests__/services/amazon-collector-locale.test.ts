// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { AMAZON_BROWSER_LOCALE } from '../../src/services/amazon-collector';

describe('amazon collector browser locale', () => {
  it('uses a supported product locale instead of retired Spanish', () => {
    expect(AMAZON_BROWSER_LOCALE).toBe('en-US');
    expect(AMAZON_BROWSER_LOCALE.toLowerCase()).not.toMatch(/^es(?:[-_]|$)/);
  });
});
