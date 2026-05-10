import { describe, expect, it } from 'vitest';

import { getPendingTasksCacheKey } from '../../src/api/routes/chat-fastpath';

describe('chat fastpath pending-task cache tenant isolation', () => {
  it('includes tenantId so equal user ids in different tenants cannot share pending-task cache', () => {
    const tenantA = getPendingTasksCacheKey(42, 1001);
    const tenantB = getPendingTasksCacheKey(42, 2002);

    expect(tenantA).toBe('u:42:t:1001:fastpath:pending-tasks');
    expect(tenantB).toBe('u:42:t:2002:fastpath:pending-tasks');
    expect(tenantA).not.toBe(tenantB);
  });

  it('does not preserve the legacy user-only cache key format', () => {
    expect(getPendingTasksCacheKey(42, 1001)).not.toBe('u:42:fastpath:pending-tasks');
  });
});
