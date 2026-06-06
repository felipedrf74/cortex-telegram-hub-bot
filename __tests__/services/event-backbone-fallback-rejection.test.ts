import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';

vi.mock('../../src/services/database', () => ({
  getDb: () => {
    throw new Error('Database not initialized. Call initDatabase() first.');
  },
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import { runOutboxTransaction } from '../../src/services/event-outbox';

afterEach(() => {
  vi.clearAllMocks();
});

describe('event backbone DB-unavailable behavior', () => {
  it('propagates DB initialization failure through an HTTP write path without running the business write', async () => {
    const businessWrite = vi.fn();
    const app = express();
    app.post('/test/write', (_req, res) => {
      try {
        runOutboxTransaction(() => {
          businessWrite();
        });
        res.status(201).json({ ok: true });
      } catch (err) {
        res.status(500).json({
          ok: false,
          error: {
            code: 'INTERNAL',
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    });

    const response = await request(app, 'POST', '/test/write');

    expect(response.status).toBe(500);
    expect(response.body.error.message).toMatch(/Database not initialized/);
    expect(businessWrite).not.toHaveBeenCalled();
  });
});

async function request(app: express.Express, method: string, path: string): Promise<{ status: number; body: any }> {
  const server = app.listen(0);
  try {
    const address = server.address() as { port: number };
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          method,
          path,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: data ? JSON.parse(data) : null,
            });
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
