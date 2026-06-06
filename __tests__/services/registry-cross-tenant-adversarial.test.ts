// Phase 6 batch 33 (2026-05-15): cross-tenant adversarial baseline tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  discoverCrossTenantAdversarialPatterns,
  formatCrossTenantAdversarialMarkdown,
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
  skill: string;
  action: string;
  failureReason: string;
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
    `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    'tier0_deterministic',
    opts.skill,
    opts.action,
    'planned',
    opts.failureReason,
    opts.createdAt ?? '2026-05-15T12:00:00Z',
  );
}

describe('cross-tenant adversarial baseline (Phase 6 batch 33)', () => {
  it('classifies a 5-tenant 24h pattern as critical', () => {
    for (let tenant = 1; tenant <= 5; tenant++) {
      insertRow({
        tenantId: tenant,
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        createdAt: '2026-05-15T12:00:00Z',
      });
    }
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].severity).toBe('critical');
    expect(patterns[0].tenantCount).toBe(5);
  });

  it('classifies a 3-tenant 7-day pattern as high', () => {
    insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected', createdAt: '2026-05-10T00:00:00Z' });
    insertRow({ tenantId: 2, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected', createdAt: '2026-05-12T00:00:00Z' });
    insertRow({ tenantId: 3, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected', createdAt: '2026-05-15T00:00:00Z' });
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].severity).toBe('high');
    expect(patterns[0].tenantCount).toBe(3);
  });

  it('classifies a 2-tenant pattern as medium', () => {
    insertRow({ tenantId: 1, skill: 'tasks', action: 'delete_task', failureReason: 'unsafe_title_destructive_vocabulary' });
    insertRow({ tenantId: 2, skill: 'tasks', action: 'delete_task', failureReason: 'unsafe_title_destructive_vocabulary' });
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    expect(patterns).toHaveLength(1);
    expect(patterns[0].severity).toBe('medium');
    expect(patterns[0].tenantCount).toBe(2);
  });

  it('skips single-tenant patterns (default minTenantCount: 2)', () => {
    for (let i = 0; i < 5; i++) {
      insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    }
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    expect(patterns).toHaveLength(0);
  });

  it('respects custom minTenantCount filter', () => {
    insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 2, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 3, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    const patterns = discoverCrossTenantAdversarialPatterns(db, { minTenantCount: 4 });
    expect(patterns).toHaveLength(0);
  });

  it('formatCrossTenantAdversarialMarkdown emits severity-sorted markdown', () => {
    insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 2, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 3, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 4, skill: 'tasks', action: 'delete_task', failureReason: 'unsafe_title_destructive_vocabulary' });
    insertRow({ tenantId: 5, skill: 'tasks', action: 'delete_task', failureReason: 'unsafe_title_destructive_vocabulary' });
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    const md = formatCrossTenantAdversarialMarkdown(patterns);
    expect(md).toMatch(/Cross-Tenant Adversarial Baseline/);
    expect(md).toMatch(/Severity breakdown/);
    expect(md).toMatch(/HIGH|MEDIUM/);
  });

  it('emits empty-state message when no patterns surface', () => {
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    const md = formatCrossTenantAdversarialMarkdown(patterns);
    expect(md).toMatch(/No cross-tenant adversarial patterns detected/);
  });

  it('per-tenant counts capture tenant-specific volume', () => {
    insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 1, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ tenantId: 2, skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    const patterns = discoverCrossTenantAdversarialPatterns(db);
    expect(patterns[0].perTenantCounts['1']).toBe(2);
    expect(patterns[0].perTenantCounts['2']).toBe(1);
    expect(patterns[0].totalCount).toBe(3);
  });
});
