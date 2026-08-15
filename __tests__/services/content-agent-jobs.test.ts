// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentMocks = vi.hoisted(() => ({
  completeOneShotWithFallback: vi.fn(),
  withAiBudgetReservation: vi.fn(),
  getUserLanguage: vi.fn(() => 'en-US'),
  executeSkillInference: vi.fn(),
  rejectApplicationResult: vi.fn(),
  runWithAccountAdmission: vi.fn(),
  contentSpecialistsEnabled: false,
  localControlMode: 'off' as 'off' | 'shadow' | 'canary' | 'active',
  localRolloutPercent: 0,
  localUserEnrolled: false,
}));

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: {
    get contentSpecialistsEnabled() { return agentMocks.contentSpecialistsEnabled; },
  },
}));
vi.mock('../../src/services/skill-inference-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/skill-inference-service')>(
    '../../src/services/skill-inference-service',
  )),
  executeSkillInference: (...args: unknown[]) => agentMocks.executeSkillInference(...args),
  isLocalInferenceUserEnrolled: () => agentMocks.localUserEnrolled,
  isSkillInferenceAccountDeletionError: (error: unknown) => (
    Boolean(error && typeof error === 'object'
      && (error as { code?: unknown }).code === 'ACCOUNT_DELETION_IN_PROGRESS')
  ),
  rejectSkillInferenceApplicationResult: (...args: unknown[]) => agentMocks.rejectApplicationResult(...args),
  runWithSkillInferenceAccountAdmission: (...args: unknown[]) => agentMocks.runWithAccountAdmission(...args),
}));
vi.mock('../../src/services/local-inference-runtime-control', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-runtime-control')>(
    '../../src/services/local-inference-runtime-control',
  )),
  getLocalInferenceRuntimeControl: () => ({
    mode: agentMocks.localControlMode,
    rolloutPercent: agentMocks.localRolloutPercent,
    environment: 'staging',
    manifestVersion: 'test-manifest',
    activeModelId: 'test-model',
    reason: 'test',
    updatedAt: null,
  }),
}));

vi.mock('../../src/services/gemini-provider', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/gemini-provider')>(
    '../../src/services/gemini-provider',
  );
  return {
    ...actual,
    completeOneShotWithFallback: (...args: unknown[]) => agentMocks.completeOneShotWithFallback(...args),
  };
});

vi.mock('../../src/services/cost-guardrail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/cost-guardrail')>();
  return {
    ...actual,
    withAiBudgetReservation: (...args: unknown[]) => agentMocks.withAiBudgetReservation(...args),
  };
});
vi.mock('../../src/services/user-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/user-service')>();
  return {
    ...actual,
    getUserLanguage: (...args: unknown[]) => agentMocks.getUserLanguage(...args),
  };
});
import {
  buildContentAgencyPackage,
  computeContentAgencyArtifactHash,
  handoffContentAgencyPackageToWorkspace,
  persistContentAgencyArtifact,
  type ContentAgencyPackage,
} from '../../src/services/content-agency';
import {
  ContentAgentJobError,
  acceptContentAgentProposal,
  cancelContentAgentJob,
  createContentAgentJob,
  getContentAgentJob,
  listContentAgentJobs,
  rejectContentAgentProposal,
  retryContentAgentJob,
  runContentAgentJob,
  type ContentAgentRole,
} from '../../src/services/content-agent-jobs';
import {
  createContentArtifact,
  createContentWorkspaceItem,
  getContentArtifact,
  getContentWorkspaceItemDetail,
  listContentRevisions,
  saveContentRevision,
  type ContentArtifact,
  type ContentWorkspaceScope,
} from '../../src/services/content-workspace';
import { listContentArtifactRelationships } from '../../src/services/content-artifact-relationships';
import { withDatabaseForTest } from '../../src/services/database';
import { AiBudgetError } from '../../src/services/cost-guardrail';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

const OWNER: ContentWorkspaceScope = { tenantId: 501, userId: 501 };
const OTHER: ContentWorkspaceScope = { tenantId: 777, userId: 777 };

