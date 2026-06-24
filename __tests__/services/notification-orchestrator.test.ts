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
  registerNotificationDeviceToken,
  releaseDueNotificationDeliveries,
  revokeNotificationDeviceToken,
  sanitizeNotificationDeliveryErrorCode,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';
import { deliveryPolicyForNotificationContract, resolveNotificationContract } from '../../src/services/notification-contracts';
import { getDecisionOverview } from '../../src/services/decision-center';

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

describe('Secretary Notification Orchestrator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-07T12:00:00.000Z'));
    testDb = new Database(':memory:');
    pushTokens = [];
    apnsConfigured = false;
    mockSendPushNotification.mockReset();
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
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
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 2));

    expect(result.item?.sourceSkill).toBe('cooking');
    expect(result.decisionLog.decision).toBe('blocked_missing_device_token');
    expect(result.deliveryAttempts[0].status).toBe('blocked_missing_device_token');
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
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
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
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('system', 54, {
      dedupeKey: 'digest-item-1',
    }));
    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('system', 54, {
      dedupeKey: 'digest-item-2',
    }));

    expect(first.decisionLog.decision).toBe('digest');
    expect(second.decisionLog.decision).toBe('digest');
    expect(assembleDailyDigest(54, 54, 2).body).toBe('2 Nexus updates are ready.');

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
    expect(firstLog?.decision).toBe('sent_push');
    expect(secondLog?.decision).toBe('sent_push');
    expect(firstLog?.deliveryAttemptIds).toEqual(secondLog?.deliveryAttemptIds);
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

  it('rate-limits active push delivery while preserving in-app notification items', async () => {
    pushTokens = ['sandbox-token'];
    const results = [];
    for (let index = 0; index < 21; index += 1) {
      results.push(await createNotificationIntent(buildSkillNotificationFixtureIntent('cooking', 56, {
        dedupeKey: `cooking-rate-${index}`,
      })));
    }

    expect(results.filter((result) => result.decisionLog.decision === 'sent_push')).toHaveLength(20);
    expect(results.at(-1)?.decisionLog.decision).toBe('in_app_only');
    expect(results.at(-1)?.decisionLog.reason).toContain('rate limit');
    expect(listNotificationCenterItems(56, 56)).toHaveLength(21);
  });

  it('allows configured time-sensitive deadlines through quiet hours and downgrades critical by default', async () => {
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
});
