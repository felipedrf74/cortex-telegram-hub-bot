import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  STAGING: process.env.STAGING,
  IOS_API_JWT_SECRET: process.env.IOS_API_JWT_SECRET,
  IOS_API_JWT_KEYS: process.env.IOS_API_JWT_KEYS,
  FINANCE_ENCRYPTION_KEY: process.env.FINANCE_ENCRYPTION_KEY,
  BACKUP_ENCRYPT: process.env.BACKUP_ENCRYPT,
  BACKUP_KEY: process.env.BACKUP_KEY,
};
const STAGING_IOS_JWT_SECRET = 'staging-fixture-test-secret-000000000000000000000000';

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function mockReq(token: string): Request {
  return {
    headers: { authorization: `Bearer ${token}` },
    header(name: string) {
      return (this.headers as Record<string, string>)[name.toLowerCase()];
    },
    method: 'GET',
    url: '/api/v1/dashboard',
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as any;
}

function mockRes(): Response & { statusCodeValue: number; jsonBody: any } {
  const res: any = {
    statusCodeValue: 200,
    jsonBody: null,
    status(code: number) {
      res.statusCodeValue = code;
      return res;
    },
    json(body: any) {
      res.jsonBody = body;
      return res;
    },
  };
  return res;
}

describe('authMiddleware: staging fixture production refusal', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('../../../src/services/database', () => ({
      getDb: vi.fn(() => {
        throw new Error('database should not be touched for refused staging fixture tokens');
      }),
    }));
    vi.doMock('../../../src/utils/logger', () => ({
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        child: vi.fn().mockReturnThis(),
      },
    }));
    vi.doMock('../../../src/services/tenant-scope-observability', async () => {
      const actual = await vi.importActual<typeof import('../../../src/services/tenant-scope-observability')>(
        '../../../src/services/tenant-scope-observability',
      );
      return {
        ...actual,
        recordTenantScopeAnomaly: vi.fn(),
      };
    });

    process.env.NODE_ENV = 'production';
    delete process.env.STAGING;
    process.env.IOS_API_JWT_SECRET = STAGING_IOS_JWT_SECRET;
    delete process.env.IOS_API_JWT_KEYS;
    process.env.FINANCE_ENCRYPTION_KEY = 'auth-middleware-prod-test-finance-key-32';
    process.env.BACKUP_ENCRYPT = 'true';
    process.env.BACKUP_KEY = 'auth-middleware-prod-test-backup-key-32';
  });

  afterEach(() => {
    restoreEnv();
    vi.doUnmock('../../../src/services/database');
    vi.doUnmock('../../../src/utils/logger');
    vi.doUnmock('../../../src/services/tenant-scope-observability');
    vi.resetModules();
  });

  async function run(payload: Record<string, unknown>): Promise<{ admitted: boolean; res: ReturnType<typeof mockRes> }> {
    const token = jwt.sign(payload, STAGING_IOS_JWT_SECRET, { expiresIn: '30d' as any });
    const { authMiddleware } = await import('../../../src/api/auth-middleware');
    const req = mockReq(token);
    const res = mockRes();
    let admitted = false;

    await new Promise<void>((resolve) => {
      const next: NextFunction = () => {
        admitted = true;
        resolve();
      };
      authMiddleware(req, res, next);
      setImmediate(resolve);
    });

    return { admitted, res };
  }

  it('rejects staging_fixture JWTs before any database lookup in production', async () => {
    const { admitted, res } = await run({
      userId: 1_000_001,
      deviceId: 'staging-fixture-device-1000001',
      staging_fixture: true,
    });

    expect(admitted).toBe(false);
    expect(res.statusCodeValue).toBe(401);
    expect(res.jsonBody.error.code).toBe('UNAUTHORIZED');
  });

  it('rejects reserved synthetic user IDs in production even without the claim', async () => {
    const { admitted, res } = await run({
      userId: 1_000_001,
      deviceId: 'staging-fixture-device-1000001',
    });

    expect(admitted).toBe(false);
    expect(res.statusCodeValue).toBe(401);
    expect(res.jsonBody.error.code).toBe('UNAUTHORIZED');
  });
});
