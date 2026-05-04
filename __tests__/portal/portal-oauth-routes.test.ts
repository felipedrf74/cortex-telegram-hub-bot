import { describe, expect, it, vi } from 'vitest';
import { registerPortalOAuthRoutes } from '../../src/portal/oauth-routes';

type Handler = (req: any, res: any, next?: () => void) => unknown;

interface CapturedRoute {
  method: 'GET';
  path: string;
  handlers: Handler[];
}

function createServices(overrides: Record<string, unknown> = {}) {
  return {
    exchangeCode: vi.fn(async () => ({ access_token: 'token' })),
    storeTokens: vi.fn(),
    getUserLanguage: vi.fn(() => 'pt'),
    t: vi.fn((_key: string, _lang: string, params?: Record<string, string>) => `${params?.provider} ligado`),
    isIOSState: vi.fn((state: string) => state.startsWith('ios:')),
    parseIOSState: vi.fn((state: string) => {
      const [, userId, nonce] = state.split(':');
      return { userId: Number(userId), nonce };
    }),
    consumeNonce: vi.fn((nonce: string) => ({ userId: nonce === 'bad' ? 999 : 7, provider: 'outlook' })),
    isIOSGoogleAuthState: vi.fn((state: string) => state.startsWith('ios-auth:')),
    parseIOSGoogleAuthState: vi.fn((_state: string) => ({ nonce: 'google-nonce' })),
    consumeGoogleAuthPendingSession: vi.fn(() => ({ deviceId: 'device-1', deviceName: 'iPhone' })),
    storeGoogleAuthCompletion: vi.fn(() => 'auth-code'),
    exchangeGoogleCodeForIdentity: vi.fn(async () => ({ sub: 'google-user' })),
    resolveGoogleIdentityUser: vi.fn(() => ({ id: 42 })),
    createAuthSessionAndRegisterDevice: vi.fn(() => ({ refreshToken: 'refresh' })),
    resetGoogleClients: vi.fn(),
    resetMicrosoftClients: vi.fn(),
    syncProvider: vi.fn(async () => undefined),
    invalidateIntegrationDerivedCaches: vi.fn(),
    ...overrides,
  };
}

function createRes() {
  return {
    statusCode: 200,
    redirectedTo: undefined as string | undefined,
    sent: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    redirect(url: string) {
      this.redirectedTo = url;
      return this;
    },
    send(body: unknown) {
      this.sent = body;
      return this;
    },
  };
}

function captureRoutes(
  services = createServices(),
  loadServices: () => unknown = () => services,
): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const app = {
    get(path: string, ...handlers: Handler[]) {
      routes.push({ method: 'GET', path, handlers });
    },
  };
  registerPortalOAuthRoutes(app as any, {
    loadServices: loadServices as any,
    logger: { warn: vi.fn(), error: vi.fn() },
    getBotRef: () => ({ api: { sendMessage: vi.fn(async () => undefined) } }) as any,
    env: { OAUTH_REDIRECT_BASE: 'https://api.test' },
  });
  return routes;
}

function findRoute(routes: CapturedRoute[], path: string): CapturedRoute {
  const route = routes.find((candidate) => candidate.path === path);
  if (!route) throw new Error(`Route not registered: GET ${path}`);
  return route;
}

async function invoke(route: CapturedRoute, req: Record<string, unknown> = {}) {
  const res = createRes();
  const handler = route.handlers.at(-1);
  if (!handler) throw new Error(`Route has no handler: ${route.path}`);
  await handler({ params: {}, query: {}, headers: {}, body: {}, ...req }, res);
  return res;
}

