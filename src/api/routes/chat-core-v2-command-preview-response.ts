// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { ChatCoreV2CommandPreviewRouteResult } from '../../services/chat-core-v2';
import type { ChatResponseCard } from '../../services/chat-response-cards';

export interface ChatCoreV2CommandPreviewShortcutResponse {
  id: string;
  text: string;
  domain: 'secretary';
  routeMethod: 'chat-core-v2-command-preview';
  confidence: number;
  buttons: null;
  metadata: {
    type: 'chat_core_v2_command_preview';
    chatCoreV2: {
      capabilityId: string;
      executionEnabled: false;
      executionDisabledReason: ChatCoreV2CommandPreviewRouteResult['executionDisabledReason'];
      response: {
        schemaVersion: string;
        kind: string;
        locale: string;
        reasonCodes: string[];
        cards: ChatCoreV2CommandPreviewRouteResult['response']['cards'];
      };
      routeGuess: ChatCoreV2CommandPreviewRouteResult['routeGuess'];
      command: {
        commandId: string;
        commandSchemaVersion: string;
        previewSchemaVersion: string;
        responseSchemaVersion: string;
        domain: string;
        commandType: string;
        origin: string;
        payload: unknown;
        basedOn: ChatCoreV2CommandPreviewRouteResult['command']['basedOn'];
        preconditions: {
          requiredEntityVersions: Record<string, string>;
          invariants: ChatCoreV2CommandPreviewRouteResult['command']['preconditions']['invariants'];
          hasPermissionSnapshot: boolean;
          hasTenantPolicySnapshot: boolean;
          hasIntegrationConnectionSnapshot: boolean;
          hasDecisionSnapshot: boolean;
        };
        expiresAt: string;
      };
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

export interface BuildChatCoreV2CommandPreviewShortcutResponseInput {
  result: ChatCoreV2CommandPreviewRouteResult;
  requestStartedAt: number;
}

export interface BuildChatCoreV2CommandPreviewShortcutResponseResult {
  conversationDomain: 'secretary';
  response: ChatCoreV2CommandPreviewShortcutResponse;
  logContext: {
    capabilityId: string;
    commandId: string;
  };
}

export function buildChatCoreV2CommandPreviewShortcutResponse(
  input: BuildChatCoreV2CommandPreviewShortcutResponseInput,
): BuildChatCoreV2CommandPreviewShortcutResponseResult {
  const { result, requestStartedAt } = input;
  const conversationDomain = 'secretary';
  const payload = result.command.payload as Record<string, unknown>;
  const responseCards = buildLegacyResponseCards(result);

  return {
    conversationDomain,
    response: {
      id: `msg-${requestStartedAt}`,
      text: result.response.text,
      domain: conversationDomain,
      routeMethod: 'chat-core-v2-command-preview',
      confidence: result.routeGuess.confidence,
      buttons: null,
      metadata: {
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: result.capabilityId,
          executionEnabled: result.executionEnabled,
          executionDisabledReason: result.executionDisabledReason,
          response: {
            schemaVersion: result.response.schemaVersion,
            kind: result.response.kind,
            locale: result.response.locale,
            reasonCodes: result.response.reasonCodes,
            cards: result.response.cards,
          },
          routeGuess: result.routeGuess,
          command: {
            commandId: result.command.commandId,
            commandSchemaVersion: result.command.commandSchemaVersion,
            previewSchemaVersion: result.command.previewSchemaVersion,
            responseSchemaVersion: result.command.responseSchemaVersion,
            domain: result.command.domain,
            commandType: result.command.commandType,
            origin: result.command.origin,
            payload: result.command.payload,
            basedOn: result.command.basedOn,
            preconditions: {
              requiredEntityVersions: result.command.preconditions.requiredEntityVersions,
              invariants: result.command.preconditions.invariants,
              hasPermissionSnapshot: Boolean(result.command.preconditions.requiredPermissionsVersion),
              hasTenantPolicySnapshot: Boolean(result.command.preconditions.requiredTenantPolicyVersion),
              hasIntegrationConnectionSnapshot: Boolean(result.command.preconditions.requiredIntegrationConnectionVersion),
              hasDecisionSnapshot: Boolean(result.command.preconditions.requiredDecisionVersion),
            },
            expiresAt: result.command.expiresAt,
          },
          gate: {
            ok: result.gateVerdict.ok,
            operation: result.gateVerdict.operation,
            gateVersion: result.gateVerdict.gateVersion,
            commandStatus: result.gateVerdict.commandStatus,
            capabilityId: result.gateVerdict.capabilityId,
          },
        },
      },
      timestamp: new Date(requestStartedAt).toISOString(),
      responseCards,
    },
    logContext: {
      capabilityId: result.capabilityId,
      commandId: result.command.commandId,
    },
  };
}

function buildLegacyResponseCards(result: ChatCoreV2CommandPreviewRouteResult): ChatResponseCard[] {
  const payload = result.command.payload as Record<string, unknown>;
  const title = String(payload.title ?? '').trim();
  if (result.command.domain === 'notifications') {
    const notificationId = typeof payload.notificationId === 'string' && payload.notificationId.trim()
      ? payload.notificationId.trim()
      : null;
    return [{
      kind: 'notificationCard',
      notificationId,
      title,
      detail: result.response.text,
    }];
  }
  if (result.command.domain === 'decision_center') {
    const decisionId = typeof payload.decisionId === 'string' && payload.decisionId.trim()
      ? payload.decisionId.trim()
      : '';
    return [{
      kind: 'decisionCard',
      decisionId,
      status: 'pending',
      detail: result.response.text,
    }];
  }
  if (result.command.domain === 'cooking') {
    const items = Array.isArray(payload.items)
      ? payload.items.map((item) => String(item).trim()).filter(Boolean)
      : [];
    const weekStart = typeof payload.weekStart === 'string' && payload.weekStart.trim()
      ? payload.weekStart.trim()
      : new Date().toISOString().slice(0, 10);
    return [{
      kind: 'groceryListCard',
      weekStart,
      items,
    }];
  }
  if (result.command.domain === 'content') {
    const topic = typeof payload.topic === 'string' && payload.topic.trim()
      ? payload.topic.trim()
      : 'Untitled';
    const format = typeof payload.format === 'string' && payload.format.trim()
      ? payload.format.trim()
      : 'content';
    return [{
      kind: 'openSurfaceCard',
      surface: 'content',
      pendingActionId: null,
      prefill: {
        kind: 'content_brief_preview',
        topic,
        format,
        objective: typeof payload.objective === 'string' ? payload.objective : null,
      },
    }];
  }
  if (result.command.domain === 'secretary') {
    return [{
      kind: 'eventCard',
      eventId: null,
      title,
      startAt: typeof payload.startDateTime === 'string' ? payload.startDateTime : '',
      endAt: typeof payload.endDateTime === 'string' ? payload.endDateTime : null,
      location: typeof payload.location === 'string' ? payload.location : null,
      attendees: Array.isArray(payload.attendees)
        ? payload.attendees.map((attendee) => String(attendee).trim()).filter(Boolean)
        : null,
      status: 'pending',
    }];
  }
  if (result.command.domain === 'training') {
    return [{
      kind: 'trainingSessionCard',
      sessionId: typeof payload.sessionId === 'number' ? String(payload.sessionId) : null,
      title,
      dateLabel: typeof payload.sessionDateLabel === 'string' && payload.sessionDateLabel.trim()
        ? payload.sessionDateLabel.trim()
        : String(payload.dayOfWeek ?? ''),
      summary: [{ kind: 'paragraph', text: result.response.text }],
    }];
  }

  const dueAt = typeof payload.dueDateTime === 'string' && payload.dueDateTime.trim()
    ? payload.dueDateTime.trim()
    : null;
  return [{
    kind: 'taskCard',
    title,
    status: 'pending',
    dueAt,
    listName: null,
  }];
}
