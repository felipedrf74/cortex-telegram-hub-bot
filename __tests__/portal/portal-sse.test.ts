import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetSseForTests, getActiveSseStreams, openSse, SSE_MAX_STREAMS } from '../../src/portal/sse';

function fakePair() {
  const req = new EventEmitter() as any;
  const res = new EventEmitter() as any;
  res.headers = {} as Record<string, string>;
  res.chunks = [] as string[];
  res.statusCode = 0;
  res.ended = false;
  res.status = vi.fn((code: number) => { res.statusCode = code; return res; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res; });
  res.setHeader = vi.fn((k: string, v: string) => { res.headers[k.toLowerCase()] = v; });
  res.flushHeaders = vi.fn();
  res.write = vi.fn((chunk: string) => { res.chunks.push(chunk); return true; });
  res.end = vi.fn(() => { res.ended = true; });
  return { req, res };
}

afterEach(() => {
  _resetSseForTests();
  vi.useRealTimers();
});

describe('portal SSE helper', () => {
  it('opens a stream with the right headers and frames events', () => {
    const { req, res } = fakePair();
    const handle = openSse(req, res)!;
    expect(handle).not.toBeNull();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');
    expect(res.chunks[0]).toBe(': connected\n\n');

    handle.send('log', { msg: 'hi' });
    expect(res.chunks[1]).toBe('event: log\ndata: {"msg":"hi"}\n\n');
    expect(getActiveSseStreams()).toBe(1);

    req.emit('close');
    expect(handle.closed).toBe(true);
    expect(res.ended).toBe(true);
    expect(getActiveSseStreams()).toBe(0);
    handle.send('log', { msg: 'ignored' });
    expect(res.chunks).toHaveLength(2);
  });

  it('sends heartbeats while open', () => {
    vi.useFakeTimers();
    const { req, res } = fakePair();
    const handle = openSse(req, res)!;
    vi.advanceTimersByTime(15_000);
    expect(res.chunks.filter((c: string) => c === ': ping\n\n')).toHaveLength(1);
    handle.close();
    vi.advanceTimersByTime(30_000);
    expect(res.chunks.filter((c: string) => c === ': ping\n\n')).toHaveLength(1);
  });

  it('caps concurrent streams and replies 429 beyond the cap', () => {
    const handles = [];
    for (let i = 0; i < SSE_MAX_STREAMS; i += 1) {
      const { req, res } = fakePair();
      handles.push(openSse(req, res));
    }
    const { req, res } = fakePair();
    expect(openSse(req, res)).toBeNull();
    expect(res.statusCode).toBe(429);
    expect(res.body).toMatchObject({ ok: false, error: { code: 'SSE_LIMIT' } });
    handles.forEach((h) => h!.close());
    expect(getActiveSseStreams()).toBe(0);
  });
});
