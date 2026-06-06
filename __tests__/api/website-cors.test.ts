import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import { createApiRouter } from '../../src/api/router';

vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn().mockReturnThis() },
  LOGGER_REDACTION_PATHS: [],
}));

async function requestOptions(
  path: string,
  origin: string,
  requestMethod = 'POST',
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const app = express();
  app.use('/api/v1', express.json(), createApiRouter());
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'OPTIONS',
        path,
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': requestMethod,
          'Access-Control-Request-Headers': 'Authorization, Content-Type',
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return response;
}

async function requestPost(path: string, origin: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const app = express();
  app.use('/api/v1', express.json(), createApiRouter());
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const response = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const body = JSON.stringify({ packageId: 'me.nexushub.points.small' });
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path,
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return response;
}

describe('website CORS for web login and Nexus Points checkout', () => {
  it('allows nexushub.me to preflight billing checkout/status routes', async () => {
    const res = await requestOptions('/api/v1/billing/nexus-points/stripe-checkout', 'https://nexushub.me');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://nexushub.me');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('allows Cloudflare Pages previews for web auth routes', async () => {
    const res = await requestOptions('/api/v1/auth/login/email', 'https://branch.nexushub-landing.pages.dev');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://branch.nexushub-landing.pages.dev');
  });

  it('does not grant CORS headers to untrusted origins', async () => {
    const res = await requestOptions('/api/v1/billing/nexus-points/stripe-checkout', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not grant CORS headers to untrusted POST origins', async () => {
    const res = await requestPost('/api/v1/billing/nexus-points/stripe-checkout', 'https://evil.example');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects unsupported website preflight methods', async () => {
    const res = await requestOptions('/api/v1/billing/nexus-points/stripe-checkout', 'https://nexushub.me', 'PUT');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows Cloudflare Pages previews to preflight the Stripe checkout route', async () => {
    const res = await requestOptions('/api/v1/billing/nexus-points/stripe-checkout', 'https://preview.nexushub-landing.pages.dev');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://preview.nexushub-landing.pages.dev');
  });
});
