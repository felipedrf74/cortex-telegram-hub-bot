import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');
let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

import {
  buildContentChatStatusSignal,
  buildContentSecretarySignals,
  consumeContentCrossSkillSignal,
  listContentCrossSkillRadarSignals,
} from '../../src/services/content-cross-skill-orchestration';

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8'));
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

describe('Content cross-skill orchestration', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    applyMigrations(testDb);
  });

  afterEach(() => {
    testDb?.close();
  });

  it('turns a permitted Training milestone into a Content idea', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'training',
      signalType: 'milestone',
      sourceEntityId: 'session-10k',
      topic: 'First 10K run breakthrough',
      summary: 'Training logged a first 10K milestone worth turning into a story.',
      confidence: 0.9,
      permission: 'granted',
      convertToIdea: true,
    });

    expect(result.status).toBe('consumed');
    expect(result.convertedObjectId).toBeGreaterThan(0);
    expect(result.radarSignal).toMatchObject({
      tenantId: 101,
      ownerUserId: 501,
      sourceSkill: 'training',
      sourceSignalType: 'milestone',
    });
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'training_milestone_content_opportunity',
      'radar_signal_converted_to_idea',
    ]));
  });

  it('lets Secretary availability reduce content cadence feasibility', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'secretary',
      signalType: 'content_work_availability',
      sourceEntityId: 'week-2026-05-04',
      topic: 'Limited content production capacity this week',
      summary: 'Only two short content blocks fit this week.',
      permission: 'not_required',
      auditMetadata: { capacityScore: 0.3 },
    });

    expect(result.status).toBe('consumed');
    expect(result.policy.usePolicy).toBe('anonymize_summary');
    expect(result.radarSignal?.score.productionFeasibility).toBeLessThanOrEqual(0.3);
    expect(result.radarSignal?.score.reasonCodes).toEqual(expect.arrayContaining([
      'low_production_feasibility',
      'cross_skill_secretary_capacity_signal',
      'secretary_capacity_affects_content_cadence',
    ]));
    expect(result.downstreamImplications.join('\n')).toContain('Reduce content cadence');
  });

  it('turns Finance constraints into workflow guidance without exposing private details', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'finance',
      signalType: 'budget_constraint',
      sourceEntityId: 'budget-week',
      topic: 'Keep content production low cost this week',
      summary: 'Private account details should not appear in content.',
      evidence: [{ account: 'private', balance: 42 }],
      permission: 'granted',
    });

    expect(result.status).toBe('consumed');
    expect(result.policy.usePolicy).toBe('anonymize_summary');
    expect(result.radarSignal?.evidence).toEqual([]);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      'finance_constraint_affects_content_workflow',
      'sensitive_signal_permission_granted_summary_only',
    ]));
    expect(result.downstreamImplications.join('\n')).toContain('low-cost content production');
  });

  it('promotes recurring Chat questions into tenant-scoped Content radar signals', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'chat',
      signalType: 'recurring_question',
      sourceEntityId: 'creator-systems-faq',
      topic: 'Users keep asking how to build a creator operating system',
      summary: 'Chat saw repeated questions about creator operating systems.',
      confidence: 0.85,
      permission: 'not_required',
    });

    expect(result.status).toBe('consumed');
    expect(result.radarSignal?.sourceSkill).toBe('chat');
    expect(result.radarSignal?.score.reasonCodes).toEqual(expect.arrayContaining([
      'chat_repeated_question_signal',
      'chat_recurring_question_content_signal',
    ]));
  });

  it('requires review for sensitive Training recovery signals without permission', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceSkill: 'training',
      signalType: 'recovery_insight',
      sourceEntityId: 'recovery-week',
      topic: 'Recovery struggle could become a lesson',
      summary: 'Specific recovery details are private.',
      confidence: 0.82,
      permission: 'missing',
    });

    expect(result.status).toBe('requires_review');
    expect(result.policy.reviewRequired).toBe(true);
    expect(result.radarSignal?.reviewRequired).toBe(true);
    expect(result.radarSignal?.lifecycleState).toBe('review_required');
    expect(result.reasonCodes).toContain('sensitive_signal_requires_review');
  });

  it('rejects cross-tenant signals before creating radar state', () => {
    const result = consumeContentCrossSkillSignal({
      userId: 501,
      tenantId: 101,
      sourceTenantId: 202,
      sourceSkill: 'training',
      signalType: 'milestone',
      sourceEntityId: 'tenant-b-session',
      topic: 'Tenant B private training milestone',
      permission: 'granted',
    });

    expect(result.status).toBe('rejected');
    expect(result.reasonCodes).toContain('cross_tenant_signal_rejected');
    expect(listContentCrossSkillRadarSignals({ userId: 501, tenantId: 101 })).toHaveLength(0);
  });

  it('deduplicates repeated cross-skill warnings by stable source reference', () => {
    const input = {
      userId: 501,
      tenantId: 101,
      sourceSkill: 'chat' as const,
      signalType: 'recurring_question',
      sourceEntityId: 'same-question',
      topic: 'Users ask the same creator question again',
      summary: 'Duplicate recurring question signal.',
      permission: 'not_required' as const,
    };

    consumeContentCrossSkillSignal(input);
    consumeContentCrossSkillSignal(input);

    const signals = listContentCrossSkillRadarSignals({ userId: 501, tenantId: 101, includeInactive: true });
    expect(signals).toHaveLength(1);
    expect(signals[0].sourceReferenceId).toBe('chat:recurring_question:same-question');
  });

  it('emits Secretary and Chat outbound signals with scoped payloads', () => {
    const secretarySignals = buildContentSecretarySignals({
      userId: 501,
      tenantId: 101,
      objectId: 'script-1',
      title: 'Creator systems script',
      signalTypes: ['writing_block', 'publishing_deadline', 'radar_review_block'],
      deadline: '2026-05-08T16:00:00.000Z',
    });
    const chatSignal = buildContentChatStatusSignal({
      userId: 501,
      tenantId: 101,
      signalType: 'pending_approvals',
      summary: 'Two content items need review before scheduling.',
      count: 2,
      objectIds: ['script-1', 'idea-2'],
      pendingApprovalTypes: ['low_confidence_sources'],
    });

    expect(secretarySignals).toHaveLength(3);
    expect(secretarySignals[0].schedulingIntent.sourceSkill).toBe('content');
    expect(secretarySignals[0].schedulingIntent.tenantId).toBe(101);
    expect(secretarySignals.map((signal) => signal.signalType)).toEqual([
      'writing_block',
      'publishing_deadline',
      'radar_review_block',
    ]);
    expect(chatSignal).toMatchObject({
      targetSkill: 'chat',
      tenantId: 101,
      userId: 501,
      permissionRequired: true,
    });
  });
});
