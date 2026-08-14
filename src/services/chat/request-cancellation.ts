// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { isProviderRequestCancellation } from '../ai-provider';

/** Preserve caller-owned cancellation across model, retry, and fallback paths. */
export function throwIfChatRequestCancelled(
  abortSignal?: AbortSignal,
  error?: unknown,
): void {
  if (error !== undefined && isProviderRequestCancellation(error)) throw error;
  if (!abortSignal?.aborted) return;
  if (abortSignal.reason instanceof Error) throw abortSignal.reason;
  throw Object.assign(new Error('chat_request_cancelled'), {
    name: 'AbortError',
    code: 'CHAT_REQUEST_CANCELLED',
  });
}
