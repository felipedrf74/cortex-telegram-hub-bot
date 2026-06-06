// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { sendError, sendInternalError } from '../response-helpers';

export type ProviderRouteOperation = 'create' | 'read' | 'update' | 'delete';

export interface ProviderRouteError {
  status: number;
  code: string;
  message: string;
  internalMessage?: string;
}

export function classifyProviderRouteError(
  err: unknown,
  operation: ProviderRouteOperation,
  noun = 'task',
): ProviderRouteError {
  const raw = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' && 'message' in err ? String((err as any).message) : '');
  const message = raw.toLowerCase();
  const status = typeof err === 'object' && err && 'status' in err ? Number((err as any).status) : undefined;

  if (status === 401 || status === 403 || /\b(invalid_grant|unauthorized|forbidden|expired|reauth|token)\b/.test(message)) {
    return {
      status: 401,
      code: 'PROVIDER_AUTH_REQUIRED',
      message: `Reconnect your ${noun} provider and try again.`,
    };
  }

  if (status === 429 || /\b(rate|quota|throttle)\b/.test(message)) {
    return {
      status: 429,
      code: 'PROVIDER_RATE_LIMITED',
      message: `Your ${noun} provider is rate limited right now. Try again shortly.`,
    };
  }

  if ((status && status >= 500) || /\b(timeout|network|unavailable|temporar|econnreset|etimedout)\b/.test(message)) {
    return {
      status: 503,
      code: 'PROVIDER_TEMPORARY_UNAVAILABLE',
      message: `Your ${noun} provider is temporarily unavailable. Try again shortly.`,
    };
  }

  return {
    status: 500,
    code: 'PROVIDER_FAILED',
    message: `Failed to ${operation} ${noun}`,
    internalMessage: `Failed to ${operation} ${noun}`,
  };
}

export function sendProviderRouteError(
  res: Response,
  err: unknown,
  operation: ProviderRouteOperation,
  noun = 'task',
  fallbackCode = 'PROVIDER_FAILED',
): void {
  const classified = classifyProviderRouteError(err, operation, noun);
  if (classified.status >= 500 && classified.code === 'PROVIDER_FAILED') {
    sendInternalError(res, classified.internalMessage || classified.message, { code: fallbackCode });
    return;
  }
  sendError(res, classified.code, classified.message, classified.status);
}
