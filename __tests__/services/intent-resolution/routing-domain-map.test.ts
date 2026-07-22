// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { V2_TO_LEGACY_DOMAIN } from '../../../src/services/intent-resolution/routing-domain-map';

describe('provider-free routing domain map', () => {
  it('pins the Chat Core v2 to legacy runtime domain contract', () => {
    expect(V2_TO_LEGACY_DOMAIN).toEqual({
      secretary: 'secretary',
      tasks: 'secretary',
      training: 'triathlon',
      content: 'content',
      cooking: 'cooking',
      finance: 'finance',
      connections: 'connections',
      notifications: 'notifications',
      decision_center: 'decision_center',
    });
    expect(Object.isFrozen(V2_TO_LEGACY_DOMAIN)).toBe(true);
  });
});
