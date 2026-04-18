import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('microsoft-auth refresh token fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('retries with a public MSAL client when Microsoft rejects the client secret for that refresh token', async () => {
    vi.doMock('../../src/config', () => ({
      config: {
        outlook: {
          clientId: 'outlook-client-id',
          clientSecret: 'outlook-client-secret',
          tenantId: 'consumers',
          refreshToken: null,
        },
        telegram: {
          allowedUserIds: [],
        },
      },
    }));
    vi.doMock('../../src/services/user-service', () => ({
      getOwnerBootstrapUserRefs: () => [111111],
    }));

    const confidentialAcquire = vi.fn().mockRejectedValue(
      new Error("AADSTS90023: Public clients can't send a client secret"),
    );
    const publicAcquire = vi.fn().mockResolvedValue({ accessToken: 'public-token' });

    const { __testing, resetMicrosoftClients } = await import('../../src/services/microsoft-auth');
    resetMicrosoftClients();
    __testing.setMsalClientsForTests({
      confidential: { acquireTokenByRefreshToken: confidentialAcquire },
      public: { acquireTokenByRefreshToken: publicAcquire } as any,
    });

    const token = await __testing.acquireAccessTokenFromRefreshToken('refresh-token');

    expect(token).toBe('public-token');
    expect(confidentialAcquire).toHaveBeenCalledTimes(1);
    expect(publicAcquire).toHaveBeenCalledTimes(1);
  });

  it('does not hide non-mismatch refresh token failures', async () => {
    vi.doMock('../../src/config', () => ({
      config: {
        outlook: {
          clientId: 'outlook-client-id',
          clientSecret: 'outlook-client-secret',
          tenantId: 'consumers',
          refreshToken: null,
        },
        telegram: {
          allowedUserIds: [],
        },
      },
    }));
    vi.doMock('../../src/services/user-service', () => ({
      getOwnerBootstrapUserRefs: () => [111111],
    }));

    const confidentialAcquire = vi.fn().mockRejectedValue(
      new Error('AADSTS70000: refresh token expired'),
    );
    const publicAcquire = vi.fn();

    const { __testing, resetMicrosoftClients } = await import('../../src/services/microsoft-auth');
    resetMicrosoftClients();
    __testing.setMsalClientsForTests({
      confidential: { acquireTokenByRefreshToken: confidentialAcquire },
      public: { acquireTokenByRefreshToken: publicAcquire } as any,
    });

    await expect(__testing.acquireAccessTokenFromRefreshToken('refresh-token')).rejects.toThrow('AADSTS70000');
    expect(publicAcquire).not.toHaveBeenCalled();
  });

  it('detects the exact public-client mismatch error text we saw in live Outlook validation', async () => {
    vi.doMock('../../src/services/user-service', () => ({
      getOwnerBootstrapUserRefs: () => [111111],
    }));
    const { __testing } = await import('../../src/services/microsoft-auth');

    expect(
      __testing.isPublicClientRefreshTokenMismatch(
        new Error("AADSTS90023: Public clients can't send a client secret"),
      ),
    ).toBe(true);
    expect(__testing.isPublicClientRefreshTokenMismatch(new Error('AADSTS70000: refresh token expired'))).toBe(
      false,
    );
  });
});
