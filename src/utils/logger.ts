// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import pino from 'pino';
import { getCurrentContext } from './request-context';

export const LOGGER_REDACTION_PATHS = [
  'authorization',
  'Authorization',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'accessToken',
  'refreshToken',
  'idToken',
  'password',
  'secret',
  'client_secret',
  'clientSecret',
  'body.access_token',
  'body.refresh_token',
  'body.id_token',
  'body.token',
  'body.password',
  'body.client_secret',
  'body.clientSecret',
  'headers.authorization',
  'headers.Authorization',
  'req.headers.authorization',
  'req.headers.Authorization',
  'err.config.headers.authorization',
  'err.config.headers.Authorization',
  'err.config.headers.cookie',
  'err.config.headers.Cookie',
  'err.config.auth',
  'err.response.config.headers.authorization',
  'err.response.config.headers.Authorization',
  'err.response.config.headers.cookie',
  'err.response.config.headers.Cookie',
  'err.request._headers.authorization',
  'err.request._headers.Authorization',
  'err.request._header',
  'err.options.headers.authorization',
  'err.options.headers.Authorization',
  'err.options.authProvider',
  'err.options.auth',
  'config.headers.authorization',
  'config.headers.Authorization',
  'config.auth',
  'response.config.headers.authorization',
  'response.config.headers.Authorization',
  'prompt',
  'systemPrompt',
  'rawPrompt',
  'completion',
  'responseText',
  'messages',
  'context',
  'memory',
  'references',
  'draft',
  'script',
  'voiceProfile',
  'body.prompt',
  'body.system',
  'body.systemPrompt',
  'body.rawPrompt',
  'body.messages',
  'body.context',
  'body.memory',
  'body.references',
  'body.draft',
  'body.script',
  'body.voiceProfile',
  'err.prompt',
  'err.systemPrompt',
  'err.rawPrompt',
  'err.messages',
  'err.context',
  'err.response.data.prompt',
  'err.response.data.system',
  'err.response.data.messages',
  'err.response.data.context',
  'amount',
  'category',
  'merchant',
  'vendor',
  'taxDue',
  'tax_due',
  'gross_income',
  'destinationEmail',
  'body.amount',
  'body.category',
  'body.merchant',
  'body.vendor',
  'body.taxDue',
  'body.tax_due',
  'body.gross_income',
  'body.destinationEmail',
  'err.amount',
  'err.category',
  'err.merchant',
  'err.vendor',
  'err.taxDue',
  'err.tax_due',
  'err.gross_income',
  'err.destinationEmail',
  'err.response.data.amount',
  'err.response.data.category',
  'err.response.data.merchant',
  'err.response.data.vendor',
  'err.response.data.taxDue',
  'err.response.data.tax_due',
  'err.response.data.gross_income',
  'err.response.data.destinationEmail',
] as const;

const PINO_REDACTION_PATHS = [...LOGGER_REDACTION_PATHS];

/**
 * Pino logger with a context-aware mixin (Quarter: distributed tracing).
 *
 * The `mixin` function runs on every log call. When the call is happening
 * inside a request context (set up by runWithContext at the entry point),
 * we automatically attach `reqId`, `src`, and `userId` to the log line.
 * Outside any context (e.g. boot-time logs before the first request, or
 * background work that wasn't wrapped) the mixin returns an empty object
 * and the log line looks the same as before — fully backward compatible.
 *
 * Why a mixin instead of pino's child logger pattern? A child logger would
 * require every handler to call `logger.child({ reqId })` and pass the new
 * instance through every downstream call — defeating the purpose of using
 * AsyncLocalStorage. The mixin reads from storage on each call, so it
 * "just works" without touching any caller.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: PINO_REDACTION_PATHS,
    censor: '[Redacted]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
  mixin() {
    const ctx = getCurrentContext();
    if (!ctx) return {};
    return {
      reqId: ctx.requestId,
      src: ctx.source,
      ...(ctx.userId ? { userId: ctx.userId } : {}),
    };
  },
});
