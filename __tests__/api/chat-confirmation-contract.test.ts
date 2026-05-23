// Copyright (c) 2026 Felipe Dominguez. MIT License. See LICENSE.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  signChatConfirmationToken,
  validateChatConfirmationToken,
} from '../../src/services/chat-confirmation-token';
import {
  getCompletedChatConfirmation,
  getPendingChatConfirmation,
  rememberCompletedChatConfirmation,
  resetPendingChatConfirmationsForTests,
  trackPendingChatConfirmation,
} from '../../src/services/chat-pending-confirmations';
import {
  authorizeChatToolCall,
  runWithChatToolAuthorization,
} from '../../src/services/chat-tool-authorization';

const now = new Date('2026-05-23T10:00:00.000Z');
const userId = 7001;
const tenantId = 7001;

function issuePendingTaskCreate() {
  const pending = trackPendingChatConfirmation({
    userId,
    tenantId,
    actionSummary: 'Add a task to call my dentist on Friday',
    involvedSkills: ['secretary'],
    reasonCodes: ['write_requires_confirmation'],
    intentClass: 'task_create',
    summary: { title: 'Call my dentist', due_at: '2026-05-29' },
    sourceMessageId: 'msg-user-contract',
    now,
  });
  const confirmationToken = signChatConfirmationToken({
    pendingId: pending.id,
    userId,
    tenantId,
    intentClass: 'task_create',
    expiresAt: pending.expiresAt,
    sourceMessageId: pending.sourceMessageId,
    now,
  });
  return { pending, confirmationToken };
}

afterEach(() => {
  resetPendingChatConfirmationsForTests();
});

describe('chat confirmation contract', () => {
  it('write intent without token returns a pending-confirmation envelope and does not mutate', async () => {
    const executeMutation = vi.fn();
    const { pending, confirmationToken } = issuePendingTaskCreate();

    await runWithChatToolAuthorization(
      {
        userId,
        tenantId,
        confirmedDestructiveAction: false,
        confirmationSource: 'none',
        requireConfirmationForWrites: true,
      },
      async () => {
        const authorization = authorizeChatToolCall('ms_todo_create_task', { userId, tenantId }, userId, tenantId);
        expect(authorization).toMatchObject({
          allowed: false,
          code: 'CONFIRMATION_REQUIRED',
          confirmationRequired: true,
          toolRisk: 'write',
        });
        if (authorization.allowed) executeMutation();
      },
    );

    expect(executeMutation).not.toHaveBeenCalled();
    expect(getPendingChatConfirmation(userId, tenantId, now)).toMatchObject({
      id: pending.id,
      intentClass: 'task_create',
      summary: { title: 'Call my dentist', due_at: '2026-05-29' },
    });
    expect({
      kind: 'pending_confirmation',
      intent_class: pending.intentClass,
      summary: pending.summary,
      confirmation_token: confirmationToken,
      expires_at: pending.expiresAt,
    }).toMatchObject({
      kind: 'pending_confirmation',
      intent_class: 'task_create',
      confirmation_token: expect.any(String),
      expires_at: expect.any(String),
    });
  });

  it('stale token is rejected before execution', () => {
    const { pending } = issuePendingTaskCreate();
    const staleToken = signChatConfirmationToken({
      pendingId: pending.id,
      userId,
      tenantId,
      intentClass: 'task_create',
      expiresAt: '2026-05-23T09:59:00.000Z',
      sourceMessageId: pending.sourceMessageId,
      now: new Date('2026-05-23T09:50:00.000Z'),
    });

    const validation = validateChatConfirmationToken(staleToken, {
      userId,
      tenantId,
      intentClass: 'task_create',
      now,
    });

    expect(validation).toEqual({ ok: false, code: 'expired_token' });
  });

  it('wrong-user token is rejected before execution', () => {
    const { confirmationToken } = issuePendingTaskCreate();

    const validation = validateChatConfirmationToken(confirmationToken, {
      userId: 7002,
      tenantId: 7002,
      intentClass: 'task_create',
      now,
    });

    expect(validation).toEqual({ ok: false, code: 'wrong_scope' });
  });

  it('valid token and matching intent allow execution to proceed', async () => {
    const executeMutation = vi.fn(async () => ({ taskId: 'task-contract-1' }));
    const { confirmationToken } = issuePendingTaskCreate();

    const validation = validateChatConfirmationToken(confirmationToken, {
      userId,
      tenantId,
      intentClass: 'task_create',
      now,
    });
    expect(validation).toMatchObject({ ok: true });

    await runWithChatToolAuthorization(
      {
        userId,
        tenantId,
        confirmedDestructiveAction: true,
        confirmationSource: 'pending_confirmation',
        requireConfirmationForWrites: true,
      },
      async () => {
        const authorization = authorizeChatToolCall('ms_todo_create_task', { userId, tenantId }, userId, tenantId);
        expect(authorization).toMatchObject({ allowed: true, toolRisk: 'write' });
        if (authorization.allowed) await executeMutation();
      },
    );

    expect(executeMutation).toHaveBeenCalledTimes(1);
  });

  it('idempotent re-submit with same token returns the prior result without a second mutation', async () => {
    const executeMutation = vi.fn(async () => ({
      id: 'msg-confirmed-contract',
      metadata: { actionStatus: 'verified_success' },
    }));
    const { pending, confirmationToken } = issuePendingTaskCreate();

    const firstResult = await executeMutation();
    rememberCompletedChatConfirmation({
      confirmationToken,
      userId,
      tenantId,
      expiresAt: pending.expiresAt,
      statusCode: 200,
      responseBody: firstResult,
      now,
    });

    const replay = getCompletedChatConfirmation(confirmationToken, userId, tenantId, now);

    expect(replay).toMatchObject({
      statusCode: 200,
      responseBody: firstResult,
    });
    expect(executeMutation).toHaveBeenCalledTimes(1);
  });
});
