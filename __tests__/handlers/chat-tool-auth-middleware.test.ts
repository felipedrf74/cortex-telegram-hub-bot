import { describe, expect, it } from 'vitest';

import { createBot } from '../../src/bot';
import {
  authorizeChatToolCall,
  getCurrentChatToolAuthorizationContext,
} from '../../src/services/chat-tool-authorization';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

describe('Telegram bot chat-tool authorization middleware', () => {
  it('wraps the whole bot handler chain before command, callback, and media handlers run', async () => {
    clearTenantScopeAnomaliesForTests();
    const bot = createBot() as any;
    const chatToolMiddleware = bot.use.mock.calls[2]?.[0];

    expect(typeof chatToolMiddleware).toBe('function');

    await chatToolMiddleware({ from: { id: 4242 } }, async () => {
      expect(getCurrentChatToolAuthorizationContext()).toMatchObject({
        userId: 4242,
        tenantId: 4242,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
      });
      expect(authorizeChatToolCall('ms_todo_complete_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: true,
        toolRisk: 'write',
      });
      expect(authorizeChatToolCall('ms_todo_delete_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
        allowed: false,
        code: 'CONFIRMATION_REQUIRED',
        confirmationRequired: true,
      });
    });
  });

  it('does not create chat-tool authorization for invalid Telegram user ids', async () => {
    clearTenantScopeAnomaliesForTests();
    const bot = createBot() as any;
    const chatToolMiddleware = bot.use.mock.calls[2]?.[0];

    await chatToolMiddleware({ from: { id: 0 } }, async () => {
      expect(getCurrentChatToolAuthorizationContext()).toBeUndefined();
      expect(authorizeChatToolCall('ms_todo_complete_task', { userId: 0 }, 0, 0)).toMatchObject({
        allowed: false,
        code: 'AUTH_REQUIRED',
      });
    });

    expect(getTenantScopeAnomalies(1)[0]).toMatchObject({
      layer: 'delivery',
      operation: 'telegram_bot_middleware_authorization',
      reason: 'invalid_user_scope',
    });
  });
});
