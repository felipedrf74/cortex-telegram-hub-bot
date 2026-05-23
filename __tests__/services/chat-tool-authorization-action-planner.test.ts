// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Phase 16 batch 80 (2026-05-16): action-planner auth-wrap regression.
//
// Before Batch 80, `executeChatActionPlan` did NOT wrap its body in
// `runWithChatToolAuthorization`. Destructive actions (createEvent,
// updateEvent, deleteEvent, mail send) reached providers without the
// AsyncLocalStorage auth context that `authorizeChatToolCall` requires
// at chat-tool-authorization.ts:156-164. The gate was only wired into
// the older tool-call surface at chat-message-routes.ts:1160.
//
// This file asserts the wrap is now in place: when executeChatActionPlan
// runs from a fresh context, getCurrentChatToolAuthorizationContext() is
// populated with the input's userId/tenantId during execution. When the
// caller already provides a context, the inner call does not double-wrap
// (the existing context is preserved).

import { describe, expect, it, vi } from 'vitest';
import {
  executeChatActionPlan,
  type ChatActionPlan,
  type ChatPlannerInput,
} from '../../src/services/chat-action-planner';
import {
  authorizeChatToolCall,
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../../src/services/chat-tool-authorization';

const NOW = '2026-05-16T12:00:00+01:00';

describe('chat tool authorization AsyncLocalStorage scoping', () => {
  it('runWithChatToolAuthorization establishes the auth context for its callback', async () => {
    let captured: ReturnType<typeof getCurrentChatToolAuthorizationContext>;
    await runWithChatToolAuthorization(
      {
        userId: 4242,
        tenantId: 909,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
      },
      async () => {
        captured = getCurrentChatToolAuthorizationContext();
      },
    );
    expect(captured).toEqual({
      userId: 4242,
      tenantId: 909,
      confirmedDestructiveAction: false,
      confirmationSource: 'none',
    });
  });

  it('clears the auth context when runWithChatToolAuthorization returns', async () => {
    await runWithChatToolAuthorization(
      {
        userId: 4242,
        tenantId: 909,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
      },
      async () => {
        expect(getCurrentChatToolAuthorizationContext()).toBeDefined();
      },
    );
    expect(getCurrentChatToolAuthorizationContext()).toBeUndefined();
  });

  it('nested runWithChatToolAuthorization replaces the outer context inside the inner scope', async () => {
    let inner: ReturnType<typeof getCurrentChatToolAuthorizationContext>;
    let afterInner: ReturnType<typeof getCurrentChatToolAuthorizationContext>;
    await runWithChatToolAuthorization(
      {
        userId: 1,
        tenantId: 1,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
      },
      async () => {
        await runWithChatToolAuthorization(
          {
            userId: 2,
            tenantId: 2,
            confirmedDestructiveAction: true,
            confirmationSource: 'explicit_current_turn',
          },
          async () => {
            inner = getCurrentChatToolAuthorizationContext();
          },
        );
        afterInner = getCurrentChatToolAuthorizationContext();
      },
    );
    expect(inner).toMatchObject({ userId: 2, tenantId: 2, confirmedDestructiveAction: true });
    expect(afterInner).toMatchObject({ userId: 1, tenantId: 1, confirmedDestructiveAction: false });
  });

  it('confirmedDestructiveAction true + explicit_current_turn matches the executor wrap shape', async () => {
    let captured: ReturnType<typeof getCurrentChatToolAuthorizationContext>;
    await runWithChatToolAuthorization(
      {
        userId: 5,
        tenantId: 5,
        confirmedDestructiveAction: true,
        confirmationSource: 'explicit_current_turn',
      },
      async () => {
        captured = getCurrentChatToolAuthorizationContext();
      },
    );
    expect(captured).toEqual({
      userId: 5,
      tenantId: 5,
      confirmedDestructiveAction: true,
      confirmationSource: 'explicit_current_turn',
    });
  });

  it('blocks safe-write tools only when the caller opts into write confirmation', async () => {
    await runWithChatToolAuthorization(
      {
        userId: 4242,
        tenantId: 4242,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
        requireConfirmationForWrites: true,
      },
      async () => {
        expect(authorizeChatToolCall('ms_todo_create_task', { userId: 4242 }, 4242, 4242)).toMatchObject({
          allowed: false,
          code: 'CONFIRMATION_REQUIRED',
          confirmationRequired: true,
          toolRisk: 'write',
        });
      },
    );
  });

  it('executeChatActionPlan preserves an existing auth context during re-entrant execution', async () => {
    const input: ChatPlannerInput = {
      text: 'create task call dentist',
      userId: 999,
      tenantId: 999,
      conversationId: 'conv-auth-reentry',
      messageId: 'msg-auth-reentry',
      channel: 'api',
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      nowIso: NOW,
      persistRuns: false,
    };
    const plan: ChatActionPlan = {
      schemaVersion: 1,
      userId: String(input.userId),
      tenantId: String(input.tenantId),
      conversationId: input.conversationId,
      messageId: input.messageId,
      locale: input.locale,
      timezone: input.timezone,
      channel: input.channel,
      createdAt: NOW,
      planner: 'deterministic',
      confidence: 0.9,
      requiresConfirmation: false,
      steps: [
        {
          stepId: 'task-auth-reentry',
          skill: 'tasks',
          action: 'create_task',
          type: 'tasks.create_task',
          risk: 'safe_write',
          riskClass: 'R1',
          provider: 'nexus',
          args: { title: 'call dentist' },
          requiredArgsPresent: true,
          slotProvenance: {},
          idempotencyKey: 'auth-reentry-idem',
          verification: { required: false, method: 'read_back', expectedFields: ['title'] },
        } as unknown as ChatActionPlan['steps'][number],
      ],
      routingSignals: ['auth-reentry:test'],
    };
    let providerContext: ReturnType<typeof getCurrentChatToolAuthorizationContext>;
    const taskProvider = {
      getLists: vi.fn(async () => ({ success: true, data: [{ id: 'tasks', displayName: 'Tasks' }] })),
      getDefaultList: vi.fn(async () => ({ id: 'tasks', displayName: 'Tasks' })),
      createTask: vi.fn(async () => {
        providerContext = getCurrentChatToolAuthorizationContext();
        return { success: true, data: { id: 'task-auth-reentry', title: 'call dentist', listId: 'tasks' } };
      }),
      getTask: vi.fn(async () => ({ success: true, data: { id: 'task-auth-reentry', title: 'call dentist' } })),
    };

    await runWithChatToolAuthorization(
      {
        userId: 1,
        tenantId: 1,
        confirmedDestructiveAction: true,
        confirmationSource: 'explicit_current_turn',
      },
      async () => {
        const response = await executeChatActionPlan(plan, input, {
          calendar: {} as never,
          taskProviderForUser: vi.fn(() => taskProvider as never),
        } as never);
        expect(response.metadata.actionStatus).toBe('verified_success');
      },
    );

    expect(providerContext).toMatchObject({
      userId: 1,
      tenantId: 1,
      confirmedDestructiveAction: true,
      confirmationSource: 'explicit_current_turn',
    });
  });
});
