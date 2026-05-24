import { describe, expect, it } from 'vitest';

import { buildChatCoreV2CommandPreviewShortcutResponse } from '../../src/api/routes/chat-core-v2-command-preview-response';
import type { ChatCoreV2CommandPreviewRouteResult } from '../../src/services/chat-core-v2';

describe('Chat Core v2 command preview API adapter', () => {
  it('maps preview-only commands into the legacy iOS chat envelope without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'tasks.create',
      routeGuess: {
        intent: 'create_action',
        confidence: 0.88,
        domains: ['tasks'],
        capabilityIds: ['tasks.create'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'tasks.create',
      },
      command: {
        commandId: 'cmd_abc123',
        commandSchemaVersion: 'tasks.create@1.0.0',
        previewSchemaVersion: 'task_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'tasks',
        commandType: 'tasks.create',
        origin: 'chat',
        payload: {
          title: 'Buy milk',
          dueDateTime: null,
          list: null,
          notes: null,
        },
        basedOn: {
          entityIds: ['task_draft:cmd_abc123'],
          entityVersions: {},
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: {},
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:tasks:v1',
          invariants: [],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['tasks:read', 'tasks:write'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:tasks:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:task-create',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would prepare the task "Buy milk".',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'task_preview_card',
          version: '1.0.0',
          title: 'Task preview: Buy milk',
          summary: 'I would prepare the task "Buy milk".',
          risk: 'low',
          sensitivity: 'personal',
          capabilityId: 'tasks.create',
          commandId: 'cmd_abc123',
          sourceEntityIds: ['task_draft:cmd_abc123'],
          diff: [{ label: 'Task', after: 'Buy milk' }],
          primaryAction: {
            id: 'view',
            kind: 'view',
            label: 'View',
            style: 'primary',
          },
          secondaryActions: [],
        }],
      },
    };

    const built = buildChatCoreV2CommandPreviewShortcutResponse({
      result,
      requestStartedAt,
    });

    expect(built.conversationDomain).toBe('secretary');
    expect(built.logContext).toEqual({
      capabilityId: 'tasks.create',
      commandId: 'cmd_abc123',
    });
    expect(built.response).toMatchObject({
      id: `msg-${requestStartedAt}`,
      text: 'I would prepare the task "Buy milk".',
      domain: 'secretary',
      routeMethod: 'chat-core-v2-command-preview',
      confidence: 0.88,
      buttons: null,
      timestamp: '2026-05-24T12:34:56.000Z',
      metadata: {
        type: 'chat_core_v2_command_preview',
        chatCoreV2: {
          capabilityId: 'tasks.create',
          executionEnabled: false,
          executionDisabledReason: 'preview_only_rollout',
          command: {
            commandId: 'cmd_abc123',
            commandSchemaVersion: 'tasks.create@1.0.0',
            previewSchemaVersion: 'task_preview_card@1.0.0',
            responseSchemaVersion: 'chat_response_v2@1.0.0',
            domain: 'tasks',
            commandType: 'tasks.create',
            origin: 'chat',
            payload: {
              title: 'Buy milk',
            },
            preconditions: {
              requiredEntityVersions: {},
              invariants: [],
              hasPermissionSnapshot: true,
              hasTenantPolicySnapshot: false,
              hasIntegrationConnectionSnapshot: false,
              hasDecisionSnapshot: false,
            },
          },
          response: {
            schemaVersion: 'chat_response_v2@1.0.0',
            kind: 'action_preview',
            locale: 'en',
            reasonCodes: ['preview_only_rollout'],
          },
          gate: {
            ok: true,
            operation: 'preview',
            commandStatus: 'previewed',
          },
        },
      },
      responseCards: [{
        kind: 'taskCard',
        title: 'Buy milk',
        status: 'pending',
        dueAt: null,
        listName: null,
      }],
    });
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });
});
