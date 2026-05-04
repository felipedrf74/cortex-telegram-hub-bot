import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: {
    google: { clientId: 'google-client', clientSecret: 'google-secret' },
    outlook: { clientId: 'outlook-client', tenantId: 'common' },
    todoist: { clientId: 'todoist-client' },
    notion: { clientId: 'notion-client' },
  },
}));

const createOAuthNonceSession = vi.fn();

vi.mock('../../src/services/oauth-state-store', () => ({
  createOAuthNonceSession,
}));

vi.mock('../../src/utils/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn().mockReturnThis() },
}));

describe('oauth-flow URL state binding', () => {
  beforeEach(() => {
    vi.resetModules();
    createOAuthNonceSession.mockReset();
    createOAuthNonceSession.mockReturnValue('nonce-abc');
  });

  it('binds Telegram-origin OAuth state to user, provider, and one-time nonce', async () => {
    const { getOAuthUrl } = await import('../../src/services/oauth-flow');

    const url = new URL(getOAuthUrl('todoist', 7));

    expect(url.searchParams.get('state')).toBe('tg:7:nonce-abc');
    expect(createOAuthNonceSession).toHaveBeenCalledWith(7, 'todoist');
  });

  it('uses the same nonce-bound state shape for calendar providers', async () => {
    const { getOAuthUrl } = await import('../../src/services/oauth-flow');

    const url = new URL(getOAuthUrl('google', 42));

    expect(url.searchParams.get('state')).toBe('tg:42:nonce-abc');
    expect(createOAuthNonceSession).toHaveBeenCalledWith(42, 'google');
  });
});