describe('canonical Content specialist jobs', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMigratedTestDatabase();
    agentMocks.completeOneShotWithFallback.mockReset();
    agentMocks.completeOneShotWithFallback.mockRejectedValue(new Error('specialist provider unavailable'));
    agentMocks.withAiBudgetReservation.mockReset();
    agentMocks.withAiBudgetReservation.mockImplementation(async (_request, callback) => callback());
    agentMocks.getUserLanguage.mockReset();
    agentMocks.getUserLanguage.mockReturnValue('en-US');
    agentMocks.executeSkillInference.mockReset();
    agentMocks.rejectApplicationResult.mockReset();
    agentMocks.runWithAccountAdmission.mockReset();
    agentMocks.runWithAccountAdmission.mockImplementation(async (
      input: { abortSignal?: AbortSignal },
      operation: (abortSignal: AbortSignal) => Promise<unknown>,
    ) => operation(input.abortSignal ?? new AbortController().signal));
    agentMocks.contentSpecialistsEnabled = false;
    agentMocks.localControlMode = 'off';
    agentMocks.localRolloutPercent = 0;
    agentMocks.localUserEnrolled = false;
  });

  afterEach(() => db.close());

  it('runs against the artifact produced by the canonical package handoff', () => {
    const pkg = buildContentAgencyPackage({
      userId: OWNER.userId,
      tenantId: OWNER.tenantId,
      brief: {
        userId: OWNER.userId,
        tenantId: OWNER.tenantId,
        goal: 'Turn one private package into reviewable specialist options',
        audience: 'creator teams reviewing an evidence-backed script',
        platform: 'youtube',
        objective: 'preserve the package-to-script chain during specialist review',
        brandVoice: 'clear, calm, and specific',
      },
      references: ['private-workspace-note'],
    });

    withDatabaseForTest(db, () => {
      expect(persistContentAgencyArtifact('package', pkg)).toBeTypeOf('number');
      const handoff = handoffContentAgencyPackageToWorkspace({
        userId: OWNER.userId,
        tenantId: OWNER.tenantId,
        packageId: pkg.id,
      });
      expect(handoff).toMatchObject({
        status: 'created',
        workspaceArtifactId: expect.any(Number),
        workspaceRevisionId: expect.any(Number),
      });
      const artifact = getContentArtifact(OWNER, handoff.workspaceArtifactId!, db)!;
      const created = createContentAgentJob({
        scope: OWNER,
        artifactId: artifact.id,
        packageId: pkg.id,
        idempotencyKey: 'create-agent-canonical-handoff-001',
      }, db);
      expect(created.value).toMatchObject({
        itemId: handoff.workspaceItemId,
        artifactId: handoff.workspaceArtifactId,
        packageId: pkg.id,
        status: 'queued',
      });
    });
  });

  it('runs the dependency graph and creates only reviewable proposals without mutating a revision', async () => {
    const fixture = seedFixture(db, 'graph');
    const created = createContentAgentJob({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'create-agent-job-graph-001',
    }, db);
    const replay = createContentAgentJob({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'create-agent-job-graph-001',
    }, db);

    expect(created).toMatchObject({ replayed: false, changed: true });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(created.value.steps.map((step) => step.dependencyGroup)).toEqual([1, 1, 2, 3, 3, 3, 4]);
    expect(created.value.proposals).toEqual([]);

    const before = listContentRevisions(OWNER, fixture.artifact.id, db);
    const completed = await runContentAgentJob({
      scope: OWNER,
      jobKey: created.value.jobKey,
      idempotencyKey: 'run-agent-job-graph-001',
    }, db);
    const runReplay = await runContentAgentJob({
      scope: OWNER,
      jobKey: created.value.jobKey,
      idempotencyKey: 'run-agent-job-graph-001',
    }, db);
    const completedNoOp = await runContentAgentJob({
      scope: OWNER,
      jobKey: created.value.jobKey,
      idempotencyKey: 'run-agent-job-graph-fresh-noop-002',
    }, db);

    expect(completed.value.status).toBe('completed');
    expect(completed.value.steps).toHaveLength(7);
    expect(completed.value.steps.every((step) => step.status === 'completed')).toBe(true);
    expect(completed.value.proposals.map((proposal) => proposal.role)).toEqual([
      'writer',
      'editor',
      'platform_adapter',
    ]);
    expect(completed.value.proposals.every((proposal) => proposal.status === 'proposed')).toBe(true);
    expect(runReplay).toMatchObject({ replayed: true, changed: false });
    expect(completedNoOp).toMatchObject({ replayed: false, changed: false });
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toHaveLength(before.length);

    const serialized = JSON.stringify(completed.value);
    expect(serialized).not.toContain(fixture.pkg.contentHash);
    expect(serialized).not.toContain('lease_token');
    expect(serialized).not.toContain('payload_json');
    expect(serialized).not.toContain('tenantId');
    expect(serialized).not.toContain('ownerUserId');
    expect(completed.value).toMatchObject({
      workflowKind: 'package_suggestions',
      executionMode: 'package_derived',
      independentReviewPerformed: false,
      approvalRequiresLineageReview: true,
    });
    expect(completed.value.steps.every((step) => (
      step.summary.basis === 'package_derived'
      && step.summary.independentReviewPerformed === false
      && step.summary.verificationState === 'not_independently_verified'
    ))).toBe(true);
    expect(completed.value.steps.find((step) => step.role === 'research')?.summary.title)
      .toContain('not fact-checked');
    expect(completed.value.proposals.every((proposal) => (
      proposal.reviewBasis === 'package_derived' && proposal.independentReviewPerformed === false
    ))).toBe(true);
    expect(completed.value.steps.every((step) => step.summary.fallbackReason === 'provider_unavailable')).toBe(true);
    expect(agentMocks.withAiBudgetReservation).toHaveBeenCalledTimes(1);
  });

  it('runs provider-routed dependency groups in parallel and persists bounded review provenance', async () => {
    const fixture = seedFixture(db, 'provider-graph');
    const created = createFixtureJob(db, fixture, 'provider-graph');
    const started: ContentAgentRole[] = [];
    let releaseGroupOne = (): void => undefined;
    let releaseGroupThree = (): void => undefined;
    const groupOneGate = new Promise<void>((resolve) => { releaseGroupOne = resolve; });
    const groupThreeGate = new Promise<void>((resolve) => { releaseGroupThree = resolve; });
    agentMocks.completeOneShotWithFallback.mockImplementation(async (
      _system: unknown,
      _user: unknown,
      rawCategory: unknown,
    ) => {
      const role = String(rawCategory).replace('content_agent_', '') as ContentAgentRole;
      started.push(role);
      if (role === 'strategy' || role === 'research') await groupOneGate;
      if (role === 'structural_editor' || role === 'factuality' || role === 'platform_adapter') {
        await groupThreeGate;
      }
      return validProviderCompletion(role, 'gemini');
    });

    const before = listContentRevisions(OWNER, fixture.artifact.id, db);
    const pending = runContentAgentJob({
      scope: OWNER,
      jobKey: created.jobKey,
      idempotencyKey: 'run-agent-provider-graph-001',
    }, db);

    await vi.waitFor(() => {
      expect(started).toEqual(expect.arrayContaining(['strategy', 'research']));
      expect(started).not.toContain('writer');
    });
    releaseGroupOne();
    await vi.waitFor(() => expect(started).toContain('writer'));
    await vi.waitFor(() => {
      expect(started).toEqual(expect.arrayContaining(['structural_editor', 'factuality', 'platform_adapter']));
      expect(started).not.toContain('quality_reviewer');
    });
    releaseGroupThree();
    const completed = await pending;

    expect(started.indexOf('writer')).toBeGreaterThan(started.indexOf('strategy'));
    expect(started.indexOf('writer')).toBeGreaterThan(started.indexOf('research'));
    expect(started.indexOf('quality_reviewer')).toBeGreaterThan(started.indexOf('platform_adapter'));
    expect(completed.value).toMatchObject({
      status: 'completed',
      executionMode: 'provider_routed',
      independentReviewPerformed: true,
    });
    expect(completed.value.steps.every((step) => (
      step.summary.basis === 'provider_routed'
      && step.summary.provider === 'gemini'
      && step.summary.independentReviewPerformed
      && step.summary.verificationState === 'model_reviewed_not_source_verified'
      && step.summary.fallbackReason === null
    ))).toBe(true);
    expect(completed.value.proposals).toHaveLength(3);
    expect(completed.value.proposals.every((proposal) => (
      proposal.reviewBasis === 'provider_routed'
      && proposal.provider === 'gemini'
      && proposal.independentReviewPerformed
      && proposal.fallbackReason === null
    ))).toBe(true);
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toEqual(before);
    expect(listContentAgentJobs({ scope: OWNER, artifactId: fixture.artifact.id }, db).jobs[0])
      .toMatchObject({ executionMode: 'provider_routed', independentReviewPerformed: true });

    const providerCalls = agentMocks.completeOneShotWithFallback.mock.calls;
    const promptFor = (role: ContentAgentRole): string => String(
      providerCalls.find((call) => call[2] === `content_agent_${role}`)?.[1] ?? '',
    );
    expect(promptFor('writer')).toContain('Strategy provider review');
    expect(promptFor('writer')).toContain('Research provider review');
    expect(promptFor('structural_editor')).toContain('# writer provider draft');
    expect(promptFor('quality_reviewer')).toContain('Structural Editor provider review');
    expect(promptFor('quality_reviewer')).toContain('# structural_editor provider draft');
    expect(promptFor('quality_reviewer')).toContain('# platform_adapter provider draft');
    expect(providerCalls.every((call) => (call[4] as { maxRetries?: number }).maxRetries === 0)).toBe(true);
    for (const call of providerCalls) {
      const prompt = String(call[1]);
      expect(prompt).not.toContain(fixture.pkg.id);
      expect(prompt).not.toContain(fixture.pkg.contentHash);
      expect(prompt.length).toBeLessThanOrEqual(32_000);
    }
    expect(JSON.stringify(completed.value)).not.toContain('content-agent-specialist-output-v1');

    const writer = completed.value.proposals.find((proposal) => proposal.role === 'writer')!;
    const accepted = acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: writer.proposalKey,
      idempotencyKey: 'accept-provider-writer-proposal-001',
    }, db);
    expect(accepted.value.status).toBe('accepted');
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)[0]?.provenance).toMatchObject({
      specialistExecutionBasis: 'provider_routed',
      specialistProvider: 'gemini',
      specialistFallbackReason: null,
    });
  });

  it('keeps every local specialist batch within the Pro output ceiling while retaining seven role records', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'active';
    agentMocks.localRolloutPercent = 100;
    let activeInferenceCalls = 0;
    let maximumConcurrentInferenceCalls = 0;
    agentMocks.executeSkillInference.mockImplementation(async (request: {
      outputSchema: { properties: { outputs: { items: { properties: { role: { enum: ContentAgentRole[] } } } } } };
    }) => {
      activeInferenceCalls += 1;
      maximumConcurrentInferenceCalls = Math.max(
        maximumConcurrentInferenceCalls,
        activeInferenceCalls,
      );
      await Promise.resolve();
      const roles = request.outputSchema.properties.outputs.items.properties.role.enum;
      const result = {
        text: 'group',
        parsed: {
          schemaVersion: 'content-agent-specialist-group-v1',
          outputs: roles.map((role) => JSON.parse(validProviderCompletion(role, 'gemini').text)),
        },
        provider: 'ollama',
        route: 'local',
        runId: `run-${roles.join('-')}`,
        operationId: 'grouped-specialists',
        validationStatus: 'valid',
        queueWaitMs: 0,
        durationMs: 10,
      };
      activeInferenceCalls -= 1;
      return result;
    });
    const fixture = seedFixture(db, 'local-grouped');
    const job = createFixtureJob(db, fixture, 'local-grouped');

    const completed = await runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-local-grouped-001',
    }, db);

    expect(agentMocks.executeSkillInference).toHaveBeenCalledTimes(5);
    expect(agentMocks.executeSkillInference.mock.calls.map(([request]) => (
      (request as { requestedOutputTokens: number }).requestedOutputTokens
    ))).toEqual([3_000, 3_600, 4_500, 3_000, 1_500]);
    expect(agentMocks.withAiBudgetReservation).not.toHaveBeenCalled();
    expect(agentMocks.completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(agentMocks.rejectApplicationResult).not.toHaveBeenCalled();
    expect(maximumConcurrentInferenceCalls).toBe(1);
    expect(completed.value.steps).toHaveLength(7);
    expect(completed.value.steps.map((step) => step.dependencyGroup)).toEqual([1, 1, 2, 3, 3, 3, 4]);
    expect(completed.value.steps.every((step) => (
      step.summary.basis === 'provider_routed'
      && step.summary.provider === 'ollama'
      && step.summary.independentReviewPerformed === true
    ))).toBe(true);
    expect(completed.value.proposals.map((proposal) => proposal.role)).toEqual([
      'writer', 'editor', 'platform_adapter',
    ]);
  });

  it('rejects local specialist evidence when lease loss discards the generated group', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'active';
    agentMocks.localRolloutPercent = 100;
    let jobKey = '';
    const discardedRunId = 'content-specialist-lease-discarded-run';
    agentMocks.executeSkillInference.mockImplementationOnce(async (request: {
      outputSchema: { properties: { outputs: { items: { properties: { role: { enum: ContentAgentRole[] } } } } } };
    }) => {
      const roles = request.outputSchema.properties.outputs.items.properties.role.enum;
      db.prepare(`UPDATE content_agent_jobs
        SET lease_token = 'replacement-worker-token', lease_expires_at = ?
        WHERE job_key = ?`).run(new Date(Date.now() + 60_000).toISOString(), jobKey);
      return {
        text: 'group',
        parsed: {
          schemaVersion: 'content-agent-specialist-group-v1',
          outputs: roles.map((role) => JSON.parse(validProviderCompletion(role, 'gemini').text)),
        },
        provider: 'ollama',
        route: 'local',
        runId: discardedRunId,
        operationId: 'content-specialist-lease-discarded',
        validationStatus: 'valid',
        queueWaitMs: 0,
        durationMs: 10,
      };
    });
    const fixture = seedFixture(db, 'local-grouped-lease-loss');
    const job = createFixtureJob(db, fixture, 'local-grouped-lease-loss');
    jobKey = job.jobKey;

    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey,
      idempotencyKey: 'run-agent-local-grouped-lease-loss-001',
    }, db)).rejects.toMatchObject({ code: 'CONTENT_AGENT_JOB_LEASE_LOST' });
    expect(agentMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: discardedRunId,
        tenantId: OWNER.tenantId,
        userId: OWNER.userId,
        reason: 'content_specialist_checkpoint_not_committed_content_agent_job_lease_lost',
      }),
      db,
    );
  });

  it('rejects an earlier split-batch run when a later batch aborts before checkpointing', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'active';
    agentMocks.localRolloutPercent = 100;
    const accountDeletion = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    let callNumber = 0;
    agentMocks.executeSkillInference.mockImplementation(async (request: {
      outputSchema: { properties: { outputs: { items: { properties: { role: { enum: ContentAgentRole[] } } } } } };
    }) => {
      callNumber += 1;
      if (callNumber === 4) throw accountDeletion;
      const roles = request.outputSchema.properties.outputs.items.properties.role.enum;
      return {
        text: 'group',
        parsed: {
          schemaVersion: 'content-agent-specialist-group-v1',
          outputs: roles.map((role) => JSON.parse(validProviderCompletion(role, 'gemini').text)),
        },
        provider: 'ollama',
        route: 'local',
        runId: `split-batch-run-${callNumber}`,
        operationId: 'content-specialist-split-batch-abort',
        validationStatus: 'valid',
        queueWaitMs: 0,
        durationMs: 10,
      };
    });
    const fixture = seedFixture(db, 'local-grouped-split-abort');
    const job = createFixtureJob(db, fixture, 'local-grouped-split-abort');

    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-local-grouped-split-abort-001',
    }, db)).rejects.toBe(accountDeletion);
    expect(agentMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'split-batch-run-3',
        reason: 'content_specialist_group_not_checkpointed_account_deletion_in_progress',
      }),
      db,
    );
    expect(agentMocks.rejectApplicationResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'split-batch-run-1' }),
      db,
    );
    expect(agentMocks.rejectApplicationResult).not.toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'split-batch-run-2' }),
      db,
    );
  });

  it('repairs only an invalid local specialist subset and records the rejected first group result', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'active';
    agentMocks.localRolloutPercent = 100;
    let callNumber = 0;
    agentMocks.executeSkillInference.mockImplementation(async (request: {
      outputSchema: { properties: { outputs: { items: { properties: { role: { enum: ContentAgentRole[] } } } } } };
    }) => {
      callNumber += 1;
      const roles = request.outputSchema.properties.outputs.items.properties.role.enum;
      const outputs = roles.map((role) => JSON.parse(validProviderCompletion(role, 'gemini').text));
      if (callNumber === 1) {
        const research = outputs.find((output) => output.role === 'research');
        if (research) research.title = '';
      }
      return {
        text: 'group',
        parsed: { schemaVersion: 'content-agent-specialist-group-v1', outputs },
        provider: 'ollama',
        route: 'local',
        runId: `run-${callNumber}`,
        operationId: 'grouped-specialists-repair',
        validationStatus: 'valid',
        queueWaitMs: 0,
        durationMs: 10,
      };
    });
    const fixture = seedFixture(db, 'local-grouped-repair');
    const job = createFixtureJob(db, fixture, 'local-grouped-repair');

    const completed = await runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-local-grouped-repair-001',
    }, db);

    expect(agentMocks.executeSkillInference).toHaveBeenCalledTimes(6);
    expect(agentMocks.executeSkillInference.mock.calls[1]?.[0]).toMatchObject({
      taskType: 'content_specialist_group_repair',
    });
    expect(agentMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        reason: 'content_specialist_group_subset_invalid',
      }),
      db,
    );
    expect(completed.value.steps).toHaveLength(7);
    expect(completed.value.steps.every((step) => step.summary.provider === 'ollama')).toBe(true);
  });

  it('stops grouped local specialist repair when account deletion cancels inference', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'active';
    agentMocks.localRolloutPercent = 100;
    const accountDeletion = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    agentMocks.executeSkillInference
      .mockResolvedValueOnce({
        text: 'group',
        parsed: {
          schemaVersion: 'content-agent-specialist-group-v1',
          outputs: [
            JSON.parse(validProviderCompletion('strategy', 'gemini').text),
            { ...JSON.parse(validProviderCompletion('research', 'gemini').text), title: '' },
          ],
        },
        provider: 'ollama',
        route: 'local',
        runId: 'account-deletion-group-first',
        operationId: 'account-deletion-group-repair',
        validationStatus: 'valid',
        queueWaitMs: 0,
        durationMs: 10,
      })
      .mockRejectedValueOnce(accountDeletion);
    const fixture = seedFixture(db, 'account-deletion-group-repair');
    const job = createFixtureJob(db, fixture, 'account-deletion-group-repair');

    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-account-deletion-group-repair-001',
    }, db)).rejects.toBe(accountDeletion);

    expect(agentMocks.executeSkillInference).toHaveBeenCalledTimes(2);
    expect(getContentAgentJob(OWNER, job.jobKey, db)).toMatchObject({ status: 'failed' });
  });

  it('keeps the legacy cloud specialist workflow when runtime control is off', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'off';
    agentMocks.completeOneShotWithFallback.mockImplementation(async (
      _system: unknown,
      _user: unknown,
      rawCategory: unknown,
    ) => validProviderCompletion(
      String(rawCategory).replace('content_agent_', '') as ContentAgentRole,
      'gemini',
    ));
    const fixture = seedFixture(db, 'local-control-off');

    const completed = await runFixtureJob(db, fixture, 'local-control-off');

    expect(agentMocks.withAiBudgetReservation).toHaveBeenCalledTimes(1);
    expect(agentMocks.runWithAccountAdmission).toHaveBeenCalledTimes(7);
    expect(agentMocks.completeOneShotWithFallback).toHaveBeenCalledTimes(7);
    expect(agentMocks.executeSkillInference).not.toHaveBeenCalled();
    expect(completed.steps).toHaveLength(7);
    expect(completed.steps.every((step) => step.summary.provider === 'gemini')).toBe(true);
  });

  it('stops the legacy cloud specialist job when account deletion aborts provider admission', async () => {
    agentMocks.contentSpecialistsEnabled = true;
    agentMocks.localControlMode = 'off';
    const accountDeletion = Object.assign(new Error('account deletion started'), {
      name: 'AbortError',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    agentMocks.runWithAccountAdmission.mockRejectedValue(accountDeletion);
    const fixture = seedFixture(db, 'account-deletion-cloud');
    const job = createFixtureJob(db, fixture, 'account-deletion-cloud');

    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-account-deletion-cloud-001',
    }, db)).rejects.toBe(accountDeletion);

    expect(agentMocks.completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(getContentAgentJob(OWNER, job.jobKey, db)).toMatchObject({
      status: 'failed',
    });
  });

  it('falls back per specialist on invalid provider output and reports a mixed execution truthfully', async () => {
    const fixture = seedFixture(db, 'mixed-provider');
    agentMocks.completeOneShotWithFallback.mockImplementation(async (
      _system: unknown,
      _user: unknown,
      rawCategory: unknown,
    ) => {
      const role = String(rawCategory).replace('content_agent_', '') as ContentAgentRole;
      if (role === 'structural_editor') return { text: '{"unexpected":true}', provider: 'openai' };
      return validProviderCompletion(role, 'openai');
    });

    const before = listContentRevisions(OWNER, fixture.artifact.id, db);
    const completed = await runFixtureJob(db, fixture, 'mixed-provider');
    const fallbackStep = completed.steps.find((step) => step.role === 'structural_editor')!;
    const fallbackProposal = completed.proposals.find((proposal) => proposal.role === 'editor')!;

    expect(completed).toMatchObject({
      status: 'completed',
      executionMode: 'mixed',
      independentReviewPerformed: false,
    });
    expect(fallbackStep.summary).toMatchObject({
      basis: 'package_derived',
      provider: null,
      fallbackReason: 'provider_output_invalid',
      independentReviewPerformed: false,
    });
    expect(fallbackProposal).toMatchObject({
      reviewBasis: 'package_derived',
      provider: null,
      fallbackReason: 'provider_output_invalid',
      independentReviewPerformed: false,
    });
    expect(completed.steps.filter((step) => step.role !== 'structural_editor').every((step) => (
      step.summary.basis === 'provider_routed' && step.summary.provider === 'openai'
    ))).toBe(true);
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toEqual(before);
    expect(JSON.stringify(completed)).not.toContain('{"unexpected":true}');
  });

  it('contains mismatched specialist output before provider bytes can become a proposal', async () => {
    const fixture = seedFixture(db, 'provider-language-containment');
    const leakedSpanish = 'Aquí tienes el guion completo para organizar todas tus tareas.';
    agentMocks.completeOneShotWithFallback.mockImplementation(async (
      _system: unknown,
      _user: unknown,
      rawCategory: unknown,
    ) => {
      const role = String(rawCategory).replace('content_agent_', '') as ContentAgentRole;
      if (role !== 'writer') return validProviderCompletion(role, 'gemini');
      return {
        provider: 'gemini',
        text: JSON.stringify({
          schemaVersion: 'content-agent-specialist-output-v1',
          role,
          title: 'Borrador completo',
          summary: 'Preparé una propuesta clara para revisar.',
          warnings: [],
          nextAction: 'Revisa el resultado antes de aceptar los cambios.',
          proposal: {
            title: 'Opción de guion',
            summary: 'Una propuesta editable para el contenido.',
            reason: 'Mejora la estructura y mantiene el objetivo.',
            markdown: `# Guion\n\n${leakedSpanish}`,
          },
        }),
      };
    });

    const completed = await runFixtureJob(db, fixture, 'provider-language-containment');
    const writer = completed.steps.find((step) => step.role === 'writer')!;
    const writerProposal = completed.proposals.find((proposal) => proposal.role === 'writer')!;
    const writerSystemPrompt = String(
      agentMocks.completeOneShotWithFallback.mock.calls
        .find((call) => call[2] === 'content_agent_writer')?.[0] ?? '',
    );

    expect(writerSystemPrompt).toContain('Generate every user-facing field only in English.');
    expect(writer.summary).toMatchObject({
      basis: 'package_derived',
      fallbackReason: 'provider_output_invalid',
    });
    expect(writerProposal).toMatchObject({
      reviewBasis: 'package_derived',
      fallbackReason: 'provider_output_invalid',
    });
    expect(JSON.stringify(completed)).not.toContain(leakedSpanish);
    expect(JSON.stringify(completed)).not.toContain('Borrador completo');
  });

  it('rejects one Spanish provider field even when the remaining specialist output is English', async () => {
    const fixture = seedFixture(db, 'provider-field-language-containment');
    agentMocks.completeOneShotWithFallback.mockImplementation(async (
      _system: unknown,
      _user: unknown,
      rawCategory: unknown,
    ) => {
      const role = String(rawCategory).replace('content_agent_', '') as ContentAgentRole;
      if (role !== 'writer') return validProviderCompletion(role, 'gemini');
      const valid = validProviderCompletion(role, 'gemini');
      const parsed = JSON.parse(valid.text);
      parsed.title = 'Cómo organizar tus tareas';
      return { ...valid, text: JSON.stringify(parsed) };
    });

    const completed = await runFixtureJob(db, fixture, 'provider-field-language-containment');
    const writer = completed.steps.find((step) => step.role === 'writer')!;

    expect(writer.summary).toMatchObject({
      basis: 'package_derived',
      fallbackReason: 'provider_output_invalid',
    });
    expect(JSON.stringify(completed)).not.toContain('Cómo organizar tus tareas');
  });

  it('suppresses a preserved Spanish package draft instead of materializing a new fallback proposal', async () => {
    const fixture = seedFixture(db, 'spanish-package-containment', (pkg) => ({
      ...pkg,
      scriptVariants: pkg.scriptVariants.map((variant) => ({
        ...variant,
        title: 'Cómo organizar tus tareas',
        coldOpen: 'Aquí tienes el guion completo.',
        promise: 'Aprenderás cómo mejorar tu rutina.',
        beats: ['Revisa todas tus tareas.', 'Elige la próxima acción.'],
        payoff: 'Tendrás una rutina más clara.',
        cta: 'Comparte este vídeo con alguien.',
      })),
    }));

    const completed = await runFixtureJob(db, fixture, 'spanish-package-containment');

    expect(completed.proposals).toEqual([]);
    expect(JSON.stringify(completed)).not.toContain('Cómo organizar tus tareas');
    expect(JSON.stringify(completed)).not.toContain('Aquí tienes el guion completo.');
  });

  it('localizes provider-unavailable fallback summaries for a Portuguese user', async () => {
    agentMocks.getUserLanguage.mockReturnValue('pt-BR');
    const fixture = seedFixture(db, 'portuguese-fallback-copy');

    const completed = await runFixtureJob(db, fixture, 'portuguese-fallback-copy');

    expect(completed.steps.every((step) => (
      step.summary.summary.includes('pacote')
      || step.summary.summary.includes('revisão')
      || step.summary.summary.includes('fontes')
    ))).toBe(true);
    expect(JSON.stringify(completed.steps)).not.toContain('Model-backed specialist review was unavailable');
  });

  it('uses the same proposal engine with an explicit budget-derived fallback', async () => {
    const fixture = seedFixture(db, 'budget-fallback');
    agentMocks.withAiBudgetReservation.mockRejectedValueOnce(new AiBudgetError({
      code: 'AI_BUDGET_EXCEEDED',
    } as any));

    const completed = await runFixtureJob(db, fixture, 'budget-fallback');

    expect(agentMocks.completeOneShotWithFallback).not.toHaveBeenCalled();
    expect(completed).toMatchObject({
      status: 'completed',
      executionMode: 'package_derived',
      independentReviewPerformed: false,
    });
    expect(completed.steps.every((step) => (
      step.summary.basis === 'package_derived'
      && step.summary.fallbackReason === 'budget_unavailable'
      && step.summary.warnings.some((warning) => warning.includes('AI budget'))
    ))).toBe(true);
    expect(completed.proposals.every((proposal) => proposal.fallbackReason === 'budget_unavailable')).toBe(true);
  });

  it('does not allow a proposal decision before the whole preparation graph completes', () => {
    const fixture = seedFixture(db, 'early-decision');
    const queued = createFixtureJob(db, fixture, 'early-decision');
    const row = db.prepare(`
      SELECT j.id AS job_id, s.id AS step_id
        FROM content_agent_jobs j
        JOIN content_agent_job_steps s ON s.job_id = j.id AND s.role = 'writer'
       WHERE j.job_key = ?
    `).get(queued.jobKey) as { job_id: number; step_id: number };
    const suggested = { format: 'markdown', text: '# Early suggestion\nDo not apply yet.' };
    const suggestedHash = createHash('sha256').update(JSON.stringify(suggested)).digest('hex');
    db.prepare(`
      INSERT INTO content_agent_proposals (
        proposal_key, tenant_id, owner_user_id, job_id, step_id,
        proposal_role, artifact_id, base_revision_id, base_revision_number,
        base_content_hash, content_format, suggested_content_text,
        suggested_content_hash, title, summary, reason, created_by
      ) VALUES (?, ?, ?, ?, ?, 'writer', ?, ?, 1, ?, 'markdown', ?, ?, ?, ?, ?, ?)
    `).run(
      'cap_early_decision',
      OWNER.tenantId,
      OWNER.userId,
      row.job_id,
      row.step_id,
      fixture.artifact.id,
      fixture.artifact.currentRevision!.id,
      fixture.artifact.currentRevision!.contentHash,
      suggested.text,
      suggestedHash,
      'Early suggestion',
      'Not ready for a decision.',
      'The remaining checks have not finished.',
      OWNER.userId,
    );

    expect(() => acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: 'cap_early_decision',
      idempotencyKey: 'accept-early-agent-proposal-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_JOB_REVIEW_INCOMPLETE',
    }));
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toHaveLength(1);
  });

  it('accepts exactly one proposal through canonical revision CAS and stales siblings', async () => {
    const fixture = seedFixture(db, 'accept');
    const job = await runFixtureJob(db, fixture, 'accept');
    const [writer, editor] = job.proposals;
    const rejected = rejectContentAgentProposal({
      scope: OWNER,
      proposalKey: writer!.proposalKey,
      idempotencyKey: 'reject-agent-proposal-001',
    }, db);
    expect(rejected.value.status).toBe('rejected');
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toHaveLength(1);

    const accepted = acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: editor!.proposalKey,
      idempotencyKey: 'accept-agent-proposal-001',
    }, db);
    const replay = acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: editor!.proposalKey,
      idempotencyKey: 'accept-agent-proposal-001',
    }, db);

    expect(accepted.value.status).toBe('accepted');
    expect(accepted.value.acceptedRevisionId).toBeTypeOf('number');
    expect(replay).toMatchObject({ replayed: true, changed: false });
    const revisions = listContentRevisions(OWNER, fixture.artifact.id, db);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({
      revisionNumber: 2,
      actorType: 'agent',
      changeReason: 'content_agent_proposal_accepted',
    });
    expect(revisions[0]?.provenance).toMatchObject({
      source: 'content_agent_proposal',
      jobKey: job.jobKey,
      proposalKey: editor!.proposalKey,
      specialistExecutionBasis: 'package_derived',
      specialistProvider: null,
      specialistFallbackReason: 'provider_unavailable',
    });
    const refreshed = getContentAgentJob(OWNER, job.jobKey, db)!;
    expect(refreshed.proposals.filter((proposal) => proposal.status === 'accepted')).toHaveLength(1);
    expect(refreshed.proposals.filter((proposal) => proposal.status === 'stale')).toHaveLength(1);
    expect(refreshed.proposals.filter((proposal) => proposal.status === 'rejected')).toHaveLength(1);
  });

  it('accepts a platform option as a separate variant without replacing the source draft', async () => {
    const fixture = seedFixture(db, 'platform-variant');
    const job = await runFixtureJob(db, fixture, 'platform-variant');
    const platform = job.proposals.find((proposal) => proposal.role === 'platform_adapter')!;
    const sourceRevisionId = fixture.artifact.currentRevision!.id;

    const accepted = acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: platform.proposalKey,
      idempotencyKey: 'accept-platform-variant-001',
    }, db);
    const replay = acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: platform.proposalKey,
      idempotencyKey: 'accept-platform-variant-001',
    }, db);

    expect(accepted.value).toMatchObject({
      status: 'accepted',
      acceptanceKind: 'platform_variant',
      acceptedArtifactId: expect.any(Number),
      acceptedRevisionId: expect.any(Number),
    });
    expect(accepted.value.acceptedArtifactId).not.toBe(fixture.artifact.id);
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(listContentRevisions(OWNER, fixture.artifact.id, db)).toEqual([
      expect.objectContaining({ id: sourceRevisionId, revisionNumber: 1 }),
    ]);

    const detail = getContentWorkspaceItemDetail(OWNER, fixture.artifact.itemId, db)!;
    expect(detail.currentArtifactId).toBe(fixture.artifact.id);
    const variant = detail.artifacts.find((artifact) => artifact.id === accepted.value.acceptedArtifactId)!;
    expect(variant).toMatchObject({
      artifactType: 'platform_variant',
      platformId: 'youtube',
      currentRevision: expect.objectContaining({ actorType: 'agent', revisionNumber: 1 }),
    });
    expect(listContentArtifactRelationships(OWNER, [fixture.artifact.id, variant.id], db)).toEqual([
      expect.objectContaining({
        fromArtifactId: variant.id,
        toArtifactId: fixture.artifact.id,
        relationshipType: 'variant_of',
      }),
    ]);
    const refreshed = getContentAgentJob(OWNER, job.jobKey, db)!;
    expect(refreshed.proposals.filter((proposal) => proposal.status === 'proposed')).toHaveLength(2);
  });

  it('persists stale outcomes and preserves user edits when the base changes', async () => {
    const fixture = seedFixture(db, 'stale');
    const job = await runFixtureJob(db, fixture, 'stale');
    saveContentRevision({
      scope: OWNER,
      artifactId: fixture.artifact.id,
      baseRevision: 1,
      content: { format: 'markdown', text: '# User edit\nPreserve this exact draft.' },
      idempotencyKey: 'user-edit-before-agent-accept-001',
    }, db);

    expect(() => acceptContentAgentProposal({
      scope: OWNER,
      proposalKey: job.proposals[0]!.proposalKey,
      idempotencyKey: 'stale-agent-proposal-accept-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PROPOSAL_STALE',
    }));

    const revisions = listContentRevisions(OWNER, fixture.artifact.id, db);
    expect(revisions).toHaveLength(2);
    expect(revisions[0]?.content).toEqual({ format: 'markdown', text: '# User edit\nPreserve this exact draft.' });
    expect(getContentAgentJob(OWNER, job.jobKey, db)?.proposals.every((proposal) => proposal.status === 'stale')).toBe(true);
  });

  it('recovers an expired lease but rejects an active lease', async () => {
    const activeFixture = seedFixture(db, 'active-lease');
    const active = createFixtureJob(db, activeFixture, 'active-lease');
    db.prepare(`
      UPDATE content_agent_jobs
         SET status = 'running', lease_token = 'active-token', lease_expires_at = ?
       WHERE job_key = ?
    `).run(new Date(Date.now() + 60_000).toISOString(), active.jobKey);
    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: active.jobKey,
      idempotencyKey: 'run-active-lease-001',
    }, db)).rejects.toMatchObject<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_JOB_ACTIVE' });

    const expiredFixture = seedFixture(db, 'expired-lease');
    const expired = createFixtureJob(db, expiredFixture, 'expired-lease');
    const firstStep = db.prepare('SELECT id FROM content_agent_job_steps WHERE job_id = (SELECT id FROM content_agent_jobs WHERE job_key = ?) ORDER BY id LIMIT 1')
      .get(expired.jobKey) as { id: number };
    db.prepare(`
      UPDATE content_agent_jobs
         SET status = 'running', lease_token = 'expired-token', lease_expires_at = ?
       WHERE job_key = ?
    `).run(new Date(Date.now() - 60_000).toISOString(), expired.jobKey);
    db.prepare("UPDATE content_agent_job_steps SET status = 'running' WHERE id = ?").run(firstStep.id);

    const recovered = await runContentAgentJob({
      scope: OWNER,
      jobKey: expired.jobKey,
      idempotencyKey: 'run-expired-lease-001',
    }, db);
    expect(recovered.value.status).toBe('completed');
    expect(recovered.value.steps.every((step) => step.status === 'completed')).toBe(true);
  });

  it('supports explicit cancellation and failed-job retry checkpoints', () => {
    const cancelFixture = seedFixture(db, 'cancel');
    const queued = createFixtureJob(db, cancelFixture, 'cancel');
    const cancelled = cancelContentAgentJob({
      scope: OWNER,
      jobKey: queued.jobKey,
      idempotencyKey: 'cancel-agent-job-001',
    }, db);
    expect(cancelled.value.status).toBe('cancelled');
    expect(cancelled.value.steps.every((step) => step.status === 'cancelled')).toBe(true);

    const retryFixture = seedFixture(db, 'retry');
    const failed = createFixtureJob(db, retryFixture, 'retry');
    db.prepare(`
      UPDATE content_agent_job_steps SET status = 'failed'
       WHERE id = (SELECT MIN(id) FROM content_agent_job_steps WHERE job_id = (SELECT id FROM content_agent_jobs WHERE job_key = ?))
    `).run(failed.jobKey);
    db.prepare("UPDATE content_agent_jobs SET status = 'failed', last_error_code = 'PROVIDER_FAILURE' WHERE job_key = ?")
      .run(failed.jobKey);
    const retried = retryContentAgentJob({
      scope: OWNER,
      jobKey: failed.jobKey,
      idempotencyKey: 'retry-agent-job-001',
    }, db);
    expect(retried.value.status).toBe('queued');
    expect(retried.value.steps[0]?.status).toBe('queued');
  });

  it('enforces tenant scope and blocks poisoned or safety-blocked packages before job creation', async () => {
    const fixture = seedFixture(db, 'scope');
    const job = createFixtureJob(db, fixture, 'scope');
    expect(getContentAgentJob(OTHER, job.jobKey, db)).toBeNull();
    expect(listContentAgentJobs({ scope: OTHER }, db).jobs).toEqual([]);
    expect(() => createContentAgentJob({
      scope: OTHER,
      artifactId: fixture.artifact.id,
      packageId: fixture.pkg.id,
      idempotencyKey: 'other-tenant-create-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PACKAGE_NOT_FOUND',
    }));
    await expect(runContentAgentJob({
      scope: OTHER,
      jobKey: job.jobKey,
      idempotencyKey: 'other-tenant-run-001',
    }, db)).rejects.toMatchObject<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_JOB_NOT_FOUND' });

    const blockedFixture = seedFixture(db, 'blocked', (pkg) => ({
      ...pkg,
      blockers: ['unsafe_claim_blocked'],
      quality: { ...pkg.quality, status: 'blocked', blockers: ['unsafe_claim_blocked'] },
    }));
    expect(() => createFixtureJob(db, blockedFixture, 'blocked')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_BLOCKED' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_agent_jobs WHERE source_package_id = ?')
      .get(blockedFixture.pkg.id)).toEqual({ count: 0 });

    const poisonedFixture = seedFixture(db, 'poisoned', (pkg) => ({ ...pkg, objective: 'mutated after hashing' }), false);
    expect(() => createFixtureJob(db, poisonedFixture, 'poisoned')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_INTEGRITY_FAILED' }),
    );

    const futureFixture = seedFixture(db, 'future-contract', (pkg) => ({
      ...pkg,
      generatorContractVersion: 'content-agency-package.v999',
    }));
    expect(() => createFixtureJob(db, futureFixture, 'future-contract')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_VERSION_UNSUPPORTED' }),
    );

    const malformedFixture = seedFixture(db, 'malformed-contract', (pkg) => ({
      ...pkg,
      positioning: undefined,
    } as unknown as ContentAgencyPackage));
    expect(() => createFixtureJob(db, malformedFixture, 'malformed-contract')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_INTEGRITY_FAILED' }),
    );
  });

  it('requires an exact immutable package-to-artifact handoff binding', () => {
    const unbound = seedFixture(db, 'unbound');
    db.prepare(`
      DELETE FROM content_workspace_ingress_bindings
       WHERE tenant_id = ? AND owner_user_id = ?
         AND source_kind = 'content_agency_package' AND source_id = ?
    `).run(OWNER.tenantId, OWNER.userId, unbound.pkg.id);

    expect(() => createFixtureJob(db, unbound, 'unbound')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_BINDING_REQUIRED' }),
    );
    expect(db.prepare('SELECT COUNT(*) AS count FROM content_agent_jobs WHERE source_package_id = ?')
      .get(unbound.pkg.id)).toEqual({ count: 0 });

    const pairedSource = seedFixture(db, 'paired-source');
    const pairedPackage = seedFixture(db, 'paired-package');
    expect(() => createContentAgentJob({
      scope: OWNER,
      artifactId: pairedSource.artifact.id,
      packageId: pairedPackage.pkg.id,
      idempotencyKey: 'create-agent-cross-paired-package-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PACKAGE_BINDING_MISMATCH',
    }));

    const mismatchedHash = seedFixture(db, 'binding-hash');
    db.prepare(`
      DELETE FROM content_workspace_ingress_bindings
       WHERE tenant_id = ? AND owner_user_id = ?
         AND source_kind = 'content_agency_package' AND source_id = ?
    `).run(OWNER.tenantId, OWNER.userId, mismatchedHash.pkg.id);
    persistPackageBinding(db, mismatchedHash.pkg, mismatchedHash.artifact, 'f'.repeat(64));
    expect(() => createFixtureJob(db, mismatchedHash, 'binding-hash')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_BINDING_MISMATCH' }),
    );

    const mismatchedVersion = seedFixture(
      db,
      'binding-version',
      (pkg) => pkg,
      true,
      'content-agency-package.v999',
    );
    expect(() => createFixtureJob(db, mismatchedVersion, 'binding-version')).toThrowError(
      expect.objectContaining<Partial<ContentAgentJobError>>({ code: 'CONTENT_AGENT_PACKAGE_BINDING_INTEGRITY_FAILED' }),
    );
  });

  it('revalidates package binding and contract version before run and retry resume', async () => {
    const fixture = seedFixture(db, 'resume-binding');
    const job = createFixtureJob(db, fixture, 'resume-binding');
    db.prepare(`
      DELETE FROM content_workspace_ingress_bindings
       WHERE tenant_id = ? AND owner_user_id = ?
         AND source_kind = 'content_agency_package' AND source_id = ?
    `).run(OWNER.tenantId, OWNER.userId, fixture.pkg.id);

    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-resume-unbound-001',
    }, db)).rejects.toMatchObject<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PACKAGE_BINDING_REQUIRED',
    });
    expect(getContentAgentJob(OWNER, job.jobKey, db)).toMatchObject({
      status: 'failed',
      lastErrorCode: 'CONTENT_AGENT_PACKAGE_BINDING_REQUIRED',
    });
    expect(() => retryContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'retry-agent-resume-unbound-001',
    }, db)).toThrowError(expect.objectContaining<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PACKAGE_BINDING_REQUIRED',
    }));

    persistPackageBinding(db, fixture.pkg, fixture.artifact);
    expect(retryContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'retry-agent-resume-rebound-001',
    }, db).value.status).toBe('queued');

    const future = { ...fixture.pkg, generatorContractVersion: 'content-agency-package.v999' };
    const futurePayload = { ...future, contentHash: computeContentAgencyArtifactHash(future) };
    db.prepare(`
      UPDATE content_agency_packages SET payload_json = ?
       WHERE agency_id = ? AND tenant_id = ? AND user_id = ?
    `).run(JSON.stringify(futurePayload), fixture.pkg.id, OWNER.tenantId, OWNER.userId);
    await expect(runContentAgentJob({
      scope: OWNER,
      jobKey: job.jobKey,
      idempotencyKey: 'run-agent-resume-future-version-001',
    }, db)).rejects.toMatchObject<Partial<ContentAgentJobError>>({
      code: 'CONTENT_AGENT_PACKAGE_VERSION_UNSUPPORTED',
    });
  });
});

