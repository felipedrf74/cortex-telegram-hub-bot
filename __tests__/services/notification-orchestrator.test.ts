import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;
let pushTokens: string[] = [];
let apnsConfigured = false;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

// These suites assert redaction and routing, not translation. Lock-screen copy
// is now resolved from the account language (users.language, default pt-BR), so
// pin English here and let notification-localization.test.ts own the language
// behaviour. Only the language resolver is overridden — every other
// user-service export stays real.
vi.mock('../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/user-service')>()),
  getUserLanguageById: () => 'en-US',
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => pushTokens),
  isApnsConfigured: vi.fn(() => apnsConfigured),
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  INTERRUPT_SKILL_DAILY_CAP,
  assembleDailyDigest,
  buildSkillNotificationFixtureIntent,
  countUnreadNotificationCenterItems,
  createNotificationIntent,
  dismissNotificationCenterItem,
  ensureNotificationTables,
  expireStaleNotificationIntents,
  getNotificationDecisionLog,
  getNotificationDeliveryObservabilityMetrics,
  getNotificationCenterItem,
  getNotificationReliabilityDashboard,
  getOrCreateNotificationProfile,
  listNotificationBridgeEntityIds,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  performNotificationAction,
  recordNotificationReliabilityEvent,
  buildApnsCollapseId,
  pruneStaleDeviceTokens,
  registerNotificationDeviceToken,
  releaseDueNotificationDeliveries,
  resumeNotificationIntentDelivery,
  revokeNotificationDeviceToken,
  sanitizeNotificationDeliveryErrorCode,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';
import { deliveryPolicyForNotificationContract, resolveNotificationContract } from '../../src/services/notification-contracts';
import { getDecisionOverview } from '../../src/services/decision-center';
import {
  getUnreadCountExcludingNotificationIds,
  listUnreadContentNotificationIdsByTypes,
} from '../../src/services/content-notification-store';
import { logger } from '../../src/utils/logger';

