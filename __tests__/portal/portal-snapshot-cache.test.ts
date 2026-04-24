import { describe, expect, it, beforeEach } from 'vitest';
import {
  clearPortalSnapshotCache,
  getCachedPortalSnapshot,
  setCachedPortalSnapshot,
} from '../../src/portal/snapshot-cache';

describe('portal snapshot cache', () => {
  beforeEach(() => {
    clearPortalSnapshotCache();
  });

  it('returns cached snapshots while the TTL is valid', () => {
    setCachedPortalSnapshot({ version: 'test' }, 1_000);

    expect(getCachedPortalSnapshot<{ version: string }>(3_999, 3_000)).toEqual({ version: 'test' });
  });

  it('expires cached snapshots at the TTL boundary', () => {
    setCachedPortalSnapshot({ version: 'test' }, 1_000);

    expect(getCachedPortalSnapshot(4_000, 3_000)).toBeNull();
  });

  it('clears cached snapshots explicitly after mutations', () => {
    setCachedPortalSnapshot({ version: 'test' }, 1_000);

    clearPortalSnapshotCache();

    expect(getCachedPortalSnapshot(1_001, 3_000)).toBeNull();
  });
});

