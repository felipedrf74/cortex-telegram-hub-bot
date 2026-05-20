import { describe, expect, it } from 'vitest';
import express from 'express';
import http from 'http';
import { createApiRouter } from '../../src/api/router';

async function requestOptions(path: string, origin: string): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
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
          'Access-Control-Request-Method': 'POST',
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

describe('website CORS for web login and Nexus Points checkout', () => {
  it('allows nexushub.me to preflight billing checkout/status routes', async () => {
    const res = await requestOptions('/api/v1/billing/nexus-points/stripe-checkout', 'https://nexushub.me');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('https://nexushub.me');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
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
});
