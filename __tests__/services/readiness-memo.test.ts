import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearReadinessMemoForTests,
  getReadinessMemo,
  invalidateReadinessMemoForUser,
  setReadinessMemo,
} from '../../src/services/readiness-memo';

describe('readiness memo tenant scoping', () => {
  beforeEach(() => {
    clearReadinessMemoForTests();
  });

  it('evicts every tenant scope for one user without touching suffix-like users', () => {
    setReadinessMemo(2, 2, { source: 'estimated' }, 100);
    setReadinessMemo(9, 2, { source: 'apple_health' }, 101);
    setReadinessMemo(2, 12, { source: 'whoop' }, 102);
    setReadinessMemo(2, 22, { source: 'garmin' }, 103);

    invalidateReadinessMemoForUser(2);

    expect(getReadinessMemo(2, 2)).toBeUndefined();
    expect(getReadinessMemo(9, 2)).toBeUndefined();
    expect(getReadinessMemo(2, 12)?.result).toEqual({ source: 'whoop' });
    expect(getReadinessMemo(2, 22)?.result).toEqual({ source: 'garmin' });
  });
});
