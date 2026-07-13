import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionApiItem } from '../../src/services/decision-center';
import type { AICommandEnvelope } from '../../src/services/chat-core-v2/types';

const mockExecuteChatCoreV2Command = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/chat-core-v2/command-executor', () => ({
  CHAT_CORE_V2_COMMAND_EXECUTOR_VERSION: 'chat_core_v2_command_executor@1.0.0',
  CHAT_CORE_V2_SYNC_EXECUTABLE_COMMAND_TYPES: [
    'tasks.create',
    'tasks.complete',
    'notifications.snooze',
    'decision_center.dismiss',
    'decision_center.snooze',
    'content.approve_script',
    'content.request_rewrite',
    'decision_center.accept_chat_action_fix',
  ],
  assertChatCoreV2ReadbackVerificationContract: vi.fn(() => true),
  executeChatCoreV2Command: (...args: unknown[]) => mockExecuteChatCoreV2Command(...args),
  isExecutableCommandType: vi.fn((commandType: string) => [
    'tasks.create',
    'tasks.complete',
    'notifications.snooze',
    'decision_center.dismiss',
    'decision_center.snooze',
    'content.approve_script',
    'content.request_rewrite',
    'decision_center.accept_chat_action_fix',
  ].includes(commandType)),
}));

import {
  DECISION_COMMAND_ADAPTER_VERSION,
  buildDecisionCommandEnvelope,
  isDecisionActionBusEligible,
  runDecisionActionViaCommandBus,
} from '../../src/services/decision-command-adapter';
import { decisionDismissVersionForItem } from '../../src/services/chat-core-v2/command-status-policy';

const NOW = new Date('2026-06-03T10:00:00.000Z');