describe('portal oauth routes', () => {
  it('registers all public OAuth callbacks before portal API auth can run', () => {
    const routes = captureRoutes();

    expect(routes.map((route) => route.path)).toEqual([
      '/oauth/google/callback',
      '/oauth/outlook/callback',
      '/oauth/strava/callback',
      '/oauth/whoop/callback',
      '/oauth/fitbit/callback',
      '/oauth/todoist/callback',
      '/oauth/notion/callback',
    ]);
  });

  it('rejects callbacks missing code or state without touching integrations', async () => {
    const services = createServices();
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/google/callback'), { query: { code: 'abc' } });

    expect(res.statusCode).toBe(400);
    expect(res.sent).toBe('Missing code or state parameter');
    expect(services.exchangeCode).not.toHaveBeenCalled();
  });

  it('completes the Google Sign In callback through the app auth redirect', async () => {
    const services = createServices();
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/google/callback'), {
      query: { code: 'code-1', state: 'ios-auth:nonce' },
      ip: '127.0.0.1',
    });

    expect(services.exchangeGoogleCodeForIdentity).toHaveBeenCalledWith('code-1', 'https://api.test/oauth/google/callback');
    expect(services.createAuthSessionAndRegisterDevice).toHaveBeenCalledWith(expect.objectContaining({
      userId: 42,
      deviceId: 'device-1',
      pushToken: null,
    }));
    expect(res.redirectedTo).toBe('me.nexushub.app://auth/google?status=success&authCode=auth-code');
  });

  it('stores Outlook tokens and resets clients for a valid iOS OAuth callback', async () => {
    const services = createServices();
    services.consumeNonce = vi.fn(() => ({ userId: 7, provider: 'outlook' }));
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/outlook/callback'), {
      query: { code: 'code-2', state: 'ios:7:nonce-2' },
    });

    expect(services.exchangeCode).toHaveBeenCalledWith('outlook', 'code-2', 7);
    expect(services.storeTokens).toHaveBeenCalledWith(7, 'outlook', { access_token: 'token' });
    expect(services.invalidateIntegrationDerivedCaches).toHaveBeenCalledWith(7, 'outlook');
    expect(services.resetMicrosoftClients).toHaveBeenCalled();
    expect(res.redirectedTo).toBe('me.nexushub.app://oauth/outlook?status=success');
  });

  it('invalidates calendar-derived caches after a valid Google OAuth callback stores tokens', async () => {
    const services = createServices({
      consumeNonce: vi.fn(() => ({ userId: 7, provider: 'google' })),
    });
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/google/callback'), {
      query: { code: 'code-g', state: 'ios:7:nonce-g' },
    });

    expect(services.exchangeCode).toHaveBeenCalledWith('google', 'code-g', 7);
    expect(services.storeTokens).toHaveBeenCalledWith(7, 'google', { access_token: 'token' });
    expect(services.invalidateIntegrationDerivedCaches).toHaveBeenCalledWith(7, 'google');
    expect(services.resetGoogleClients).toHaveBeenCalled();
    expect(res.redirectedTo).toBe('me.nexushub.app://oauth/google?status=success');
  });

  it('keeps service-loader failures inside the iOS OAuth callback error boundary', async () => {
    const routes = captureRoutes(createServices(), () => {
      throw new Error('missing integration module');
    });

    const res = await invoke(findRoute(routes, '/oauth/outlook/callback'), {
      query: { code: 'code-2', state: 'ios:7:nonce-2' },
    });

    expect(res.redirectedTo).toBe('me.nexushub.app://oauth/outlook?status=error&message=Connection%20failed');
  });

  it('starts Todoist sync after a Telegram-origin callback stores tokens', async () => {
    const services = createServices({
      consumeNonce: vi.fn(() => ({ userId: 7, provider: 'todoist' })),
    });
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/todoist/callback'), {
      query: { code: 'code-3', state: 'tg:7:nonce-todoist' },
    });

    expect(services.consumeNonce).toHaveBeenCalledWith('nonce-todoist');
    expect(services.exchangeCode).toHaveBeenCalledWith('todoist', 'code-3', 7);
    expect(services.storeTokens).toHaveBeenCalledWith(7, 'todoist', { access_token: 'token' });
    expect(services.invalidateIntegrationDerivedCaches).toHaveBeenCalledWith(7, 'todoist');
    expect(services.syncProvider).toHaveBeenCalledWith(7, 'todoist');
    expect(String(res.sent)).toContain('Your first sync is starting now');
  });

  it('rejects legacy numeric Telegram OAuth state without exchanging tokens', async () => {
    const services = createServices({
      exchangeCode: vi.fn(async () => ({ access_token: 'token' })),
      consumeNonce: vi.fn(() => ({ userId: 7, provider: 'todoist' })),
    });
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/todoist/callback'), {
      query: { code: 'code-legacy', state: '7' },
    });

    expect(res.statusCode).toBe(400);
    expect(services.consumeNonce).not.toHaveBeenCalled();
    expect(services.exchangeCode).not.toHaveBeenCalled();
    expect(services.storeTokens).not.toHaveBeenCalled();
  });

  it('rejects Telegram OAuth state when the nonce provider does not match the callback provider', async () => {
    const services = createServices({
      exchangeCode: vi.fn(async () => ({ access_token: 'token' })),
      consumeNonce: vi.fn(() => ({ userId: 7, provider: 'outlook' })),
    });
    const routes = captureRoutes(services);

    const res = await invoke(findRoute(routes, '/oauth/todoist/callback'), {
      query: { code: 'code-mismatch', state: 'tg:7:nonce-outlook' },
    });

    expect(res.statusCode).toBe(400);
    expect(services.consumeNonce).toHaveBeenCalledWith('nonce-outlook');
    expect(services.exchangeCode).not.toHaveBeenCalled();
    expect(services.storeTokens).not.toHaveBeenCalled();
  });
});
