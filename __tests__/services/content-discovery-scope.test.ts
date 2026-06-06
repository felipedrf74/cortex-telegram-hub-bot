import { describe, expect, it } from 'vitest';

import { runContentDiscovery } from '../../src/services/content-discovery';

describe('content discovery user scope', () => {
  it('rejects missing or invalid user scope before provider calls or saved-idea writes', async () => {
    await expect(runContentDiscovery(undefined as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 0 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: 1.5 } as any)).rejects.toThrow(/userId required/);
    await expect(runContentDiscovery({ userId: Number.MAX_SAFE_INTEGER + 1 } as any)).rejects.toThrow(/userId required/);
  });

  it('rejects authenticated discovery without validated tenant scope', async () => {
    await expect(runContentDiscovery({ userId: 42 } as any)).rejects.toThrow(/runContentDiscovery requires a validated tenantId/);
  });
});
