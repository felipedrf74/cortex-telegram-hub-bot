// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type {
  ChatCoreV2CommandExecutionResult,
  PendingChatCoreV2Command,
} from '../../services/chat-core-v2';
import type { ChatResponseCard } from '../../services/chat-response-cards';

export interface ChatCoreV2CommandConfirmationShortcutResponse {
  id: string;
  text: string;
  domain: 'secretary';
  routeMethod: 'chat-core-v2-command-confirmation';
  confidence: number;
  buttons: null;
  metadata: {
    type: 'chat_core_v2_command_result';
    actionStatus: string;
    verificationStatus: string;
    pendingConfirmation: {
      kind: 'completed_confirmation';
      id: string;
      intent_class: string;
      intentClass: string;
      expires_at: string;
      expiresAt: string;
    };
    chatCoreV2: {
      capabilityId: string;
      executorVersion: string;
      commandId: string;
      commandType: string;
      status: string;
      response: ChatCoreV2CommandExecutionResult['response'];
      gate: {
        ok: boolean;
        operation: string;
        gateVersion: string;
        commandStatus: string;
        capabilityId?: string;
      };
    };
  };
  timestamp: string;
  responseCards: ChatResponseCard[];
}

export function buildChatCoreV2CommandConfirmationShortcutResponse(input: {
  pending: PendingChatCoreV2Command;
  execution: ChatCoreV2CommandExecutionResult & { response: NonNullable<ChatCoreV2CommandExecutionResult['response']> };
  requestStartedAt: number;
}): ChatCoreV2CommandConfirmationShortcutResponse {
  const { pending, execution, requestStartedAt } = input;
  return {
    id: `msg-${requestStartedAt}`,
    text: execution.response.text,
    domain: 'secretary',
    routeMethod: 'chat-core-v2-command-confirmation',
    confidence: 1,
    buttons: null,
    metadata: {
      type: 'chat_core_v2_command_result',
      actionStatus: execution.status,
      verificationStatus: execution.status,
      pendingConfirmation: {
        kind: 'completed_confirmation',
        id: pending.commandId,
        intent_class: pending.command.commandType,
        intentClass: pending.command.commandType,
        expires_at: pending.expiresAt,
        expiresAt: pending.expiresAt,
      },
      chatCoreV2: {
        capabilityId: pending.capabilityId,
        executorVersion: execution.executorVersion,
        commandId: pending.commandId,
        commandType: pending.command.commandType,
        status: execution.status,
        response: execution.response,
        gate: {
          ok: execution.gateVerdict.ok,
          operation: execution.gateVerdict.operation,
          gateVersion: execution.gateVerdict.gateVersion,
          commandStatus: execution.gateVerdict.commandStatus,
          capabilityId: execution.gateVerdict.capabilityId,
        },
      },
    },
    timestamp: new Date(requestStartedAt).toISOString(),
    responseCards: buildResultCards(pending, execution),
  };
}

function buildResultCards(
  pending: PendingChatCoreV2Command,
  execution: ChatCoreV2CommandExecutionResult,
): ChatResponseCard[] {
  if (pending.command.commandType === 'tasks.create') {
    const payload = pending.command.payload;
    return [{
      kind: 'taskCard',
      // M5 single write path: prefer the NEXUS id — the id the REST read
      // model speaks. The numeric row id remains the legacy flag-off shape.
      taskId: execution.createdTaskNexusId
        ?? (typeof execution.createdTaskId === 'number' ? String(execution.createdTaskId) : null),
      title: typeof payload.title === 'string' ? payload.title : 'Task',
      status: execution.status === 'verified' ? 'created' : 'pending',
      dueAt: typeof payload.dueDateTime === 'string' ? payload.dueDateTime : null,
      listName: typeof payload.list === 'string' ? payload.list : null,
    }];
  }
  if (pending.command.commandType === 'tasks.complete') {
    const payload = pending.command.payload;
    return [{
      kind: 'taskCard',
      taskId: typeof execution.completedTaskId === 'number'
        ? String(execution.completedTaskId)
        : typeof payload.taskId === 'number'
          ? String(payload.taskId)
          : null,
      title: typeof payload.title === 'string' ? payload.title : 'Task',
      status: execution.status === 'verified' ? 'completed' : 'pending',
      dueAt: typeof payload.dueDateTime === 'string' ? payload.dueDateTime : null,
      listName: null,
    }];
  }
  if (pending.command.commandType === 'notifications.snooze') {
    const payload = pending.command.payload;
    const notificationId = typeof execution.snoozedNotificationId === 'string'
      ? execution.snoozedNotificationId
      : typeof payload.notificationId === 'string'
        ? payload.notificationId
        : null;
    return [{
      kind: 'notificationCard',
      notificationId,
      title: typeof payload.title === 'string' ? payload.title : 'Notification',
      detail: execution.response?.text ?? null,
    }];
  }
  if (pending.command.commandType === 'decision_center.dismiss') {
    const payload = pending.command.payload;
    const decisionId = typeof execution.dismissedDecisionId === 'string'
      ? execution.dismissedDecisionId
      : typeof payload.decisionId === 'string'
        ? payload.decisionId
        : '';
    return [{
      kind: 'decisionCard',
      decisionId,
      status: 'dismissed',
      detail: execution.response?.text ?? null,
    }];
  }
  return [];
}