function ensureDecisionDependencyFixtureTable(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS decision_dependencies (
      dependency_id TEXT PRIMARY KEY,
      decision_id TEXT NOT NULL,
      depends_on_decision_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'blocks',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(decision_id, depends_on_decision_id, user_id, tenant_id, relationship)
    );
  `);
}

function ensureSecretaryAgendaFixtureTable(): void {
  testDb.exec(readFileSync('migrations/083_secretary_agenda_ledger.sql', 'utf8'));
  testDb.exec(readFileSync('migrations/098_secretary_decision_explanation.sql', 'utf8'));
  testDb.exec('ALTER TABLE secretary_agenda_items ADD COLUMN reasoning_trail_json TEXT');
}

function ensureContentNotificationsFixtureTable(): void {
  testDb.exec(readFileSync('migrations/061_content_notifications.sql', 'utf8'));
}

describe('Secretary Notification Orchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    testDb = new Database(':memory:');
    pushTokens = [{ token: 'tok-default', environment: 'production' }];
    apnsConfigured = true;
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    ensureNotificationTables();
  });

  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('A1: does not mark an expired notification read and does not surface it on open', async () => {
    const expired = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 5));
    const expiredId = expired.item!.itemId;
    testDb.prepare('UPDATE notification_center_items SET expires_at = ? WHERE item_id = ?')
      .run('2020-01-01T00:00:00.000Z', expiredId);

    expect(markNotificationCenterItemRead(expiredId, 5, 5)).toBeNull();
    const expiredStatus = (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?').get(expiredId) as { status: string }).status;
    expect(expiredStatus).toBe('unread'); // guard prevented mark-read

    const live = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 6));
    const liveId = live.item!.itemId;
    expect(markNotificationCenterItemRead(liveId, 6, 6)).not.toBeNull();
    const liveStatus = (testDb.prepare('SELECT status FROM notification_center_items WHERE item_id = ?').get(liveId) as { status: string }).status;
    expect(liveStatus).toBe('read');
  });

  it('creates default profile, updates preferences, and blocks disabled skills', async () => {
    const defaultProfile = getOrCreateNotificationProfile(1, 1);
    expect(defaultProfile.pushEnabled).toBe(true);
    expect(defaultProfile.skillPreferences.finance).toBe(true);

    const updated = updateNotificationProfile(1, 1, {
      pushEnabled: false,
      skillPreferences: { finance: false },
      quietHours: { start: '21:30', end: '06:15' },
    });
    expect(updated.pushEnabled).toBe(false);
    expect(updated.skillPreferences.finance).toBe(false);
    expect(updated.quietHours.start).toBe('21:30');

    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 1));
    expect(result.item).toBeNull();
    expect(result.decisionLog.decision).toBe('blocked_user_preferences');
  });

  it('resumes the exact committed intent without sending its canonical APNs attempt twice', async () => {
    const created = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 902, {
      tenantId: 902,
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs a choice',
      body: 'Review the plan choice in Nexus.',
      relatedEntityId: 'training-exact-delivery-resume',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'training:exact-delivery-resume',
    }));
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect(created.item).not.toBeNull();

    // Model a process exit after APNs acceptance and its durable attempt, but
    // before the evaluation log/intent status became the completion receipt.
    testDb.prepare('DELETE FROM notification_decision_logs WHERE intent_id = ?')
      .run(created.intent.intentId);
    testDb.prepare(`
      UPDATE notification_center_items SET decision_log_id = NULL WHERE item_id = ?
    `).run(created.item!.itemId);
    testDb.prepare(`
      UPDATE notification_intents SET status = 'pending' WHERE intent_id = ?
    `).run(created.intent.intentId);

    const resumed = await resumeNotificationIntentDelivery(created.intent.intentId, 902, 902);
    const replayed = await resumeNotificationIntentDelivery(created.intent.intentId, 902, 902);

    expect(resumed).toMatchObject({
      intentId: created.intent.intentId,
      notificationId: created.item!.itemId,
      decision: 'sent_push',
      replayed: false,
    });
    expect(replayed).toMatchObject({
      decisionLogId: resumed.decisionLogId,
      replayed: true,
    });
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect((testDb.prepare(`
      SELECT COUNT(*) AS n FROM notification_delivery_attempts
       WHERE intent_id = ? AND notification_id = ?
    `).get(created.intent.intentId, created.item!.itemId) as { n: number }).n).toBe(1);
    expect((testDb.prepare(`
      SELECT COUNT(*) AS n FROM notification_decision_logs
       WHERE intent_id = ? AND user_id = 902 AND tenant_id = 902
    `).get(created.intent.intentId) as { n: number }).n).toBe(1);
  });

  it('does not let an intervening duplicate receipt suppress canonical delivery resume', async () => {
    const canonical = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 904, {
      tenantId: 904,
      intentId: 'ni-canonical-delivery-resume-904',
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs a canonical choice',
      body: 'Review the canonical training plan choice in Nexus.',
      relatedEntityId: 'training-canonical-delivery-resume',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'training:canonical-delivery-resume',
    }));
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect(canonical.item).not.toBeNull();

    // Model a committed proposal whose request process exits after APNs and its
    // durable attempt, but before the canonical evaluation receipt is written.
    testDb.prepare('DELETE FROM notification_decision_logs WHERE intent_id = ?')
      .run(canonical.intent.intentId);
    testDb.prepare('UPDATE notification_center_items SET decision_log_id = NULL WHERE item_id = ?')
      .run(canonical.item!.itemId);
    testDb.prepare("UPDATE notification_intents SET status = 'pending' WHERE intent_id = ?")
      .run(canonical.intent.intentId);

    const duplicate = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 904, {
      tenantId: 904,
      intentId: 'ni-duplicate-delivery-resume-904',
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs a canonical choice',
      body: 'Review the canonical training plan choice in Nexus.',
      relatedEntityId: 'training-canonical-delivery-resume',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'training:canonical-delivery-resume',
    }));
    expect(duplicate.decisionLog).toMatchObject({
      notificationId: canonical.item!.itemId,
      intentId: canonical.intent.intentId,
      decision: 'deduped',
    });

    const resumed = await resumeNotificationIntentDelivery(canonical.intent.intentId, 904, 904);
    const replayed = await resumeNotificationIntentDelivery(canonical.intent.intentId, 904, 904);

    expect(resumed).toMatchObject({
      intentId: canonical.intent.intentId,
      notificationId: canonical.item!.itemId,
      decision: 'sent_push',
      replayed: false,
    });
    expect(replayed).toMatchObject({
      decisionLogId: resumed.decisionLogId,
      decision: 'sent_push',
      replayed: true,
    });
    expect(resumed.decisionLogId).not.toBe(duplicate.decisionLog.decisionLogId);
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect((testDb.prepare(`
      SELECT COUNT(*) AS n FROM notification_delivery_attempts
       WHERE intent_id = ? AND notification_id = ?
    `).get(canonical.intent.intentId, canonical.item!.itemId) as { n: number }).n).toBe(1);
    expect(testDb.prepare(`
      SELECT decision_log_id AS decisionLogId
        FROM notification_center_items
       WHERE item_id = ? AND user_id = 904 AND tenant_id = 904
    `).get(canonical.item!.itemId)).toEqual({ decisionLogId: resumed.decisionLogId });
  });

  it('terminalizes an abandoned APNs claim as outcome-unknown without resending', async () => {
    const created = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 903, {
      tenantId: 903,
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs review',
      body: 'Review the current plan in Nexus.',
      relatedEntityId: 'training-abandoned-delivery-claim',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'training:abandoned-delivery-claim',
    }));
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);

    testDb.prepare('DELETE FROM notification_decision_logs WHERE intent_id = ?')
      .run(created.intent.intentId);
    testDb.prepare('UPDATE notification_center_items SET decision_log_id = NULL WHERE item_id = ?')
      .run(created.item!.itemId);
    testDb.prepare("UPDATE notification_intents SET status = 'pending' WHERE intent_id = ?")
      .run(created.intent.intentId);
    testDb.prepare(`
      UPDATE notification_delivery_attempts
         SET status = 'claimed', error_code = NULL, provider_response_code = NULL,
             sent_at = NULL, created_at = '2026-05-07T11:00:00.000Z'
       WHERE intent_id = ? AND notification_id = ?
    `).run(created.intent.intentId, created.item!.itemId);

    const resumed = await resumeNotificationIntentDelivery(created.intent.intentId, 903, 903);

    expect(resumed).toMatchObject({
      decision: 'apns_delivery_failed',
      replayed: false,
    });
    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect(testDb.prepare(`
      SELECT status, error_code AS errorCode
        FROM notification_delivery_attempts
       WHERE intent_id = ? AND notification_id = ?
    `).get(created.intent.intentId, created.item!.itemId)).toEqual({
      status: 'failed',
      errorCode: 'apns_delivery_outcome_unknown',
    });
  });

  it('defaults per-user report schedule preferences to null and persists explicit overrides', () => {
    const fresh = getOrCreateNotificationProfile(31, 31);
    expect(fresh.morningBriefingTime).toBeNull();
    expect(fresh.coachBriefingTime).toBeNull();
    expect(fresh.endOfDayTime).toBeNull();
    expect(fresh.weeklyReviewReportDay).toBeNull();
    expect(fresh.weeklyReviewReportTime).toBeNull();

    const updated = updateNotificationProfile(31, 31, {
      morningBriefingTime: '07:15',
      weeklyReviewReportDay: 0,
    });
    expect(updated.morningBriefingTime).toBe('07:15');
    expect(updated.weeklyReviewReportDay).toBe(0); // Sunday must survive as 0, not fall back
    expect(updated.coachBriefingTime).toBeNull();
    expect(updated.endOfDayTime).toBeNull();
    expect(updated.weeklyReviewReportTime).toBeNull();

    // Undefined fields keep the stored values.
    const untouched = updateNotificationProfile(31, 31, { pushEnabled: false });
    expect(untouched.morningBriefingTime).toBe('07:15');
    expect(untouched.weeklyReviewReportDay).toBe(0);

    // Explicit null clears back to the global default (NULL column).
    const cleared = updateNotificationProfile(31, 31, {
      morningBriefingTime: null,
      weeklyReviewReportDay: null,
    });
    expect(cleared.morningBriefingTime).toBeNull();
    expect(cleared.weeklyReviewReportDay).toBeNull();
  });

  it('rejects malformed report schedule values without persisting partial state', () => {
    updateNotificationProfile(32, 32, { morningBriefingTime: '07:15' });

    expect(() => updateNotificationProfile(32, 32, { endOfDayTime: '25:99' }))
      .toThrow(/expected HH:MM/);
    expect(() => updateNotificationProfile(32, 32, { morningBriefingTime: '9:00' }))
      .toThrow(/expected HH:MM/);
    expect(() => updateNotificationProfile(32, 32, { weeklyReviewReportDay: 9 }))
      .toThrow(/expected 0 \(Sunday\) through 6 \(Saturday\)/);
    expect(() => updateNotificationProfile(32, 32, { weeklyReviewReportDay: 2.5 }))
      .toThrow(/expected 0 \(Sunday\) through 6 \(Saturday\)/);

    const after = getOrCreateNotificationProfile(32, 32);
    expect(after.morningBriefingTime).toBe('07:15');
    expect(after.endOfDayTime).toBeNull();
    expect(after.weeklyReviewReportDay).toBeNull();
  });

  it('returns a deduped evaluation for duplicate suppressed intents instead of aborting on the intent index', async () => {
    updateNotificationProfile(14, 14, {
      skillPreferences: { finance: false },
    });

    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 14, {
      dedupeKey: 'finance:suppressed-duplicate',
    }));
    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 14, {
      dedupeKey: 'finance:suppressed-duplicate',
    }));

    expect(first.item).toBeNull();
    expect(first.decisionLog.decision).toBe('blocked_user_preferences');
    expect(second.item).toBeNull();
    expect(second.intent.status).toBe('deduped');
    expect(second.decisionLog.decision).toBe('deduped');
    expect(second.pushPayload).toBeNull();
    const intentCount = (testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_intents
       WHERE user_id = 14
         AND tenant_id = 14
         AND source_skill = 'finance'
         AND dedupe_key = 'finance:suppressed-duplicate'
    `).get() as { count: number }).count;
    expect(intentCount).toBe(1);
  });

  it('counts badge-contributing center unread and bridge entity ids without the UI list limit', () => {
    // Legacy bridge key whose trailing id equals the userId (index 15 below)
    // is interpreted as the entity-stable format and expanded through the
    // legacy content_notifications table, so provide the covered unread row.
    ensureContentNotificationsFixtureTable();
    testDb.prepare(`
      INSERT INTO content_notifications (id, user_id, type, title, body)
      VALUES (15, 15, 'script_ready', 'Bridge', 'Bridge body')
    `).run();
    const insert = testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key, requires_user_action
      ) VALUES (?, ?, 15, 15, 'Content', 'Open Nexus.', 'Open Nexus.',
        'content', 'approval_required', 'active', 'unread', '[]', ?, 1)
    `);
    for (let index = 1; index <= 205; index += 1) {
      insert.run(`nc_bridge_${index}`, `ni_bridge_${index}`, `content:script_ready:${index}`);
    }
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key
      ) VALUES ('nc_digest_badge_excluded', 'ni_digest_badge_excluded', 15, 15,
        'Digest', 'Digest ready.', 'Digest ready.', 'secretary', 'daily_digest',
        'passive', 'unread', '[]', 'secretary:digest:today')
    `).run();

    expect(countUnreadNotificationCenterItems(15, 15)).toBe(205);
    expect(listNotificationBridgeEntityIds(15, 15, 'content')).toHaveLength(205);
    expect(listNotificationCenterItems(15, 15, { status: 'all', limit: 500 })).toHaveLength(200);
  });

  it('keeps concrete but lower-rank decisions in-app instead of visible push', async () => {
    pushTokens = ['sandbox-token'];
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 1, {
      decisionDeadline: null,
      decisionContext: {
        entityTitle: 'Demo content draft',
        sourceState: 'awaiting_approval',
      },
    }));

    expect(result.intent.sourceSkill).toBe('content');
    expect(result.item?.status).toBe('unread');
    expect(result.decisionLog.decision).toBe('in_app_only');
    expect(result.decisionLog.reason).toContain('decision rank gate held visible push');
    expect(result.deliveryAttempts).toHaveLength(0);
    expect(result.pushPayload?.body).toBe('Content item is ready for review.');

    const items = listNotificationCenterItems(1, 1);
    expect(items).toHaveLength(1);
    expect(items[0].userId).toBe(1);
  });

  it('reports aggregate push delivery observability without private notification text', async () => {
    pushTokens = ['sandbox-token'];
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 11, {
      decisionDeadline: null,
      decisionContext: {
        entityTitle: 'Demo content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 11));

    const metrics = getNotificationDeliveryObservabilityMetrics(11, 11);

    expect(metrics).toMatchObject({
      userId: 11,
      tenantId: 11,
      totalDecisions: 2,
      pushAttemptCount: 1,
      pushSentCount: 1,
      inAppOnlyCount: 1,
      visibleDecisionPushBlockedCount: 1,
    });
    expect(metrics.blockedByReason['decision rank gate held visible push']).toBe(1);
    expect(JSON.stringify(metrics)).not.toContain('Demo content draft');
  });

  it('builds a scoped reliability dashboard for dedupe, digest, push, badge, and read-state signals', async () => {
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 12, {
      dedupeKey: 'dashboard:content:1',
      decisionDeadline: null,
      decisionContext: {
        entityTitle: 'Demo content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 12, {
      dedupeKey: 'dashboard:content:1',
      decisionDeadline: null,
      decisionContext: {
        entityTitle: 'Demo content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 12, {
      type: 'insight',
      priority: 'passive',
      relatedEntityType: 'cross_skill_impact',
      relatedEntityId: '2026-05-08',
      requiresUserAction: false,
      decisionContext: { recipe: 'cross_skill_impact', entityTitle: 'Friday coordination' },
      dedupeKey: 'dashboard:cross-skill',
    }));
    recordNotificationReliabilityEvent({
      userId: 12,
      tenantId: 12,
      eventType: 'badge_reconciled',
      badgeCount: 7,
      source: 'ios_dashboard',
    });
    recordNotificationReliabilityEvent({
      userId: 12,
      tenantId: 12,
      eventType: 'read_state_failure',
      source: 'ios_inbox',
      errorCode: 'network_timeout',
    });
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, deeplink, actions_json, dedupe_key, created_at
      ) VALUES (
        'legacy_dead_deeplink', 'legacy_dead_deeplink_intent', 12, 12, 'Legacy link', 'Legacy body', 'Legacy body',
        'chat', 'decision_required', 'active', 'read', 'nexushub://decision-center/legacy',
        '[]', 'legacy:dead-deeplink', datetime('now')
      )
    `).run();
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, deeplink, actions_json, dedupe_key, created_at
      ) VALUES (
        'unsupported_nexus_deeplink', 'unsupported_nexus_deeplink_intent', 12, 12, 'Unsupported route', 'Route body', 'Route body',
        'secretary', 'decision_required', 'active', 'read', 'nexus://today',
        '[]', 'unsupported:dead-deeplink', datetime('now')
      )
    `).run();

    const dashboard = getNotificationReliabilityDashboard(12, 12);

    expect(dashboard.dedupe.dedupedCount).toBe(1);
    expect(dashboard.digest.pendingCount).toBe(1);
    expect(dashboard.pushOutcome.blockedByReason['decision rank gate held visible push']).toBe(1);
    expect(dashboard.badge.canonicalUnreadCount).toBe(1);
    expect(dashboard.badge.expectedBadgeCount).toBe(1);
    expect(dashboard.badge.clientReportedBadgeCount).toBe(7);
    expect(dashboard.badge.drift).toBe(7 - dashboard.badge.expectedBadgeCount);
    expect(dashboard.readState.serverReadFailureCount).toBe(0);
    expect(dashboard.readState.clientReportedReadFailureCount).toBe(1);
    expect(dashboard.quality.deadDeeplinkCount).toBe(2);
    expect(dashboard.quality.byTopic).not.toContainEqual(expect.objectContaining({
      sourceSkill: '*',
      type: '*',
      recipe: '*',
    }));
    expect(JSON.stringify(dashboard.quality.byTopic)).not.toContain('badgeDrift');
  });

  it('blocks generic decision-shaped notifications from visible push', async () => {
    pushTokens = ['sandbox-token'];
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 1));

    expect(result.item?.status).toBe('unread');
    expect(result.decisionLog.decision).toBe('in_app_only');
    expect(result.decisionLog.reason).toContain('decision quality gate blocked visible push');
    expect(result.deliveryAttempts).toHaveLength(0);
    expect(result.pushPayload?.body).toBe('Schedule decision — open Nexus to review the recommendation.');
  });

  it('handles missing device tokens without failing the durable notification', async () => {
    pushTokens = []; // this case exercises the no-device-token path
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 2));

    expect(result.item?.sourceSkill).toBe('cooking');
    expect(result.decisionLog.decision).toBe('blocked_missing_device_token');
    // The attempt never reached a provider: no delivery-attempt row is
    // fabricated (previously a provider='mock' blocked row was inserted).
    expect(result.deliveryAttempts).toHaveLength(0);
    expect(result.decisionLog.deliveryAttemptIds).toHaveLength(0);
    const attemptCount = (testDb.prepare(
      'SELECT COUNT(*) AS count FROM notification_delivery_attempts WHERE user_id = 2',
    ).get() as { count: number }).count;
    expect(attemptCount).toBe(0);
    // The in-app center item stays durable for push-less users.
    expect(listNotificationCenterItems(2, 2)).toHaveLength(1);
  });

  it('sanitizes delivery error codes before structured reporting', () => {
    expect(sanitizeNotificationDeliveryErrorCode('BadDeviceToken')).toBe('BadDeviceToken');
    expect(sanitizeNotificationDeliveryErrorCode('apns_delivery_failed')).toBe('apns_delivery_failed');
    expect(sanitizeNotificationDeliveryErrorCode('BadDeviceToken[abc123-token-fragment]')).toBe('opaque_error');
    expect(sanitizeNotificationDeliveryErrorCode('')).toBeNull();
  });

  it('redacts finance, training, and content bodies for lock-screen payloads', async () => {
    pushTokens = ['sandbox-token'];
    const finance = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 3, {
      body: 'Your €2,400 invoice from Vendor X is overdue.',
      sensitiveBody: 'Your €2,400 invoice from Vendor X is overdue.',
      dedupeKey: 'finance-sensitive',
    }));
    const training = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 3, {
      body: 'Your knee pain and fatigue suggest under-fueling.',
      dedupeKey: 'training-sensitive',
    }));
    const content = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 3, {
      body: 'Draft says private launch copy with brand strategy.',
      dedupeKey: 'content-sensitive',
    }));

    expect(finance.pushPayload?.body).toBe('Finance reminder needs review.');
    expect(finance.pushPayload?.body).not.toContain('€2,400');
    expect(training.pushPayload?.body).toBe('Training check-in needed. Review today’s adjustment.');
    expect(training.pushPayload?.body).not.toContain('knee pain');
    expect(content.pushPayload?.body).toBe('Content item is ready for review.');
    expect(content.pushPayload?.body).not.toContain('brand strategy');
  });

  it('redacts standard secretary, security, chat, and public-overridden sensitive skill bodies', async () => {
    pushTokens = ['sandbox-token'];

    const secretary = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 31, {
      body: 'Meeting with John Doe about Acme acquisition.',
      sensitiveBody: 'Meeting with John Doe about Acme acquisition.',
      dedupeKey: 'privacy-secretary',
      privacyPolicy: 'standard',
    }));
    const security = await createNotificationIntent(buildSkillNotificationFixtureIntent('security', 31, {
      body: 'Login from 192.0.2.5 near Lisbon.',
      sensitiveBody: 'Login from 192.0.2.5 near Lisbon.',
      dedupeKey: 'privacy-security',
    }));
    const chat = await createNotificationIntent(buildSkillNotificationFixtureIntent('chat', 31, {
      body: 'Private chat answer includes tomorrow’s legal call.',
      sensitiveBody: 'Private chat answer includes tomorrow’s legal call.',
      dedupeKey: 'privacy-chat',
    }));
    const financePublic = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 31, {
      body: 'Bank balance: $42K with Vendor Z invoice.',
      sensitiveBody: 'Bank balance: $42K with Vendor Z invoice.',
      dedupeKey: 'privacy-finance-public',
      privacyPolicy: 'public',
    }));

    expect(secretary.pushPayload?.body).toBe('Schedule decision — open Nexus to review the recommendation.');
    expect(secretary.pushPayload?.body).not.toContain('John Doe');
    expect(security.pushPayload?.body).toBe('Account activity — open Nexus to review the recommendation.');
    expect(security.pushPayload?.body).not.toContain('192.0.2.5');
    expect(chat.pushPayload?.body).toBe('Nexus needs your choice — open Nexus to review the recommendation.');
    expect(chat.pushPayload?.body).not.toContain('legal call');
    expect(financePublic.pushPayload?.body).toBe('Finance reminder needs review.');
    expect(financePublic.pushPayload?.body).not.toContain('Bank balance');
  });

  it('persists sensitiveBody for authenticated in-app detail while keeping safeBody redacted', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 32, {
      body: 'Meeting with John Doe about Acme acquisition.',
      sensitiveBody: 'Meeting with John Doe about Acme acquisition at 16:00.',
      dedupeKey: 'privacy-sensitive-detail',
      privacyPolicy: 'standard',
    }));

    expect(result.item?.safeBody).toBe('Schedule decision — open Nexus to review the recommendation.');
    expect(result.item?.safeBody).not.toContain('John Doe');
    expect(result.item?.sensitiveBody).toBe('Meeting with John Doe about Acme acquisition at 16:00.');
    expect(listNotificationCenterItems(32, 32)).toHaveLength(0);
  });

  it('deduplicates unresolved conflicts by dedupe key', async () => {
    pushTokens = ['sandbox-token'];
    const dedupeKey = 'secretary:conflict:repeat';
    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 4, {
      dedupeKey,
    }));
    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 4, {
      dedupeKey,
    }));

    expect(first.item?.itemId).toBeDefined();
    expect(second.item?.itemId).toBe(first.item?.itemId);
    expect(second.decisionLog.decision).toBe('deduped');
    expect(listNotificationCenterItems(4, 4)).toHaveLength(0);
    const centerCount = (testDb.prepare(
      'SELECT COUNT(*) AS cnt FROM notification_center_items WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND dedupe_key = ?',
    ).get(4, 4, 'secretary', dedupeKey) as { cnt: number }).cnt;
    expect(centerCount).toBe(1);
    const intentCount = (testDb.prepare(
      'SELECT COUNT(*) AS cnt FROM notification_intents WHERE user_id = ? AND tenant_id = ? AND source_skill = ? AND dedupe_key = ?',
    ).get(4, 4, 'secretary', dedupeKey) as { cnt: number }).cnt;
    expect(intentCount).toBe(1);
  });

  it('filters decision-shaped inbox rows that are admin, internal, smoke, unsafe, or stale', async () => {
    const userId = 48;
    const tenantId = 48;
    const visible = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
      tenantId,
      dedupeKey: 'inbox-filter:visible',
      deliveryPolicy: 'in_app_only',
      decisionContext: {
        entityTitle: 'Visible content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    const admin = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
      tenantId,
      dedupeKey: 'inbox-filter:admin',
      deliveryPolicy: 'in_app_only',
      visibilityScope: 'tenant_admin',
      decisionContext: {
        entityTitle: 'Admin-only content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    const internal = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
      tenantId,
      dedupeKey: 'inbox-filter:internal',
      deliveryPolicy: 'in_app_only',
      decisionContext: {
        entityTitle: 'Internal content draft',
        sourceState: 'awaiting_approval',
        internalOnly: true,
      },
    }));
    const smoke = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
      tenantId,
      dedupeKey: 'smoke:inbox-filter',
      deliveryPolicy: 'in_app_only',
      decisionContext: {
        entityTitle: 'Smoke content draft',
        sourceState: 'awaiting_approval',
      },
    }));
    const unsafe = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', userId, {
      tenantId,
      dedupeKey: 'inbox-filter:unsafe',
      deliveryPolicy: 'in_app_only',
      relatedEntityId: null,
      relatedEntityType: null,
      title: 'Decision details',
      body: 'Review this decision.',
      decisionContext: {},
    }));
    const stale = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', userId, {
      tenantId,
      dedupeKey: 'inbox-filter:stale',
      deliveryPolicy: 'in_app_only',
      decisionContext: {
        entityTitle: 'Stale calendar conflict',
        sourceState: 'conflict_detected',
        currentStartAt: '2026-05-07T13:00:00.000Z',
        currentEndAt: '2026-05-07T13:30:00.000Z',
        recommendedStartAt: '2026-05-07T14:00:00.000Z',
        recommendedEndAt: '2026-05-07T14:30:00.000Z',
        providerSyncState: 'not_synced',
        providerSyncUpdatedAt: '2026-05-07T11:00:00.000Z',
      },
    }));

    const hiddenIds = [admin, internal, smoke, unsafe, stale].map((result) => result.item?.itemId);
    expect(hiddenIds.every(Boolean)).toBe(true);
    const listedIds = listNotificationCenterItems(userId, tenantId, { status: 'all', limit: 20 }).map((item) => item.itemId);
    expect(listedIds).toEqual([visible.item?.itemId]);
    for (const hiddenId of hiddenIds) {
      expect(listedIds).not.toContain(hiddenId);
    }
  });

  it('keeps action state parity between single-item read and list projections', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 411, {
      dedupeKey: 'inbox-single-read-parity',
    }));
    const itemId = result.item!.itemId;

    const read = markNotificationCenterItemRead(itemId, 411, 411);
    const listed = listNotificationCenterItems(411, 411, { status: 'all', limit: 20 })
      .find((item) => item.itemId === itemId);

    expect(read?.actionEffectiveStatuses).toEqual(listed?.actionEffectiveStatuses);
    expect(read?.frontendActionState).toBe(listed?.frontendActionState);
    expect(getNotificationCenterItem(itemId, 411, 411)?.actionEffectiveStatuses)
      .toEqual(listed?.actionEffectiveStatuses);
  });

  it('fails closed for orphaned decision rows when intent context is missing', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 412, {
      dedupeKey: 'inbox-orphan-fail-closed',
    }));
    const itemId = result.item!.itemId;

    testDb.prepare('DELETE FROM notification_intents WHERE intent_id = ?').run(result.intent.intentId);

    const orphan = listNotificationCenterItems(412, 412, { status: 'all', limit: 20 })
      .find((item) => item.itemId === itemId);

    expect(orphan).toBeTruthy();
    expect(orphan?.frontendActionState).toBe('disabled_missing_details');
    expect(orphan?.actionEffectiveStatuses[0]).toMatchObject({
      actionId: 'open_detail',
      effective: 'disabled_missing_details',
    });
  });

  it('resolves inbox action states from list projection for snoozed unsafe and dependency-blocked decisions', async () => {
    ensureDecisionDependencyFixtureTable();
    const snoozed = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 413, {
      dedupeKey: 'inbox-snoozed-missing-context',
    }));
    testDb.prepare('DELETE FROM notification_intents WHERE intent_id = ?').run(snoozed.intent.intentId);
    testDb.prepare("UPDATE notification_center_items SET status = 'snoozed' WHERE item_id = ?").run(snoozed.item!.itemId);

    const blocker = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 413, {
      dedupeKey: 'inbox-dependency-blocker',
    }));
    const blocked = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 413, {
      dedupeKey: 'inbox-dependency-blocked',
    }));
    testDb.prepare(`
      INSERT INTO decision_dependencies (
        dependency_id, decision_id, depends_on_decision_id, user_id, tenant_id, relationship
      ) VALUES ('dep-inbox-blocked', ?, ?, 413, 413, 'blocks')
    `).run(blocked.item!.itemId, blocker.item!.itemId);

    const items = listNotificationCenterItems(413, 413, { status: 'all', limit: 20 });
    const snoozedItem = items.find((item) => item.itemId === snoozed.item!.itemId);
    const blockedItem = items.find((item) => item.itemId === blocked.item!.itemId);

    expect(snoozedItem?.frontendActionState).toBe('disabled_missing_details');
    expect(snoozedItem?.actionEffectiveStatuses[0]?.effective).toBe('disabled_missing_details');
    expect(blockedItem?.frontendActionState).toBe('disabled_blocked_by_dependency');
    expect(blockedItem?.actionEffectiveStatuses.find((status) => status.actionId === 'approve_script')?.effective)
      .toBe('disabled_blocked_by_dependency');
  });

  it('hides live-stale secretary agenda decisions from both Decision Center and Notification Center', async () => {
    ensureSecretaryAgendaFixtureTable();
    testDb.prepare(`
      INSERT INTO secretary_agenda_items (
        agenda_item_id, source_intent_id, source_skill, source_action, intent_action,
        source_entity_id, source_entity_type, owner_user_id, tenant_id, lifecycle_state,
        provider_sync_state, provider_event_id, provider_source, version, title, start_at,
        end_at, duration_minutes, decision_action, decision_reason_codes_json,
        source_shape_hash, scheduled_segments_json, created_at, updated_at
      ) VALUES (
        'agenda-live-stale', 'source-live-stale', 'secretary', 'reschedule', 'reschedule_this',
        'agenda-live-stale', 'secretary_agenda_item', 414, '414', 'scheduled',
        'not_synced', NULL, NULL, 1, 'Live stale agenda item',
        '2026-05-07T13:00:00.000Z', '2026-05-07T13:30:00.000Z', 30,
        'reschedule_this', '["calendar_conflict"]', 'shape-live-stale', '[]',
        '2026-05-07T10:00:00.000Z', '2026-05-07T11:00:00.000Z'
      )
    `).run();

    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 414, {
      relatedEntityId: 'agenda-live-stale',
      relatedEntityType: 'secretary_agenda_item',
      deeplink: 'nexus://secretary/conflict/agenda-live-stale',
      dedupeKey: 'inbox-live-stale-secretary-agenda',
      decisionContext: {
        entityTitle: 'Live stale agenda item',
        sourceState: 'scheduled',
        currentStartAt: '2026-05-07T13:00:00.000Z',
        currentEndAt: '2026-05-07T13:30:00.000Z',
        recommendedStartAt: '2026-05-07T14:00:00.000Z',
        recommendedEndAt: '2026-05-07T14:30:00.000Z',
        providerSyncState: 'synced',
        providerSyncUpdatedAt: '2026-05-07T12:00:00.000Z',
        candidateSlots: [{
          startAt: '2026-05-07T14:00:00.000Z',
          endAt: '2026-05-07T14:30:00.000Z',
          label: '2:00 PM',
        }],
      },
    }));

    const inboxIds = listNotificationCenterItems(414, 414, { status: 'all', limit: 20 }).map((item) => item.itemId);
    const decisionIds = getDecisionOverview(414, 414, { limit: 20 }).items.map((item) => item.itemId);

    expect(result.item?.itemId).toBeDefined();
    expect(inboxIds).not.toContain(result.item!.itemId);
    expect(decisionIds).not.toContain(result.item!.itemId);
  });

  it('marks expired intent dedupe rows expired and allows a fresh intent for the same key', async () => {
    const dedupeKey = 'secretary:conflict:expired-recreate';
    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 402, {
      dedupeKey,
      expiresAt: '2026-05-07T11:00:00.000Z',
    }));

    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 402, {
      dedupeKey,
      expiresAt: '2026-05-08T12:00:00.000Z',
    }));

    expect(second.intent.intentId).not.toBe(first.intent.intentId);
    expect(second.intent.status).not.toBe('deduped');
    expect(second.decisionLog.decision).not.toBe('deduped');
    const statuses = testDb.prepare(`
      SELECT intent_id AS intentId, status
        FROM notification_intents
       WHERE user_id = 402 AND tenant_id = 402 AND source_skill = 'secretary' AND dedupe_key = ?
    `).all(dedupeKey) as Array<{ intentId: string; status: string }>;
    expect(Object.fromEntries(statuses.map((row) => [row.intentId, row.status]))).toEqual({
      [first.intent.intentId]: 'expired',
      [second.intent.intentId]: 'evaluated',
    });
    const centerStatuses = testDb.prepare(`
      SELECT intent_id AS intentId, status
        FROM notification_center_items
       WHERE user_id = 402 AND tenant_id = 402 AND source_skill = 'secretary' AND dedupe_key = ?
    `).all(dedupeKey) as Array<{ intentId: string; status: string }>;
    expect(Object.fromEntries(centerStatuses.map((row) => [row.intentId, row.status]))).toEqual({
      [first.intent.intentId]: 'expired',
      [second.intent.intentId]: 'unread',
    });
  });

  it('sweeps stale intent statuses without expiring active dedupe rows', async () => {
    const stale = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 403, {
      dedupeKey: 'finance:dedupe:stale',
      expiresAt: '2026-05-08T12:00:00.000Z',
    }));
    const active = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 403, {
      dedupeKey: 'finance:dedupe:active',
      expiresAt: '2026-05-08T12:00:00.000Z',
    }));
    testDb.prepare('UPDATE notification_intents SET expires_at = ? WHERE intent_id = ?')
      .run('2026-05-07T11:00:00.000Z', stale.intent.intentId);

    expect(expireStaleNotificationIntents()).toBe(1);

    const rows = testDb.prepare(`
      SELECT intent_id AS intentId, status
        FROM notification_intents
       WHERE intent_id IN (?, ?)
    `).all(stale.intent.intentId, active.intent.intentId) as Array<{ intentId: string; status: string }>;
    expect(Object.fromEntries(rows.map((row) => [row.intentId, row.status]))).toEqual({
      [stale.intent.intentId]: 'expired',
      [active.intent.intentId]: 'evaluated',
    });
  });

  it('does not rewrite terminal center-item history while freeing its dedupe key', async () => {
    const dedupeKey = 'training:terminal-dedupe-recreate';
    const terminal = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 407, {
      dedupeKey,
      expiresAt: '2026-05-08T12:00:00.000Z',
    }));
    testDb.prepare(`
      UPDATE notification_center_items
         SET status = 'actioned', expires_at = ?
       WHERE item_id = ?
    `).run('2026-05-07T11:00:00.000Z', terminal.item!.itemId);
    testDb.prepare('UPDATE notification_intents SET expires_at = ? WHERE intent_id = ?')
      .run('2026-05-07T11:00:00.000Z', terminal.intent.intentId);

    expect(expireStaleNotificationIntents()).toBe(1);

    const terminalStatus = (testDb.prepare(`
      SELECT status FROM notification_center_items WHERE item_id = ?
    `).get(terminal.item!.itemId) as { status: string }).status;
    expect(terminalStatus).toBe('actioned');

    const replacement = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 407, {
      dedupeKey,
      expiresAt: '2026-05-09T12:00:00.000Z',
    }));
    expect(replacement.item?.itemId).toBeDefined();
    expect(replacement.item?.itemId).not.toBe(terminal.item!.itemId);
    expect(replacement.decisionLog.decision).not.toBe('deduped');
  });

  it('allows the same dedupe key across different source skills', async () => {
    const dedupeKey = 'shared:cross-skill:key';

    await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 404, {
      dedupeKey,
    }));
    await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 404, {
      dedupeKey,
    }));

    const rawCount = (testDb.prepare(`
      SELECT COUNT(*) AS cnt
        FROM notification_center_items
       WHERE user_id = ? AND tenant_id = ? AND dedupe_key = ?
    `).get(404, 404, dedupeKey) as { cnt: number }).cnt;
    expect(rawCount).toBe(2);
    expect(listNotificationCenterItems(404, 404).map((item) => item.sourceSkill)).toEqual(['content']);
  });

  it('creates runtime dedupe indexes equivalent to the migration contract', () => {
    const rows = testDb.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN ('idx_notification_intents_dedupe_unique', 'idx_notification_center_items_dedupe_unique')
      ORDER BY name
    `).all() as Array<{ name: string; sql: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'idx_notification_center_items_dedupe_unique',
      'idx_notification_intents_dedupe_unique',
    ]);
    const byName = Object.fromEntries(rows.map((row) => [row.name, row.sql]));
    expect(byName.idx_notification_intents_dedupe_unique).toContain("status != 'expired'");
    expect(byName.idx_notification_center_items_dedupe_unique).toContain("status NOT IN ('expired','actioned','dismissed','superseded')");
  });

  it('resolves notification contracts for server APNs categories and badge contribution', () => {
    const conflict = resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'conflict_detected',
      actionId: 'accept_reflow',
    });
    expect(conflict).toMatchObject({
      apnsCategory: 'DECISION_SCHEDULE_CONFLICT',
      iosDestination: 'decision_center',
      privacySafeCopyPolicy: 'standard',
      defaultDelivery: ['in_app', 'inbox_history', 'push'],
      contributesToBadge: true,
      supportedActions: ['accept_reflow', 'choose_another_time', 'open_detail', 'snooze'],
      actionId: 'accept_reflow',
    });
    expect(deliveryPolicyForNotificationContract(conflict)).toBe('auto');

    expect(resolveNotificationContract({
      sourceSkill: 'content',
      type: 'approval_required',
      actionId: 'approve_script',
    })).toMatchObject({
      apnsCategory: 'DECISION_APPROVAL',
      iosDestination: 'decision_center',
      privacySafeCopyPolicy: 'private_content',
      supportedActions: ['approve_script', 'request_rewrite', 'open_detail'],
      actionId: 'approve_script',
      contributesToBadge: true,
    });

    expect(resolveNotificationContract({
      sourceSkill: 'training',
      type: 'approval_required',
      actionId: 'approve_product_learning_case',
    })).toMatchObject({
      apnsCategory: 'DECISION_CLARIFICATION',
      iosDestination: 'decision_center',
      privacySafeCopyPolicy: 'health',
      supportedActions: [
        'activate_training_plan_revision',
        'activate_training_coach_v2_proposal',
        'approve_product_learning_case',
        'open_detail',
      ],
      actionId: 'approve_product_learning_case',
      contributesToBadge: true,
    });

    expect(resolveNotificationContract({
      sourceSkill: 'finance',
      type: 'approval_required',
      actionId: 'open_detail',
    })).toMatchObject({
      apnsCategory: 'DECISION_CLARIFICATION',
      iosDestination: 'decision_center',
      privacySafeCopyPolicy: 'financial',
      supportedActions: ['open_detail'],
      actionId: 'open_detail',
      contributesToBadge: true,
    });

    const digest = resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'daily_digest',
    });
    expect(digest).toMatchObject({
      apnsCategory: 'daily_digest',
      iosDestination: 'report_detail',
      defaultDelivery: ['in_app', 'inbox_history', 'digest'],
      contributesToBadge: false,
    });
    expect(deliveryPolicyForNotificationContract(digest)).toBe('digest_only');

    expect(resolveNotificationContract({
      sourceSkill: 'finance',
      type: 'decision_required',
      actionId: 'mark_paid',
    })).toMatchObject({
      apnsCategory: 'FINANCE_PAYMENT',
      iosDestination: 'decision_center',
      supportedActions: ['mark_paid', 'open_detail', 'dismiss'],
      actionId: 'mark_paid',
    });

    expect(resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'reminder',
      actionId: 'mark_done',
    })).toMatchObject({
      apnsCategory: 'reminder',
      iosDestination: 'notification_detail',
      supportedActions: ['open_detail', 'snooze', 'dismiss'],
      actionId: null,
    });

    const crossSkill = resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'insight',
      entityType: 'cross_skill_impact',
      entityId: '2026-05-08',
      recipe: 'cross_skill_impact',
    });
    expect(crossSkill).toMatchObject({
      topic: {
        sourceSkill: 'secretary',
        entityType: 'cross_skill_impact',
        entityId: '2026-05-08',
        recipe: 'cross_skill_impact',
      },
      iosDestination: 'coordinated_plan',
      defaultDelivery: ['in_app', 'inbox_history', 'digest'],
      contributesToBadge: false,
    });
    expect(deliveryPolicyForNotificationContract(crossSkill)).toBe('digest_only');
  });

  it('defaults cross-skill impact recipe notifications to digest delivery', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 405, {
      type: 'insight',
      priority: 'passive',
      relatedEntityType: 'cross_skill_impact',
      relatedEntityId: '2026-05-08',
      requiresUserAction: false,
      decisionContext: { recipe: 'cross_skill_impact', entityTitle: 'Friday coordination' },
      dedupeKey: 'secretary:cross-skill:2026-05-08',
    }));

    expect(result.intent.deliveryPolicy).toBe('digest_only');
    expect(result.decisionLog.decision).toBe('digest');
  });

  it('filters unsupported producer actions and exposes action effectiveness metadata', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 406, {
      type: 'decision_required',
      relatedEntityType: 'task_attention_day',
      relatedEntityId: '2026-06-17',
      actionButtons: [
        { id: 'open_today_plan', label: 'Open today\'s plan', style: 'primary', deeplink: 'nexus://today' },
      ],
      deeplink: 'nexus://tasks?filter=dueToday',
      dedupeKey: 'secretary:daily-attention:unsupported-action',
      decisionContext: {
        recipe: 'daily_task_attention',
        sourceState: 'task_pressure',
        entityTitle: 'Daily task attention',
        visibilityScope: 'user_private',
      },
    }));

    expect(result.item?.actions).toHaveLength(1);
    expect(result.item?.actions[0]).toMatchObject({
      id: 'open_detail',
      label: 'Open',
      style: 'primary',
      deeplink: 'nexus://tasks?filter=dueToday',
    });
    expect(result.item?.actionEffectiveStatuses).toEqual([
      {
        actionId: 'open_detail',
        effective: 'enabled',
        implemented: true,
        capabilityReason: null,
      },
    ]);
    expect(result.item?.frontendActionState).toBe('enabled');
  });

  it('normalizes non-app-routable producer deeplinks to Notification Center fallback', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 407, {
      type: 'decision_required',
      relatedEntityType: 'task_attention_day',
      relatedEntityId: '2026-06-18',
      actionButtons: [
        { id: 'open_detail', label: 'Open old route', style: 'primary', deeplink: 'nexushub://tasks?filter=dueToday' },
      ],
      deeplink: 'nexushub://tasks?filter=dueToday',
      dedupeKey: 'secretary:daily-attention:legacy-deeplink',
      decisionContext: {
        recipe: 'daily_task_attention',
        sourceState: 'task_pressure',
        entityTitle: 'Daily task attention',
        visibilityScope: 'user_private',
      },
    }));

    expect(result.item?.deeplink).toBe('nexus://notifications');
    expect(result.item?.actions[0]?.deeplink).toBe('nexus://notifications');
    expect(result.item?.expiresAt).toBeTruthy();
    expect(Date.parse(result.item!.expiresAt!)).toBeGreaterThan(Date.now());

    const external = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 407, {
      type: 'approval_required',
      relatedEntityType: 'content_script',
      relatedEntityId: 'https-route',
      actionButtons: [
        { id: 'open_detail', label: 'Open external URL', style: 'primary', deeplink: 'https://example.com/review' },
      ],
      deeplink: 'https://example.com/review',
      dedupeKey: 'content:approval:https-route',
      decisionContext: {
        recipe: 'content_approval',
        sourceState: 'approval_required',
        entityTitle: 'HTTPS route',
        visibilityScope: 'user_private',
      },
    }));

    expect(external.item?.deeplink).toBe('nexus://notifications');
    expect(external.item?.actions[0]?.deeplink).toBe('nexus://notifications');
  });

  it('does not allow producer privacy overrides to loosen source-skill policy', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('finance', 408, {
      type: 'decision_required',
      relatedEntityType: 'finance_tax_event',
      relatedEntityId: '2026-06',
      actionButtons: [
        { id: 'mark_paid', label: 'Mark paid', style: 'primary' },
      ],
      deeplink: 'nexus://finance/reminder/2026-06',
      dedupeKey: 'finance:privacy-policy-gate',
      privacyPolicy: 'public',
      decisionContext: {
        recipe: 'finance_payment',
        entityTitle: 'Finance payment',
        sourceState: 'payment_due',
      },
    }));

    expect(result.intent.privacyPolicy).toBe('financial');
  });

  it('downgrades actionable intents that are missing source scope', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 409, {
      relatedEntityType: null,
      relatedEntityId: null,
      requiresUserAction: true,
      dedupeKey: 'content:missing-source-scope',
    }));

    expect(result.intent.requiresUserAction).toBe(false);
    expect(result.intent.priority).toBe('passive');
    expect(result.intent.deliveryPolicy).toBe('digest_only');
  });

  it('enforces active dedupe keys at the database layer', () => {
    testDb.exec(readFileSync('migrations/125_notification_dedupe_unique.sql', 'utf8'));

    testDb.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority,
        title, body, action_buttons_json, dedupe_key, status
      ) VALUES (?, 401, 401, 'training', 'decision_required', 'active',
        'Training decision', 'Training decision', '[]',
        'training:dedupe-db', 'pending')
    `).run('intent-db-1');
    expect(() => testDb.prepare(`
      INSERT INTO notification_intents (
        intent_id, user_id, tenant_id, source_skill, type, priority,
        title, body, action_buttons_json, dedupe_key, status
      ) VALUES (?, 401, 401, 'training', 'decision_required', 'active',
        'Training decision duplicate', 'Training decision duplicate',
        '[]', 'training:dedupe-db', 'pending')
    `).run('intent-db-2')).toThrow(/UNIQUE/);

    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key
      ) VALUES (?, 'intent-db-1', 401, 401, 'Training decision',
        'Training decision', 'Training decision', 'training',
        'decision_required', 'active', 'unread', '[]', 'training:center-dedupe')
    `).run('item-db-1');
    expect(() => testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key
      ) VALUES (?, 'intent-db-1', 401, 401, 'Training decision duplicate',
        'Training decision duplicate', 'Training decision duplicate', 'training',
        'decision_required', 'active', 'unread', '[]', 'training:center-dedupe')
    `).run('item-db-2')).toThrow(/UNIQUE/);
  });

  it('holds passive notifications for digest and delays active items during quiet hours', async () => {
    updateNotificationProfile(5, 5, {
      quietHours: { start: '00:00', end: '23:59' },
      digestPassiveItems: true,
    });

    const digest = await createNotificationIntent(buildSkillNotificationFixtureIntent('system', 5));
    const active = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 5, {
      dedupeKey: 'cooking:quiet-hours',
    }));

    expect(digest.decisionLog.decision).toBe('digest');
    expect(digest.decisionLog.scheduledFor).toBeTruthy();
    expect(active.decisionLog.decision).toBe('quiet_hours_delayed');
    expect(active.decisionLog.scheduledFor).toBeTruthy();
  });

  it('rejects ambiguous quiet hours where start equals end', () => {
    expect(() => updateNotificationProfile(50, 50, {
      quietHours: { start: '08:00', end: '08:00' },
    })).toThrow(/quiet hours start and end must be different/);
  });

  it('uses the notification profile timezone for quiet hours decisions', async () => {
    pushTokens = []; // this case exercises the no-device-token path
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T22:30:00.000Z'));

    updateNotificationProfile(51, 51, {
      timezone: 'Europe/Lisbon',
      quietHours: { start: '23:00', end: '07:00' },
    });
    updateNotificationProfile(52, 52, {
      timezone: 'America/New_York',
      quietHours: { start: '23:00', end: '07:00' },
    });

    const lisbon = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 51, {
      dedupeKey: 'timezone-lisbon',
    }));
    const newYork = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 52, {
      dedupeKey: 'timezone-new-york',
    }));

    expect(lisbon.decisionLog.decision).toBe('quiet_hours_delayed');
    expect(newYork.decisionLog.decision).toBe('blocked_missing_device_token');
  });

  it('releases due quiet-hours and digest notifications through the delivery provider', async () => {
    pushTokens = ['sandbox-token'];
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    updateNotificationProfile(53, 53, {
      quietHours: { start: '00:00', end: '23:59' },
    });
    const delayed = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 53, {
      dedupeKey: 'release-delayed',
    }));
    expect(delayed.decisionLog.decision).toBe('quiet_hours_delayed');

    testDb.prepare(`
      UPDATE notification_decision_logs
      SET scheduled_for = ?
      WHERE decision_log_id = ?
    `).run('2026-05-07T11:59:00.000Z', delayed.decisionLog.decisionLogId);

    const result = await releaseDueNotificationDeliveries();
    expect(result.inspected).toBe(1);
    expect(result.released).toBe(1);
    const updated = getNotificationDecisionLog(delayed.decisionLog.decisionLogId, 53, 53);
    expect(updated?.decision).toBe('sent_push');
    expect(updated?.deliveryAttemptIds).toHaveLength(1);
  });

  it('assembles due passive items into a single daily digest release', async () => {
    pushTokens = ['sandbox-token'];
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('system', 54, {
      dedupeKey: 'digest-item-1',
    }));
    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('system', 54, {
      dedupeKey: 'digest-item-2',
    }));

    expect(first.decisionLog.decision).toBe('digest');
    expect(second.decisionLog.decision).toBe('digest');
    // The digest now states what is waiting rather than only how much.
    expect(assembleDailyDigest(54, 54, 2).body).toBe('2 updates');

    testDb.prepare(`
      UPDATE notification_decision_logs
      SET scheduled_for = ?
      WHERE decision_log_id IN (?, ?)
    `).run('2026-05-07T11:59:00.000Z', first.decisionLog.decisionLogId, second.decisionLog.decisionLogId);

    const result = await releaseDueNotificationDeliveries();
    expect(result.inspected).toBe(2);
    expect(result.released).toBe(2);
    const firstLog = getNotificationDecisionLog(first.decisionLog.decisionLogId, 54, 54);
    const secondLog = getNotificationDecisionLog(second.decisionLog.decisionLogId, 54, 54);
    // A digest is ONE interrupt, so exactly one row may be recorded as one.
    // This assertion previously required `sent_push` on both rows, which
    // encoded an over-count that `evaluateInterruptBudget` then billed to the
    // user's daily cap — an N-item digest burned N of their 8 daily interrupts.
    expect(firstLog?.decision).toBe('sent_push');
    expect(firstLog?.sentAt).toBeTruthy();
    expect(secondLog?.decision).toBe('in_app_only');
    expect(secondLog?.sentAt).toBeNull();
    // Both rows still point at the delivery, so it stays traceable from either.
    expect(firstLog?.deliveryAttemptIds).toEqual(secondLog?.deliveryAttemptIds);
    expect(firstLog?.deliveryAttemptIds).toHaveLength(1);
  });

  it('single-flights concurrent release sweeps so a due row is pushed at most once', async () => {
    pushTokens = ['sandbox-token'];
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    updateNotificationProfile(57, 57, {
      quietHours: { start: '00:00', end: '23:59' },
    });
    const delayed = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 57, {
      dedupeKey: 'release-single-flight',
    }));
    expect(delayed.decisionLog.decision).toBe('quiet_hours_delayed');
    testDb.prepare(`
      UPDATE notification_decision_logs
      SET scheduled_for = ?
      WHERE decision_log_id = ?
    `).run('2026-05-07T11:59:00.000Z', delayed.decisionLog.decisionLogId);

    const [first, second] = await Promise.all([
      releaseDueNotificationDeliveries(),
      releaseDueNotificationDeliveries(),
    ]);

    // The second concurrent caller joins the in-flight sweep instead of
    // starting a competing one, so both see the same summary object.
    expect(second).toBe(first);
    expect(first.released).toBe(1);
    const attemptCount = (testDb.prepare(`
      SELECT COUNT(*) AS count
        FROM notification_delivery_attempts
       WHERE user_id = 57 AND channel = 'push'
    `).get() as { count: number }).count;
    expect(attemptCount).toBe(1);
    const updated = getNotificationDecisionLog(delayed.decisionLog.decisionLogId, 57, 57);
    expect(updated?.decision).toBe('sent_push');

    // The latch is released once the sweep completes.
    const third = await releaseDueNotificationDeliveries();
    expect(third.inspected).toBe(0);
  });

  it('CAS-skips a due row that a concurrent sweep already claimed and does not count it as sent', async () => {
    pushTokens = ['sandbox-token'];
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    updateNotificationProfile(58, 58, {
      quietHours: { start: '00:00', end: '23:59' },
    });
    const delayed = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 58, {
      dedupeKey: 'release-cas-claimed',
    }));
    expect(delayed.decisionLog.decision).toBe('quiet_hours_delayed');
    testDb.prepare(`
      UPDATE notification_decision_logs
      SET scheduled_for = ?
      WHERE decision_log_id = ?
    `).run('2026-05-07T11:59:00.000Z', delayed.decisionLog.decisionLogId);

    mockSendPushNotification.mockImplementation(() => {
      // Simulate another sweep claiming the row between this sweep's SELECT
      // and its updateReleasedLogs UPDATE.
      testDb.prepare(`
        UPDATE notification_decision_logs
        SET decision = 'sent_push', reason = 'released by concurrent sweep', sent_at = datetime('now')
        WHERE decision_log_id = ?
      `).run(delayed.decisionLog.decisionLogId);
      return Promise.resolve({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    });

    const result = await releaseDueNotificationDeliveries();
    expect(result.inspected).toBe(1);
    expect(result.released).toBe(0);
    expect(result.blocked).toBe(0);
    const updated = getNotificationDecisionLog(delayed.decisionLog.decisionLogId, 58, 58);
    expect(updated?.reason).toBe('released by concurrent sweep');
    expect(vi.mocked(logger.warn).mock.calls.some(
      (call) => String(call[1]).includes('already claimed by a concurrent sweep'),
    )).toBe(true);
  });

  it('records apns_delivery_failed when a due release fails at APNs with tokens present', async () => {
    pushTokens = ['sandbox-token'];
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    mockSendPushNotification.mockResolvedValue({ sent: 0, failed: 1, skipped: 0, retriable: 0, unregistered: [] });
    updateNotificationProfile(59, 59, {
      quietHours: { start: '00:00', end: '23:59' },
    });
    const delayed = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 59, {
      dedupeKey: 'release-apns-failure',
    }));
    expect(delayed.decisionLog.decision).toBe('quiet_hours_delayed');
    testDb.prepare(`
      UPDATE notification_decision_logs
      SET scheduled_for = ?
      WHERE decision_log_id = ?
    `).run('2026-05-07T11:59:00.000Z', delayed.decisionLog.decisionLogId);

    const result = await releaseDueNotificationDeliveries();
    expect(result.inspected).toBe(1);
    expect(result.released).toBe(0);
    expect(result.blocked).toBe(1);
    expect(result.failed).toBe(1);
    const updated = getNotificationDecisionLog(delayed.decisionLog.decisionLogId, 59, 59);
    expect(updated?.decision).toBe('apns_delivery_failed');
    expect(updated?.reason).toContain('APNs delivery failed');
    const attemptRow = testDb.prepare(`
      SELECT provider, status FROM notification_delivery_attempts WHERE user_id = 59
    `).get() as { provider: string; status: string };
    expect(attemptRow).toEqual({ provider: 'apns', status: 'failed' });
  });

  it('legacy bridge write-path is retired; historical rows keep badge exclusion', async () => {
    ensureContentNotificationsFixtureTable();

    // 2026-07-04 retirement pin: the legacy-store -> orchestrator bridge is
    // gone. Its last producer (Garmin reauth) emits a first-class intent now.
    const legacyStore = await import('../../src/services/content-notification-store');
    expect((legacyStore as Record<string, unknown>).createAndPushNotification).toBeUndefined();

    // Old-format rows already in the DB keep excluding by legacy id so
    // historical badge math stays correct until phase-2 drains the table.
    testDb.prepare(`
      INSERT INTO content_notifications (id, user_id, type, title, body)
      VALUES (900, 21, 'script_ready', 'Old-format', 'Old-format body')
    `).run();
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key, requires_user_action
      ) VALUES ('nc_bridge_old_format', 'ni_bridge_old_format', 21, 21, 'Content', 'Open Nexus.', 'Open Nexus.',
        'content', 'approval_required', 'active', 'unread', '[]', 'content:script_ready:900', 1)
    `).run();

    const bridgedIds = listNotificationBridgeEntityIds(21, 21, 'content');
    expect(bridgedIds).toEqual(expect.arrayContaining([900]));
    expect(getUnreadCountExcludingNotificationIds(21, bridgedIds)).toBe(0);
  });

  it('Garmin reauth emits a deduped first-class orchestrator intent', async () => {
    const intentInput = {
      userId: 21,
      tenantId: 21,
      sourceSkill: 'training' as const,
      type: 'sync_failure' as const,
      priority: 'active' as const,
      relatedEntityId: 'garmin_reauth:21',
      relatedEntityType: 'garmin_session',
      title: 'Garmin needs re-authentication',
      body: 'Your Garmin session expired. Reconnect Garmin to restore training data in Nexus Hub.',
      dedupeKey: 'training:garmin_reauth:21',
      privacyPolicy: 'standard' as const,
    };
    const first = await createNotificationIntent(intentInput as Parameters<typeof createNotificationIntent>[0]);
    const second = await createNotificationIntent(intentInput as Parameters<typeof createNotificationIntent>[0]);

    expect(first.item?.dedupeKey).toBe('training:garmin_reauth:21');
    // Recurring session expiries collapse into the active item.
    expect(second.decisionLog.decision).toBe('deduped');
    const rows = testDb.prepare(
      "SELECT COUNT(*) AS n FROM notification_center_items WHERE user_id = 21 AND dedupe_key = 'training:garmin_reauth:21' AND status = 'unread'",
    ).get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('does not let untrusted send_now intents bypass quiet hours', async () => {
    pushTokens = ['sandbox-token'];
    updateNotificationProfile(55, 55, {
      quietHours: { start: '00:00', end: '23:59' },
      allowTimeSensitive: true,
    });

    const untrusted = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 55, {
      quietHoursPolicy: 'send_now',
      priority: 'active',
      dedupeKey: 'cooking-send-now',
    }));
    const trusted = await createNotificationIntent(buildSkillNotificationFixtureIntent('security', 55, {
      type: 'security_account',
      quietHoursPolicy: 'send_now',
      priority: 'time_sensitive',
      dedupeKey: 'security-send-now',
    }));

    expect(untrusted.decisionLog.decision).toBe('quiet_hours_delayed');
    expect(untrusted.decisionLog.reason).toContain('untrusted send_now policy');
    expect(trusted.decisionLog.decision).toBe('sent_push');
  });

  it('caps push delivery per skill while preserving in-app notification items', async () => {
    // Was: 20 pushes allowed before limiting, from a process-local Map that
    // also exempted time_sensitive entirely — i.e. it did not bind. The budget
    // that replaced it counts real sends from notification_decision_logs and
    // caps each skill at INTERRUPT_SKILL_DAILY_CAP per local day.
    pushTokens = ['sandbox-token'];
    // Past the new-user ramp, which would otherwise be what binds here.
    getOrCreateNotificationProfile(56, 56);
    // SQLite's datetime('now') reads the REAL clock while this suite runs on a
    // fake one, so a relative offset can land in the future and trip the
    // new-user ramp. Pin an absolute date instead.
    testDb.prepare("UPDATE notification_profiles SET created_at = '2020-01-01 00:00:00' WHERE user_id = 56").run();

    const results = [];
    for (let index = 0; index < INTERRUPT_SKILL_DAILY_CAP + 2; index += 1) {
      results.push(await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 56, {
        dedupeKey: `cooking-rate-${index}`,
      })));
    }

    expect(results.filter((result) => result.decisionLog.decision === 'sent_push'))
      .toHaveLength(INTERRUPT_SKILL_DAILY_CAP);
    // Demoted to the digest, not silently withheld in-app: the user still gets
    // it, batched, in the next slot.
    expect(results.at(-1)?.decisionLog.decision).toBe('digest');
    expect(results.at(-1)?.decisionLog.reason).toContain('interrupt budget');
    // Every intent still produced a durable item.
    expect(listNotificationCenterItems(56, 56)).toHaveLength(INTERRUPT_SKILL_DAILY_CAP + 2);
  });

  it('allows configured time-sensitive deadlines through quiet hours and downgrades critical by default', async () => {
    pushTokens = []; // this case exercises the no-device-token path
    updateNotificationProfile(6, 6, {
      quietHours: { start: '00:00', end: '23:59' },
      allowTimeSensitive: true,
      allowCritical: false,
    });

    const soon = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 6, {
      priority: 'time_sensitive',
      decisionDeadline: new Date(Date.now() + 60 * 60_000).toISOString(),
      dedupeKey: 'content:soon',
    }));
    const critical = await createNotificationIntent(buildSkillNotificationFixtureIntent('security', 6, {
      priority: 'critical',
      dedupeKey: 'security:critical',
    }));

    expect(soon.decisionLog.decision).toBe('blocked_missing_device_token');
    expect(critical.intent.priority).toBe('time_sensitive');
  });

  it('does not let an already-expired deadline bypass quiet hours', async () => {
    updateNotificationProfile(57, 57, {
      quietHours: { start: '00:00', end: '23:59' },
      allowTimeSensitive: true,
    });

    const expired = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 57, {
      priority: 'time_sensitive',
      decisionDeadline: new Date(Date.now() - 60_000).toISOString(),
      dedupeKey: 'content:expired-deadline',
    }));

    expect(expired.decisionLog.decision).toBe('quiet_hours_delayed');
  });

  it('registers and revokes iOS device tokens with hashed notification metadata', () => {
    const token = registerNotificationDeviceToken({
      userId: 7,
      tenantId: 7,
      token: 'abcdef1234567890',
      deviceId: 'iphone-7',
      appVersion: '1.0',
    });

    expect(token.tokenSuffix).toBe('34567890');
    expect(token.tokenHash).not.toContain('abcdef');
    const rawMetadata = testDb.prepare('SELECT token_hash, token_suffix FROM notification_device_tokens WHERE token_id = ?').get(token.tokenId) as any;
    expect(rawMetadata.token_hash).not.toBe('abcdef1234567890');
    expect(rawMetadata.token_suffix).toBe('34567890');
    expect(revokeNotificationDeviceToken(token.tokenId, 7, 7)).toBe(true);
    const iosRow = testDb.prepare('SELECT push_token FROM ios_devices WHERE device_id = ?').get('iphone-7') as any;
    expect(iosRow.push_token).toBeNull();
  });

  it('revokes the prior user token row and cancels queued deliveries when a device is re-associated', () => {
    registerNotificationDeviceToken({
      userId: 70,
      tenantId: 70,
      token: 'token-user-a',
      deviceId: 'shared-device',
    });
    testDb.prepare(`
      INSERT INTO notification_decision_logs (
        decision_log_id, notification_id, intent_id, user_id, tenant_id, source_skill,
        source_entity_id, decision, priority, reason, dedupe_key, scheduled_for, sent_at,
        delivery_attempt_ids_json
      ) VALUES ('log-user-a', NULL, NULL, 70, 70, 'secretary', NULL, 'quiet_hours_delayed',
        'active', 'queued for later', NULL, '2026-05-07T13:00:00.000Z', NULL, '[]')
    `).run();

    registerNotificationDeviceToken({
      userId: 71,
      tenantId: 71,
      token: 'token-user-b',
      deviceId: 'shared-device',
    });

    const stale = testDb.prepare(`
      SELECT revoked_at FROM notification_device_tokens
      WHERE user_id = 70 AND device_id = 'shared-device'
    `).get() as { revoked_at: string | null };
    expect(stale.revoked_at).toBeTruthy();

    const queued = getNotificationDecisionLog('log-user-a', 70, 70);
    expect(queued?.decision).toBe('blocked_missing_device_token');
    expect(queued?.sentAt).toBeTruthy();
  });

  it('sends decision pushes with collapse id and canonical unread badge count', async () => {
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    pushTokens = ['sandbox-token'];
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    testDb.prepare(`
      INSERT INTO notification_center_items (
        item_id, intent_id, user_id, tenant_id, title, body, safe_body,
        source_skill, type, priority, status, actions_json, dedupe_key, requires_user_action
      ) VALUES ('nc_existing_badge_item', 'ni_existing_badge_item', 72, 72, 'Reminder',
        'Reminder', 'Reminder', 'cooking', 'reminder', 'passive', 'unread', '[]',
        'existing-badge-item', 1)
    `).run();

    const decision = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 72, {
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs race date',
      body: 'Add a race date before the next plan update.',
      relatedEntityId: 'triathlon-running',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'decision-collapse-badge',
    }));

    expect(decision.decisionLog.decision).toBe('sent_push');
    expect(mockSendPushNotification).toHaveBeenCalledWith(72, expect.objectContaining({
      collapseId: `decision:${decision.item!.itemId}`,
      badge: 2,
      threadId: 'decision-center',
      category: 'DECISION_CLARIFICATION',
      interruptionLevel: 'time-sensitive',
      data: expect.objectContaining({
        decisionId: decision.item!.itemId,
        notificationUserId: 72,
        userId: 72,
        tenantId: 72,
        iosDestination: 'decision_center',
      }),
    }));
  });

  it('includes exact action versions only after atomic Decision metadata is committed', async () => {
    testDb.exec(`
      ALTER TABLE notification_center_items
        ADD COLUMN record_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE notification_intents
        ADD COLUMN context_version TEXT;
    `);
    const contextVersion = 'ctx_atomic_apns_contract_v1';

    const decision = await createNotificationIntent(buildSkillNotificationFixtureIntent('training', 721, {
      type: 'decision_required',
      priority: 'time_sensitive',
      title: 'Training plan needs a current choice',
      body: 'Review the current training plan choice.',
      relatedEntityId: 'training-versioned-apns',
      relatedEntityType: 'training_profile',
      requiresUserAction: true,
      dedupeKey: 'decision-versioned-apns',
    }), {
      atomicItemProposal: true,
      onItemPersistedInTransaction: ({ intent }) => {
        testDb.prepare(`
          UPDATE notification_intents
             SET context_version = ?
           WHERE intent_id = ? AND user_id = ? AND tenant_id = ?
        `).run(contextVersion, intent.intentId, intent.userId, intent.tenantId);
      },
    });

    expect(mockSendPushNotification).toHaveBeenCalledWith(721, expect.objectContaining({
      data: expect.objectContaining({
        decisionId: decision.item!.itemId,
        notificationUserId: 721,
        userId: 721,
        tenantId: 721,
        recordVersion: 1,
        contextVersion,
      }),
    }));
  });

  it('does not attach decision collapse ids to regular reminder pushes', async () => {
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    pushTokens = ['sandbox-token'];
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });

    await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 73, {
      type: 'reminder',
      requiresUserAction: false,
      actionButtons: [{ id: 'open_detail', label: 'Open' }],
      dedupeKey: 'regular-reminder-no-collapse',
    }));

    expect(mockSendPushNotification).toHaveBeenCalledWith(73, expect.not.objectContaining({
      collapseId: expect.stringMatching(/^decision:/),
    }));
  });

  it('keeps APNs payloads privacy-safe for sensitive decisions', async () => {
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    pushTokens = ['sandbox-token'];
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });

    const cases = [
      { source: 'finance' as const, body: 'Pay $4,200 to Therapy Center', forbidden: ['$4,200', 'Therapy Center'] },
      { source: 'training' as const, body: 'HRV dropped and soreness is high', forbidden: ['HRV', 'soreness'] },
      { source: 'secretary' as const, body: 'Private calendar: Acquisition meeting', forbidden: ['Acquisition meeting'] },
      { source: 'content' as const, body: 'Script body with private launch copy', forbidden: ['private launch copy'] },
    ];

    for (const [index, entry] of cases.entries()) {
      await createNotificationIntent(buildSkillNotificationFixtureIntent(entry.source, 74 + index, {
        title: entry.body,
        body: entry.body,
        sensitiveBody: entry.body,
        privacyPolicy: entry.source === 'finance' ? 'financial' : entry.source === 'training' ? 'health' : entry.source === 'content' ? 'private_content' : 'standard',
        dedupeKey: `privacy-apns-${entry.source}`,
      }));
      const payload = mockSendPushNotification.mock.calls.at(-1)?.[1] as Record<string, unknown>;
      const serialized = JSON.stringify(payload);
      expect(payload.title).toMatch(/decision|review|attention|update|reminder/i);
      for (const forbidden of entry.forbidden) {
        expect(serialized).not.toContain(forbidden);
      }
    }
  });

  it('scopes list, read, dismiss, and safe generic actions by authenticated user and tenant', async () => {
    pushTokens = ['sandbox-token'];
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 8, {
      dedupeKey: 'content:scope',
    }));
    const itemId = result.item!.itemId;

    expect(listNotificationCenterItems(9, 9)).toHaveLength(0);
    expect(markNotificationCenterItemRead(itemId, 9, 9)).toBeNull();
    expect(dismissNotificationCenterItem(itemId, 9, 9)).toBeNull();
    expect(() => performNotificationAction(itemId, 'approve_script', 9, 9)).toThrow(/not found/);

    expect(() => performNotificationAction(itemId, 'approve_script', 8, 8)).toThrow(/deterministic executor/);
    const afterRejected = listNotificationCenterItems(8, 8)[0];
    expect(afterRejected.status).toBe('unread');
    expect(getNotificationReliabilityDashboard(8, 8).quality.unsupportedActionBlockedCount).toBe(1);

    const action = performNotificationAction(itemId, 'open_detail', 8, 8);
    expect(action.item.status).toBe('read');
    const log = getNotificationDecisionLog(result.decisionLog.decisionLogId, 8, 8);
    expect(log?.actionTaken).toBe('open_detail');

    const dismissed = dismissNotificationCenterItem(itemId, 8, 8);
    expect(dismissed?.status).toBe('dismissed');
    expect(() => performNotificationAction(itemId, 'open_detail', 8, 8)).toThrow(/dismissed/);
  });

  it('rejects expired or invalid actions safely', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 10, {
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      dedupeKey: 'expired-action',
    }));

    expect(() => performNotificationAction(result.item!.itemId, 'accept_reflow', 10, 10)).toThrow(/expired/);

    const valid = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 10, {
      dedupeKey: 'invalid-action',
    }));
    expect(() => performNotificationAction(valid.item!.itemId, 'mark_paid', 10, 10)).toThrow(/not allowed/);
  });

  it('persists Decision Center context slots, timezone, locale, reason codes, and task counts for downstream enrichment', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 12, {
      dedupeKey: 'secretary:context-normalization',
      decisionContext: {
        timezone: 'America/New_York',
        locale: 'pt-BR',
        candidateSlots: [
          { startAt: '2026-05-08T14:00:00.000Z', endAt: '2026-05-08T15:00:00.000Z', label: '  Backup slot  ' },
        ],
        reasonCodes: [' training_schedule_request ', 'overcapacity'],
        taskCounts: { pending: 5, overdue: 2, dueToday: 1, highPriority: 1 },
      },
    }));

    const row = testDb.prepare('SELECT decision_context_json FROM notification_intents WHERE intent_id = ?').get(result.intent.intentId) as {
      decision_context_json: string;
    };
    const context = JSON.parse(row.decision_context_json);
    expect(context).toMatchObject({
      timezone: 'America/New_York',
      locale: 'pt-BR',
      candidateSlots: [{
        startAt: '2026-05-08T14:00:00.000Z',
        endAt: '2026-05-08T15:00:00.000Z',
        label: 'Backup slot',
      }],
      reasonCodes: ['training_schedule_request', 'overcapacity'],
      taskCounts: { pending: 5, overdue: 2, dueToday: 1, highPriority: 1 },
    });
  });

  it('drops unsafe Decision Center task counts while keeping valid count fields', async () => {
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 13, {
      dedupeKey: 'secretary:task-count-normalization',
      decisionContext: {
        recipe: 'daily_task_attention',
        taskCounts: {
          pending: Number.NaN,
          overdue: -1,
          dueToday: 1000,
          highPriority: 2,
        },
      },
    }));

    const row = testDb.prepare('SELECT decision_context_json FROM notification_intents WHERE intent_id = ?').get(result.intent.intentId) as {
      decision_context_json: string;
    };
    const context = JSON.parse(row.decision_context_json);
    expect(context.taskCounts).toEqual({ highPriority: 2 });
  });

  it('provides deterministic skill fixtures for all notification-producing domains', () => {
    for (const source of ['secretary', 'training', 'content', 'cooking', 'finance', 'security', 'chat', 'system'] as const) {
      const intent = buildSkillNotificationFixtureIntent(source, 11);
      expect(intent.userId).toBe(11);
      expect(intent.tenantId).toBe(11);
      expect(intent.sourceSkill).toBe(source);
      expect(intent.deeplink).toMatch(/^nexus:\/\//);
    }
  });

  it('profile shape stays backward-compatible for existing API clients (QA finding 5)', () => {
    // iOS decodes the `profile` object from GET/PUT /preferences and ignores
    // unknown keys. This pins the legacy key set so a rename/removal breaks
    // loudly here instead of silently breaking old clients, and documents
    // that migration 225 only ADDED the five reportSchedule fields and
    // migration 269 only ADDED marketingPushEnabled.
    const profile = getOrCreateNotificationProfile(21, 21) as unknown as Record<string, unknown>;
    const legacyKeys = [
      'userId', 'tenantId', 'quietHours', 'timezone', 'pushEnabled', 'localEnabled',
      'emailEnabled', 'portalEnabled', 'inAppEnabled', 'skillPreferences',
      'defaultReminderMinutes', 'workoutReminderMinutes', 'contentReminderMinutes',
      'financeReminderDays', 'allowTimeSensitive', 'allowCritical', 'digestPassiveItems',
      'dailyDigestTime', 'weeklyReviewDay', 'weeklyReviewTime', 'doNotNotifyRules',
      'updatedAt', 'createdAt',
    ];
    for (const key of legacyKeys) {
      expect(profile, key).toHaveProperty(key);
    }
    const addedKeys = Object.keys(profile).filter((key) => !legacyKeys.includes(key)).sort();
    expect(addedKeys).toEqual([
      'coachBriefingTime', 'endOfDayTime', 'marketingPushEnabled', 'morningBriefingTime',
      'weeklyReviewReportDay', 'weeklyReviewReportTime',
    ]);
  });

  describe('2026-07-04 APNs + engagement round', () => {
    const OLD_STREAK_ENV = process.env.NOTIFICATION_DIGEST_UNREAD_STREAK_SUPPRESS;
    const OLD_STALE_ENV = process.env.NOTIFICATION_TOKEN_STALE_DAYS;

    afterEach(() => {
      if (OLD_STREAK_ENV === undefined) delete process.env.NOTIFICATION_DIGEST_UNREAD_STREAK_SUPPRESS;
      else process.env.NOTIFICATION_DIGEST_UNREAD_STREAK_SUPPRESS = OLD_STREAK_ENV;
      if (OLD_STALE_ENV === undefined) delete process.env.NOTIFICATION_TOKEN_STALE_DAYS;
      else process.env.NOTIFICATION_TOKEN_STALE_DAYS = OLD_STALE_ENV;
    });

    // Non-decision, time-sensitive reminder: bypasses the decision quality
    // gate and the per-source rate limit, landing directly on the push path.
    function activeIntent(userId: number, overrides: Record<string, unknown> = {}) {
      return createNotificationIntent({
        userId,
        tenantId: userId,
        sourceSkill: 'secretary',
        type: 'reminder',
        priority: 'time_sensitive',
        title: 'Reminder',
        body: 'A reminder is due.',
        quietHoursPolicy: 'allow_time_sensitive',
        dedupeKey: `round:${userId}`,
        ...overrides,
      } as Parameters<typeof createNotificationIntent>[0]);
    }

    it('revokes tokens APNs reports as 410 unregistered and labels the attempt', async () => {
      registerNotificationDeviceToken({
        userId: 88, tenantId: 88, token: 'tok-410', deviceId: 'iphone-410', appVersion: '1.5', environment: 'production',
      });
      pushTokens = [{ token: 'tok-410', environment: 'production' }];
      mockSendPushNotification.mockResolvedValue({ sent: 0, failed: 1, skipped: 0, retriable: 0, unregistered: ['tok-410'] });

      const result = await activeIntent(88);

      expect(result.decisionLog.decision).toBe('apns_delivery_failed');
      const attempt = testDb.prepare(
        "SELECT status, error_code FROM notification_delivery_attempts WHERE user_id = 88 ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; error_code: string };
      expect(attempt.error_code).toBe('apns_token_unregistered');
      const tokenRow = testDb.prepare(
        'SELECT revoked_at FROM notification_device_tokens WHERE user_id = 88',
      ).get() as { revoked_at: string | null };
      expect(tokenRow.revoked_at).not.toBeNull();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ unregisteredCount: 1 }),
        expect.stringContaining('unregistered'),
      );
    });

    it('refreshes last_seen_at on successful delivery so live devices never look stale', async () => {
      registerNotificationDeviceToken({
        userId: 89, tenantId: 89, token: 'tok-live', deviceId: 'iphone-89', appVersion: '1.5', environment: 'production',
      });
      testDb.prepare(
        "UPDATE notification_device_tokens SET last_seen_at = '2026-01-01 00:00:00' WHERE user_id = 89",
      ).run();
      pushTokens = [{ token: 'tok-live', environment: 'production' }];

      const result = await activeIntent(89);

      expect(result.decisionLog.decision).toBe('sent_push');
      const row = testDb.prepare(
        'SELECT last_seen_at FROM notification_device_tokens WHERE user_id = 89',
      ).get() as { last_seen_at: string };
      expect(row.last_seen_at > '2026-01-01 00:00:00').toBe(true);
    });

    it('prunes tokens with no activity in the stale window, honoring the 0-disable knob', () => {
      registerNotificationDeviceToken({
        userId: 90, tenantId: 90, token: 'tok-stale', deviceId: 'iphone-90', appVersion: '1.5', environment: 'production',
      });
      testDb.prepare(
        "UPDATE notification_device_tokens SET last_seen_at = datetime('now', '-120 days') WHERE user_id = 90",
      ).run();

      process.env.NOTIFICATION_TOKEN_STALE_DAYS = '0';
      expect(pruneStaleDeviceTokens()).toBe(0);

      delete process.env.NOTIFICATION_TOKEN_STALE_DAYS;
      expect(pruneStaleDeviceTokens()).toBe(1);
      const row = testDb.prepare(
        'SELECT revoked_at FROM notification_device_tokens WHERE user_id = 90',
      ).get() as { revoked_at: string | null };
      expect(row.revoked_at).not.toBeNull();
    });

    it('suppresses the daily digest push after a fully-unread streak, item still created', async () => {
      process.env.NOTIFICATION_DIGEST_UNREAD_STREAK_SUPPRESS = '3';
      for (let i = 0; i < 3; i += 1) {
        const prior = await createNotificationIntent({
          userId: 91, tenantId: 91, sourceSkill: 'secretary', type: 'daily_digest',
          priority: 'passive', title: 'Digest', body: `Day ${i}`, dedupeKey: `digest:91:${i}`,
        } as Parameters<typeof createNotificationIntent>[0]);
        expect(prior.item).toBeTruthy();
      }

      const fourth = await createNotificationIntent({
        userId: 91, tenantId: 91, sourceSkill: 'secretary', type: 'daily_digest',
        priority: 'passive', title: 'Digest', body: 'Day 3', dedupeKey: 'digest:91:3',
      } as Parameters<typeof createNotificationIntent>[0]);

      expect(fourth.decisionLog.decision).toBe('suppressed');
      expect(fourth.item?.itemId).toBeTruthy();

      // Reading one digest breaks the streak for the next evaluation.
      testDb.prepare(
        "UPDATE notification_center_items SET read_at = datetime('now') WHERE user_id = 91 AND type = 'daily_digest' AND item_id = ?",
      ).run(fourth.item!.itemId);
      const fifth = await createNotificationIntent({
        userId: 91, tenantId: 91, sourceSkill: 'secretary', type: 'daily_digest',
        priority: 'passive', title: 'Digest', body: 'Day 4', dedupeKey: 'digest:91:4',
      } as Parameters<typeof createNotificationIntent>[0]);
      expect(fifth.decisionLog.decision).not.toBe('suppressed');
    });

    it('records apns_delivery_mode_disabled when the delivery mode is not apns', async () => {
      delete process.env.NOTIFICATION_DELIVERY_MODE;

      const result = await activeIntent(92);

      expect(result.decisionLog.decision).toBe('apns_delivery_failed');
      const attempt = testDb.prepare(
        "SELECT status, error_code FROM notification_delivery_attempts WHERE user_id = 92 ORDER BY created_at DESC LIMIT 1",
      ).get() as { status: string; error_code: string };
      expect(attempt.status).toBe('blocked_missing_credentials');
      expect(attempt.error_code).toBe('apns_delivery_mode_disabled');
    });
  });

  describe('2026-07-04 Codex QA fixes', () => {
    it('preserves the Garmin reauth deeplink through normalization (no inbox downgrade)', async () => {
      const result = await createNotificationIntent({
        userId: 93,
        tenantId: 93,
        sourceSkill: 'training',
        type: 'sync_failure',
        priority: 'active',
        relatedEntityId: 'garmin_reauth:93',
        relatedEntityType: 'garmin_session',
        title: 'Garmin needs re-authentication',
        body: 'Reconnect Garmin.',
        deeplink: 'nexus://connections/garmin/reauth',
        dedupeKey: 'training:garmin_reauth:93',
        privacyPolicy: 'standard',
      } as Parameters<typeof createNotificationIntent>[0]);

      expect(result.item?.deeplink).toBe('nexus://connections/garmin/reauth');
      // Regression pin for the original bug: unsupported hosts DO downgrade.
      const downgraded = await createNotificationIntent({
        userId: 93,
        tenantId: 93,
        sourceSkill: 'training',
        type: 'sync_failure',
        priority: 'active',
        title: 'Bad deeplink',
        body: 'Should downgrade.',
        deeplink: 'nexus://settings/integrations/garmin',
        dedupeKey: 'training:bad_deeplink:93',
        privacyPolicy: 'standard',
      } as Parameters<typeof createNotificationIntent>[0]);
      expect(downgraded.item?.deeplink).toBe('nexus://notifications');
    });

    it('caps apns-collapse-id at 64 UTF-8 bytes without breaking surrogate pairs', () => {
      // Short ids pass through untouched.
      expect(buildApnsCollapseId('decision:nc_abc123')).toBe('decision:nc_abc123');

      // Long ASCII: capped, deterministic, distinct for distinct inputs.
      const longA = buildApnsCollapseId(`secretary:daily_digest:${'a'.repeat(200)}`);
      const longB = buildApnsCollapseId(`secretary:daily_digest:${'a'.repeat(200)}b`);
      expect(Buffer.byteLength(longA, 'utf8')).toBeLessThanOrEqual(64);
      expect(longA).toBe(buildApnsCollapseId(`secretary:daily_digest:${'a'.repeat(200)}`));
      expect(longA).not.toBe(longB);

      // Multibyte/emoji dedupe keys: byte cap holds and no lone surrogate
      // fragment survives the cut (round-trips through UTF-8 unchanged).
      const emoji = buildApnsCollapseId(`content:insight:${'🏋️‍♂️🇧🇷é'.repeat(20)}`);
      expect(Buffer.byteLength(emoji, 'utf8')).toBeLessThanOrEqual(64);
      expect(Buffer.from(emoji, 'utf8').toString('utf8')).toBe(emoji);
    });
  });
});
