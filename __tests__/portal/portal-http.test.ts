import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPortalInternalError } from '../../src/portal/http';

const hoisted = vi.hoisted(() => ({
  loggerError: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    error: hoisted.loggerError,
  },
}));

function makeResponse() {
  const payload = { statusCode: 0, body: undefined as unknown };
  return {
    payload,
    res: {
      status: vi.fn((code: number) => {
        payload.statusCode = code;
        return {
          json: vi.fn((body: unknown) => {
            payload.body = body;
          }),
        };
      }),
    },
  };
}

describe('portal HTTP helpers', () => {
  beforeEach(() => {
    hoisted.loggerError.mockReset();
  });

  it('logs raw internal errors but returns a stable portal-compatible response body', () => {
    const { res, payload } = makeResponse();
    const err = new Error('database password leaked in stack');

    sendPortalInternalError(res as any, err, 'Failed to load portal data', 'Portal: test failed');

    expect(hoisted.loggerError).toHaveBeenCalledWith({ err }, 'Portal: test failed');
    expect(payload.statusCode).toBe(500);
    expect(payload.body).toMatchObject({
      ok: false,
      message: 'Failed to load portal data',
      error: {
        code: 'INTERNAL',
        message: 'Failed to load portal data',
      },
    });
    expect(JSON.stringify(payload.body)).not.toContain('database password');
  });
});
