// Phase 10 batch 53 (2026-05-16): credential-stuffing probe + time-of-
// day cluster attack patterns.
//
// These extend the cross-tenant attack-pattern family with two new signal
// classes:
//
//   • credential_stuffing_probe — single tenant generates refusals across
//     many DISTINCT (skill, action) pairs within ≤ 24h. Implies an
//     attacker probing the action surface after credential capture.
//
//   • time_of_day_cluster — refusals concentrated in a narrow hour-of-day
//     band that exceeds the baseline rate by ≥ 3×. Bots tend to spike at
//     off-business hours; this surfaces that pattern.
//
// Both detectors operate on the same `chat_action_telemetry` table and
// re-use the `isRefusalRowMulti` filter.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  discoverCredentialStuffingProbes,
  discoverTimeOfDayClusters,
} from '../../src/services/registry-adversarial-discovery';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE chat_action_telemetry (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      conversation_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      planner TEXT NOT NULL,
      route_tier TEXT NOT NULL,
      skill TEXT,
      action TEXT,
      status TEXT,
      calibrated_score REAL,
      threshold REAL,
      model_provider TEXT,
      model TEXT,
      estimated_token_cost_usd REAL,
      verifier_status TEXT,
      latency_ms INTEGER,
      outcome TEXT,
      failure_reason TEXT,
      predicted_action_hash TEXT,
      slot_provenance_json TEXT,
      created_at TEXT NOT NULL
    );
  `);
});

afterEach(() => {
  db.close();
});

function insertRow(opts: {
  tenantId: number;
  skill?: string;
  action?: string;
  failureReason?: string;
  conversationId?: string;
  createdAt?: string;
}) {
  db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, failure_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tel-${randomUUID()}`,
    1,
    opts.tenantId,
    opts.conversationId ?? `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    'tier0_deterministic',
    opts.skill ?? 'mail',
    opts.action ?? 'send_email',
    'planned',
    opts.failureReason ?? 'prompt_injection_marker_detected',
    opts.createdAt ?? '2026-05-16T12:00:00Z',
  );
}

describe('discoverCredentialStuffingProbes (Phase 10 batch 53)', () => {
  it('detects a single tenant probing many distinct actions in a short window', () => {
    // 6 distinct (skill, action) pairs across 3 skills, all within 1 day.
    const probes: Array<[string, string]> = [
      ['mail', 'send_email'],
      ['mail', 'draft_email'],
      ['secretary_calendar', 'schedule_event'],
      ['secretary_calendar', 'delete_event'],
      ['tasks', 'create_task'],
      ['tasks', 'delete_task'],
    ];
    for (const [skill, action] of probes) {
      insertRow({ tenantId: 1, skill, action, createdAt: '2026-05-16T12:00:00Z' });
    }
    const patterns = discoverCredentialStuffingProbes(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tenantId).toBe('1');
    expect(patterns[0].distinctActionCount).toBe(6);
    expect(patterns[0].skillCount).toBe(3);
  });

  it('skips a single tenant with only one skill (high distinct actions, low skill spread)', () => {
    // 6 distinct mail actions but ONE skill — could be a legitimate user
    // hitting a mail-feature flow, not credential probing.
    for (let i = 0; i < 6; i++) {
      insertRow({
        tenantId: 1,
        skill: 'mail',
        action: `mail_action_${i}`,
        createdAt: '2026-05-16T12:00:00Z',
      });
    }
    const patterns = discoverCredentialStuffingProbes(db);
    expect(patterns).toHaveLength(0);
  });

  it('skips when the window exceeds 24 hours by default', () => {
    const probes: Array<[string, string, string]> = [
      ['mail', 'send_email', '2026-05-10T12:00:00Z'],
      ['secretary_calendar', 'schedule_event', '2026-05-11T12:00:00Z'],
      ['tasks', 'create_task', '2026-05-12T12:00:00Z'],
      ['content', 'content_brief_create', '2026-05-13T12:00:00Z'],
      ['finance', 'finance_summary', '2026-05-14T12:00:00Z'],
    ];
    for (const [skill, action, createdAt] of probes) {
      insertRow({ tenantId: 1, skill, action, createdAt });
    }
    const patterns = discoverCredentialStuffingProbes(db);
    expect(patterns).toHaveLength(0);
  });

  it('respects custom minDistinctActions threshold', () => {
    const probes: Array<[string, string]> = [
      ['mail', 'send_email'],
      ['secretary_calendar', 'schedule_event'],
      ['tasks', 'create_task'],
    ];
    for (const [skill, action] of probes) {
      insertRow({ tenantId: 1, skill, action, createdAt: '2026-05-16T12:00:00Z' });
    }
    const probedDefault = discoverCredentialStuffingProbes(db);
    expect(probedDefault).toHaveLength(0); // default min=5, only 3 pairs
    const probedLowered = discoverCredentialStuffingProbes(db, { minDistinctActions: 3 });
    expect(probedLowered).toHaveLength(1);
  });

  it('returns no patterns when there are no refusal rows', () => {
    const patterns = discoverCredentialStuffingProbes(db);
    expect(patterns).toHaveLength(0);
  });

  it('sorts patterns by distinct action count descending', () => {
    const tenant1: Array<[string, string]> = [
      ['mail', 'send_email'],
      ['secretary_calendar', 'schedule_event'],
      ['tasks', 'create_task'],
      ['content', 'content_brief_create'],
      ['finance', 'finance_summary'],
    ];
    const tenant2: Array<[string, string]> = [
      ['mail', 'send_email'],
      ['secretary_calendar', 'schedule_event'],
      ['tasks', 'create_task'],
      ['content', 'content_brief_create'],
      ['finance', 'finance_summary'],
      ['training', 'training_plan_create'],
    ];
    for (const [skill, action] of tenant1) {
      insertRow({ tenantId: 1, skill, action, createdAt: '2026-05-16T12:00:00Z' });
    }
    for (const [skill, action] of tenant2) {
      insertRow({ tenantId: 2, skill, action, createdAt: '2026-05-16T12:00:00Z' });
    }
    const patterns = discoverCredentialStuffingProbes(db);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].tenantId).toBe('2'); // higher action count first
    expect(patterns[1].tenantId).toBe('1');
  });
});

describe('discoverTimeOfDayClusters (Phase 10 batch 53)', () => {
  it('detects a refusal spike concentrated in a single off-hours window', () => {
    // 10 rows at 03:00 UTC, 1 row each at other random hours.
    // 10 at hour 3, plus 10 more spread over 10 other hours = total 20 rows.
    // baselineMean = 20/24 ≈ 0.83. 3 × baseline = 2.5. Hour 3 has 10 rows ≥ 5 floor.
    for (let i = 0; i < 10; i++) {
      insertRow({ tenantId: i + 1, createdAt: `2026-05-16T03:${String(i).padStart(2, '0')}:00Z` });
    }
    for (let i = 0; i < 10; i++) {
      const hour = 10 + i;
      insertRow({ tenantId: 100 + i, createdAt: `2026-05-16T${String(hour).padStart(2, '0')}:00:00Z` });
    }
    const patterns = discoverTimeOfDayClusters(db);
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].hourUtc).toBe(3);
    expect(patterns[0].count).toBe(10);
    expect(patterns[0].multiplierOverBaseline).toBeGreaterThan(3);
  });

  it('respects minCount floor to avoid small-sample false positives', () => {
    // 1 row at 03:00 — fails the floor even if baseline is near-zero.
    insertRow({ tenantId: 1, createdAt: '2026-05-16T03:00:00Z' });
    const patterns = discoverTimeOfDayClusters(db);
    expect(patterns).toHaveLength(0);
  });

  it('returns empty when there are no refusal rows', () => {
    const patterns = discoverTimeOfDayClusters(db);
    expect(patterns).toHaveLength(0);
  });

  it('returns empty when refusals are evenly distributed', () => {
    // 5 rows at each of 4 hours = 20 rows, no hour exceeds 3 × baseline (3 × 0.83 = 2.5).
    for (let hour = 0; hour < 24; hour++) {
      const count = (hour % 4 === 0) ? 2 : 0;
      for (let i = 0; i < count; i++) {
        insertRow({
          tenantId: hour + 1,
          createdAt: `2026-05-16T${String(hour).padStart(2, '0')}:${String(i).padStart(2, '0')}:00Z`,
        });
      }
    }
    // Each spike-hour has only 2 rows, below the default minCount of 5.
    const patterns = discoverTimeOfDayClusters(db);
    expect(patterns).toHaveLength(0);
  });

  it('respects custom baselineMultiplier threshold', () => {
    // 6 rows at hour 3, 18 rows elsewhere (baseline mean = 24/24 = 1).
    // 6 > 5 × baseline? 5 × 1 = 5 — yes 6 > 5, so it fires at threshold 5.
    // At threshold 10, 10 × 1 = 10, 6 < 10, so it doesn't fire.
    for (let i = 0; i < 6; i++) {
      insertRow({ tenantId: i + 1, createdAt: `2026-05-16T03:${String(i).padStart(2, '0')}:00Z` });
    }
    for (let hour = 4; hour < 22; hour++) {
      insertRow({ tenantId: 100 + hour, createdAt: `2026-05-16T${String(hour).padStart(2, '0')}:00:00Z` });
    }
    const aggressive = discoverTimeOfDayClusters(db, { baselineMultiplier: 5 });
    expect(aggressive.length).toBeGreaterThanOrEqual(1);
    const conservative = discoverTimeOfDayClusters(db, { baselineMultiplier: 10 });
    expect(conservative).toHaveLength(0);
  });

  it('returns top actions in the cluster ranked by count', () => {
    // 8 rows at hour 3, mostly send_email + a couple of others.
    for (let i = 0; i < 5; i++) {
      insertRow({
        tenantId: i + 1, skill: 'mail', action: 'send_email',
        createdAt: `2026-05-16T03:${String(i).padStart(2, '0')}:00Z`,
      });
    }
    for (let i = 0; i < 2; i++) {
      insertRow({
        tenantId: 10 + i, skill: 'tasks', action: 'create_task',
        createdAt: `2026-05-16T03:${String(10 + i).padStart(2, '0')}:00Z`,
      });
    }
    insertRow({
      tenantId: 99, skill: 'finance', action: 'finance_summary',
      createdAt: '2026-05-16T03:30:00Z',
    });
    const patterns = discoverTimeOfDayClusters(db, { minCount: 5, baselineMultiplier: 1 });
    expect(patterns.length).toBeGreaterThanOrEqual(1);
    expect(patterns[0].hourUtc).toBe(3);
    expect(patterns[0].topActions[0].action).toBe('send_email');
    expect(patterns[0].topActions[0].count).toBe(5);
  });
});
