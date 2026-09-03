// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Request, Response } from 'express';

export type ContentRequestCancellation = {
  signal: AbortSignal;
  cleanup: () => void;
};

export function bindContentRequestCancellation(
  req: Request,
  res: Response,
  operation: string,
): ContentRequestCancellation {
  const controller = new AbortController();
  const abortOnClientDisconnect = (): void => {
    if (res.writableEnded || controller.signal.aborted) return;
    controller.abort(Object.assign(new Error(`${operation}_client_disconnected`), {
      name: 'AbortError',
      code: 'CONTENT_CLIENT_DISCONNECTED',
    }));
  };

  if (typeof req.once === 'function') req.once('aborted', abortOnClientDisconnect);
  if (typeof res.once === 'function') res.once('close', abortOnClientDisconnect);
  if (req.aborted || res.destroyed) abortOnClientDisconnect();

  return {
    signal: controller.signal,
    cleanup: () => {
      if (typeof req.removeListener === 'function') req.removeListener('aborted', abortOnClientDisconnect);
      if (typeof res.removeListener === 'function') res.removeListener('close', abortOnClientDisconnect);
    },
  };
}
