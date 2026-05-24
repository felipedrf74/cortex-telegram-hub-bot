import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedTask } from '../../src/services/task-store/types';
import type { NotificationCenterItem } from '../../src/services/notification-orchestrator';

vi.mock('../../src/services/task-store/task-service', () => ({
  listTasks: vi.fn(),
}));

vi.mock('../../src/services/decision-center', () => ({
  getDecisionSummary: vi.fn(),
}));

vi.mock('../../src/services/notification-orchestrator', () => ({
  listNotificationCenterItems: vi.fn(),
}));

import { getDecisionSummary } from '../../src/services/decision-center';
import { listNotificationCenterItems } from '../../src/services/notification-orchestrator';
import { listTasks } from '../../src/services/task-store/task-service';
import { tryBuildChatCoreV2DeterministicReadRoute } from '../../src/services/chat-core-v2';

const FIXED_NOW = new Date('2026-05-24T10:00:00.000Z');
const ENABLED_ENV = {
  CHAT_CORE_V2_ENABLED: 'true',
  CHAT_CORE_V2_READS_ENABLED: 'true',
} as NodeJS.ProcessEnv;

function task(overrides: Partial<NormalizedTask>): NormalizedTask {
  return {
    id: 1,
    provider: 'nexus',
    externalId: `task-${overrides.id ?? 1}`,
    title: 'Task',
    status: 'pending',
    priority: 0,
    projectName: 'Inbox',
    ...overrides,
  };
}

function notification(overrides: Partial<NotificationCenterItem>): NotificationCenterItem {
  return {
    itemId: 'notif_1',
    intentId: 'intent_1',
    decisionLogId: null,
    userId: 42,
    tenantId: 84,
    title: 'Notification',
    body: 'Notification body',
    safeBody: 'Notification body',
    sensitiveBody: null,
    sourceSkill: 'system',
    type: 'reminder',
    priority: 'active',
    status: 'unread',
    deeplink: null,
    actions: [],
    dedupeKey: null,
    createdAt: '2026-05-24T09:00:00.000Z',
    expiresAt: null,
    ...overrides,
  };
}

