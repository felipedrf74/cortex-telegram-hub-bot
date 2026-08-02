/**
 * Travel window — the first cross-skill notification producer.
 *
 * `cross_skill_impact` has been a complete contract since the notification
 * layer shipped, resolving to the `coordinated_plan` iOS destination, and
 * nothing ever produced one. Every recipe targeted its own skill, so the
 * product could not say "this one thing moves several parts of your week".
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
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
  sendPushNotification: vi.fn(async () => ({ sent: 1, failed: 0, skipped: 0, retriable: 0, unregistered: [] })),
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
  ensureNotificationTables,
  getOrCreateNotificationProfile,
  listNotificationCenterItems,
} from '../../src/services/notification-orchestrator';
import { resolveNotificationContract } from '../../src/services/notification-contracts';
import { runTravelWindowNotices } from '../../src/services/travel-window-notifier';

const NOW = new Date('2026-05-07T09:00:00.000Z');

function createTables(): void {
  testDb.exec(`
    CREATE TABLE IF NOT EXISTS travel_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      time_zone_shift_hours INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS secretary_agenda_items (
      agenda_item_id TEXT PRIMARY KEY,
      source_skill TEXT NOT NULL,
      owner_user_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL,
      lifecycle_state TEXT NOT NULL,
      title TEXT NOT NULL,
      start_at TEXT
    );
  `);
}

function addTrip(o: { userId: number; start: string; end: string; shift?: number }): void {
  testDb.prepare(`
    INSERT INTO travel_windows (user_id, tenant_id, start_date, end_date, time_zone_shift_hours)
    VALUES (?, ?, ?, ?, ?)
  `).run(o.userId, o.userId, o.start, o.end, o.shift ?? null);
}

function addCommitment(o: { id: string; userId: number; skill: string; startAt: string; state?: string }): void {
  testDb.prepare(`
    INSERT INTO secretary_agenda_items
      (agenda_item_id, source_skill, owner_user_id, tenant_id, lifecycle_state, title, start_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(o.id, o.skill, o.userId, String(o.userId), o.state ?? 'scheduled', 'Private title', o.startAt);
}

describe('travel window notices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    testDb = new Database(':memory:');
    ensureNotificationTables();
    createTables();
    process.env.NOTIFICATION_DELIVERY_MODE = 'apns';
  });
  afterEach(() => {
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    vi.useRealTimers();
    testDb?.close();
  });

  it('resolves to the coordinated_plan destination — the cross-skill contract', () => {
    // This is the contract that existed with no producer. Pinning it here
    // because the producer is worthless if the routing silently regresses.
    //
    // The type must be the one the producer actually emits. This asserted
    // `decision_required` while `runTravelWindowNotices` emits
    // `schedule_changed`, so it passed without covering the real path.
    const contract = resolveNotificationContract({
      sourceSkill: 'secretary',
      type: 'schedule_changed',
      entityType: 'cross_skill_impact',
      entityId: '1',
    });
    expect(contract.iosDestination).toBe('coordinated_plan');
  });

  it('names every skill the trip collides with', async () => {
    getOrCreateNotificationProfile(400, 400);
    addTrip({ userId: 400, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'a1', userId: 400, skill: 'training', startAt: '2026-05-10T07:00:00.000Z' });
    addCommitment({ id: 'a2', userId: 400, skill: 'training', startAt: '2026-05-11T07:00:00.000Z' });
    addCommitment({ id: 'a3', userId: 400, skill: 'secretary', startAt: '2026-05-10T14:00:00.000Z' });

    expect((await runTravelWindowNotices([400], NOW)).notified).toBe(1);

    const item = listNotificationCenterItems(400, 400)[0];
    expect(item.body).toContain('2 training sessions');
    expect(item.body).toContain('1 commitment');
  });

  it('stays silent for a trip that collides with nothing', async () => {
    getOrCreateNotificationProfile(401, 401);
    addTrip({ userId: 401, start: '2026-05-09', end: '2026-05-12' });
    // A trip with no commitments is not a decision.
    expect((await runTravelWindowNotices([401], NOW)).notified).toBe(0);
  });

  it('mentions a timezone shift only when there is one', async () => {
    getOrCreateNotificationProfile(402, 402);
    addTrip({ userId: 402, start: '2026-05-09', end: '2026-05-12', shift: -5 });
    addCommitment({ id: 'b1', userId: 402, skill: 'secretary', startAt: '2026-05-10T14:00:00.000Z' });
    await runTravelWindowNotices([402], NOW);
    expect(listNotificationCenterItems(402, 402)[0].body).toContain('-5h');

    getOrCreateNotificationProfile(403, 403);
    addTrip({ userId: 403, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'b2', userId: 403, skill: 'secretary', startAt: '2026-05-10T14:00:00.000Z' });
    await runTravelWindowNotices([403], NOW);
    expect(listNotificationCenterItems(403, 403)[0].body).not.toContain('h.');
  });

  it('keeps commitment titles off the lock screen', async () => {
    getOrCreateNotificationProfile(404, 404);
    addTrip({ userId: 404, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'c1', userId: 404, skill: 'secretary', startAt: '2026-05-10T14:00:00.000Z' });
    await runTravelWindowNotices([404], NOW);

    const item = listNotificationCenterItems(404, 404)[0];
    // Counts, never the underlying titles.
    expect(item.safeBody).not.toContain('Private title');
    expect(item.body).not.toContain('Private title');
  });

  it('only announces trips inside the lead window', async () => {
    getOrCreateNotificationProfile(405, 405);
    // Too far out.
    addTrip({ userId: 405, start: '2026-06-01', end: '2026-06-05' });
    addCommitment({ id: 'd1', userId: 405, skill: 'training', startAt: '2026-06-02T07:00:00.000Z' });
    expect((await runTravelWindowNotices([405], NOW)).notified).toBe(0);

    // Already started — nothing left to coordinate.
    addTrip({ userId: 405, start: '2026-05-06', end: '2026-05-08' });
    addCommitment({ id: 'd2', userId: 405, skill: 'training', startAt: '2026-05-07T07:00:00.000Z' });
    expect((await runTravelWindowNotices([405], NOW)).notified).toBe(0);
  });

  it('ignores cancelled commitments when counting impact', async () => {
    getOrCreateNotificationProfile(406, 406);
    addTrip({ userId: 406, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'e1', userId: 406, skill: 'training', startAt: '2026-05-10T07:00:00.000Z', state: 'canceled' });
    expect((await runTravelWindowNotices([406], NOW)).notified).toBe(0);
  });

  it('announces a trip once, not on every daily sweep', async () => {
    getOrCreateNotificationProfile(407, 407);
    addTrip({ userId: 407, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'f1', userId: 407, skill: 'training', startAt: '2026-05-10T07:00:00.000Z' });

    expect((await runTravelWindowNotices([407], NOW)).notified).toBe(1);
    expect((await runTravelWindowNotices([407], NOW)).notified).toBe(0);
  });

  it('skips users who have never opened notification settings', async () => {
    addTrip({ userId: 408, start: '2026-05-09', end: '2026-05-12' });
    addCommitment({ id: 'g1', userId: 408, skill: 'training', startAt: '2026-05-10T07:00:00.000Z' });
    expect((await runTravelWindowNotices([408], NOW)).notified).toBe(0);
  });

  it('survives the travel_windows table being absent', async () => {
    getOrCreateNotificationProfile(409, 409);
    testDb.exec('DROP TABLE travel_windows');
    const summary = await runTravelWindowNotices([409], NOW);
    expect(summary.failed).toBe(1);
    expect(summary.notified).toBe(0);
  });
});
