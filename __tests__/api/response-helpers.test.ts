// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Contract tests for the standardized iOS API response envelope.
 *
 * The iOS Swift decoder relies on the `ok: true | false` discriminator and
 * the field names being stable. These tests fail loudly if anyone changes
 * the envelope shape without coordinating with the iOS app.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';

const mockRecordOperatorAlert = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: (...args: unknown[]) => mockRecordOperatorAlert(...args),
}));

import {
  apiSuccess,
  apiError,
  apiPaginated,
  sendSuccess,
  sendError,
  sendInternalError,
  asyncHandler,
} from '../../src/api/response-helpers';

beforeEach(() => {
  mockRecordOperatorAlert.mockReset();
});

describe('apiSuccess', () => {
  it('produces an envelope with ok=true and the data payload', () => {
    const r = apiSuccess({ name: 'felipe' });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: 'felipe' });
    expect(r.cached).toBe(false);
    expect(typeof r.timestamp).toBe('string');
    expect(new Date(r.timestamp).getTime()).not.toBeNaN();
  });

  it('marks responses as cached when requested', () => {
    const r = apiSuccess({ x: 1 }, { cached: true });
    expect(r.cached).toBe(true);
  });

  it('serializes nested data without losing structure', () => {
    const data = { tasks: [{ id: 'a', title: 'b' }], count: 1 };
    const r = apiSuccess(data);
    const json = JSON.parse(JSON.stringify(r));
    expect(json.data).toEqual(data);
    expect(json.ok).toBe(true);
  });
});

describe('apiError', () => {
  it('produces an envelope with ok=false and a structured error', () => {
    const r = apiError('BAD_REQUEST', 'missing field');
    expect(r.ok).toBe(false);
    expect(r.error).toEqual({ code: 'BAD_REQUEST', message: 'missing field' });
    expect(typeof r.timestamp).toBe('string');
  });

  it('keeps the timestamp on error envelopes too', () => {
    const r = apiError('INTERNAL', 'oops');
    expect(new Date(r.timestamp).getTime()).not.toBeNaN();
  });
});

describe('apiPaginated', () => {
  it('returns pagination metadata with hasMore=true on intermediate pages', () => {
    const r = apiPaginated([1, 2, 3], 1, 100, 20);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([1, 2, 3]);
    expect(r.pagination).toEqual({ page: 1, perPage: 20, total: 100, hasMore: true });
  });

  it('returns hasMore=false on the last page', () => {
    const r = apiPaginated([1, 2], 5, 100, 20);
    expect(r.pagination.hasMore).toBe(false);
  });

  it('uses default perPage=20 when omitted', () => {
    const r = apiPaginated([1], 1, 1);
    expect(r.pagination.perPage).toBe(20);
    expect(r.pagination.hasMore).toBe(false);
  });
});

describe('sendSuccess (express helper)', () => {
  it('writes a 200 by default with the success envelope', () => {
    const res = mockResponse();
    sendSuccess(res, { hi: 'there' });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, data: { hi: 'there' }, cached: false }),
    );
  });

  it('honors a custom status code', () => {
    const res = mockResponse();
    sendSuccess(res, { id: 1 }, { status: 201 });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('passes the cached flag through', () => {
    const res = mockResponse();
    sendSuccess(res, { x: 1 }, { cached: true });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cached: true }));
  });
});

describe('sendError (express helper)', () => {
  it('defaults to 400 Bad Request', () => {
    const res = mockResponse();
    sendError(res, 'BAD_REQUEST', 'invalid');
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: { code: 'BAD_REQUEST', message: 'invalid' } }),
    );
  });

  it('honors a custom status code', () => {
    const res = mockResponse();
    sendError(res, 'NOT_FOUND', 'no such id', 404);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('records a durable operator alert for degraded backend responses', () => {
    const res = mockResponse();
    sendError(res, 'SERVICE_UNAVAILABLE', 'Try again later', 503, {
      rawBackendError: 'postgres password=not-for-alerts',
    });

    expect(mockRecordOperatorAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: 'warning',
        source: 'api_degraded_response',
        dedupeKey: 'api_degraded:SERVICE_UNAVAILABLE:503',
        title: 'Backend degraded API response',
        metadata: expect.objectContaining({
          code: 'SERVICE_UNAVAILABLE',
          status: 503,
        }),
      }),
    );
    expect(mockRecordOperatorAlert.mock.calls[0][0].metadata).not.toHaveProperty('rawBackendError');
  });
});

describe('sendInternalError (express helper)', () => {
  it('emits a stable internal error envelope without leaking exception text', () => {
    const res = mockResponse();
    sendInternalError(res, 'Unable to load dashboard right now.');
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: {
          code: 'INTERNAL',
          message: 'Unable to load dashboard right now.',
        },
      }),
    );
  });
});

describe('asyncHandler', () => {
  it('passes through to the wrapped handler on success', async () => {
    const res = mockResponse();
    const handler = asyncHandler(async (_req, res) => {
      sendSuccess(res, { ok: 'yes' });
    });
    await handler({}, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
  });

  it('catches a thrown error and emits a 500 envelope with a client-safe message', async () => {
    // Hardening audit 2026-04-20: asyncHandler previously leaked
    // `err.message` verbatim to the client. That's a mild
    // info-disclosure issue and makes the 500 shape depend on the
    // underlying exception string. The wrapper now records the real
    // cause via errorMonitor (captured separately in its own test
    // suite) and returns a stable client-safe message.
    const res = mockResponse();
    const handler = asyncHandler(async () => {
      throw new Error('boom');
    });
    await handler({}, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'INTERNAL', message: 'Internal server error' }),
      }),
    );
  });

  it('does NOT double-send when the handler already responded', async () => {
    const res = mockResponse();
    res.headersSent = true; // simulate handler already wrote a response
    const handler = asyncHandler(async () => {
      throw new Error('boom after send');
    });
    await handler({}, res);
    expect(res.status).not.toHaveBeenCalled();
  });
});

// ── Test helpers ────────────────────────────────────────────────────

function mockResponse() {
  const res: any = {
    headersSent: false,
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res;
}
