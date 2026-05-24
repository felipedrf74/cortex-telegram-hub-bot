// Phase 5 batch 28 (2026-05-15): readableIntents proposer tests.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import {
  proposeReadableIntentsExtensions,
  formatReadableIntentsProposalsMarkdown,
} from '../../src/services/registry-readable-intents-proposer';
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
  outcome: string;
  routeTier?: string;
  createdAt?: string;
}) {
  db.prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, outcome, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `tel-${randomUUID()}`,
    1,
    1,
    `conv-${randomUUID()}`,
    `msg-${randomUUID()}`,
    'deterministic',
    opts.routeTier ?? 'tier0_deterministic',
    opts.skill,
    opts.action,
    'planned',
    opts.outcome,
    opts.createdAt ?? '2026-05-15T12:00:00Z',
  );
}

describe('readableIntents proposer (Phase 5 batch 28)', () => {
  it('surfaces actions with high clarification volume', () => {
    // Pick an action that exists in the registry — choose one with minimal
    // readableIntents to ensure low coverage score.
    const registry = getChatActionRegistry();
    const target = registry.find((e) => e.readableIntents.length <= 2);
    expect(target).toBeDefined();
    const { skill, action } = target!;
    for (let i = 0; i < 10; i++) {
      insertRow({ skill, action, outcome: 'needs_clarification' });
    }
    const proposals = proposeReadableIntentsExtensions(db);
    const proposal = proposals.find((p) => p.skill === skill && p.action === action);
    expect(proposal).toBeDefined();
    expect(proposal!.clarificationVolume).toBe(10);
    expect(proposal!.clarificationRate).toBe(1);
  });

  it('respects the minVolume threshold', () => {
    const registry = getChatActionRegistry();
    const target = registry[0];
    for (let i = 0; i < 2; i++) {
      insertRow({ skill: target.skill, action: target.action, outcome: 'needs_clarification' });
    }
    const proposals = proposeReadableIntentsExtensions(db, { minVolume: 5 });
    expect(proposals).toHaveLength(0);
  });

  it('respects the maxCoverageScore filter (well-covered actions skipped)', () => {
    const registry = getChatActionRegistry();
    // Find an action with HIGH readableIntents count to push coverage score up.
    const wellCovered = registry.find((e) => e.readableIntents.length >= 4);
    if (!wellCovered) return;
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'needs_clarification' });
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'verified_success' });
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'verified_success' });
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'verified_success' });
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'verified_success' });
    insertRow({ skill: wellCovered.skill, action: wellCovered.action, outcome: 'verified_success' });
    const proposals = proposeReadableIntentsExtensions(db, { maxCoverageScore: 0.5 });
    // Coverage = readableIntents.length / (1 + clarVol). For 4 intents and
    // 1 clarification → 4/2 = 2.0 — well above the threshold.
    expect(proposals.find((p) => p.skill === wellCovered.skill && p.action === wellCovered.action)).toBeUndefined();
  });

  it('builds a recommendation string with specific suggestions', () => {
    const registry = getChatActionRegistry();
    const target = registry.find((e) => e.readableIntents.length <= 1);
    if (!target) return;
    for (let i = 0; i < 12; i++) {
      insertRow({ skill: target.skill, action: target.action, outcome: 'needs_clarification' });
    }
    const proposals = proposeReadableIntentsExtensions(db);
    const proposal = proposals.find((p) => p.skill === target.skill && p.action === target.action);
    expect(proposal).toBeDefined();
    expect(proposal!.recommendation).toMatch(/paraphrase|example|tier2|clarification/i);
  });

  it('formatReadableIntentsProposalsMarkdown emits a stable markdown table', () => {
    const registry = getChatActionRegistry();
    const target = registry.find((e) => e.readableIntents.length <= 2);
    if (!target) return;
    for (let i = 0; i < 8; i++) {
      insertRow({ skill: target.skill, action: target.action, outcome: 'needs_clarification' });
    }
    const proposals = proposeReadableIntentsExtensions(db);
    const md = formatReadableIntentsProposalsMarkdown(proposals);
    expect(md).toMatch(/readableIntents Proposer/);
    expect(md).toMatch(/\| Skill.Action \| Coverage \|/);
    expect(md).toMatch(new RegExp(`${target.skill}\\.${target.action}`));
  });

  it('emits an empty-state message when no proposals surface', () => {
    const proposals = proposeReadableIntentsExtensions(db);
    const md = formatReadableIntentsProposalsMarkdown(proposals);
    expect(md).toMatch(/No actions exceed the coverage-gap threshold/);
  });
});
