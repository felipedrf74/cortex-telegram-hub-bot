// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

const testDb = new Database(':memory:');

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
}));

const logAuditMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/audit-trail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/audit-trail')>()),
  logAudit: logAuditMock,
}));

const recordOperatorAlertMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/operator-alerts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/operator-alerts')>()),
  recordOperatorAlert: recordOperatorAlertMock,
}));

import {
  HYBRID_KILL_SWITCH_KEYS,
  _resetHybridKillSwitchCacheForTests,
  isApplePackFulfillmentActive,
  isHybridKillSwitchEngaged,
  isStripePackFulfillmentActive,
  listHybridKillSwitches,
  setHybridKillSwitch,
} from '../../src/services/hybrid-runtime-kill-switches';
import { isAiCreditAdmissionEnabled } from '../../src/services/ai-credit-admission';

function recreateControlTables(): void {
  testDb.exec(`
    DROP TABLE IF EXISTS hybrid_commerce_control_events;
    DROP TABLE IF EXISTS hybrid_commerce_runtime_control;
    CREATE TABLE hybrid_commerce_runtime_control (
      control_key TEXT PRIMARY KEY CHECK (control_key IN (
        'hybrid_credits', 'apple_pack_fulfillment', 'stripe_pack_fulfillment', 'cloud_reasoning_fallback'
      )),
      engaged INTEGER NOT NULL DEFAULT 0 CHECK (engaged IN (0, 1)),
      reason TEXT NOT NULL DEFAULT 'migration_default_disengaged',
      actor_user_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO hybrid_commerce_runtime_control (control_key, engaged) VALUES
      ('hybrid_credits', 0), ('apple_pack_fulfillment', 0),
      ('stripe_pack_fulfillment', 0), ('cloud_reasoning_fallback', 0);
    CREATE TABLE hybrid_commerce_control_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      control_key TEXT NOT NULL,
      previous_engaged INTEGER NOT NULL,
      engaged INTEGER NOT NULL,
      actor_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
}

beforeEach(() => {
  recreateControlTables();
  _resetHybridKillSwitchCacheForTests();
  logAuditMock.mockClear();
  recordOperatorAlertMock.mockClear();
  delete process.env.HYBRID_AI_CREDITS_ENABLED;
  delete process.env.HYBRID_AI_CREDITS_KILL_SWITCH;
  delete process.env.APPLE_PACK_FULFILLMENT_ENABLED;
  delete process.env.STRIPE_PACK_FULFILLMENT_ENABLED;
});

describe('hybrid-runtime-kill-switches', () => {
  it('starts with all four switches disengaged', () => {
    const states = listHybridKillSwitches();
    expect(states.map((s) => s.controlKey).sort()).toEqual([...HYBRID_KILL_SWITCH_KEYS].sort());
    expect(states.every((s) => !s.engaged)).toBe(true);
    for (const key of HYBRID_KILL_SWITCH_KEYS) {
      expect(isHybridKillSwitchEngaged(key)).toBe(false);
    }
  });

  it('engages a switch with an event row and audit attribution', () => {
    const result = setHybridKillSwitch({
      controlKey: 'hybrid_credits',
      engaged: true,
      actorUserId: 7,
      reason: 'incident: duplicate captures suspected',
    });
    expect(result.kind).toBe('updated');
    expect(isHybridKillSwitchEngaged('hybrid_credits')).toBe(true);

    const events = testDb.prepare('SELECT * FROM hybrid_commerce_control_events').all() as any[];
    expect(events).toHaveLength(1);
    expect(events[0].control_key).toBe('hybrid_credits');
    expect(events[0].previous_engaged).toBe(0);
    expect(events[0].engaged).toBe(1);
    expect(events[0].actor_user_id).toBe(7);

    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin_mutation',
      resource: 'hybrid_kill_switch:hybrid_credits',
      actorId: 7,
    }));
  });

  it('is idempotent: re-engaging an engaged switch writes no second event', () => {
    setHybridKillSwitch({ controlKey: 'apple_pack_fulfillment', engaged: true, actorUserId: 7, reason: 'stop' });
    const second = setHybridKillSwitch({ controlKey: 'apple_pack_fulfillment', engaged: true, actorUserId: 7, reason: 'stop again' });
    expect(second.kind).toBe('unchanged');
    const events = testDb.prepare('SELECT COUNT(*) AS n FROM hybrid_commerce_control_events').get() as { n: number };
    expect(events.n).toBe(1);
  });

  it('rejects a flip without an authenticated actor or reason', () => {
    expect(setHybridKillSwitch({ controlKey: 'hybrid_credits', engaged: true, actorUserId: 0, reason: 'x' }).kind).toBe('rejected');
    expect(setHybridKillSwitch({ controlKey: 'hybrid_credits', engaged: true, actorUserId: 7, reason: '   ' }).kind).toBe('rejected');
    expect(isHybridKillSwitchEngaged('hybrid_credits')).toBe(false);
  });

  it('kills credit admission even while the env enable flag is on', () => {
    process.env.HYBRID_AI_CREDITS_ENABLED = 'true';
    expect(isAiCreditAdmissionEnabled()).toBe(true);
    setHybridKillSwitch({ controlKey: 'hybrid_credits', engaged: true, actorUserId: 7, reason: 'incident stop' });
    expect(isAiCreditAdmissionEnabled()).toBe(false);
    setHybridKillSwitch({ controlKey: 'hybrid_credits', engaged: false, actorUserId: 7, reason: 'incident resolved' });
    expect(isAiCreditAdmissionEnabled()).toBe(true);
  });

  it('gates apple and stripe pack fulfillment through the DB switch', () => {
    process.env.APPLE_PACK_FULFILLMENT_ENABLED = 'true';
    process.env.STRIPE_PACK_FULFILLMENT_ENABLED = 'true';
    expect(isApplePackFulfillmentActive()).toBe(true);
    expect(isStripePackFulfillmentActive()).toBe(true);
    setHybridKillSwitch({ controlKey: 'apple_pack_fulfillment', engaged: true, actorUserId: 7, reason: 'stop apple' });
    setHybridKillSwitch({ controlKey: 'stripe_pack_fulfillment', engaged: true, actorUserId: 7, reason: 'stop stripe' });
    expect(isApplePackFulfillmentActive()).toBe(false);
    expect(isStripePackFulfillmentActive()).toBe(false);
  });

  it('fails open to env-only behavior when the control table is unreadable', () => {
    testDb.exec('DROP TABLE hybrid_commerce_control_events; DROP TABLE hybrid_commerce_runtime_control;');
    _resetHybridKillSwitchCacheForTests();
    expect(isHybridKillSwitchEngaged('hybrid_credits')).toBe(false);
    // QA4 P2-6: fail-open is deliberate but never silent — every failed
    // control read raises a critical operator alert.
    expect(recordOperatorAlertMock).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'critical',
      dedupeKey: 'hybrid_kill_switch_control_read_failed',
    }));
    process.env.HYBRID_AI_CREDITS_ENABLED = 'true';
    expect(isAiCreditAdmissionEnabled()).toBe(true);
    // The env kill switch stays authoritative while the DB surface is down.
    process.env.HYBRID_AI_CREDITS_KILL_SWITCH = 'true';
    expect(isAiCreditAdmissionEnabled()).toBe(false);
  });

  it('caches reads briefly and invalidates on a flip', () => {
    expect(isHybridKillSwitchEngaged('cloud_reasoning_fallback')).toBe(false);
    // A raw DB write (bypassing the service) stays invisible inside the TTL…
    testDb.prepare("UPDATE hybrid_commerce_runtime_control SET engaged = 1 WHERE control_key = 'cloud_reasoning_fallback'").run();
    expect(isHybridKillSwitchEngaged('cloud_reasoning_fallback')).toBe(false);
    // …but a service flip invalidates immediately.
    _resetHybridKillSwitchCacheForTests();
    expect(isHybridKillSwitchEngaged('cloud_reasoning_fallback')).toBe(true);
  });
});
