import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Request, Response } from 'express';

import { bindContentRequestCancellation } from '../../src/api/routes/content-request-cancellation';

describe('Content HTTP request cancellation', () => {
  it.each(['aborted', 'close'] as const)('aborts provider work on client %s', (event) => {
    const req = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    }) as unknown as Response;
    const binding = bindContentRequestCancellation(req, res, 'content_generation');

    (event === 'aborted' ? req : res).emit(event);

    expect(binding.signal.aborted).toBe(true);
    expect(binding.signal.reason).toMatchObject({
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    });
    binding.cleanup();
  });

  it('does not reinterpret a normal completed response as cancellation', () => {
    const req = Object.assign(new EventEmitter(), { aborted: false }) as unknown as Request;
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: true,
    }) as unknown as Response;
    const binding = bindContentRequestCancellation(req, res, 'content_generation');

    res.emit('close');

    expect(binding.signal.aborted).toBe(false);
    binding.cleanup();
  });
});