function seedFixture(
  db: Database.Database,
  suffix: string,
  mutate: (pkg: ContentAgencyPackage) => ContentAgencyPackage = (pkg) => pkg,
  recompute = true,
  bindingContractVersion?: string,
): { artifact: ContentArtifact; pkg: ContentAgencyPackage } {
  const original = buildContentAgencyPackage({
    userId: OWNER.userId,
    tenantId: OWNER.tenantId,
    brief: {
      userId: OWNER.userId,
      tenantId: OWNER.tenantId,
      goal: `Teach a trustworthy creator workflow ${suffix}`,
      audience: 'founder-creators who need an evidence-backed process',
      platform: 'youtube',
      objective: 'help viewers capture, develop, and review one useful idea',
      brandVoice: 'clear, calm, specific, and evidence-led',
    },
    references: ['private-workspace-note'],
  });
  let pkg = mutate(original);
  if (recompute) {
    // Rebuild through the package builder is unnecessary for ordinary tests;
    // changed safety fields are deliberately represented with a valid pinned
    // package hash so the policy gate, not integrity, is under test.
    pkg = { ...pkg, contentHash: computeContentAgencyArtifactHash(pkg) };
  }
  persistPackageRow(db, pkg);
  const item = createContentWorkspaceItem({
    scope: OWNER,
    itemType: 'content_item',
    title: `Agent workspace ${suffix}`,
    idempotencyKey: `agent-item-${suffix}-001`,
  }, db).value;
  const artifact = createContentArtifact({
    scope: OWNER,
    itemId: item.id,
    expectedWorkflowVersion: item.workflowVersion,
    artifactType: 'script',
    initialContent: { format: 'markdown', text: `# Current draft\nPrivate base ${suffix}.` },
    actorType: 'agent',
    actorId: 'content_agency',
    provenance: {
      sourceKind: 'content_agency_package',
      packageId: pkg.id,
      packageHash: pkg.contentHash,
      generatorContractVersion: bindingContractVersion ?? pkg.generatorContractVersion,
    },
    idempotencyKey: `agent-artifact-${suffix}-001`,
  }, db).value;
  persistPackageBinding(db, pkg, artifact);
  return { artifact, pkg };
}

