import { describe, expect, it } from 'vitest';
import {
  authorizeChatToolCall,
  getChatToolRisk,
  isChatToolRiskClassified,
  runWithChatToolAuthorization,
} from '../../src/services/chat-tool-authorization';
import { DISPATCHABLE_TOOL_NAMES } from '../../src/services/tool-executor';

describe('chat tool authorization fail-closed behavior', () => {
  it('denies tool calls when AsyncLocalStorage authorization context is missing', () => {
    const result = authorizeChatToolCall('create_calendar_event', { title: 'private tenant event' }, 7, 70);

    expect(result).toMatchObject({
      allowed: false,
      code: 'AUTH_REQUIRED',
      toolRisk: 'write',
      message: 'create_calendar_event requires authenticated chat authorization context',
    });
  });

  it('classifies shared_memory_set as destructive because it persists long-lived memory', () => {
    expect(getChatToolRisk('shared_memory_set')).toBe('destructive');
  });

  it('requires every dispatchable tool to have an explicit risk classification', () => {
    for (const toolName of DISPATCHABLE_TOOL_NAMES) {
      expect(isChatToolRiskClassified(toolName), `${toolName} is missing a chat risk classification`).toBe(true);
    }
  });

  it('fails closed for unknown future tools by requiring write confirmation', async () => {
    expect(getChatToolRisk('secretary_send_invite')).toBe('write');

    await runWithChatToolAuthorization(
      {
        userId: 4242,
        tenantId: 4242,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
        requireConfirmationForWrites: true,
      },
      async () => {
        const result = authorizeChatToolCall(
          'secretary_send_invite',
          { userId: 4242, tenantId: 4242 },
          4242,
          4242,
        );

        expect(result).toMatchObject({
          allowed: false,
          code: 'CONFIRMATION_REQUIRED',
          confirmationRequired: true,
          toolRisk: 'write',
        });
      },
    );
  });
});
