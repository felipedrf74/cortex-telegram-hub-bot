// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatStepExecutionResult } from './chat/types';

export interface ChatActionRetryVerdict {
  retryable: boolean;
  reason: string;
  category:
    | 'provider_read_back'
    | 'sqlite_busy'
    | 'upstream_5xx'
    | 'timeout'
    | 'network_transient'
    | 'non_retryable';
}

export interface ChatActionRetryOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  onRetry?: (event: { attempt: number; reason: string; category: ChatActionRetryVerdict['category'] }) => void;
}

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

export function normalizeChatActionErrorReason(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    for (const key of ['reason', 'code', 'error', 'message', 'statusText']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim().length > 0) return value;
    }
    const status = record.status ?? record.statusCode;
    if (typeof status === 'number') return String(status);
  }
  return String(error ?? 'unknown_error');
}

export function classifyChatActionRetry(reasonLike: unknown): ChatActionRetryVerdict {
  const reason = normalizeChatActionErrorReason(reasonLike).slice(0, 500);
  const normalized = reason.toLowerCase();
  if (isNonRetryableChatActionReason(normalized)) {
    return { retryable: false, reason, category: 'non_retryable' };
  }
  if (/\bsqlite_(busy|locked)\b/i.test(reason) || /database is locked|database locked/i.test(reason)) {
    return { retryable: true, reason, category: 'sqlite_busy' };
  }
  if (/provider[_ -]?read[_ -]?back[_ -]?(failed|timeout)|read[_ -]?back[_ -]?failed/i.test(reason)) {
    return { retryable: true, reason, category: 'provider_read_back' };
  }
  if (/\b(500|502|503|504)\b|upstream[_ -]?5xx|provider[_ -]?5xx|server error|bad gateway|service unavailable|gateway timeout/i.test(reason)) {
    return { retryable: true, reason, category: 'upstream_5xx' };
  }
  if (/timeout|timed out|etimedout/i.test(reason)) {
    return { retryable: true, reason, category: 'timeout' };
  }
  if (/\b(econnreset|econnrefused|eai_again|socket hang up)\b/i.test(reason)) {
    return { retryable: true, reason, category: 'network_transient' };
  }
  return { retryable: false, reason, category: 'non_retryable' };
}

export function isRetryableChatActionFailure(reasonLike: unknown): boolean {
  return classifyChatActionRetry(reasonLike).retryable;
}

export function shouldQueueChatActionFixerReview(reasonLike: unknown): boolean {
  const normalized = normalizeChatActionErrorReason(reasonLike).toLowerCase();
  return /verifier[_ -]?mismatch|verification[_ -]?mismatch|unexpected[_ -]?provider[_ -]?response|provider[_ -]?read[_ -]?back[_ -]?mismatch/.test(normalized);
}

export async function runChatActionWithBoundedRetry<T extends ChatStepExecutionResult>(
  operation: () => Promise<T> | T,
  options: ChatActionRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(3, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)));
  const retryDelayMs = Math.max(0, Math.min(5_000, Math.floor(options.retryDelayMs ?? defaultRetryDelayMs())));
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await operation();
      const verdict = result.status !== 'failed' || !result.error
        ? { retryable: false, reason: '', category: 'non_retryable' as const }
        : classifyChatActionRetry(result.error);
      if (!verdict.retryable || attempt >= maxRetries) return result;
      attempt += 1;
      options.onRetry?.({ attempt, reason: verdict.reason, category: verdict.category });
      await delay(retryDelayMs);
    } catch (err) {
      const verdict = classifyChatActionRetry(err);
      if (!verdict.retryable || attempt >= maxRetries) throw err;
      attempt += 1;
      options.onRetry?.({ attempt, reason: verdict.reason, category: verdict.category });
      await delay(retryDelayMs);
    }
  }
}

export async function withChatActionRetry<T>(
  operation: () => Promise<T> | T,
  options: ChatActionRetryOptions = {},
): Promise<T> {
  const maxRetries = Math.max(0, Math.min(3, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)));
  const retryDelayMs = Math.max(0, Math.min(5_000, Math.floor(options.retryDelayMs ?? defaultRetryDelayMs())));
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await operation();
    } catch (err) {
      const verdict = classifyChatActionRetry(err);
      if (!verdict.retryable || attempt >= maxRetries) throw err;
      attempt += 1;
      options.onRetry?.({ attempt, reason: verdict.reason, category: verdict.category });
      await delay(retryDelayMs);
    }
  }
}

function isNonRetryableChatActionReason(reason: string): boolean {
  return /auth[_ -]?token[_ -]?expired|invalid[_ -]?grant|unauthorized|forbidden|permission denied|verifier[_ -]?mismatch|verification[_ -]?mismatch|unexpected[_ -]?provider[_ -]?response|\b4\d\d\b|bad request|not found|conflict/.test(reason);
}

function defaultRetryDelayMs(): number {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return 0;
  const raw = process.env.CHAT_ACTION_RETRY_DELAY_MS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RETRY_DELAY_MS;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
