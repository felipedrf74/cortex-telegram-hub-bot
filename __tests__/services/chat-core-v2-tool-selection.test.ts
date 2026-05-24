import { describe, expect, it } from 'vitest';

import {
  CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION,
  CHAT_CORE_V2_TOOL_SELECTION_VERSION,
  buildChatCoreV2RouteDecision,
  selectChatCoreV2ToolSchemas,
} from '../../src/services/chat-core-v2';

describe('Chat Core v2 tool selection', () => {
  it('exposes no model tools for deterministic reads', () => {
    const route = buildChatCoreV2RouteDecision({
      intent: 'app_question',
      confidence: 0.95,
      domains: ['tasks'],
      capabilityIds: ['tasks.today_summary'],
    });

    const selected = selectChatCoreV2ToolSchemas(route);
    expect(selected).toMatchObject({
      selectionVersion: CHAT_CORE_V2_TOOL_SELECTION_VERSION,
      toolSchemaSetVersion: CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION,
      promptFamily: 'chat_v2_tasks',
      routeMethod: 'deterministic_read',
      capabilityIds: [],
      tools: [],
      omittedCapabilities: [{ capabilityId: 'tasks.today_summary', reason: 'route_does_not_use_tools' }],
    });
  });

  it('selects only the requested task command proposal tool for low-risk writes', () => {
    const route = buildChatCoreV2RouteDecision({
      intent: 'create_action',
      confidence: 0.91,
      domains: ['tasks'],
      capabilityIds: ['tasks.create'],
    });

    const selected = selectChatCoreV2ToolSchemas(route);
    expect(selected.promptFamily).toBe('chat_v2_tasks');
    expect(selected.capabilityIds).toEqual(['tasks.create']);
    expect(selected.toolSchemaSetVersion).toMatch(/^chat_core_v2_tools@1\.0\.0\+[a-f0-9]{12}$/);
    expect(selected.tools).toHaveLength(1);
    expect(selected.tools[0]).toMatchObject({
      name: 'chat_v2_tasks_create',
      capabilityId: 'tasks.create',
      commandType: 'tasks.create',
      risk: 'low',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['commandType', 'payload'],
      },
    });
    expect(selected.tools[0].description).toContain('never mutates state directly');
  });

  it('keeps planner tool sets narrow and multi-domain without exposing read-only capabilities as tools', () => {
    const route = buildChatCoreV2RouteDecision({
      intent: 'planning',
      confidence: 0.88,
      domains: ['training', 'secretary', 'tasks'],
      capabilityIds: ['training.modify_session_preview', 'secretary.schedule_event_preview', 'tasks.today_summary'],
    });

    const selected = selectChatCoreV2ToolSchemas(route);
    expect(selected.promptFamily).toBe('chat_v2_multi_domain');
    expect(selected.capabilityIds).toEqual([
      'training.modify_session_preview',
      'secretary.schedule_event_preview',
    ]);
    expect(selected.tools.map((tool) => tool.commandType)).toEqual([
      'training.modify_session',
      'secretary.schedule_event',
    ]);
    expect(selected.omittedCapabilities).toEqual([
      { capabilityId: 'tasks.today_summary', reason: 'not_model_visible' },
    ]);
  });

  it('exposes no tools for blocked or restricted finance decisions', () => {
    const route = buildChatCoreV2RouteDecision({
      intent: 'modify_action',
      confidence: 0.99,
      domains: ['finance'],
      capabilityIds: ['finance.payment_or_tax_action_blocked'],
    });

    const selected = selectChatCoreV2ToolSchemas(route);
    expect(selected.tools).toEqual([]);
    expect(selected.toolSchemaSetVersion).toBe(CHAT_CORE_V2_EMPTY_TOOL_SCHEMA_SET_VERSION);
    expect(selected.omittedCapabilities).toEqual([
      { capabilityId: 'finance.payment_or_tax_action_blocked', reason: 'route_does_not_use_tools' },
    ]);
  });

  it('enforces the max tool schema cap deterministically', () => {
    const route = buildChatCoreV2RouteDecision({
      intent: 'planning',
      confidence: 0.88,
      domains: ['tasks', 'notifications', 'decision_center'],
      capabilityIds: ['tasks.create', 'notifications.snooze', 'decision_center.dismiss'],
    });

    const selected = selectChatCoreV2ToolSchemas(route, { maxToolSchemas: 2 });
    expect(selected.capabilityIds).toEqual(['tasks.create', 'notifications.snooze']);
    expect(selected.omittedCapabilities).toEqual([
      { capabilityId: 'decision_center.dismiss', reason: 'tool_limit' },
    ]);
  });

  it('produces stable tool-schema fingerprints regardless of selected capability order', () => {
    const first = selectChatCoreV2ToolSchemas(buildChatCoreV2RouteDecision({
      intent: 'planning',
      confidence: 0.9,
      domains: ['tasks', 'notifications'],
      capabilityIds: ['tasks.create', 'notifications.snooze'],
    }));
    const second = selectChatCoreV2ToolSchemas(buildChatCoreV2RouteDecision({
      intent: 'planning',
      confidence: 0.9,
      domains: ['notifications', 'tasks'],
      capabilityIds: ['notifications.snooze', 'tasks.create'],
    }));

    expect(first.toolSchemaSetVersion).toBe(second.toolSchemaSetVersion);
  });
});
