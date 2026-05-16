// Phase 5 batch 27 (2026-05-15): adversarial discovery script tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  discoverAdversarialCandidates,
  formatAdversarialDiscoveryMarkdown,
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
  skill?: string;
  action?: string;
  failureReason?: string;
  outcome?: string;
  conversationId?: string;
  tenantId?: number;
  createdAt?: string;
}) {
  db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, outcome, failure_reason, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tel-${randomUUID()}`,
    1,
    opts.tenantId ?? 1,
    opts.conversationId ?? `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    'tier0_deterministic',
    opts.skill ?? 'tasks',
    opts.action ?? 'create_task',
    'planned',
    opts.outcome ?? null,
    opts.failureReason ?? null,
    opts.createdAt ?? '2026-05-15T12:00:00Z',
  );
}

describe('adversarial discovery — discoverAdversarialCandidates', () => {
  it('surfaces clusters whose failure_reason matches a known refusal pattern', () => {
    for (let i = 0; i < 5; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const clusters = discoverAdversarialCandidates(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].skill).toBe('mail');
    expect(clusters[0].failureReason).toBe('prompt_injection_marker_detected');
    expect(clusters[0].count).toBe(5);
  });

  it('surfaces clusters whose outcome matches a refusal label', () => {
    for (let i = 0; i < 4; i++) {
      insertRow({
        skill: 'tasks',
        action: 'delete_task',
        outcome: 'refused',
      });
    }
    const clusters = discoverAdversarialCandidates(db);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].outcome).toBe('refused');
  });

  it('skips clusters below the minCount threshold', () => {
    insertRow({ skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    insertRow({ skill: 'mail', action: 'send_email', failureReason: 'prompt_injection_marker_detected' });
    const clusters = discoverAdversarialCandidates(db, { minCount: 3 });
    expect(clusters).toHaveLength(0);
  });

  it('counts distinct conversations per cluster', () => {
    for (let i = 0; i < 5; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        conversationId: `conv-shared-${i}`,
      });
    }
    insertRow({
      skill: 'mail',
      action: 'send_email',
      failureReason: 'prompt_injection_marker_detected',
      conversationId: 'conv-shared-0', // duplicate
    });
    const clusters = discoverAdversarialCandidates(db);
    expect(clusters[0].count).toBe(6);
    expect(clusters[0].conversationCount).toBe(5);
  });

  it('respects the since filter', () => {
    for (let i = 0; i < 4; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        createdAt: '2026-04-01T00:00:00Z',
      });
    }
    for (let i = 0; i < 4; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        createdAt: '2026-05-15T00:00:00Z',
      });
    }
    const clusters = discoverAdversarialCandidates(db, { since: '2026-05-01T00:00:00Z' });
    expect(clusters[0].count).toBe(4);
  });

  it('ignores rows without refusal markers or labels', () => {
    for (let i = 0; i < 5; i++) {
      insertRow({
        skill: 'tasks',
        action: 'create_task',
        outcome: 'verified_success',
      });
    }
    const clusters = discoverAdversarialCandidates(db);
    expect(clusters).toHaveLength(0);
  });
});

describe('adversarial discovery — formatAdversarialDiscoveryMarkdown', () => {
  it('emits totals and a per-cluster table', () => {
    for (let i = 0; i < 4; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const clusters = discoverAdversarialCandidates(db);
    const md = formatAdversarialDiscoveryMarkdown(clusters);
    expect(md).toMatch(/Adversarial Discovery Report/);
    expect(md).toMatch(/Clusters surfaced.*1/);
    expect(md).toMatch(/Total refusal rows.*4/);
    expect(md).toMatch(/mail.*send_email/);
  });

  it('classifies single-user repeat vs distributed', () => {
    // Single conversation repeat
    for (let i = 0; i < 4; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        conversationId: 'conv-single',
      });
    }
    const single = discoverAdversarialCandidates(db);
    const md = formatAdversarialDiscoveryMarkdown(single);
    expect(md).toMatch(/single_user_repeat/);
  });

  it('classifies distributed attacks (many distinct conversations)', () => {
    for (let i = 0; i < 6; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
        conversationId: `conv-dist-${i}`,
      });
    }
    const clusters = discoverAdversarialCandidates(db);
    const md = formatAdversarialDiscoveryMarkdown(clusters);
    expect(md).toMatch(/distributed_attack/);
  });

  it('emits an empty-state message when no clusters surface', () => {
    const clusters = discoverAdversarialCandidates(db);
    const md = formatAdversarialDiscoveryMarkdown(clusters);
    expect(md).toMatch(/No adversarial clusters above the threshold/);
  });
});
