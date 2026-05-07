// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { resolveChatTenantId } from '../services/chat-tenant-scope';
import { runWithChatToolAuthorization } from '../services/chat-tool-authorization';
import {
  isValidTenantUserId,
  recordTenantScopeAnomaly,
} from '../services/tenant-scope-observability';

/**
 * Legacy Telegram domain routing still reaches the same tool loop as iOS.
 * Keep its tool calls inside the same AsyncLocalStorage authorization
 * context so the tool executor can enforce tenant scope and confirmation
 * rules instead of seeing an unauthenticated background call.
 */
export function runTelegramDomainHandlerWithToolAuthorization<T>(
  userId: number | undefined,
  fn: () => T | Promise<T>,
): T | Promise<T> {
  if (!isValidTenantUserId(userId)) {
    recordTenantScopeAnomaly({
      layer: 'delivery',
      operation: 'telegram_chat_tool_authorization',
      reason: userId == null ? 'missing_user_scope' : 'invalid_user_scope',
      userId: typeof userId === 'number' && Number.isFinite(userId) ? userId : null,
    });
    return fn();
  }

  return runWithChatToolAuthorization({
    userId,
    tenantId: resolveChatTenantId(userId),
    confirmedDestructiveAction: false,
    confirmationSource: 'none',
  }, fn);
}
