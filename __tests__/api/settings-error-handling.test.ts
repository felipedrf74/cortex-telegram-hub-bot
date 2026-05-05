import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';

const mockRuntimeStatus = vi.fn();
const mockGetPushPreferences = vi.fn();
const mockSetPushPreference = vi.fn();

vi.mock('../../src/services/runtime-status', () => ({
  getRuntimeStatus: (...args: unknown[]) => mockRuntimeStatus(...args),
}));

vi.mock('../../src/services/report-document-store', () => ({
  getPushPreferences: (...args: unknown[]) => mockGetPushPreferences(...args),
  setPushPreference: (...args: unknown[]) => mockSetPushPreference(...args),
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

function mockRes() {
  const res: any = {
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

function baseReq(userId = 9, body: any = {}): Request {
  return {
    userId,
    deviceId: 'device-1',
    body,
    headers: {},
    header() { return undefined; },
  } as any;
}

async function dispatchStatus(): Promise<any> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = baseReq();
  (req as any).method = 'GET';
  (req as any).url = '/status';
  (req as any).originalUrl = '/status';
  (req as any).baseUrl = '';
  (req as any).path = '/status';
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

async function dispatchPushPreferencesGet(): Promise<any> {
  const { settingsRoutes } = await import('../../src/api/routes/settings');
  const router = settingsRoutes();
  const req = baseReq();
  (req as any).method = 'GET';
  (req as any).url = '/push-preferences';
  (req as any).originalUrl = '/push-preferences';
  (req as any).baseUrl = '';
  (req as any).path = '/push-preferences';
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

describe('Settings route error handling', () => {
  beforeEach(() => {
    vi.resetModules();
    mockRuntimeStatus.mockReset();
    mockGetPushPreferences.mockReset();
    mockSetPushPreference.mockReset();
  });

  it('returns a client-safe message when runtime status resolution fails', async () => {
    mockRuntimeStatus.mockImplementation(() => {
      throw new Error('pm2 probe failed');
    });

    const res = await dispatchStatus();

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load runtime status right now.',
    });
  });

  it('returns a client-safe message when push preference loading fails', async () => {
    mockGetPushPreferences.mockImplementation(() => {
      throw new Error('sqlite busy on push_preferences');
    });

    const res = await dispatchPushPreferencesGet();

    expect(res.statusCode).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toEqual({
      code: 'INTERNAL',
      message: 'Unable to load push preferences right now.',
    });
  });
});