describe('Chat Core v2 deterministic read route', () => {
  beforeEach(() => {
    vi.mocked(listTasks).mockReset();
    vi.mocked(getDecisionSummary).mockReset();
    vi.mocked(listNotificationCenterItems).mockReset();
  });

  it('stays disabled unless both global and read flags are explicitly enabled', () => {
    vi.mocked(listTasks).mockReturnValue([]);

    const disabled = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: {},
    });
    expect(disabled).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();

    const globalOnly = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: { CHAT_CORE_V2_ENABLED: 'true' } as NodeJS.ProcessEnv,
    });
    expect(globalOnly).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
  });

  it('answers task summary questions without model calls or provider reads', () => {
    vi.mocked(listTasks).mockReturnValue([
      task({ id: 1, title: 'Review proposal', dueDate: '2026-05-24', priority: 3 }),
      task({ id: 2, title: 'Send invoice', dueDate: '2026-05-23', priority: 2 }),
      task({ id: 3, title: 'Buy groceries', dueDate: '2026-05-26', priority: 1 }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What tasks do I have today?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listTasks).toHaveBeenCalledWith(42, { status: 'pending' });
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'tasks.today_summary'],
    });
    expect(result?.response.text).toContain('You have 3 open tasks.');
    expect(result?.response.text).toContain('1 due today');
    expect(result?.response.text).toContain('1 overdue');
    expect(result?.response.text).toContain('- Send invoice (overdue)');
    expect(result?.response.text).toContain('- Review proposal (today)');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'tasks.today_summary',
      domain: 'tasks',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        pendingCount: 3,
        dueTodayCount: 1,
        overdueCount: 1,
        highPriorityCount: 1,
      },
    });
    expect(result?.contextPack.contextHash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('answers Decision Center summary questions through the filtered Decision Center facade', () => {
    vi.mocked(getDecisionSummary).mockReturnValue({
      openCount: 2,
      urgentCount: 1,
      todayCount: 1,
      handledTodayCount: 3,
      topDecisionTitle: 'Move client review to 15:30?',
      topDecisionSourceSkill: 'secretary',
      topDecisionUrgency: 'urgent',
      topDecisionWhy: 'The current time conflicts with another commitment.',
      topSuggestion: {
        decisionId: 'dec_1',
        title: 'Move client review to 15:30?',
        actionLabel: 'Move to 15:30',
        whyNow: 'This affects today.',
        expectedOutcome: 'Calendar stays conflict-free.',
        riskIfIgnored: 'The conflict may remain.',
        sourceSkill: 'secretary',
      },
      previewItems: [
        {
          decisionId: 'dec_1',
          itemId: 'item_1',
          id: 'item_1',
          intentId: 'intent_1',
          decisionLogId: null,
          userId: 42,
          tenantId: 84,
          sourceSkill: 'secretary',
          type: 'decision_required',
          status: 'unread',
          urgency: 'urgent',
          timingLabel: null,
          priorityScore: 90,
          title: 'Move client review to 15:30?',
          summary: 'Client review needs a better slot.',
          safePreviewTitle: 'Move client review to 15:30?',
          safePreviewBody: 'Client review needs a better slot.',
          recommendedActionLabel: 'Move to 15:30',
          recommendedAction: null,
          alternativeActions: [],
          whySummary: 'The current time conflicts with another commitment.',
          whyDetails: [],
          explanation: {
            headline: 'Move client review to 15:30?',
            whatHappened: 'The current time conflicts with another commitment.',
            whyItMatters: 'It keeps the afternoon plan realistic.',
            nexusAction: 'Nexus will move the item after confirmation.',
            userAction: 'Choose whether to move it.',
            result: 'The calendar item moves to 15:30.',
            verification: 'Nexus will check the calendar after the move.',
            nextStep: 'Confirm or choose another time.',
            steps: [],
            actionLabels: { primary: 'Move to 15:30', secondary: ['Choose another time'] },
          },
          problemStatement: 'The current time conflicts with another commitment.',
          recommendation: 'Move to 15:30',
          expectedEffect: 'Calendar stays conflict-free.',
          impactIfIgnored: 'The conflict may remain.',
          impactLevel: 'high',
          primaryActionLabel: 'Move to 15:30',
          secondaryActionLabels: ['Choose another time'],
          urgencyReason: 'Affects today.',
          why: { facts: [], rules: [], tradeoffs: [], confidence: 'high' },
          actionPreview: [],
          whatWillChange: [],
          alternatives: [],
          automationEligibility: { eligible: false, reason: 'needs_user', mode: 'manual' },
          autopilotPolicy: 'manual',
          readBackVerifier: null,
          handledByNexus: false,
          handledAt: null,
          outcomeSummary: null,
          failureReason: null,
          retryActions: [],
          notificationEligibility: 'visible',
          apnsInterruptionLevel: 'active',
          collapseKey: null,
          badgeContribution: true,
          quality: {
            status: 'safe',
            safeToShowUser: true,
            safeForFrontendAction: true,
            missingFields: [],
            warnings: [],
          },
          relatedEntities: [],
          relatedEntitiesSafe: [],
          sourceTraceSummary: null,
          sourceTrace: null,
          dependencyGraphSummary: null,
          actionTruthTableEntry: null,
          askNexusContext: null,
          deadlineAt: null,
          expiresAt: null,
          confidence: 0.9,
          analysis: {
            confidence: 0.9,
            confidenceLabel: 'high',
            sourceFreshness: 'live',
            freshnessLabel: 'Live',
            whyNow: 'This affects today.',
            expectedOutcome: 'Calendar stays conflict-free.',
            costOfDelay: 'The conflict may remain.',
            tradeoffs: [],
            uncertainty: [],
            rollbackConfidence: 'high',
          },
          riskLevel: 'medium',
          groupKey: 'secretary',
          sectionKey: 'urgent',
          displayMode: 'decision_required',
          frontendActionState: 'enabled',
          privacyClassification: 'standard',
          visibilityScope: 'user_private',
          createdAt: '2026-05-24T09:00:00.000Z',
          updatedAt: '2026-05-24T09:05:00.000Z',
          snoozedUntil: null,
          actions: [],
          dependsOnDecisionIds: [],
          blockedByDecisionIds: [],
          rollbackAvailable: false,
          rollbackActionId: null,
        },
      ],
      badgeCount: 1,
      ctaLabel: 'Urgent decision',
      gamification: null,
    });

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What is in Decision Center?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(getDecisionSummary).toHaveBeenCalledWith(42, 84, 3);
    expect(listTasks).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('decision_center.summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'decision_center.summary'],
    });
    expect(result?.response.text).toContain('Decision Center has 2 open decisions.');
    expect(result?.response.text).toContain('1 urgent');
    expect(result?.response.text).toContain('3 handled today');
    expect(result?.response.text).toContain('- Move client review to 15:30? (urgent) - needs: Move to 15:30');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'decision_center.summary',
      domain: 'decision_center',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        openCount: 2,
        urgentCount: 1,
        todayCount: 1,
        handledTodayCount: 3,
        badgeCount: 1,
      },
    });
    expect(result?.contextPack.sourceEntityIds).toEqual(['decision:dec_1']);
  });

  it('localizes clear Decision Center summaries for Portuguese users', () => {
    vi.mocked(getDecisionSummary).mockReturnValue({
      openCount: 0,
      urgentCount: 0,
      todayCount: 0,
      handledTodayCount: 0,
      topDecisionTitle: null,
      topDecisionSourceSkill: null,
      topDecisionUrgency: null,
      topDecisionWhy: null,
      topSuggestion: null,
      previewItems: [],
      badgeCount: 0,
      ctaLabel: 'Tudo certo',
      gamification: null,
    });

    const pt = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'O que está no Decision Center?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(pt?.response.locale).toBe('pt-PT');
    expect(pt?.response.text).toBe('O Decision Center não tem pendências neste momento.');
  });

  it('localizes deterministic task summaries for Portuguese users', () => {
    vi.mocked(listTasks).mockReturnValue([
      task({ id: 1, title: 'Enviar proposta', dueDate: '2026-05-24', priority: 1 }),
    ]);

    const pt = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-PT',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(pt?.response.locale).toBe('pt-PT');
    expect(pt?.response.text).toContain('Tens 1 tarefa aberta.');
    expect(pt?.response.text).toContain('1 para hoje');
    expect(pt?.response.text).toContain('- Enviar proposta (hoje)');

    const br = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Que tarefas tenho hoje?',
      userId: 42,
      tenantId: 84,
      locale: 'pt-BR',
      timezone: 'America/Sao_Paulo',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    expect(br?.response.locale).toBe('pt-BR');
    expect(br?.response.text).toContain('Você tem 1 tarefa aberta.');
  });

  it('answers notification summary questions through the tenant-scoped notification center', () => {
    vi.mocked(listNotificationCenterItems).mockReturnValue([
      notification({
        itemId: 'notif_1',
        title: 'Training reminder',
        sourceSkill: 'training',
        type: 'reminder',
        priority: 'time_sensitive',
        actions: [{ id: 'open', label: 'Open', style: 'primary' }],
        createdAt: '2026-05-24T09:30:00.000Z',
      }),
      notification({
        itemId: 'notif_2',
        title: 'Content idea ready',
        sourceSkill: 'content',
        type: 'insight',
        priority: 'active',
        actions: [],
        createdAt: '2026-05-24T09:00:00.000Z',
      }),
    ]);

    const result = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'What notifications do I have?',
      userId: 42,
      tenantId: 84,
      locale: 'en-US',
      timezone: 'Europe/Lisbon',
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(result).not.toBeNull();
    expect(listNotificationCenterItems).toHaveBeenCalledWith(42, 84, {
      status: 'unread',
      limit: 200,
    });
    expect(listTasks).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(result?.capabilityId).toBe('notifications.summary');
    expect(result?.response).toMatchObject({
      schemaVersion: 'chat_response_v2@1.0.0',
      kind: 'message',
      locale: 'en',
      cards: [],
      reasonCodes: ['deterministic_read', 'notifications.summary'],
    });
    expect(result?.response.text).toContain('You have 2 unread notifications.');
    expect(result?.response.text).toContain('1 urgent');
    expect(result?.response.text).toContain('1 needing action');
    expect(result?.response.text).toContain('- Training reminder (urgent) - action: Open');
    expect(result?.readModel).toMatchObject({
      capabilityId: 'notifications.summary',
      domain: 'notifications',
      sensitivity: 'personal',
      freshness: { status: 'live' },
      data: {
        unreadCount: 2,
        urgentCount: 1,
        actionRequiredCount: 1,
        remindersCount: 1,
        sourceSkills: ['content', 'training'],
      },
    });
  });

  it('does not intercept task writes or multi-domain questions', () => {
    vi.mocked(listTasks).mockReturnValue([]);

    const write = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Create a task to call Joao tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const portugueseWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Cria uma tarefa para ligar ao Joao amanha',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const multiDomain = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Show my tasks and training today',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const decisionWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Dismiss this decision',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });
    const notificationWrite = tryBuildChatCoreV2DeterministicReadRoute({
      normalizedText: 'Snooze this notification until tomorrow',
      userId: 42,
      tenantId: 84,
      now: FIXED_NOW,
      env: ENABLED_ENV,
    });

    expect(write).toBeNull();
    expect(portugueseWrite).toBeNull();
    expect(multiDomain).toBeNull();
    expect(decisionWrite).toBeNull();
    expect(notificationWrite).toBeNull();
    expect(listTasks).not.toHaveBeenCalled();
    expect(getDecisionSummary).not.toHaveBeenCalled();
    expect(listNotificationCenterItems).not.toHaveBeenCalled();
  });
});
