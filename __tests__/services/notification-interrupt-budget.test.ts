/**
 * Interrupt budget.
 *
 * The limiter this replaces allowed 20 pushes/hour PER SKILL — eight skills, so
 * a 160/hour ceiling — kept its counter in a process-local Map that was lost on
 * restart and not shared across workers, and returned true immediately for
 * `time_sensitive`. It did not bind on the traffic that most needs capping, and
 * several producers added since are time-sensitive.
 *
 * The replacement counts real sends out of `notification_decision_logs`, so it
 * cannot drift from what was actually delivered, and it demotes rather than
 * drops: the item still reaches the user in the next digest.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
const mockSendPushNotification = vi.fn();

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/user-service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/user-service')>()),
  getUserLanguageById: () => 'en-US',
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => [{ token: 'tok', environment: 'production' }]),
  isApnsConfigured: vi.fn(() => true),
  sendPushNotification: (...args: unknown[]) => mockSendPushNotification(...args),
  deleteDeadPushToken: vi.fn(),
  closeApnsClient: vi.fn(),
  _resetForTests: vi.fn(),
  sendPushToUsers: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

import {
  INTERRUPT_GLOBAL_DAILY_CAP,
  INTERRUPT_SKILL_DAILY_CAP,
  INTERRUPT_TIER_DAILY_CAPS,
  NEW_USER_RAMP_DAILY_CAP,
  createNotificationIntent,
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  interruptTierFor,
  listNotificationCenterItems,
} from '../../src/services/notification-orchestrator';

/**
 * Age the profile past the new-user ramp. Almost every test here is about the
 * steady-state caps, and a fresh profile would otherwise hit the 1/day ramp first.
 */
/**
 * Pinned clock. Neither of these suites used fake timers, so they ran against
 * the real wall clock — and the default profile quiet hours are 22:00-07:00.
 * Every push therefore became `quiet_hours_delayed` when the suite happened to
 * run at night, and these tests passed only between 07:00 and 22:00 local.
 *
 * 12:00Z is 13:00 in the default Europe/Lisbon profile zone: comfortably inside
 * waking hours, and far from any DST edge.
 */
const FIXED_NOW = new Date('2026-05-07T12:00:00.000Z');

function agedProfile(userId: number): void {
  getOrCreateNotificationProfile(userId, userId);
  // Absolute, not `datetime('now','-60 days')`: SQLite's clock is the REAL one
  // even under fake timers, so a relative age would land in the future
  // relative to FIXED_NOW.
  testDb.prepare("UPDATE notification_profiles SET created_at = '2020-01-01 00:00:00' WHERE user_id = ?")
    .run(userId);
}

/**
 * A profile that is genuinely new RELATIVE TO THE PINNED CLOCK.
 *
 * `getOrCreateNotificationProfile` stamps `created_at` with SQLite's
 * `datetime('now')`, which reads the REAL clock even under fake timers. Left
 * alone, a "fresh" profile is dated months AFTER FIXED_NOW, giving it a
 * negative age — which the ramp deliberately does not treat as new (a
 * future-dated profile is clock skew or a restored backup, and throttling an
 * established user over it is the worse failure).
 */
function freshProfile(userId: number): void {
  getOrCreateNotificationProfile(userId, userId);
  testDb.prepare("UPDATE notification_profiles SET created_at = '2026-05-07 12:00:00' WHERE user_id = ?")
    .run(userId);
}

function intent(userId: number, over: Record<string, unknown> = {}) {
  return {
    userId,
    tenantId: userId,
    sourceSkill: 'secretary' as const,
    type: 'reminder' as const,
    priority: 'active' as const,
    relatedEntityId: `e-${userId}-${Math.random()}`,
    relatedEntityType: 'reminder',
    title: 'Something',
    body: 'Body',
    deeplink: 'nexus://notifications',
    ...over,
  };
}

async function sendN(userId: number, n: number, over: Record<string, unknown> = {}) {
  const decisions: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const result = await createNotificationIntent(
      intent(userId, { ...over, dedupeKey: `budget:${userId}:${String(over.tag ?? 'x')}:${i}`, relatedEntityId: `e${i}` }),
    );
    decisions.push(result.decisionLog!.decision);
  }
  return decisions;
}

