// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Minimal Server-Sent Events helper for operator portal live views.
 *
 * - caps concurrent streams (the portal is single-operator; a runaway tab
 *   loop must not pin the event loop);
 * - sends a comment heartbeat every 15s so proxies keep the socket open;
 * - the compression middleware skips `text/event-stream` (see server.ts),
 *   otherwise chunks would be buffered.
 */

import type { Request, Response } from 'express';

export const SSE_MAX_STREAMS = 5;
const HEARTBEAT_MS = 15_000;

let activeStreams = 0;

export interface SseHandle {
  send(event: string, data: unknown): void;
  close(): void;
  readonly closed: boolean;
}

export function getActiveSseStreams(): number {
  return activeStreams;
}

/**
 * Opens an SSE response. Returns `null` (after replying 429) when the stream
 * cap is reached.
 */
export function openSse(req: Request, res: Response): SseHandle | null {
  if (activeStreams >= SSE_MAX_STREAMS) {
    res.status(429).json({ ok: false, error: { code: 'SSE_LIMIT', message: 'Too many live streams open' } });
    return null;
  }
  activeStreams += 1;
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write(': connected\n\n');

  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { handle.close(); }
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const handle: SseHandle = {
    get closed() { return closed; },
    send(event, data) {
      if (closed) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        handle.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      activeStreams = Math.max(0, activeStreams - 1);
      clearInterval(heartbeat);
      try { res.end(); } catch { /* already gone */ }
    },
  };

  req.on('close', () => handle.close());
  res.on('close', () => handle.close());
  return handle;
}

export function _resetSseForTests(): void {
  activeStreams = 0;
}
