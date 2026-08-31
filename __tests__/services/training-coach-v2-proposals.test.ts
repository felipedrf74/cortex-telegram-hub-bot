import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const mocks = vi.hoisted(() => ({
  createDecisionIntent: vi.fn(),
  withTrainingCalendarOperationLock: vi.fn(),
}));

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
}));

vi.mock('../../src/services/decision-center', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/decision-center')>()),
  createDecisionIntent: (...args: unknown[]) => mocks.createDecisionIntent(...args),
}));

vi.mock('../../src/services/training-operation-locks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/training-operation-locks')>()),
  withTrainingCalendarOperationLock: (...args: unknown[]) => mocks.withTrainingCalendarOperationLock(...args),
}));

import {
  TrainingCoachV2ProposalConflictError,
  TrainingCoachV2ProposalStateError,
  bindTrainingCoachV2ProposalDecision,
  createTrainingCoachV2Proposal,
  executeApprovedTrainingCoachV2Proposal,
  findTrainingCoachV2ProposalByIdempotency,
  getTrainingCoachV2Proposal,
} from '../../src/services/training-coach-v2-proposals';
import { setCoachPlanPolicyCas } from '../../src/services/coach-plan-policy';
import {
  TrainingCoachV2ReflowPreviewError,
  createTrainingCoachV2ReflowPreview,
  getTrainingCoachV2ReflowPreview,
} from '../../src/services/training-coach-v2-reflow-previews';

function createProposal(kind: 'week_reflow' | 'coach_policy' = 'week_reflow') {
  return createTrainingCoachV2Proposal({
    tenantId: 41,
    userId: 41,
    kind,
    planId: 901,
    weekId: kind === 'week_reflow' ? 902 : null,
    expectedVersion: kind === 'week_reflow' ? 0 : 1,
    request: kind === 'week_reflow'
      ? { actions: [{ type: 'drop_session', sessionId: '903', reasonCode: 'missed_session' }] }
      : { patch: { progressionAggressiveness: 'conservative' } },
    evidence: { reasonCodes: ['explicit_user_input'] },
    idempotencyKey: `proposal-${kind}`,
    db: testDb,
  });
}

