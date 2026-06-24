import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

interface MockRes {
  statusCode: number;
  body: any;
  status(code: number): MockRes;
  json(body: any): MockRes;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function mockReq(userId: number, provider: string): Request {
  return {
    userId,
    body: { provider },
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchInitiate(userId: number, provider: string): Promise<MockRes> {
  const { oauthInitiateRoutes } = await import('../../src/api/routes/oauth-initiate');
  const router = oauthInitiateRoutes();
  const req = mockReq(userId, provider);
  (req as any).method = 'POST';
  (req as any).url = '/initiate';
  (req as any).originalUrl = '/initiate';
  (req as any).baseUrl = '';
  (req as any).path = '/initiate';
  const res = mockRes();

  await new Promise<void>((resolve) => {
    (router as any).handle(req, res, (err: any) => {
      if (err) throw err;
      resolve();
    });
    setImmediate(resolve);
  });

  return res;
}

describe('OAuth initiate routes', () => {
  const originalEnv = {
    STRAVA_CLIENT_ID: process.env.STRAVA_CLIENT_ID,
    WHOOP_CLIENT_ID: process.env.WHOOP_CLIENT_ID,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    OUTLOOK_CLIENT_ID: process.env.OUTLOOK_CLIENT_ID,
    OUTLOOK_CLIENT_SECRET: process.env.OUTLOOK_CLIENT_SECRET,
  };

  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../src/utils/logger', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    process.env.GOOGLE_CLIENT_ID = 'google-client';
    process.env.GOOGLE_CLIENT_SECRET = 'google-secret';
    process.env.OUTLOOK_CLIENT_ID = 'outlook-client';
    process.env.OUTLOOK_CLIENT_SECRET = 'outlook-secret';
    process.env.STRAVA_CLIENT_ID = 'strava-client';
    process.env.WHOOP_CLIENT_ID = 'whoop-client';
  });

  afterEach(() => {
    process.env.STRAVA_CLIENT_ID = originalEnv.STRAVA_CLIENT_ID;
    process.env.WHOOP_CLIENT_ID = originalEnv.WHOOP_CLIENT_ID;
    process.env.GOOGLE_CLIENT_ID = originalEnv.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = originalEnv.GOOGLE_CLIENT_SECRET;
    process.env.OUTLOOK_CLIENT_ID = originalEnv.OUTLOOK_CLIENT_ID;
    process.env.OUTLOOK_CLIENT_SECRET = originalEnv.OUTLOOK_CLIENT_SECRET;
    vi.resetModules();
  });

  it('starts a Strava iOS OAuth flow', async () => {
    const res = await dispatchInitiate(42, 'strava');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('strava');
    expect(res.body.data.url).toContain('https://www.strava.com/oauth/mobile/authorize?');
    expect(res.body.data.url).toContain('client_id=strava-client');
    expect(res.body.data.url).toContain('state=ios%3A42%3A');
  });

  it('starts a Google iOS OAuth flow', async () => {
    const res = await dispatchInitiate(12, 'google');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('google');
    expect(res.body.data.url).toContain('https://accounts.google.com/o/oauth2/v2/auth?');
    expect(res.body.data.url).toContain('client_id=google-client');
    expect(res.body.data.url).toContain('state=ios%3A12%3A');
    expect(res.body.data.url).toContain(encodeURIComponent('https://api.nexushub.me/oauth/google/callback'));
  });

  it('starts an Outlook iOS OAuth flow', async () => {
    const res = await dispatchInitiate(21, 'outlook');

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.provider).toBe('outlook');
    expect(res.body.data.url).toContain('https://login.microsoftonline.com/');
    expect(res.body.data.url).toContain('/oauth2/v2.0/authorize?');
    expect(res.body.data.url).toContain('client_id=outlook-client');
    expect(res.body.data.url).toContain('response_mode=query');
    expect(res.body.data.url).toContain('state=ios%3A21%3A');
    expect(res.body.data.url).toContain(encodeURIComponent('https://api.nexushub.me/oauth/outlook/callback'));
  });

  it('returns coming soon for WHOOP iOS OAuth flow', async () => {
    const res = await dispatchInitiate(84, 'whoop');

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('COMING_SOON');
  });

  it('returns not configured when Strava is missing its client id', async () => {
    delete process.env.STRAVA_CLIENT_ID;

    const res = await dispatchInitiate(11, 'strava');

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });
});
