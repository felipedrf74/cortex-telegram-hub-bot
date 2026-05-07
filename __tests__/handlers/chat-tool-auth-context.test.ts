import { beforeEach, describe, expect, it } from 'vitest';

import { runTelegramDomainHandlerWithToolAuthorization } from '../../src/handlers/chat-tool-auth-context';
import {
  authorizeChatToolCall,
  getCurrentChatToolAuthorizationContext,
} from '../../src/services/chat-tool-authorization';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

describe('Telegram chat-tool authorization context', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
  });

  it('wraps Telegram domain work in the same user/tenant authorization context used by tool execution', async () => {
    await runTelegramDomainHandlerWithToolAuthorization(4242, async () => {
      expect(getCurrentChatToolAuthorizationContext()).toMatchObject({
        userId: 4242,
        tenantId: 4242,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
      });

      expect(authorizeChatToolCall('ms_todo_create_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: true,
        toolRisk: 'write',
      });
      expect(authorizeChatToolCall('ms_todo_create_task', { userId: 7 }, 4242, 4242)).toMatchObject({
        allowed: false,
        code: 'AUTH_REQUIRED',
      });
      expect(authorizeChatToolCall('ms_todo_delete_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        confirmationRequired: true,
        toolRisk: 'destructive',
      });
      expect(authorizeChatToolCall('send_outlook_email', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        confirmationRequired: true,
        toolRisk: 'external_send',
      });
    });
  });

  it('does not invent authorization context for unauthenticated Telegram work', () => {
    runTelegramDomainHandlerWithToolAuthorization(undefined, () => {
      expect(getCurrentChatToolAuthorizationContext()).toBeUndefined();
      expect(authorizeChatToolCall('ms_todo_create_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: false,
        code: 'AUTH_REQUIRED',
      });
    });
  });

  it.each([0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'does not invent authorization context for invalid Telegram user id %s',
    (userId) => {
      runTelegramDomainHandlerWithToolAuthorization(userId, () => {
        expect(getCurrentChatToolAuthorizationContext()).toBeUndefined();
        expect(authorizeChatToolCall('ms_todo_create_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
          allowed: false,
          code: 'AUTH_REQUIRED',
        });
      });

      expect(getTenantScopeAnomalies(1)[0]).toMatchObject({
        layer: 'delivery',
        operation: 'telegram_chat_tool_authorization',
        reason: 'invalid_user_scope',
      });
    },
  );
});
