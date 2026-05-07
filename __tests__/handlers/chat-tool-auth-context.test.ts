import { describe, expect, it } from 'vitest';

import { runTelegramDomainHandlerWithToolAuthorization } from '../../src/handlers/chat-tool-auth-context';
import {
  authorizeChatToolCall,
  getCurrentChatToolAuthorizationContext,
} from '../../src/services/chat-tool-authorization';

describe('Telegram chat-tool authorization context', () => {
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
});