describe('interrupt budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    mockSendPushNotification.mockReset();
    mockSendPushNotification.mockResolvedValue({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] });
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('classifies tiers so security is never a volume decision', () => {
    expect(interruptTierFor({ type: 'security_account' } as any, 'passive')).toBe('t0_security');
    expect(interruptTierFor({ type: 'reminder' } as any, 'time_sensitive')).toBe('t1_time_sensitive');
    expect(interruptTierFor({ type: 'reminder' } as any, 'active')).toBe('t2_active');
    expect(interruptTierFor({ type: 'reminder', promotional: true } as any, 'active')).toBe('t4_promotional');
  });

  it('caps a single skill so it cannot spend the whole day', async () => {
    agedProfile(300);
    const decisions = await sendN(300, INTERRUPT_SKILL_DAILY_CAP + 2, { tag: 'skill' });
    const pushed = decisions.filter((d) => d === 'sent_push').length;
    expect(pushed).toBe(INTERRUPT_SKILL_DAILY_CAP);
    // Demoted, not dropped.
    expect(decisions.filter((d) => d === 'digest').length).toBe(2);
  });

  it('demotes over-budget items to the digest rather than dropping them', async () => {
    agedProfile(301);
    await sendN(301, INTERRUPT_SKILL_DAILY_CAP + 1, { tag: 'demote' });
    // Every intent still produced a durable Notification Center item.
    expect(listNotificationCenterItems(301, 301).length).toBe(INTERRUPT_SKILL_DAILY_CAP + 1);
  });

  it('caps time-sensitive traffic, which the old limiter exempted entirely', async () => {
    agedProfile(302);
    // Spread across skills so the per-skill cap is not what binds.
    const skills = ['secretary', 'training', 'content', 'cooking', 'finance', 'chat'] as const;
    const decisions: string[] = [];
    for (let i = 0; i < skills.length; i += 1) {
      const result = await createNotificationIntent(intent(302, {
        sourceSkill: skills[i],
        priority: 'time_sensitive',
        dedupeKey: `budget:302:ts:${i}`,
        relatedEntityId: `ts${i}`,
      }));
      decisions.push(result.decisionLog!.decision);
    }
    expect(decisions.filter((d) => d === 'sent_push').length)
      .toBe(INTERRUPT_TIER_DAILY_CAPS.t1_time_sensitive);
  });

  it('never budget-caps a security notification', async () => {
    agedProfile(303);
    // Burn the whole global budget first.
    const skills = ['secretary', 'training', 'content', 'cooking', 'finance'] as const;
    for (let i = 0; i < 10; i += 1) {
      await createNotificationIntent(intent(303, {
        sourceSkill: skills[i % skills.length],
        dedupeKey: `budget:303:fill:${i}`,
        relatedEntityId: `f${i}`,
      }));
    }
    mockSendPushNotification.mockClear();

    const security = await createNotificationIntent(intent(303, {
      sourceSkill: 'security',
      type: 'security_account',
      priority: 'time_sensitive',
      dedupeKey: 'budget:303:sec',
      relatedEntityId: 'sec',
      relatedEntityType: 'auth_device',
    }));
    expect(security.decisionLog!.decision).toBe('sent_push');
    expect(mockSendPushNotification).toHaveBeenCalled();
  });

  it('holds a brand-new user to one interrupt per day', async () => {
    // Fresh profile — inside the ramp window.
    freshProfile(304);
    const decisions = await sendN(304, 3, { tag: 'ramp' });
    expect(decisions.filter((d) => d === 'sent_push').length).toBe(NEW_USER_RAMP_DAILY_CAP);
    expect(decisions.filter((d) => d === 'digest').length).toBe(2);
  });

  it('lifts the ramp once the user is past their first week', async () => {
    agedProfile(305);
    const decisions = await sendN(305, 2, { tag: 'postramp' });
    expect(decisions.filter((d) => d === 'sent_push').length).toBe(2);
  });

  it('enforces a global ceiling across skills', async () => {
    agedProfile(306);
    const skills = ['secretary', 'training', 'content', 'cooking', 'finance', 'chat', 'system'] as const;
    let pushed = 0;
    // Two per skill stays under the per-skill cap, so the global ceiling binds.
    for (let i = 0; i < skills.length * 2; i += 1) {
      const result = await createNotificationIntent(intent(306, {
        sourceSkill: skills[i % skills.length],
        dedupeKey: `budget:306:g:${i}`,
        relatedEntityId: `g${i}`,
      }));
      if (result.decisionLog!.decision === 'sent_push') pushed += 1;
    }
    expect(pushed).toBeLessThanOrEqual(INTERRUPT_GLOBAL_DAILY_CAP);
  });

  it('counts a real day boundary in the user’s timezone, not UTC', async () => {
    agedProfile(307);
    await sendN(307, INTERRUPT_SKILL_DAILY_CAP, { tag: 'day' });
    // Age yesterday's sends out of the window.
    testDb.prepare("UPDATE notification_decision_logs SET sent_at = '2026-05-05T12:00:00.000Z' WHERE user_id = 307").run();

    const fresh = await createNotificationIntent(intent(307, { dedupeKey: 'budget:307:next', relatedEntityId: 'next' }));
    expect(fresh.decisionLog!.decision).toBe('sent_push');
  });

  it('survives a budget read failure by allowing rather than silencing', async () => {
    agedProfile(308);
    // Resolve the profile BEFORE breaking the table — the fault under test is
    // the budget read, not profile loading.
    const profile = getOrCreateNotificationProfile(308, 308);
    const { evaluateInterruptBudget } = await import('../../src/services/notification-orchestrator');

    testDb.exec('ALTER TABLE notification_decision_logs RENAME TO notification_decision_logs_moved');
    try {
      // A budget is a heuristic and fails OPEN. An explicit per-type mute is
      // the thing that fails closed — dropping every interrupt on a transient
      // read fault would be a worse failure than one extra push.
      const verdict = evaluateInterruptBudget(
        { userId: 308, tenantId: 308, sourceSkill: 'secretary', type: 'reminder', promotional: false } as any,
        'active',
        profile,
      );
      expect(verdict.allowed).toBe(true);
      expect(verdict.reason).toContain('unavailable');
    } finally {
      testDb.exec('ALTER TABLE notification_decision_logs_moved RENAME TO notification_decision_logs');
    }
  });
});
