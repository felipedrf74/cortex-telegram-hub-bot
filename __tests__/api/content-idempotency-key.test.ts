import { describe, expect, it } from 'vitest';

import {
  resolveContentIdempotencyKey,
} from '../../src/api/routes/content-idempotency-key';

function request(body: unknown, headerValue?: string) {
  return {
    body,
    header: (name: string) => name.toLowerCase() === 'x-idempotency-key' ? headerValue : undefined,
  };
}

function captureError(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (error) {
    return error;
  }
}

describe('Content idempotency key boundary', () => {
  it.each([null, [], 'scalar', 42, true])(
    'rejects a non-object body even when the header key is valid',
    (body) => {
      expect(captureError(() => resolveContentIdempotencyKey(request(body, 'header-key-123'))))
        .toMatchObject({
          code: 'CONTENT_VALIDATION_FAILED',
          status: 400,
          details: { field: 'body' },
        });
    },
  );

  it('accepts an absent or object body with a valid header key', () => {
    expect(resolveContentIdempotencyKey(request(undefined, 'header-key-123'))).toBe('header-key-123');
    expect(resolveContentIdempotencyKey(request({}, 'header-key-123'))).toBe('header-key-123');
  });

  it('requires matching body and header keys', () => {
    expect(captureError(() => resolveContentIdempotencyKey(request(
      { idempotencyKey: 'body-key-123' },
      'header-key-123',
    )))).toMatchObject({
      code: 'CONTENT_IDEMPOTENCY_KEY_CONFLICT',
      status: 409,
    });
  });

  it('rejects body-supplied control characters before the key reaches durable replay state', () => {
    expect(captureError(() => resolveContentIdempotencyKey(request({
      idempotencyKey: 'content-key\nsecond-line',
    })))).toMatchObject({
      code: 'CONTENT_VALIDATION_FAILED',
      status: 400,
      details: { field: 'idempotencyKey' },
    });
  });
});
