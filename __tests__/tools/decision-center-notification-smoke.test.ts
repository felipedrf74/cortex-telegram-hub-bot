import { describe, expect, it } from 'vitest';
import {
  buildDecisionCenterNotificationSmokeIntents,
  evaluateDecisionCenterNotificationSmokePrerequisites,
  summarizeSmokePushPayload,
} from '../../src/tools/decision-center-notification-smoke';
import { buildDecisionLogicV2 } from '../../src/services/decision-center-logic-v2';

describe('Decision Center notification smoke helper', () => {
  it('requires an explicit non-dry-run gate before creating notification rows', () => {
    const env = {
      DATABASE_PATH: '/tmp/nexushub-staging.db',
      DECISION_CENTER_NOTIFICATION_SMOKE: '1',
      NOTIFICATION_DELIVERY_MODE: 'apns',
      APNS_ENABLED: 'true',
    } as NodeJS.ProcessEnv;

    const blocked = evaluateDecisionCenterNotificationSmokePrerequisites({
      env,
      userId: 42,
      tenantId: 42,
      dryRun: false,
      confirmed: false,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.missing).toContain('--confirm for non-dry-run smoke');

    const allowed = evaluateDecisionCenterNotificationSmokePrerequisites({
      env,
      userId: 42,
      tenantId: 42,
      dryRun: false,
      confirmed: true,
    });
    expect(allowed.ok).toBe(true);
  });

  it('builds scoped visible and low-rank Decision Center smoke intents without private payloads', () => {
    const intents = buildDecisionCenterNotificationSmokeIntents({
      userId: 42,
      tenantId: 42,
      runId: 'smoke-run-1',
      mode: 'both',
      now: new Date('2026-05-22T10:00:00.000Z'),
    });

    expect(intents).toHaveLength(2);
    const visible = intents[0];
    expect(visible.sourceSkill).toBe('secretary');
    expect(visible.priority).toBe('time_sensitive');
    expect(visible.deliveryPolicy).toBe('push_allowed');
    expect(visible.quietHoursPolicy).toBe('send_now');
    expect(visible.requiresUserAction).toBe(true);
    expect(visible.decisionDeadline).toBe('2026-05-22T10:30:00.000Z');
    expect(visible.relatedEntityType).toBe('secretary_agenda_item');
    expect(visible.decisionContext?.currentStartAt).toBe('2026-05-22T10:15:00.000Z');
    expect(visible.decisionContext?.recommendedStartAt).toBe('2026-05-22T11:00:00.000Z');
    expect(visible.visibilityScope).toBe('system_admin');
    expect(visible.decisionContext?.visibilityScope).toBe('system_admin');
    expect(visible.decisionContext?.internalOnly).toBe(true);
    expect(visible.decisionContext?.smoke).toBe(true);
    expect(visible.dedupeKey).toContain('smoke-run-1');
    expect(visible.sensitiveBody).toBeNull();
    expect(JSON.stringify(visible)).not.toContain('push_token');
    expect(JSON.stringify(visible)).not.toContain('APNS_AUTH_KEY');

    const visibleLogic = buildDecisionLogicV2({
      sourceSkill: visible.sourceSkill,
      type: visible.type,
      priority: visible.priority,
      title: visible.title,
      body: visible.body,
      safeBody: 'Schedule decision — open Nexus to review the recommendation.',
      actions: visible.actionButtons,
      relatedEntityType: visible.relatedEntityType,
      relatedEntityId: visible.relatedEntityId,
      deadlineAt: visible.decisionDeadline,
      privacyClassification: visible.privacyPolicy,
      visibilityScope: visible.visibilityScope,
      context: {
        ...(visible.decisionContext ?? {}),
        deadlineAt: visible.decisionDeadline,
      },
    });
    expect(visibleLogic.quality.status).toBe('pass');
    expect(visibleLogic.quality.safeForAPNs).toBe(true);
    expect(visibleLogic.notificationEligibility).toBe('visible');

    const lowRank = intents[1];
    expect(lowRank.sourceSkill).toBe('system');
    expect(lowRank.type).toBe('insight');
    expect(lowRank.priority).toBe('passive');
    expect(lowRank.requiresUserAction).toBe(false);
    expect(lowRank.decisionDeadline).toBeNull();
    expect(lowRank.dedupeKey).toContain('low-rank');
    expect(lowRank.visibilityScope).toBe('system_admin');
    expect(lowRank.decisionContext?.internalOnly).toBe(true);
    expect(lowRank.decisionContext?.smoke).toBe(true);
  });

  it('redacts smoke report push body and non-smoke titles', () => {
    const summary = summarizeSmokePushPayload({
      title: 'Real decision title',
      body: 'Private user notification body',
      deeplink: 'nexus://notifications/private',
      actions: [],
      interruptionLevel: 'time-sensitive',
    });

    expect(summary?.title).toBe('[redacted]');
    expect(summary?.bodyLength).toBe('Private user notification body'.length);
    expect(summary?.bodyHash).toMatch(/^[a-f0-9]{8}$/);
    expect(JSON.stringify(summary)).not.toContain('Private user notification body');
  });
});
