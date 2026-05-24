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

  it('maps notification previews into notification cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'notifications.snooze',
      routeGuess: {
        intent: 'modify_action',
        confidence: 0.83,
        domains: ['notifications'],
        capabilityIds: ['notifications.snooze'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'notifications.snooze',
      },
      command: {
        commandId: 'cmd_notification',
        commandSchemaVersion: 'notifications.snooze@1.0.0',
        previewSchemaVersion: 'notification_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'notifications',
        commandType: 'notifications.snooze',
        origin: 'chat',
        payload: {
          operation: 'snooze',
          notificationId: 'nc_budget',
          title: 'Budget alert',
          currentStatus: 'unread',
          targetStatus: 'snoozed',
          snoozeMinutes: 60,
          snoozedUntil: '2026-05-24T13:34:56.000Z',
        },
        basedOn: {
          entityIds: ['notification:nc_budget'],
          entityVersions: { 'notification:nc_budget': 'abc123def4567890' },
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: { 'notification:nc_budget': 'abc123def4567890' },
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:notifications:v1',
          invariants: [{
            type: 'notification_status',
            description: 'Notification must still be snooze-eligible when the preview is confirmed.',
            check: 'notification_is_snooze_eligible',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['notifications:read', 'notifications:write'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:notifications:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:notification-snooze',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would snooze "Budget alert" for 1 hour.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'notification_preview_card',
          version: 'notification_preview_card@1.0.0',
          title: 'Snooze preview: Budget alert',
          summary: 'I would snooze "Budget alert" for 1 hour.',
          risk: 'low',
          sensitivity: 'personal',
          capabilityId: 'notifications.snooze',
          commandId: 'cmd_notification',
          sourceEntityIds: ['notification:nc_budget'],
          diff: [{ label: 'Status', before: 'Unread', after: 'Snoozed' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'notificationCard',
      notificationId: 'nc_budget',
      title: 'Budget alert',
      detail: 'I would snooze "Budget alert" for 1 hour.',
    }]);
    expect(built.response.metadata.chatCoreV2.command).toMatchObject({
      commandSchemaVersion: 'notifications.snooze@1.0.0',
      domain: 'notifications',
      commandType: 'notifications.snooze',
      payload: {
        notificationId: 'nc_budget',
        title: 'Budget alert',
        targetStatus: 'snoozed',
      },
      preconditions: {
        requiredEntityVersions: { 'notification:nc_budget': 'abc123def4567890' },
        hasPermissionSnapshot: true,
      },
    });
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });

  it('maps secretary schedule previews into pending event cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'secretary.schedule_event_preview',
      routeGuess: {
        intent: 'create_action',
        confidence: 0.84,
        domains: ['secretary'],
        capabilityIds: ['secretary.schedule_event_preview'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'secretary.schedule_event_preview',
      },
      command: {
        commandId: 'cmd_calendar',
        commandSchemaVersion: 'secretary.schedule_event@1.0.0',
        previewSchemaVersion: 'calendar_change_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'secretary',
        commandType: 'secretary.schedule_event',
        origin: 'chat',
        payload: {
          operation: 'schedule_event',
          title: 'weekly sync',
          provider: 'google_calendar',
          calendarId: 'primary',
          startDateTime: '2026-05-29T14:00:00+01:00',
          endDateTime: '2026-05-29T15:00:00+01:00',
          timezone: 'Europe/Lisbon',
          attendees: ['pedro@example.com'],
          location: null,
          notes: null,
          recurrence: null,
          status: 'preview',
        },
        basedOn: {
          entityIds: ['calendar_event_draft:cmd_calendar'],
          entityVersions: {},
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: {},
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:secretary:v1',
          invariants: [{
            type: 'preview_only',
            description: 'Secretary calendar previews do not create events or invite attendees in this rollout.',
            check: 'secretary_schedule_event_preview_only',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['secretary:read'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:secretary:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:secretary-schedule',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would prepare "weekly sync" from Fri, 29 May, 14:00 to Fri, 29 May, 15:00. No calendar event or invite would be created yet.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'calendar_change_preview_card',
          version: 'calendar_change_preview_card@1.0.0',
          title: 'Calendar preview: weekly sync',
          summary: 'I would prepare "weekly sync".',
          risk: 'medium',
          sensitivity: 'personal',
          capabilityId: 'secretary.schedule_event_preview',
          commandId: 'cmd_calendar',
          sourceEntityIds: ['calendar_event_draft:cmd_calendar'],
          diff: [{ label: 'Event', after: 'weekly sync' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'eventCard',
      eventId: null,
      title: 'weekly sync',
      startAt: '2026-05-29T14:00:00+01:00',
      endAt: '2026-05-29T15:00:00+01:00',
      location: null,
      attendees: ['pedro@example.com'],
      status: 'pending',
    }]);
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });

  it('maps training modification previews into training session cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'training.modify_session_preview',
      routeGuess: {
        intent: 'modify_action',
        confidence: 0.83,
        domains: ['training'],
        capabilityIds: ['training.modify_session_preview'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'training.modify_session_preview',
      },
      command: {
        commandId: 'cmd_training',
        commandSchemaVersion: 'training.modify_session@1.0.0',
        previewSchemaVersion: 'training_change_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'training',
        commandType: 'training.modify_session',
        origin: 'chat',
        payload: {
          operation: 'modify_session',
          changeType: 'reduce_intensity',
          sessionId: 701,
          planId: 501,
          weekId: 601,
          title: 'Lower-body strength',
          dayOfWeek: 'Monday',
          sessionDate: '2026-05-25',
          sessionDateLabel: 'Mon, 25 May',
          sessionType: 'strength',
          currentIntensity: 'hard',
          targetIntensity: 'easier',
          currentDurationMinutes: 55,
          status: 'preview',
          safetyPolicyVersion: 'chat_core_v2_training_safety_policy@1.0.0',
        },
        basedOn: {
          entityIds: ['training_session:701', 'training_plan:501'],
          entityVersions: {
            'training_session:701': 'abc123def4567890',
            'training_plan:501': 'def456abc1237890',
          },
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: {
            'training_session:701': 'abc123def4567890',
            'training_plan:501': 'def456abc1237890',
          },
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:training:v1',
          invariants: [{
            type: 'preview_only',
            description: 'Training session modification previews do not change the plan in this rollout.',
            check: 'training_modify_session_preview_only',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['training:read'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:training:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:training-preview',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would prepare a lighter version of "Lower-body strength" for Mon, 25 May. Your training plan would not change yet.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'training_change_preview_card',
          version: 'training_change_preview_card@1.0.0',
          title: 'Training preview: Lower-body strength',
          summary: 'I would prepare a lighter version of "Lower-body strength".',
          risk: 'medium',
          sensitivity: 'health_adjacent',
          capabilityId: 'training.modify_session_preview',
          commandId: 'cmd_training',
          sourceEntityIds: ['training_session:701', 'training_plan:501'],
          diff: [{ label: 'Intensity', before: 'hard', after: 'Easier' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'trainingSessionCard',
      sessionId: '701',
      title: 'Lower-body strength',
      dateLabel: 'Mon, 25 May',
      summary: [{
        kind: 'paragraph',
        text: 'I would prepare a lighter version of "Lower-body strength" for Mon, 25 May. Your training plan would not change yet.',
      }],
    }]);
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });

  it('maps decision previews into decision cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'decision_center.dismiss',
      routeGuess: {
        intent: 'modify_action',
        confidence: 0.82,
        domains: ['decision_center'],
        capabilityIds: ['decision_center.dismiss'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'decision_center.dismiss',
      },
      command: {
        commandId: 'cmd_decision',
        commandSchemaVersion: 'decision_center.dismiss@1.0.0',
        previewSchemaVersion: 'decision_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'decision_center',
        commandType: 'decision_center.dismiss',
        origin: 'chat',
        payload: {
          operation: 'dismiss',
          decisionId: 'dc_schedule',
          title: 'Schedule decision',
          currentStatus: 'unread',
          targetStatus: 'dismissed',
        },
        basedOn: {
          entityIds: ['decision:dc_schedule'],
          entityVersions: { 'decision:dc_schedule': 'abc123def4567890' },
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: { 'decision:dc_schedule': 'abc123def4567890' },
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:decision_center:v1',
          requiredDecisionVersion: 'abc123def4567890',
          invariants: [{
            type: 'decision_status',
            description: 'Decision must still be dismissible when the preview is confirmed.',
            check: 'decision_is_active',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['decision_center:read', 'decision_center:write'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:decision_center:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:decision-dismiss',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would dismiss "Schedule decision" from Decision Center. Nothing else would change.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'decision_preview_card',
          version: 'decision_preview_card@1.0.0',
          title: 'Dismiss preview: Schedule decision',
          summary: 'I would dismiss "Schedule decision" from Decision Center. Nothing else would change.',
          risk: 'low',
          sensitivity: 'personal',
          capabilityId: 'decision_center.dismiss',
          commandId: 'cmd_decision',
          sourceEntityIds: ['decision:dc_schedule'],
          diff: [{ label: 'Status', before: 'Active', after: 'Dismissed' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'decisionCard',
      decisionId: 'dc_schedule',
      status: 'pending',
      detail: 'I would dismiss "Schedule decision" from Decision Center. Nothing else would change.',
    }]);
    expect(built.response.metadata.chatCoreV2.command).toMatchObject({
      commandSchemaVersion: 'decision_center.dismiss@1.0.0',
      domain: 'decision_center',
      commandType: 'decision_center.dismiss',
      payload: {
        decisionId: 'dc_schedule',
        title: 'Schedule decision',
        targetStatus: 'dismissed',
      },
      preconditions: {
        requiredEntityVersions: { 'decision:dc_schedule': 'abc123def4567890' },
        hasPermissionSnapshot: true,
        hasDecisionSnapshot: true,
      },
    });
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });

  it('maps cooking grocery previews into grocery cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'cooking.grocery_item_preview',
      routeGuess: {
        intent: 'create_action',
        confidence: 0.8,
        domains: ['cooking'],
        capabilityIds: ['cooking.grocery_item_preview'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'cooking.grocery_item_preview',
      },
      command: {
        commandId: 'cmd_grocery',
        commandSchemaVersion: 'cooking.grocery_item@1.0.0',
        previewSchemaVersion: 'grocery_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'cooking',
        commandType: 'cooking.grocery_item',
        origin: 'chat',
        payload: {
          operation: 'add_items',
          items: ['eggs', 'milk'],
          itemCount: 2,
          weekStart: '2026-05-18',
          list: 'grocery',
        },
        basedOn: {
          entityIds: ['cooking_grocery_draft:cmd_grocery'],
          entityVersions: {},
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: {},
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:cooking:v1',
          invariants: [{
            type: 'preview_only',
            description: 'Grocery item previews do not mutate the shopping list in this rollout.',
            check: 'cooking_grocery_preview_only',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['cooking:read'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:cooking:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:grocery',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would prepare eggs and milk for the grocery list. Nothing would be added yet.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'grocery_preview_card',
          version: 'grocery_preview_card@1.0.0',
          title: 'Grocery preview: eggs and milk',
          summary: 'I would prepare eggs and milk for the grocery list. Nothing would be added yet.',
          risk: 'low',
          sensitivity: 'personal',
          capabilityId: 'cooking.grocery_item_preview',
          commandId: 'cmd_grocery',
          sourceEntityIds: ['cooking_grocery_draft:cmd_grocery'],
          diff: [{ label: 'Items', after: 'eggs and milk' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'groceryListCard',
      weekStart: '2026-05-18',
      items: ['eggs', 'milk'],
    }]);
    expect(built.response.metadata.chatCoreV2.command).toMatchObject({
      commandSchemaVersion: 'cooking.grocery_item@1.0.0',
      domain: 'cooking',
      commandType: 'cooking.grocery_item',
      payload: {
        operation: 'add_items',
        items: ['eggs', 'milk'],
        weekStart: '2026-05-18',
      },
      preconditions: {
        requiredEntityVersions: {},
        hasPermissionSnapshot: true,
      },
    });
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });

  it('maps content brief previews into content surface cards without leaking authorization scope', () => {
    const requestStartedAt = Date.parse('2026-05-24T12:34:56.000Z');
    const result: ChatCoreV2CommandPreviewRouteResult = {
      routeVersion: 'chat_core_v2_command_preview_route@1.0.0',
      capabilityId: 'content.brief_draft_preview',
      routeGuess: {
        intent: 'create_action',
        confidence: 0.8,
        domains: ['content'],
        capabilityIds: ['content.brief_draft_preview'],
      },
      executionEnabled: false,
      executionDisabledReason: 'preview_only_rollout',
      gateVerdict: {
        ok: true,
        operation: 'preview',
        gateVersion: 'chat_core_v2_command_bus_gate@1.0.0',
        commandStatus: 'previewed',
        capabilityId: 'content.brief_draft_preview',
      },
      command: {
        commandId: 'cmd_content',
        commandSchemaVersion: 'content.brief_draft@1.0.0',
        previewSchemaVersion: 'content_brief_preview_card@1.0.0',
        responseSchemaVersion: 'chat_response_v2@1.0.0',
        tenantId: '84',
        userId: '42',
        domain: 'content',
        commandType: 'content.brief_draft',
        origin: 'chat',
        payload: {
          operation: 'draft_brief',
          topic: 'recovery after hard intervals',
          objective: 'Prepare a content brief about recovery after hard intervals.',
          format: 'content',
          status: 'preview',
        },
        basedOn: {
          entityIds: ['content_brief_draft:cmd_content'],
          entityVersions: {},
          contextHash: 'abc123def4567890',
          createdAt: '2026-05-24T12:34:56.000Z',
        },
        preconditions: {
          requiredEntityVersions: {},
          requiredPermissionsVersion: 'chat-v2-permissions:84:42:content:v1',
          invariants: [{
            type: 'preview_only',
            description: 'Content brief previews do not create drafts, scripts, or publishable content in this rollout.',
            check: 'content_brief_preview_only',
          }],
        },
        authorization: {
          actorUserId: '42',
          tenantId: '84',
          actingSurface: 'ios_chat',
          delegatedScopes: ['content:read'],
          permissionSnapshotVersion: 'chat-v2-permissions:84:42:content:v1',
          authTime: '2026-05-24T12:34:56.000Z',
        },
        expiresAt: '2026-05-24T12:44:56.000Z',
        idempotencyKey: 'chat-v2:84:42:content-brief',
      },
      response: {
        schemaVersion: 'chat_response_v2@1.0.0',
        kind: 'action_preview',
        locale: 'en',
        text: 'I would prepare a content brief about recovery after hard intervals. Nothing would be created or published yet.',
        reasonCodes: ['preview_only_rollout'],
        cards: [{
          type: 'content_brief_preview_card',
          version: 'content_brief_preview_card@1.0.0',
          title: 'Content brief preview: recovery after hard intervals',
          summary: 'I would prepare a content brief about recovery after hard intervals. Nothing would be created or published yet.',
          risk: 'low',
          sensitivity: 'personal',
          capabilityId: 'content.brief_draft_preview',
          commandId: 'cmd_content',
          sourceEntityIds: ['content_brief_draft:cmd_content'],
          diff: [{ label: 'Topic', after: 'recovery after hard intervals' }],
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

    expect(built.response.responseCards).toEqual([{
      kind: 'openSurfaceCard',
      surface: 'content',
      pendingActionId: null,
      prefill: {
        kind: 'content_brief_preview',
        topic: 'recovery after hard intervals',
        format: 'content',
        objective: 'Prepare a content brief about recovery after hard intervals.',
      },
    }]);
    expect(built.response.metadata.chatCoreV2.command).toMatchObject({
      commandSchemaVersion: 'content.brief_draft@1.0.0',
      domain: 'content',
      commandType: 'content.brief_draft',
      payload: {
        operation: 'draft_brief',
        topic: 'recovery after hard intervals',
        status: 'preview',
      },
      preconditions: {
        requiredEntityVersions: {},
        hasPermissionSnapshot: true,
      },
    });
    const metadataJson = JSON.stringify(built.response.metadata);
    expect(metadataJson).not.toContain('actorUserId');
    expect(metadataJson).not.toContain('delegatedScopes');
    expect(metadataJson).not.toContain('idempotencyKey');
    expect(metadataJson).not.toContain('chat-v2-permissions:84:42');
  });
});