function persistPackageRow(db: Database.Database, pkg: ContentAgencyPackage): void {
  db.prepare(`
    INSERT INTO content_agency_packages (
      agency_id, user_id, tenant_id, visibility_scope, platform, format,
      status, source_trace_json, quality_score, warnings_json, blockers_json,
      payload_json
    ) VALUES (?, ?, ?, 'user_private', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pkg.id,
    pkg.userId,
    pkg.tenantId,
    pkg.platform,
    pkg.format,
    pkg.quality.status,
    JSON.stringify(pkg.sourceTrace ?? []),
    pkg.quality.score,
    JSON.stringify(pkg.warnings ?? []),
    JSON.stringify(pkg.blockers ?? []),
    JSON.stringify(pkg),
  );
}

function persistPackageBinding(
  db: Database.Database,
  pkg: ContentAgencyPackage,
  artifact: ContentArtifact,
  sourceHash = pkg.contentHash,
): void {
  db.prepare(`
    INSERT INTO content_workspace_ingress_bindings (
      tenant_id, owner_user_id, source_kind, source_id, source_hash,
      item_id, artifact_id, revision_id, content_parity_status, ingress_origin
    ) VALUES (?, ?, 'content_agency_package', ?, ?, ?, ?, ?, 'artifact_pinned', 'content_agency_handoff')
  `).run(
    OWNER.tenantId,
    OWNER.userId,
    pkg.id,
    sourceHash,
    artifact.itemId,
    artifact.id,
    artifact.currentRevision!.id,
  );
}

function createFixtureJob(
  db: Database.Database,
  fixture: { artifact: ContentArtifact; pkg: ContentAgencyPackage },
  suffix: string,
) {
  return createContentAgentJob({
    scope: OWNER,
    artifactId: fixture.artifact.id,
    packageId: fixture.pkg.id,
    idempotencyKey: `create-agent-${suffix}-001`,
  }, db).value;
}

async function runFixtureJob(
  db: Database.Database,
  fixture: { artifact: ContentArtifact; pkg: ContentAgencyPackage },
  suffix: string,
) {
  const job = createFixtureJob(db, fixture, suffix);
  return (await runContentAgentJob({
    scope: OWNER,
    jobKey: job.jobKey,
    idempotencyKey: `run-agent-${suffix}-001`,
  }, db)).value;
}

function validProviderCompletion(
  role: ContentAgentRole,
  provider: 'gemini' | 'openai' | 'anthropic',
): { text: string; provider: 'gemini' | 'openai' | 'anthropic' } {
  const proposalRole = role === 'writer' || role === 'structural_editor' || role === 'platform_adapter';
  const title = `${role.split('_').map((part) => part[0]!.toUpperCase() + part.slice(1)).join(' ')} provider review`;
  return {
    provider,
    text: JSON.stringify({
      schemaVersion: 'content-agent-specialist-output-v1',
      role,
      title,
      summary: `${title} completed against the bounded package and dependency context.`,
      warnings: role === 'research' || role === 'factuality'
        ? ['Model review did not independently verify linked sources.']
        : [],
      nextAction: 'Review the specialist result before accepting any change.',
      proposal: proposalRole ? {
        title: `${title} option`,
        summary: `Optional ${role} suggestion from the provider-routed workflow.`,
        reason: 'Improve the draft while preserving the user objective and explicit constraints.',
        markdown: `# ${role} provider draft\n\nA bounded, editable ${role} proposal.`,
      } : null,
    }),
  };
}
