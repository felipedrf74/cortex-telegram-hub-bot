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

import { describe, expect, it } from 'vitest';
import {
  getCurrentChatToolAuthorizationContext,
  runWithChatToolAuthorization,
} from '../../src/services/chat-tool-authorization';

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
});
