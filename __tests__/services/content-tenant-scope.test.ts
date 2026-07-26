import { describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
}));

vi.mock('../../src/services/database', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/database')>(
    '../../src/services/database',
  );
  return {
    ...actual,
    getDb: getDbMock,
  };
});

import {
  contentPrivateScopeParams,
  contentPrivateScopePredicate,
} from '../../src/services/content-tenant-scope';

describe('content tenant private scope', () => {
  it('builds the strict unaliased legacy-safe private predicate', () => {
    expect(contentPrivateScopePredicate()).toBe(`(
    COALESCE(scope_status, CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END) = 'active'
    AND COALESCE(visibility_scope, CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END) = 'user_private'
    AND COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) = ?
    AND COALESCE(owner_user_id, user_id, 0) = ?
  )`);
  });

  it('qualifies every private-scope column with the requested alias', () => {
    expect(contentPrivateScopePredicate('candidate')).toBe(`(
    COALESCE(candidate.scope_status, CASE WHEN candidate.user_id > 0 THEN 'active' ELSE 'quarantined' END) = 'active'
    AND COALESCE(candidate.visibility_scope, CASE WHEN candidate.user_id > 0 THEN 'user_private' ELSE 'platform_internal' END) = 'user_private'
    AND COALESCE(candidate.tenant_id, CASE WHEN candidate.user_id > 0 THEN candidate.user_id ELSE 0 END) = ?
    AND COALESCE(candidate.owner_user_id, candidate.user_id, 0) = ?
  )`);
  });

  it('binds an explicit positive tenant and authenticated owner in predicate order', () => {
    expect(contentPrivateScopeParams(41, 904)).toEqual([904, 41]);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['zero', 0],
    ['negative', -9],
    ['not finite', Number.POSITIVE_INFINITY],
  ])('falls back to the authenticated user for a %s tenant', (_label, tenantId) => {
    expect(contentPrivateScopeParams(41, tenantId)).toEqual([41, 41]);
  });
});
