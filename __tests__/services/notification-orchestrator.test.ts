import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

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
  createNotificationIntent,
  dismissNotificationCenterItem,
  ensureNotificationTables,
  getNotificationDecisionLog,
  getOrCreateNotificationProfile,
  listNotificationCenterItems,
  markNotificationCenterItemRead,
  performNotificationAction,
  registerNotificationDeviceToken,
  releaseDueNotificationDeliveries,
  revokeNotificationDeviceToken,
  updateNotificationProfile,
} from '../../src/services/notification-orchestrator';

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

  it('creates a concrete decision intent, center item, decision log, and mock delivery attempt', async () => {
    pushTokens = ['sandbox-token'];
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 1));

    expect(result.intent.sourceSkill).toBe('content');
    expect(result.item?.status).toBe('unread');
    expect(result.decisionLog.decision).toBe('sent_push');
    expect(result.deliveryAttempts[0].status).toBe('mock_sent');
    expect(result.pushPayload?.body).toBe('Content item is ready for review.');

    const items = listNotificationCenterItems(1, 1);
    expect(items).toHaveLength(1);
    expect(items[0].userId).toBe(1);
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

    const item = listNotificationCenterItems(32, 32)[0];
    expect(result.item?.safeBody).toBe('Schedule decision — open Nexus to review the recommendation.');
    expect(item.safeBody).not.toContain('John Doe');
    expect(item.sensitiveBody).toBe('Meeting with John Doe about Acme acquisition at 16:00.');
  });

  it('deduplicates unresolved conflicts by dedupe key', async () => {
    pushTokens = ['sandbox-token'];
    const first = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 4, {
      dedupeKey: 'secretary:conflict:repeat',
    }));
    const second = await createNotificationIntent(buildSkillNotificationFixtureIntent('secretary', 4, {
      dedupeKey: 'secretary:conflict:repeat',
    }));

    expect(first.item?.itemId).toBeDefined();
    expect(second.item?.itemId).toBe(first.item?.itemId);
    expect(second.decisionLog.decision).toBe('deduped');
    expect(listNotificationCenterItems(4, 4)).toHaveLength(1);
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

  it('sends decision pushes with collapse id and urgent/today badge count', async () => {
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
    apnsConfigured = true;
    pushTokens = ['sandbox-token'];
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });

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
      badge: 1,
      threadId: 'decision-center',
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

  it('scopes list, read, dismiss, and action operations by authenticated user and tenant', async () => {
    pushTokens = ['sandbox-token'];
    const result = await createNotificationIntent(buildSkillNotificationFixtureIntent('content', 8, {
      dedupeKey: 'content:scope',
    }));
    const itemId = result.item!.itemId;

    expect(listNotificationCenterItems(9, 9)).toHaveLength(0);
    expect(markNotificationCenterItemRead(itemId, 9, 9)).toBeNull();
    expect(dismissNotificationCenterItem(itemId, 9, 9)).toBeNull();
    expect(() => performNotificationAction(itemId, 'approve_script', 9, 9)).toThrow(/not found/);

    const read = markNotificationCenterItemRead(itemId, 8, 8);
    expect(read?.status).toBe('read');
    const action = performNotificationAction(itemId, 'approve_script', 8, 8);
    expect(action.item.status).toBe('actioned');
    const log = getNotificationDecisionLog(result.decisionLog.decisionLogId, 8, 8);
    expect(log?.actionTaken).toBe('approve_script');
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
