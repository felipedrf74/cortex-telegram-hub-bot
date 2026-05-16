// Phase 9 batch 45 (2026-05-16): low-and-slow + targeted-tenant attack
// pattern tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  discoverLowAndSlowAttacks,
  discoverTargetedTenantRepeats,
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

describe('discoverLowAndSlowAttacks (Phase 9 batch 45)', () => {
  it('detects a distributed campaign with low per-tenant volume over a long window', () => {
    // 5 tenants × 2 rows each = 10 rows over 14 days. Mean=2/tenant (low),
    // window=14d (extended), tenantCount=5 (≥3). Classic low-and-slow.
    const tenants = [1, 2, 3, 4, 5];
    const days = ['2026-05-01', '2026-05-15'];
    for (const tenant of tenants) {
      for (const day of days) {
        insertRow({ tenantId: tenant, createdAt: `${day}T12:00:00Z` });
      }
    }
    const patterns = discoverLowAndSlowAttacks(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tenantCount).toBe(5);
    expect(patterns[0].meanRowsPerTenant).toBe(2);
    expect(patterns[0].windowDays).toBeGreaterThanOrEqual(7);
  });

  it('skips short-window patterns (window < 7 days)', () => {
    for (let tenant = 1; tenant <= 4; tenant++) {
      insertRow({ tenantId: tenant, createdAt: '2026-05-15T12:00:00Z' });
      insertRow({ tenantId: tenant, createdAt: '2026-05-15T13:00:00Z' });
    }
    const patterns = discoverLowAndSlowAttacks(db);
    expect(patterns).toHaveLength(0);
  });

  it('skips high-volume patterns (mean rows per tenant exceeds threshold)', () => {
    // 4 tenants × 10 rows each over 14 days = high-volume distributed,
    // not low-and-slow.
    for (let tenant = 1; tenant <= 4; tenant++) {
      for (let i = 0; i < 10; i++) {
        const day = i % 2 === 0 ? '2026-05-01' : '2026-05-15';
        insertRow({ tenantId: tenant, createdAt: `${day}T${10 + i}:00:00Z` });
      }
    }
    const patterns = discoverLowAndSlowAttacks(db, { maxMeanRowsPerTenant: 3 });
    expect(patterns).toHaveLength(0);
  });

  it('respects custom minTenantCount filter', () => {
    for (let tenant = 1; tenant <= 4; tenant++) {
      insertRow({ tenantId: tenant, createdAt: '2026-05-01T12:00:00Z' });
      insertRow({ tenantId: tenant, createdAt: '2026-05-15T12:00:00Z' });
    }
    const patterns = discoverLowAndSlowAttacks(db, { minTenantCount: 5 });
    expect(patterns).toHaveLength(0);
  });

  it('respects custom minWindowDays filter', () => {
    for (let tenant = 1; tenant <= 4; tenant++) {
      insertRow({ tenantId: tenant, createdAt: '2026-05-10T12:00:00Z' });
      insertRow({ tenantId: tenant, createdAt: '2026-05-15T12:00:00Z' });
    }
    const patterns = discoverLowAndSlowAttacks(db, { minWindowDays: 14 });
    expect(patterns).toHaveLength(0);
  });
});

describe('discoverTargetedTenantRepeats (Phase 9 batch 45)', () => {
  it('detects single-tenant repeated attacks across distinct conversations', () => {
    for (let i = 0; i < 5; i++) {
      insertRow({
        tenantId: 1,
        conversationId: `conv-${i}`,
        createdAt: '2026-05-15T12:00:00Z',
      });
    }
    const patterns = discoverTargetedTenantRepeats(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].tenantId).toBe('1');
    expect(patterns[0].conversationCount).toBe(5);
  });

  it('skips when conversations are below minConversationCount', () => {
    for (let i = 0; i < 2; i++) {
      insertRow({
        tenantId: 1,
        conversationId: `conv-${i}`,
        createdAt: '2026-05-15T12:00:00Z',
      });
    }
    const patterns = discoverTargetedTenantRepeats(db);
    expect(patterns).toHaveLength(0);
  });

  it('skips when window exceeds maxWindowDays', () => {
    // 5 conversations spread over 14 days — too broad for targeted-repeat.
    for (let i = 0; i < 5; i++) {
      insertRow({
        tenantId: 1,
        conversationId: `conv-${i}`,
        createdAt: i < 3 ? '2026-05-01T12:00:00Z' : '2026-05-15T12:00:00Z',
      });
    }
    const patterns = discoverTargetedTenantRepeats(db, { maxWindowDays: 7 });
    expect(patterns).toHaveLength(0);
  });

  it('sorts by conversation count descending', () => {
    for (let i = 0; i < 10; i++) {
      insertRow({ tenantId: 1, conversationId: `t1-conv-${i}`, createdAt: '2026-05-15T12:00:00Z' });
    }
    for (let i = 0; i < 5; i++) {
      insertRow({ tenantId: 2, conversationId: `t2-conv-${i}`, createdAt: '2026-05-15T12:00:00Z' });
    }
    const patterns = discoverTargetedTenantRepeats(db);
    expect(patterns).toHaveLength(2);
    expect(patterns[0].tenantId).toBe('1');
    expect(patterns[0].conversationCount).toBe(10);
    expect(patterns[1].tenantId).toBe('2');
  });

  it('returns empty when no refusal rows exist', () => {
    const patterns = discoverTargetedTenantRepeats(db);
    expect(patterns).toHaveLength(0);
  });
});
