// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

vi.mock('../../src/services/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/database')>()),
  getDb: () => testDb,
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  findUnexpectedMigrationPrefixCollisions: vi.fn(() => []),
  assertNoUnexpectedMigrationPrefixCollisions: vi.fn(),
  withDatabaseForTestAsync: vi.fn(),
}));

vi.mock('../../src/services/apns-sender', () => ({
  getPushTokensForUser: vi.fn(() => []),
  isApnsConfigured: vi.fn(() => false),
  sendPushNotification: vi.fn(),
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
  getDecisionItem,
  performDecisionAction,
  reviewDecision,
} from '../../src/services/decision-center';
import {
  bindTrainingCoachV2ProposalDecision,
  createTrainingCoachV2Proposal,
  getTrainingCoachV2Proposal,
} from '../../src/services/training-coach-v2-proposals';
import { getCoachPlanPolicySnapshot } from '../../src/services/coach-plan-policy';
import { createTrainingPlanCandidateRevision } from '../../src/services/training-plan-revisions';
import { bindTrainingPlanRevisionDecision } from '../../src/services/training-plan-revision-decision';
import type { TrainingPlanCandidateRequest } from '../../src/services/training-plan-revision-candidate-builder';

const revisionRequest: TrainingPlanCandidateRequest = {
  planMode: 'continuous',
  goal: 'general_fitness',
  discipline: 'strength',
  horizonWeeks: 4,
  profile: {
    experienceLevel: 'novice',
    sessionsPerWeek: 3,
    sessionDurationMinutes: 30,
    availableDays: ['monday', 'wednesday', 'friday'],
    equipmentIds: [],
    location: 'home',
  },
};

describe('Training Coach V2 Decision Center activation', () => {
  beforeEach(() => {
    process.env.COACH_PERIODIZATION_V2_ENABLED = 'on';
    process.env.NOTIFICATION_DELIVERY_MODE = 'mock';
    delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED;
    process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_44 = 'active';
    process.env.TRAINING_ADAPTATION_V1_MODE_USER_44 = 'active';
    process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_44 = 'true';
    process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY = 'coach-v2-revision-test-encryption-key-0044';
    testDb = createMigratedTestDatabase();
    testDb.prepare(`
      INSERT INTO fitness_training_plans (
        id, user_id, tenant_id, name, sport, duration_weeks,
        start_date, end_date, status, adaptation_revision
      ) VALUES (941, 44, 44, 'Decision governed', 'running', 4,
        '2026-08-03', '2026-08-30', 'active', 0)
    `).run();
  });

  afterEach(() => {
    delete process.env.COACH_PERIODIZATION_V2_ENABLED;
    delete process.env.NOTIFICATION_DELIVERY_MODE;
    delete process.env.DECISION_FLOW_V1_ENFORCE_ENABLED;
    delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED;
    delete process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_44;
    delete process.env.TRAINING_PLAN_REVISION_V1_MODE_USER_44;
    delete process.env.TRAINING_ADAPTATION_V1_MODE_USER_44;
    delete process.env.TRAINING_TYPED_WORKOUT_V1_ENABLED_USER_44;
    delete process.env.TRAINING_PROFILE_SNAPSHOT_ENCRYPTION_KEY;
    testDb.close();
  });

  it('allows only the bound approval action to CAS policy and returns deterministic readback', async () => {
    const current = getCoachPlanPolicySnapshot(941, testDb)!;
    const created = createTrainingCoachV2Proposal({
      tenantId: 44,
      userId: 44,
      kind: 'coach_policy',
      planId: 941,
      expectedVersion: current.version,
      request: {
        patch: { progressionAggressiveness: 'conservative' },
        proposedPolicy: { ...current.policy, progressionAggressiveness: 'conservative' },
      },
      evidence: { source: 'explicit_user_request', currentPolicyVersion: current.version },
      replayRequest: {
        expectedVersion: current.version,
        patch: { progressionAggressiveness: 'conservative' },
      },
      idempotencyKey: 'decision-policy-proposal-1',
      db: testDb,
    });
    const bound = await bindTrainingCoachV2ProposalDecision({
      tenantId: 44,
      userId: 44,
      proposalId: created.proposal.proposalId,
      db: testDb,
    });
    expect(bound.decisionId).toEqual(expect.any(String));
    const decision = getDecisionItem(bound.decisionId!, 44, 44)!;
    expect(decision.actions.map((action) => action.id)).toContain('activate_training_coach_v2_proposal');

    const result = await performDecisionAction(
      bound.decisionId!,
      'activate_training_coach_v2_proposal',
      44,
      44,
      {
        idempotencyKey: 'decision-policy-approve-1',
        expectedVersion: decision.recordVersion,
        contextVersion: decision.contextVersion,
      },
    );
    expect(result.status).toBe('succeeded');
    expect(result.verification.actualEffect).toMatchObject({
      proposalState: 'activated',
      proposalKind: 'coach_policy',
      planId: 941,
      policyVersion: 2,
    });
    expect(getCoachPlanPolicySnapshot(941, testDb)).toMatchObject({
      version: 2,
      policy: { progressionAggressiveness: 'conservative' },
    });
    expect(getTrainingCoachV2Proposal({
      tenantId: 44,
      userId: 44,
      proposalId: created.proposal.proposalId,
      db: testDb,
    })).toMatchObject({ state: 'activated' });

    const replay = await performDecisionAction(
      bound.decisionId!,
      'activate_training_coach_v2_proposal',
      44,
      44,
      {
        idempotencyKey: 'decision-policy-approve-1',
        expectedVersion: decision.recordVersion,
        contextVersion: decision.contextVersion,
      },
    );
    expect(replay.status).toBe('idempotent');
    expect(getCoachPlanPolicySnapshot(941, testDb)?.version).toBe(2);
  });

  it('blocks activation of an already-approved proposal after the Coach V2 kill switch turns off', async () => {
    const current = getCoachPlanPolicySnapshot(941, testDb)!;
    const created = createTrainingCoachV2Proposal({
      tenantId: 44,
      userId: 44,
      kind: 'coach_policy',
      planId: 941,
      expectedVersion: current.version,
      request: {
        patch: { progressionAggressiveness: 'conservative' },
        proposedPolicy: { ...current.policy, progressionAggressiveness: 'conservative' },
      },
      evidence: { source: 'explicit_user_request', currentPolicyVersion: current.version },
      replayRequest: { expectedVersion: current.version, patch: { progressionAggressiveness: 'conservative' } },
      idempotencyKey: 'decision-policy-kill-switch',
      db: testDb,
    });
    const bound = await bindTrainingCoachV2ProposalDecision({
      tenantId: 44,
      userId: 44,
      proposalId: created.proposal.proposalId,
      db: testDb,
    });
    const decision = getDecisionItem(bound.decisionId!, 44, 44)!;
    testDb.prepare(`
      UPDATE training_coach_v2_proposals
      SET state = 'approved'
      WHERE tenant_id = 44 AND user_id = 44 AND proposal_id = ?
    `).run(created.proposal.proposalId);

    process.env.COACH_PERIODIZATION_V2_ENABLED = 'off';
    await expect(performDecisionAction(
      bound.decisionId!,
      'activate_training_coach_v2_proposal',
      44,
      44,
      {
        idempotencyKey: 'decision-policy-kill-switch-activate',
        expectedVersion: decision.recordVersion,
        contextVersion: decision.contextVersion,
      },
    )).rejects.toMatchObject({ code: 'TRAINING_COACH_V2_DISABLED' });
    expect(getCoachPlanPolicySnapshot(941, testDb)).toMatchObject({ version: current.version });
    expect(getTrainingCoachV2Proposal({
      tenantId: 44,
      userId: 44,
      proposalId: created.proposal.proposalId,
      db: testDb,
    })).toMatchObject({ state: 'approved' });
  });

  it('stages and activates an immutable child revision without mutating the active projection before approval', async () => {
    // This test owns a separate plan created through the revision authority.
    testDb.prepare('DELETE FROM fitness_training_plans WHERE id = 941').run();
    process.env.TRAINING_DECISION_FLOW_V1_ENFORCE_ENABLED_USER_44 = 'true';
    const candidate = createTrainingPlanCandidateRevision({
      scope: { tenantId: 44, userId: 44 },
      idempotencyKey: 'coach-v2-base-revision',
      request: revisionRequest,
    }).candidates[0];
    const baseBound = await bindTrainingPlanRevisionDecision({
      scope: { tenantId: 44, userId: 44 },
      revisionId: candidate.revisionId,
    });
    const baseDecision = getDecisionItem(baseBound.decisionId!, 44, 44)!;
    const baseApproved = reviewDecision(baseBound.decisionId!, 44, 44, {
      outcome: 'approve',
      expectedVersion: baseDecision.recordVersion,
      idempotencyKey: 'coach-v2-base-review',
      strongConfirmationText: 'CONFIRM',
    });
    const baseActivation = await performDecisionAction(
      baseBound.decisionId!,
      'activate_training_plan_revision',
      44,
      44,
      {
        idempotencyKey: 'coach-v2-base-activate',
        expectedVersion: baseApproved.recordVersion,
        contextVersion: baseApproved.contextVersion,
      },
    );
    expect(baseActivation.status).toBe('succeeded');

    const projection = testDb.prepare(`
      SELECT id, source_revision_id AS sourceRevisionId, adaptation_revision AS adaptationRevision
        FROM fitness_training_plans
       WHERE user_id = 44 AND tenant_id = 44 AND status = 'active'
    `).get() as { id: number; sourceRevisionId: string; adaptationRevision: number };
    const targets = testDb.prepare(`
      SELECT s.id AS sessionId, s.duration_minutes AS durationMinutes, w.id AS weekId
        FROM training_sessions s
        JOIN training_weeks w ON w.id = s.week_id
       WHERE s.plan_id = ? AND s.status IN ('pending', 'scheduled')
         AND w.week_number = 1
       ORDER BY s.id LIMIT 2
    `).all(projection.id) as Array<{ sessionId: number; durationMinutes: number; weekId: number }>;
    expect(targets).toHaveLength(2);
    const target = targets[0]!;
    const dropTarget = targets[1]!;

    const proposal = createTrainingCoachV2Proposal({
      tenantId: 44,
      userId: 44,
      kind: 'week_reflow',
      planId: projection.id,
      weekId: target.weekId,
      expectedVersion: projection.adaptationRevision,
      request: {
        trigger: 'manual_reflow',
        sessionsToPreserve: [],
        actions: [
          {
            type: 'scale_volume',
            sessionId: String(target.sessionId),
            multiplier: 0.8,
            reasonCode: 'reviewed_fatigue_adjustment',
          },
          {
            type: 'drop_session',
            sessionId: String(dropTarget.sessionId),
            reasonCode: 'reviewed_minimum_viable_week',
          },
        ],
        schedulingTimezone: 'UTC',
        syncTarget: 'none',
      },
      evidence: {
        sciencePolicyVersion: 'science.v1',
        reasonCodes: ['reviewed_fatigue_adjustment'],
      },
      replayRequest: { trigger: 'manual_reflow', sessionsToPreserve: [] },
      idempotencyKey: 'coach-v2-revision-reflow',
      db: testDb,
    });
    expect(proposal.proposal.proposedRevisionId).toEqual(expect.any(String));
    expect(testDb.prepare('SELECT duration_minutes AS durationMinutes FROM training_sessions WHERE id = ?')
      .get(target.sessionId)).toEqual({ durationMinutes: target.durationMinutes });
    expect(testDb.prepare(`
      SELECT active_revision_id AS activeRevisionId
        FROM training_active_plan_references WHERE tenant_id = 44 AND user_id = 44
    `).get()).toEqual({ activeRevisionId: projection.sourceRevisionId });

    const bound = await bindTrainingCoachV2ProposalDecision({
      tenantId: 44,
      userId: 44,
      proposalId: proposal.proposal.proposalId,
      db: testDb,
    });
    const decision = getDecisionItem(bound.decisionId!, 44, 44)!;
    const approved = reviewDecision(bound.decisionId!, 44, 44, {
      outcome: 'approve',
      expectedVersion: decision.recordVersion,
      idempotencyKey: 'coach-v2-revision-review',
      strongConfirmationText: 'CONFIRM',
    });
    testDb.exec(`
      CREATE TRIGGER trg_test_ignore_dropped_projection_update
      BEFORE UPDATE OF schedule_status ON training_sessions
      WHEN NEW.schedule_status = 'dropped'
      BEGIN
        SELECT RAISE(IGNORE);
      END
    `);
    await expect(performDecisionAction(
      bound.decisionId!,
      'activate_training_coach_v2_proposal',
      44,
      44,
      {
        idempotencyKey: 'coach-v2-revision-activate-conflict',
        expectedVersion: approved.recordVersion,
        contextVersion: approved.contextVersion,
      },
    )).rejects.toMatchObject({ code: 'TRAINING_ADAPTATION_PROJECTION_SESSION_CONFLICT' });
    expect(testDb.prepare(`
      SELECT source_revision_id AS sourceRevisionId, adaptation_revision AS adaptationRevision
        FROM fitness_training_plans WHERE id = ?
    `).get(projection.id)).toEqual({
      sourceRevisionId: projection.sourceRevisionId,
      adaptationRevision: 0,
    });
    expect(testDb.prepare(`
      SELECT status, schedule_status AS scheduleStatus
        FROM training_sessions WHERE id = ?
    `).get(dropTarget.sessionId)).toEqual({ status: 'pending', scheduleStatus: null });
    testDb.exec('DROP TRIGGER trg_test_ignore_dropped_projection_update');
    const retryDecision = getDecisionItem(bound.decisionId!, 44, 44)!;
    const retryApproved = reviewDecision(bound.decisionId!, 44, 44, {
      outcome: 'approve',
      expectedVersion: retryDecision.recordVersion,
      idempotencyKey: 'coach-v2-revision-review-after-conflict',
      strongConfirmationText: 'CONFIRM',
    });

    const activated = await performDecisionAction(
      bound.decisionId!,
      'activate_training_coach_v2_proposal',
      44,
      44,
      {
        idempotencyKey: 'coach-v2-revision-activate',
        expectedVersion: retryApproved.recordVersion,
        contextVersion: retryApproved.contextVersion,
      },
    );
    expect(activated.status).toBe('succeeded');
    expect(activated.verification.actualEffect).toMatchObject({
      proposalState: 'activated',
      proposalKind: 'week_reflow',
      planId: projection.id,
      adaptationRevision: 1,
    });
    expect(testDb.prepare(`
      SELECT source_revision_id AS sourceRevisionId, adaptation_revision AS adaptationRevision
        FROM fitness_training_plans WHERE id = ?
    `).get(projection.id)).toEqual({
      sourceRevisionId: proposal.proposal.proposedRevisionId,
      adaptationRevision: 1,
    });
    expect(testDb.prepare(`
      SELECT duration_minutes AS durationMinutes, schedule_reason_code AS reasonCode
        FROM training_sessions WHERE id = ?
    `).get(target.sessionId)).toEqual({
      durationMinutes: Math.round(target.durationMinutes * 0.8),
      reasonCode: 'reviewed_fatigue_adjustment',
    });
    expect(testDb.prepare(`
      SELECT status, schedule_status AS scheduleStatus, schedule_reason_code AS reasonCode
        FROM training_sessions WHERE id = ?
    `).get(dropTarget.sessionId)).toEqual({
      status: 'skipped',
      scheduleStatus: 'dropped',
      reasonCode: 'reviewed_minimum_viable_week',
    });
  });
});