function decisionItem(overrides: Partial<DecisionApiItem> = {}): DecisionApiItem {
  return {
    decisionId: 'dc_1',
    itemId: 'dc_1',
    id: 'dc_1',
    intentId: 'intent_1',
    decisionLogId: 'dl_1',
    userId: 7,
    tenantId: 7,
    sourceSkill: 'training',
    type: 'decision_required',
    status: 'unread',
    urgency: 'today',
    timingLabel: 'Today',
    priorityScore: 70,
    title: 'Review training decision',
    summary: 'Training needs your review.',
    safePreviewTitle: 'Review training decision',
    safePreviewBody: 'Training needs your review.',
    recommendedActionLabel: 'Dismiss',
    recommendedAction: { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
    alternativeActions: [],
    whySummary: 'The decision is still active.',
    whyDetails: [],
    explanation: null,
    problemStatement: 'Training needs your review.',
    recommendation: 'Dismiss it for now.',
    expectedEffect: 'The decision leaves the active list.',
    actions: [
      { id: 'dismiss', label: 'Dismiss', style: 'secondary' },
      { id: 'open_detail', label: 'Open', style: 'primary' },
    ],
    outcomeSummary: null,
    failureReason: null,
    retryActions: [],
    quality: { status: 'pass', reason: 'fixture', qualityScore: 90, missingFields: [] },
    displayMode: 'needs_input',
    frontendActionState: 'enabled',
    analysis: {
      confidenceLabel: 'medium',
      whyNow: 'It is active now.',
      costOfDelay: 'It will stay visible.',
      evidenceStrengthLabel: 'Medium',
    },
    whatWillChange: [],
    alternatives: [],
    relatedEntitiesSafe: [],
    relatedEntities: [],
    sourceTrace: null,
    actionTruthTableEntry: null,
    askNexusContext: null,
    sectionKey: 'today',
    groupKey: 'training:decision_required:dc_1',
    impactLevel: 'medium',
    sourceTraceSummary: null,
    dependencyGraphSummary: null,
    dependsOnDecisionIds: [],
    blockedByDecisionIds: [],
    expiresAt: '2026-06-03T10:05:00.000Z',
    snoozedUntil: null,
    rollback: { available: false, actionId: null, label: null, expiresAt: null },
    ...overrides,
  } as unknown as DecisionApiItem;
}

describe('decision-command-adapter', () => {
  beforeEach(() => {
    mockExecuteChatCoreV2Command.mockReset();
  });

  it('only admits the low-risk dismiss slice for statuses the legacy path verifies', () => {
    expect(isDecisionActionBusEligible({ actionId: 'dismiss', item: decisionItem({ status: 'unread' }) })).toBe(true);
    expect(isDecisionActionBusEligible({ actionId: 'dismiss', item: decisionItem({ status: 'read' }) })).toBe(true);
    expect(isDecisionActionBusEligible({ actionId: 'not_now', item: decisionItem({ status: 'unread' }) })).toBe(false);
    expect(isDecisionActionBusEligible({ actionId: 'reject_reflow', item: decisionItem({ status: 'unread' }) })).toBe(false);
    expect(isDecisionActionBusEligible({ actionId: 'dismiss', item: decisionItem({ status: 'snoozed' }) })).toBe(false);
    expect(isDecisionActionBusEligible({ actionId: 'dismiss', item: decisionItem({ status: 'failed' }) })).toBe(false);
  });

  it('admits only direct content workflow objects and scoped projection-only fixer decisions', () => {
    const content = decisionItem({
      sourceSkill: 'content',
      relatedEntities: [{ type: 'content_workflow_object', id: '41' }],
      actions: [
        { id: 'approve_script', label: 'Approve', style: 'primary' },
        { id: 'request_rewrite', label: 'Request changes', style: 'secondary' },
      ],
    });
    expect(isDecisionActionBusEligible({ actionId: 'approve_script', item: content })).toBe(true);
    expect(isDecisionActionBusEligible({ actionId: 'request_rewrite', item: content })).toBe(true);
    expect(isDecisionActionBusEligible({
      actionId: 'approve_script',
      item: { ...content, relatedEntities: [{ type: 'content_notification', id: 'legacy-1' }] },
    })).toBe(false);

    const fixer = decisionItem({
      sourceSkill: 'chat',
      relatedEntities: [{ type: 'chat_action_fixer_review', id: 'job-1' }],
      actions: [{ id: 'accept_chat_action_fix', label: 'Accept correction', style: 'primary' }],
    });
    expect(isDecisionActionBusEligible({ actionId: 'accept_chat_action_fix', item: fixer })).toBe(true);
    expect(isDecisionActionBusEligible({
      actionId: 'accept_chat_action_fix',
      item: { ...fixer, sourceSkill: 'secretary' },
    })).toBe(false);
  });

  it('builds a Decision Center origin command envelope with scoped permission and version preconditions', () => {
    const item = decisionItem();
    const envelope = buildDecisionCommandEnvelope({
      item,
      actionId: 'dismiss',
      userId: 7,
      tenantId: 7,
      idempotencyKey: 'idem-1',
      now: NOW,
    });
    const decisionVersion = decisionDismissVersionForItem(item);

    expect(envelope).toMatchObject({
      domain: 'decision_center',
      commandType: 'decision_center.dismiss',
      origin: 'decision_center',
      userId: '7',
      tenantId: '7',
      commandSchemaVersion: 'decision_center.dismiss@1.0.0',
      previewSchemaVersion: 'decision_preview_card@1.0.0',
      responseSchemaVersion: 'chat_response_v2@1.0.0',
      payload: {
        operation: 'dismiss',
        actionId: 'dismiss',
        decisionId: 'dc_1',
        currentStatus: 'unread',
        targetStatus: 'dismissed',
      },
      authorization: {
        actingSurface: 'system_automation',
        delegatedScopes: ['decision_center:read', 'decision_center:write'],
        permissionSnapshotVersion: 'decision-center-permissions:7:7:decision_center.dismiss:v1',
      },
      preconditions: {
        requiredPermissionsVersion: 'decision-center-permissions:7:7:decision_center.dismiss:v1',
        requiredDecisionVersion: decisionVersion,
      },
      idempotencyKey: 'idem-1',
    });
    expect(envelope.basedOn.entityVersions).toEqual({ 'decision:dc_1': decisionVersion });
    expect(envelope.preconditions.requiredEntityVersions).toEqual({ 'decision:dc_1': decisionVersion });
    expect(envelope.preconditions.invariants[0].check).toBe('decision_is_active');
    expect(envelope.expiresAt).toBe('2026-06-03T10:05:00.000Z');
  });

  it('executes through the current Command Bus capability and translates verified result to legacy effect shape', async () => {
    mockExecuteChatCoreV2Command.mockResolvedValue({
      ok: true,
      executorVersion: 'chat_core_v2_command_executor@1.0.0',
      commandId: 'cmd_1',
      capabilityId: 'decision_center.dismiss',
      gateVerdict: { ok: true, operation: 'execute', gateVersion: 'gate', commandStatus: 'confirmed' },
      response: { text: 'Dismissed.', schemaVersion: 'chat_response_v2@1.0.0', kind: 'action_result', locale: 'en', cards: [], reasonCodes: [] },
      status: 'verified',
      dismissedDecisionId: 'dc_1',
    });

    const result = await runDecisionActionViaCommandBus({
      item: decisionItem(),
      actionId: 'dismiss',
      userId: 7,
      tenantId: 7,
      idempotencyKey: 'idem-1',
      now: NOW,
    });
    const command = mockExecuteChatCoreV2Command.mock.calls[0][0].command as AICommandEnvelope<Record<string, unknown>>;

    expect(command.commandType).toBe('decision_center.dismiss');
    expect(mockExecuteChatCoreV2Command).toHaveBeenCalledWith(expect.objectContaining({
      capabilityId: 'decision_center.dismiss',
      userId: 7,
      tenantId: 7,
      now: NOW,
    }));
    expect(result).toMatchObject({
      readBackOk: true,
      expectedEffect: {
        decisionStatus: 'dismissed',
        viaCommandBus: true,
        adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
      },
      actualEffect: {
        decisionStatus: 'dismissed',
        decisionOutcomeRecorded: true,
        viaCommandBus: true,
        commandBusOutcomeRecorded: true,
        commandStatus: 'verified',
        dismissedDecisionId: 'dc_1',
        adapterVersion: DECISION_COMMAND_ADAPTER_VERSION,
      },
      message: 'Dismissed.',
    });
  });

  it('maps stale Command Bus rejections back to Decision Center action errors', async () => {
    mockExecuteChatCoreV2Command.mockResolvedValue({
      ok: false,
      executorVersion: 'chat_core_v2_command_executor@1.0.0',
      commandId: 'cmd_1',
      capabilityId: 'decision_center.dismiss',
      gateVerdict: {
        ok: false,
        operation: 'execute',
        gateVersion: 'gate',
        commandStatus: 'stale',
        reason: 'decision_version_changed',
      },
      status: 'stale',
      reason: 'command_gate_rejected',
    });

    await expect(runDecisionActionViaCommandBus({
      item: decisionItem(),
      actionId: 'dismiss',
      userId: 7,
      tenantId: 7,
      idempotencyKey: 'idem-1',
      now: NOW,
    })).rejects.toMatchObject({
      code: 'DECISION_SUPERSEDED',
      status: 409,
      details: expect.objectContaining({
        gateReason: 'decision_version_changed',
        commandStatus: 'stale',
      }),
    });
  });
});
