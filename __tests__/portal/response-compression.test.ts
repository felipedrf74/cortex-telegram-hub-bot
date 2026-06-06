import express from 'express';
import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { createResponseCompressionMiddleware } from '../../src/portal/server';

async function withServer<T>(app: express.Express, fn: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Test server did not bind a TCP port');
  }
  try {
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function request(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const req = http.request(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('portal response compression middleware', () => {
  let app: express.Express;

  afterEach(() => {
    app = undefined as any;
  });

  it('compresses large JSON responses and leaves small JSON responses uncompressed', async () => {
    app = express();
    app.use(createResponseCompressionMiddleware());
    app.get('/large', (_req, res) => res.json({ items: Array.from({ length: 400 }, (_, i) => `item-${i}`) }));
    app.get('/small', (_req, res) => res.json({ ok: true }));

    await withServer(app, async (baseUrl) => {
      const large = await request(`${baseUrl}/large`);
      const small = await request(`${baseUrl}/small`);

      expect(large.status).toBe(200);
      expect(large.headers['content-encoding']).toBe('gzip');
      expect(Number(large.headers['content-length'] ?? 0)).toBe(0);
      expect(large.body.length).toBeGreaterThan(0);

      expect(small.status).toBe(200);
      expect(small.headers['content-encoding']).toBeUndefined();
    });
  });
});