describe('Training Coach V2 proposal governance', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    testDb.prepare(`
      INSERT INTO fitness_training_plans (
        id, user_id, tenant_id, name, sport, duration_weeks,
        start_date, end_date, status, adaptation_revision
      ) VALUES (901, 41, 41, 'Governed', 'running', 4,
        '2026-08-03', '2026-08-30', 'active', 0)
    `).run();
    testDb.prepare('INSERT INTO training_weeks (id, plan_id, week_number) VALUES (902, 901, 1)').run();
    testDb.prepare(`
      INSERT INTO training_sessions (
        id, plan_id, week_id, day_of_week, session_type, title,
        duration_minutes, intensity_text, status
      ) VALUES (903, 901, 902, 'Monday', 'run', 'Easy run', 40, 'easy', 'pending')
    `).run();
    mocks.createDecisionIntent.mockReset();
    mocks.createDecisionIntent.mockResolvedValue({
      item: { itemId: 'decision-coach-v2' },
      eligibility: { classification: 'decision' },
    });
    mocks.withTrainingCalendarOperationLock.mockReset();
    mocks.withTrainingCalendarOperationLock.mockImplementation(async (lockInput, fn) => {
      const release = Object.assign(() => {}, {
        signal: new AbortController().signal,
        assertActive: vi.fn(),
      });
      return fn(release, lockInput);
    });
  });

  afterEach(() => testDb.close());

  it('creates and binds a user-private Decision Center proposal without mutating the plan', async () => {
    const created = createProposal();
    const bound = await bindTrainingCoachV2ProposalDecision({
      tenantId: 41,
      userId: 41,
      proposalId: created.proposal.proposalId,
      db: testDb,
    });

    expect(bound).toMatchObject({
      decisionId: 'decision-coach-v2',
      state: 'proposal_created',
      kind: 'week_reflow',
    });
    expect(testDb.prepare('SELECT adaptation_revision FROM fitness_training_plans WHERE id = 901').get())
      .toEqual({ adaptation_revision: 0 });
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM training_plan_adaptations WHERE plan_id = 901").get())
      .toEqual({ n: 0 });

    const decision = mocks.createDecisionIntent.mock.calls[0]![0];
    expect(decision).toMatchObject({
      userId: 41,
      tenantId: 41,
      sourceSkill: 'training',
      privacyPolicy: 'health',
      visibilityScope: 'user_private',
      deliveryPolicy: 'in_app_only',
      actionButtons: [expect.objectContaining({
        id: 'activate_training_coach_v2_proposal',
        mutating: true,
      }), expect.any(Object)],
    });
    expect(JSON.stringify(decision)).not.toContain('Easy run');
    expect(decision.decisionContext.normalizedAction).toMatchObject({
      intent: 'training.activate_coach_v2_proposal',
      prohibitedEffects: [expect.objectContaining({ type: 'provider_calendar_write' })],
    });
  });

  it('records a scoped launch-rule firing for scheduled weekly adjustment proposals', () => {
    const created = createTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request: {
        trigger: 'scheduled_weekly_adjustment',
        scheduledAdjustment: { intensityPct: 80, reason: 'Adherence dipped this week' },
      },
      evidence: {
        source: 'scheduled_adherence_review',
        reasonCodes: ['scheduled_weekly_adjustment'],
      },
      idempotencyKey: 'scheduled-weekly-adjustment',
      db: testDb,
    });

    expect(testDb.prepare(`
      SELECT tenant_id, user_id, proposal_id, rule_id
      FROM training_coach_v2_rule_firings
      WHERE proposal_id = ?
    `).all(created.proposal.proposalId)).toEqual([{
      tenant_id: 41,
      user_id: 41,
      proposal_id: created.proposal.proposalId,
      rule_id: 'scheduled_weekly_adjustment',
    }]);
  });

  it('requires the exact bound approval, activates under adapt lock with CAS readback, and replays idempotently', async () => {
    const created = createProposal();
    await bindTrainingCoachV2ProposalDecision({
      tenantId: 41, userId: 41, proposalId: created.proposal.proposalId, db: testDb,
    });
    const apply = vi.fn((db: Database.Database, input: { proposal: { expected_version: number } }) => {
      const changed = db.prepare(`
        UPDATE fitness_training_plans
        SET adaptation_revision = adaptation_revision + 1
        WHERE id = 901 AND tenant_id = 41 AND user_id = 41 AND adaptation_revision = ?
      `).run(input.proposal.expected_version);
      if (changed.changes !== 1) throw new Error('ADAPTATION_VERSION_CONFLICT');
      return db.prepare('SELECT adaptation_revision AS adaptationRevision FROM fitness_training_plans WHERE id = 901').get();
    });

    await expect(executeApprovedTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      proposalId: created.proposal.proposalId,
      decisionId: 'another-decision',
      apply,
      db: testDb,
    })).rejects.toMatchObject({ code: 'PROPOSAL_DECISION_MISMATCH' });
    expect(apply).not.toHaveBeenCalled();

    const activated = await executeApprovedTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      proposalId: created.proposal.proposalId,
      decisionId: 'decision-coach-v2',
      apply,
      db: testDb,
    });
    const replay = await executeApprovedTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      proposalId: created.proposal.proposalId,
      decisionId: 'decision-coach-v2',
      apply,
      db: testDb,
    });

    expect(activated).toMatchObject({
      replayed: false,
      proposal: { state: 'activated' },
      result: { adaptationRevision: 1 },
    });
    expect(replay).toMatchObject({ replayed: true, result: { adaptationRevision: 1 } });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(mocks.withTrainingCalendarOperationLock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 41, userId: 41, planId: 901, operation: 'adapt', db: testDb }),
      expect.any(Function),
    );
  });

  it('rolls back the approval transition when policy CAS/readback fails', async () => {
    const created = createProposal('coach_policy');
    await bindTrainingCoachV2ProposalDecision({
      tenantId: 41, userId: 41, proposalId: created.proposal.proposalId, db: testDb,
    });
    testDb.prepare('UPDATE fitness_training_plans SET coach_plan_policy_version = 2 WHERE id = 901').run();

    await expect(executeApprovedTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      proposalId: created.proposal.proposalId,
      decisionId: 'decision-coach-v2',
      db: testDb,
      apply: (_db, activation) => setCoachPlanPolicyCas(
        activation.proposal.plan_id,
        activation.request.patch as Record<string, never>,
        activation.proposal.expected_version,
      ),
    })).rejects.toThrow(/version|changed/i);
    expect(getTrainingCoachV2Proposal({
      tenantId: 41, userId: 41, proposalId: created.proposal.proposalId, db: testDb,
    })).toMatchObject({ state: 'proposal_created' });
  });

  it('rejects cross-tenant plan/week binding before proposal persistence', () => {
    expect(() => createTrainingCoachV2Proposal({
      tenantId: 42,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request: {},
      evidence: {},
      idempotencyKey: 'foreign',
      db: testDb,
    })).toThrow(TrainingCoachV2ProposalStateError);
    expect(testDb.prepare('SELECT COUNT(*) AS n FROM training_coach_v2_proposals').get()).toEqual({ n: 0 });
  });

  it('replays by stable client request before volatile proposal material changes', () => {
    const replayRequest = { trigger: 'manual_reflow', sessionsToPreserve: [903] };
    const created = createTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request: {
        ...replayRequest,
        actions: [{ type: 'scale_volume', sessionId: '903', multiplier: 0.8, reasonCode: 'fatigue' }],
      },
      evidence: { sciencePolicyVersion: 'science.v1' },
      replayRequest,
      idempotencyKey: 'stable-preflight',
      db: testDb,
    });

    expect(findTrainingCoachV2ProposalByIdempotency({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      idempotencyKey: 'stable-preflight',
      request: replayRequest,
      db: testDb,
    })).toMatchObject({ proposalId: created.proposal.proposalId });

    expect(() => findTrainingCoachV2ProposalByIdempotency({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      idempotencyKey: 'stable-preflight',
      request: { trigger: 'manual_reflow', sessionsToPreserve: [] },
      db: testDb,
    })).toThrow(TrainingCoachV2ProposalConflictError);
  });

  it('binds a proposal to the exact scoped immutable reflow preview', () => {
    const request = {
      trigger: 'manual_reflow',
      sessionsToPreserve: [],
      actions: [{ type: 'scale_volume', sessionId: '903', multiplier: 0.8, reasonCode: 'fatigue' }],
      schedulingTimezone: 'UTC',
      syncTarget: 'none',
    };
    const evidence = { sciencePolicyVersion: 'science.v1', reasonCodes: ['fatigue'] };
    const preview = createTrainingCoachV2ReflowPreview({
      tenantId: 41,
      userId: 41,
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request,
      evidence,
      db: testDb,
    });
    const created = createTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request,
      evidence,
      replayRequest: { previewId: preview.preview.previewId },
      previewId: preview.preview.previewId,
      idempotencyKey: 'preview-bound-proposal',
      db: testDb,
    });
    expect(created.proposal).toMatchObject({
      previewId: preview.preview.previewId,
      weekId: 902,
      state: 'proposal_created',
    });

    expect(() => createTrainingCoachV2Proposal({
      tenantId: 41,
      userId: 41,
      kind: 'week_reflow',
      planId: 901,
      weekId: 902,
      expectedVersion: 0,
      request: { ...request, trigger: 'changed_after_review' },
      evidence,
      previewId: preview.preview.previewId,
      idempotencyKey: 'preview-tamper',
      db: testDb,
    })).toThrowError(/does not match/i);

    expect(() => getTrainingCoachV2ReflowPreview({
      tenantId: 42,
      userId: 41,
      planId: 901,
      weekId: 902,
      previewId: preview.preview.previewId,
      db: testDb,
    })).toThrow(TrainingCoachV2ReflowPreviewError);
  });
});
