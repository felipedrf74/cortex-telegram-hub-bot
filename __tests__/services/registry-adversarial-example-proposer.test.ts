// Phase 7 close-out (2026-05-15): adversarial example proposer tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  proposeAdversarialExamples,
  formatAdversarialExampleProposalsMarkdown,
} from '../../src/services/registry-adversarial-example-proposer';
import { getChatActionRegistry } from '../../src/services/chat/registry';

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
  skill: string;
  action: string;
  failureReason?: string;
  outcome?: string;
  conversationId?: string;
  createdAt?: string;
}) {
  db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, failure_reason, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tel-${randomUUID()}`,
    1, 1,
    opts.conversationId ?? `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    'tier0_deterministic',
    opts.skill,
    opts.action,
    'planned',
    opts.failureReason ?? null,
    opts.outcome ?? null,
    opts.createdAt ?? '2026-05-15T12:00:00Z',
  );
}

describe('adversarial example proposer (Phase 7 close-out)', () => {
  it('surfaces a proposal for an action without safety examples but with telemetry refusals', () => {
    // Find an action that doesn't currently have prompt_injection / adversarial.
    const registry = getChatActionRegistry();
    const target = registry.find((e) => {
      const examples = (e.examples ?? []) as Array<{ tags?: string[] }>;
      return !examples.some((ex) =>
        Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
      );
    });
    if (!target) return;
    for (let i = 0; i < 5; i++) {
      insertRow({
        skill: target.skill,
        action: target.action,
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const proposals = proposeAdversarialExamples(db);
    const proposal = proposals.find((p) => p.skill === target.skill && p.action === target.action);
    expect(proposal).toBeDefined();
    expect(proposal!.suggestedTag).toBe('prompt_injection');
    expect(proposal!.priority).toBeGreaterThan(0);
  });

  it('skips actions that already have a safety example', () => {
    // Use mail.send_email — it has a prompt_injection example.
    for (let i = 0; i < 8; i++) {
      insertRow({
        skill: 'mail',
        action: 'send_email',
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const proposals = proposeAdversarialExamples(db);
    const mailProposal = proposals.find((p) => p.skill === 'mail' && p.action === 'send_email');
    expect(mailProposal).toBeUndefined();
  });

  it('classifies non-injection failures as adversarial tag', () => {
    const registry = getChatActionRegistry();
    const target = registry.find((e) => {
      const examples = (e.examples ?? []) as Array<{ tags?: string[] }>;
      return !examples.some((ex) =>
        Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
      );
    });
    if (!target) return;
    for (let i = 0; i < 5; i++) {
      insertRow({
        skill: target.skill,
        action: target.action,
        outcome: 'refused',
      });
    }
    const proposals = proposeAdversarialExamples(db);
    const proposal = proposals.find((p) => p.skill === target.skill && p.action === target.action);
    expect(proposal).toBeDefined();
    expect(proposal!.suggestedTag).toBe('adversarial');
  });

  it('returns empty when no clusters exist', () => {
    const proposals = proposeAdversarialExamples(db);
    expect(proposals).toHaveLength(0);
  });

  it('respects maxProposals limit', () => {
    const registry = getChatActionRegistry();
    const uncovered = registry.filter((e) => {
      const examples = (e.examples ?? []) as Array<{ tags?: string[] }>;
      return !examples.some((ex) =>
        Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
      );
    }).slice(0, 5);
    for (const target of uncovered) {
      for (let i = 0; i < 5; i++) {
        insertRow({
          skill: target.skill,
          action: target.action,
          failureReason: 'prompt_injection_marker_detected',
        });
      }
    }
    const proposals = proposeAdversarialExamples(db, { maxProposals: 2 });
    expect(proposals.length).toBeLessThanOrEqual(2);
  });

  it('formatAdversarialExampleProposalsMarkdown emits stable shape with proposal sections', () => {
    const registry = getChatActionRegistry();
    const target = registry.find((e) => {
      const examples = (e.examples ?? []) as Array<{ tags?: string[] }>;
      return !examples.some((ex) =>
        Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
      );
    });
    if (!target) return;
    for (let i = 0; i < 6; i++) {
      insertRow({
        skill: target.skill,
        action: target.action,
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const proposals = proposeAdversarialExamples(db);
    const md = formatAdversarialExampleProposalsMarkdown(proposals);
    expect(md).toMatch(/Adversarial Example Proposer/);
    expect(md).toMatch(/Proposals \(sorted by priority\)/);
    expect(md).toMatch(new RegExp(`${target.skill}\\.${target.action}`));
    expect(md).toMatch(/Suggested registry entry/);
  });

  it('emits empty-state markdown when no proposals exist', () => {
    const md = formatAdversarialExampleProposalsMarkdown([]);
    expect(md).toMatch(/No proposals/);
  });

  it('priority increases with telemetry volume', () => {
    const registry = getChatActionRegistry();
    const uncovered = registry.filter((e) => {
      const examples = (e.examples ?? []) as Array<{ tags?: string[] }>;
      return !examples.some((ex) =>
        Array.isArray(ex.tags) && ex.tags.some((t) => t === 'prompt_injection' || t === 'adversarial'),
      );
    });
    if (uncovered.length < 2) return;
    const [lowVolume, highVolume] = uncovered;
    for (let i = 0; i < 3; i++) {
      insertRow({
        skill: lowVolume.skill,
        action: lowVolume.action,
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    for (let i = 0; i < 30; i++) {
      insertRow({
        skill: highVolume.skill,
        action: highVolume.action,
        failureReason: 'prompt_injection_marker_detected',
      });
    }
    const proposals = proposeAdversarialExamples(db);
    const lowP = proposals.find((p) => p.skill === lowVolume.skill && p.action === lowVolume.action);
    const highP = proposals.find((p) => p.skill === highVolume.skill && p.action === highVolume.action);
    if (lowP && highP) {
      expect(highP.priority).toBeGreaterThan(lowP.priority);
    }
  });
});
