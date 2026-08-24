// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMock, modelPolicyMock, warningMock, entitlementMock, freeTierFlagMock } = vi.hoisted(() => ({
  dispatchMock: vi.fn(),
  modelPolicyMock: { unavailable: false },
  warningMock: vi.fn(),
  entitlementMock: { plan: 'pro', aiAccessAllowed: true },
  freeTierFlagMock: { enabled: false },
}));

vi.mock('../../src/config', () => ({ config: { isStaging: true, ollama: { enabled: true }, freeTierLocalInference: freeTierFlagMock } }));
vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => { throw new Error('explicit test database required'); },
}));
vi.mock('../../src/services/entitlement', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/entitlement')>('../../src/services/entitlement')),
  getEffectiveEntitlement: () => ({ ...entitlementMock }),
}));
vi.mock('../../src/services/provider-registry', () => ({
  ensureActiveProvider: () => ({ dispatchLocalReasoning: (...args: unknown[]) => dispatchMock(...args) }),
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service')),
  getOwnerBootstrapTarget: () => ({ tenantId: 42, telegramId: 99 }),
}));
vi.mock('../../src/services/ollama-model-policy', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/ollama-model-policy')>(
    '../../src/services/ollama-model-policy',
  )),
  getLocalModelManifest: () => {
    if (modelPolicyMock.unavailable) throw new Error('manifest unavailable');
    return {
      manifestVersion: 'test-v1',
      activeModelId: 'control',
      models: [{ id: 'control', maxContextTokens: 16_384, digest: 'sha256:test' }],
      productionEnvelope: {
        maxContextTokens: 16_384,
        parallelGenerations: 1,
        waitingQueueDepth: 4,
      },
    };
  },
  tryGetLocalModelManifest: () => modelPolicyMock.unavailable
    ? { ok: false as const, code: 'model_manifest_unavailable' as const }
    : {
      ok: true as const,
      manifest: {
        manifestVersion: 'test-v1',
        activeModelId: 'control',
        models: [{ id: 'control', maxContextTokens: 16_384, digest: 'sha256:test' }],
        productionEnvelope: {
          maxContextTokens: 16_384,
          parallelGenerations: 1,
          waitingQueueDepth: 4,
        },
      },
    },
}));
vi.mock('../../src/services/api-usage-attribution', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/api-usage-attribution')>(
    '../../src/services/api-usage-attribution',
  )),
  runWithApiUsageAttribution: (_attribution: unknown, call: () => unknown) => call(),
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: {
    warn: (...args: unknown[]) => warningMock(...args),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
}));
vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: {
    waitingQueueDepth: 4,
    maxOutputTokens: 6_144,
    maxContextTokens: 16_384,
    staffUserIds: [42],
    contentProxyEnabled: true,
    gatewaySocketPath: '/private/tmp/nexus-test-ollama.sock',
    hardKill: false,
  },
}));

const migrationSql = readFileSync(
  resolve(__dirname, '../../migrations/284_local_primary_inference_foundation.sql'),
  'utf8',
);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE plan_configs (
      plan_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      daily_cost_usd REAL NOT NULL DEFAULT 0,
      monthly_cost_usd REAL NOT NULL DEFAULT 0,
      allowed_skills_json TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE subscriptions (user_id INTEGER PRIMARY KEY, plan TEXT NOT NULL);
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      user_id INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO users (id, status) VALUES (42, 'active');
    INSERT INTO plan_configs (plan_id, display_name) VALUES ('pro', 'Pro');
  `);
  db.exec(migrationSql);
  db.prepare(`UPDATE local_inference_runtime_control
    SET mode = 'shadow', rollout_percent = 0, model_manifest_version = 'test-v1',
        active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
    WHERE environment = 'staging'`).run();
  return db;
}

describe('skill inference service', () => {
  beforeEach(async () => {
    dispatchMock.mockReset();
    warningMock.mockReset();
    modelPolicyMock.unavailable = false;
    entitlementMock.plan = 'pro';
    entitlementMock.aiAccessAllowed = true;
    freeTierFlagMock.enabled = false;
    const { localInferenceScheduler } = await import('../../src/services/local-inference-scheduler');
    const { resetLocalInferenceEmergencyOffLatchForTests } = await import(
      '../../src/services/local-inference-runtime-control'
    );
    localInferenceScheduler.resetForTests();
    resetLocalInferenceEmergencyOffLatchForTests();
  });

  it('keeps configured staff in every canary cohort without enrolling other users at zero percent', async () => {
    const { isLocalInferenceUserEnrolled } = await import('../../src/services/skill-inference-service');
    expect(isLocalInferenceUserEnrolled(42, 0)).toBe(true);
    expect(isLocalInferenceUserEnrolled(43, 0)).toBe(false);
  });

  it('resolves local-to-cloud fallback ceilings from the active plan configuration', async () => {
    const db = database();
    const { getSkillInferenceCloudFallbackCostCaps } = await import('../../src/services/skill-inference-service');

    expect(getSkillInferenceCloudFallbackCostCaps(42, db)).toEqual({
      perRunUsd: 0.15,
      perDayUsd: 0.40,
    });
    db.prepare(`UPDATE plan_configs
      SET local_cloud_fallback_run_usd = 0.12,
          local_cloud_fallback_daily_usd = 0.35
      WHERE plan_id = 'pro'`).run();
    expect(getSkillInferenceCloudFallbackCostCaps(42, db)).toEqual({
      perRunUsd: 0.12,
      perDayUsd: 0.35,
    });
    db.close();
  });

  it('falls back to compiled limits for malformed persisted plan policy without overriding valid zero caps', async () => {
    const db = database();
    const { getSkillInferenceCloudFallbackCostCaps } = await import('../../src/services/skill-inference-service');

    db.prepare(`UPDATE plan_configs
      SET local_operations_hourly = 100001,
          ordinary_context_tokens = 99999,
          content_context_tokens = 8192,
          script_segment_output_tokens = 9999,
          local_queue_weight = 99,
          local_cloud_fallback_run_usd = 999,
          local_cloud_fallback_daily_usd = 9999
      WHERE plan_id = 'pro'`).run();
    expect(getSkillInferenceCloudFallbackCostCaps(42, db)).toEqual({
      perRunUsd: 0.15,
      perDayUsd: 0.40,
    });

    db.prepare(`UPDATE plan_configs
      SET local_operations_hourly = 20,
          local_operations_daily = 100,
          ordinary_context_tokens = 8192,
          content_context_tokens = 12288,
          script_segment_output_tokens = 5120,
          local_queue_weight = 1,
          local_cloud_fallback_run_usd = 0,
          local_cloud_fallback_daily_usd = 0
      WHERE plan_id = 'pro'`).run();
    expect(getSkillInferenceCloudFallbackCostCaps(42, db)).toEqual({
      perRunUsd: 0,
      perDayUsd: 0,
    });
    db.close();
  });

  it('runs private shadow-local evidence out of band without cloud or fair-use accounting', async () => {
    const db = database();
    let releaseLocal!: (value: unknown) => void;
    const localPending = new Promise((resolvePending) => { releaseLocal = resolvePending; });
    dispatchMock.mockImplementation(async () => localPending);
    const { scheduleSkillInferenceShadowAttempt } = await import('../../src/services/skill-inference-service');

    scheduleSkillInferenceShadowAttempt({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'shadow_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'shadow-operation',
      prompt: 'Create a public outline.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'shadow_content' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db);
    await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(1));

    releaseLocal({
      text: 'local shadow response',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    await vi.waitFor(() => {
      expect((db.prepare(`SELECT COUNT(*) AS count FROM skill_inference_attempts
        WHERE run_id IN (SELECT run_id FROM skill_inference_runs WHERE operation_id = 'shadow-operation')`)
        .get() as { count: number }).count).toBe(1);
    });
    expect(db.prepare(`SELECT route, outcome FROM skill_inference_attempts
      ORDER BY attempt_number`).all()).toEqual([
      { route: 'local', outcome: 'success' },
    ]);
    expect(db.prepare(`SELECT local_admission_requested AS counted, evaluation_mode, final_route
      FROM skill_inference_runs WHERE operation_id = 'shadow-operation'`).get()).toEqual({
      counted: 0,
      evaluation_mode: 'shadow',
      final_route: 'none',
    });
    expect(warningMock).not.toHaveBeenCalled();
    db.close();
  });

  it('marks a completed cloud result invalid when the application rejects it', async () => {
    const db = database();
    dispatchMock.mockResolvedValueOnce({
      text: 'cloud output later rejected by the application',
      providerMetadata: {
        providerUsed: 'openai',
        modelUsed: 'gpt-5.6-luna',
        inputTokens: 20,
        outputTokens: 10,
      },
    });
    const {
      executeSkillInference,
      rejectSkillInferenceApplicationResult,
    } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'script_section',
      riskClass: 'low',
      executionClass: 'background',
      operationId: 'cloud-application-rejection',
      runId: 'cloud-application-rejection-run',
      prompt: 'Write one non-sensitive script section.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: true,
      requestSource: 'automation',
      budgetRequest: {
        userId: 42,
        requestSource: 'automation',
        baseCategory: 'content_script_job_script_section',
      },
      cloudBudgetBoundary: async <T>(_request: unknown, call: () => Promise<T>) => call(),
    }, db)).resolves.toMatchObject({ route: 'cloud', provider: 'openai' });

    rejectSkillInferenceApplicationResult({
      runId: 'cloud-application-rejection-run',
      tenantId: 42,
      userId: 42,
      reason: 'content_script_section_semantic_invalid',
    }, db);

    expect(db.prepare(`SELECT status, final_route, validation_status, fallback_reason
      FROM skill_inference_runs WHERE run_id = ?`).get('cloud-application-rejection-run')).toEqual({
      status: 'failed',
      final_route: 'none',
      validation_status: 'invalid',
      fallback_reason: 'content_script_section_semantic_invalid',
    });
    db.close();
  });

  it('repairs invalid local schema once without entering the cloud budget boundary', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock
      .mockRejectedValueOnce(Object.assign(new Error('bad json'), { kind: 'invalid_json' }))
      .mockResolvedValueOnce({
        text: '{"answer":"repaired"}',
        parsed: { answer: 'repaired' },
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'control',
          modelDigest: 'sha256:test',
          inputTokens: 120,
          outputTokens: 20,
          firstTokenMs: 400,
          generationTokensPerSec: 5,
        },
      });
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const result = await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'structured_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'one-visible-operation',
      prompt: 'Return the answer.',
      schemaId: 'generic_json',
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string' } },
      },
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'structured_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db);
    expect(result).toMatchObject({
      route: 'local', validationStatus: 'valid', inputTokens: 120, outputTokens: 20,
    });
    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls[0]?.[0]).toMatchObject({
      numPredict: 5_120,
    });
    expect(dispatchMock.mock.calls[0]?.[0].numCtx).toBeLessThan(12_288);
    expect(dispatchMock.mock.calls[0]?.[0].numCtx).toBeGreaterThan(5_120);
    expect(db.prepare(`SELECT attempt_number, route, outcome FROM skill_inference_attempts
      ORDER BY attempt_number`).all()).toEqual([
      { attempt_number: 1, route: 'local', outcome: 'failure' },
      { attempt_number: 2, route: 'local', outcome: 'success' },
    ]);
    db.close();
  });

  it('normalizes an empty provider metadata value before writing constrained attempt telemetry', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValueOnce({
      text: 'local answer',
      providerMetadata: { providerUsed: '   ', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'empty-provider-normalization',
      runId: 'empty-provider-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db)).resolves.toMatchObject({ provider: 'ollama', route: 'local' });
    expect(db.prepare(`SELECT provider FROM skill_inference_attempts
      WHERE run_id = 'empty-provider-run'`).get()).toEqual({ provider: 'ollama' });
    db.close();
  });

  it('uses one normalized operation identity for fair use, persistence, and the result contract', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValueOnce({
      text: 'local answer',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    const result = await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: '  normalized-operation  ',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db);

    expect(result.operationId).toBe('normalized-operation');
    expect(db.prepare(`SELECT operation_id FROM skill_inference_runs`).get()).toEqual({
      operation_id: 'normalized-operation',
    });
    db.close();
  });

  it('fences account deletion durably and aborts the user\'s active provider request', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    let markProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
    dispatchMock.mockImplementationOnce(async (input: { abortSignal?: AbortSignal }) => {
      markProviderStarted();
      return new Promise((_resolve, reject) => {
        const rejectFromAbort = () => reject(input.abortSignal?.reason ?? new Error('aborted'));
        if (input.abortSignal?.aborted) rejectFromAbort();
        else input.abortSignal?.addEventListener('abort', rejectFromAbort, { once: true });
      });
    });
    const {
      beginSkillInferenceAccountDeletionFence,
      clearSkillInferenceAccountDeletionFence,
      executeSkillInference,
      getSkillInferenceExternalCloudFallbackEligibility,
      isSkillInferenceAccountDeletionFenced,
      recordSkillInferenceExternalCloudAttempt,
      waitForSkillInferenceAccountAdmissionsToDrain,
    } = await import('../../src/services/skill-inference-service');
    const request = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'chat_read_only_generation',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      operationId: 'account-deletion-active-operation',
      runId: 'account-deletion-active-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    };

    const active = executeSkillInference(request, db);
    await providerStarted;
    const fenceToken = beginSkillInferenceAccountDeletionFence(42, db);
    expect(isSkillInferenceAccountDeletionFenced(42, db)).toBe(true);
    await expect(active).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    await expect(waitForSkillInferenceAccountAdmissionsToDrain(42, {
      timeoutMs: 100,
      pollIntervalMs: 1,
    })).resolves.toBeUndefined();
    await expect(executeSkillInference({
      ...request,
      operationId: 'account-deletion-blocked-operation',
      runId: 'account-deletion-blocked-run',
    }, db)).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT status, fallback_reason FROM skill_inference_runs
      WHERE run_id = 'account-deletion-active-run'`).get()).toEqual({
      status: 'failed',
      fallback_reason: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: 'account-deletion-active-run', tenantId: 42, userId: 42,
    }, db)).toEqual({ allowed: false, reason: 'account_deletion_in_progress' });
    expect(() => beginSkillInferenceAccountDeletionFence(42, db))
      .toThrow(expect.objectContaining({ code: 'ACCOUNT_DELETION_IN_PROGRESS' }));
    db.prepare(`UPDATE local_inference_account_deletion_fences
      SET runtime_instance_id = ? WHERE user_id = ?`)
      .run('00000000-0000-4000-8000-000000000099', 42);
    const restartedFenceToken = beginSkillInferenceAccountDeletionFence(42, db);
    expect(restartedFenceToken).not.toBe(fenceToken);
    expect(clearSkillInferenceAccountDeletionFence(42, 'wrong-token', db)).toBe(false);
    expect(clearSkillInferenceAccountDeletionFence(42, fenceToken, db)).toBe(false);
    expect(clearSkillInferenceAccountDeletionFence(42, restartedFenceToken, db)).toBe(true);
    expect(isSkillInferenceAccountDeletionFenced(42, db)).toBe(false);
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: 'account-deletion-active-run', tenantId: 42, userId: 42,
    }, db)).toEqual({ allowed: false, reason: 'cancelled' });
    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'account-deletion-active-run',
      tenantId: 42,
      userId: 42,
      outcome: 'success',
      provider: 'openai',
      fallbackReason: 'forbidden_after_account_deletion',
      durationMs: 1,
    }, db)).toThrow(expect.objectContaining({ code: 'EXTERNAL_CLOUD_FALLBACK_STATE_INVALID' }));
    db.close();
  });

  it('fails deletion safely when an admitted provider ignores cancellation past the drain deadline', async () => {
    const db = database();
    let releaseOperation!: () => void;
    const operationHold = new Promise<void>((resolve) => { releaseOperation = resolve; });
    const {
      beginSkillInferenceAccountDeletionFence,
      clearSkillInferenceAccountDeletionFence,
      runWithSkillInferenceAccountAdmission,
      waitForSkillInferenceAccountAdmissionsToDrain,
    } = await import('../../src/services/skill-inference-service');
    const active = runWithSkillInferenceAccountAdmission(
      { userId: 42 },
      async () => {
        await operationHold;
        return 'completed';
      },
      db,
    );

    const fenceToken = beginSkillInferenceAccountDeletionFence(42, db);
    await expect(waitForSkillInferenceAccountAdmissionsToDrain(42, { timeoutMs: 0 }))
      .rejects.toMatchObject({
        code: 'ACCOUNT_DELETION_INFERENCE_DRAIN_TIMEOUT',
        status: 503,
        details: { retryable: true },
    });
    releaseOperation();
    await expect(active).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    await expect(waitForSkillInferenceAccountAdmissionsToDrain(42, { timeoutMs: 0 }))
      .resolves.toBeUndefined();
    expect(clearSkillInferenceAccountDeletionFence(42, fenceToken, db)).toBe(true);
    db.close();
  });

  it('does not enter account-scoped model work when the caller is already cancelled', async () => {
    const db = database();
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('client disconnected'), {
      name: 'AbortError',
      code: 'CHAT_CLIENT_DISCONNECTED',
    }));
    const operation = vi.fn(async () => 'must-not-run');
    const { runWithSkillInferenceAccountAdmission } = await import('../../src/services/skill-inference-service');

    await expect(runWithSkillInferenceAccountAdmission({
      userId: 42,
      abortSignal: controller.signal,
    }, operation, db)).rejects.toMatchObject({ code: 'INFERENCE_CANCELLED' });
    expect(operation).not.toHaveBeenCalled();
    db.close();
  });

  it('keeps erased or inactive accounts closed after their durable deletion fence is gone', async () => {
    const db = database();
    const operation = vi.fn(async () => 'must-not-run');
    const { runWithSkillInferenceAccountAdmission } = await import('../../src/services/skill-inference-service');

    db.prepare(`UPDATE users SET status = 'suspended' WHERE id = 42`).run();
    await expect(runWithSkillInferenceAccountAdmission({ userId: 42 }, operation, db))
      .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });

    db.prepare(`DELETE FROM users WHERE id = 42`).run();
    db.prepare(`DELETE FROM local_inference_account_deletion_fences WHERE user_id = 42`).run();
    await expect(runWithSkillInferenceAccountAdmission({ userId: 42 }, operation, db))
      .rejects.toMatchObject({ code: 'ACCOUNT_DELETION_IN_PROGRESS' });
    expect(operation).not.toHaveBeenCalled();
    db.close();
  });

  it('does not retain an undelivered provider result as a completed operation', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    const controller = new AbortController();
    dispatchMock.mockImplementationOnce(async () => {
      queueMicrotask(() => controller.abort(Object.assign(
        new Error('content_engine_client_disconnected'),
        { name: 'AbortError', code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED' },
      )));
      return {
        text: 'locally generated but never delivered',
        providerMetadata: {
          providerUsed: 'ollama',
          modelUsed: 'control',
          modelDigest: 'sha256:test',
        },
      };
    });
    const {
      executeSkillInference,
      getSkillInferenceExternalCloudFallbackEligibility,
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'undelivered-result-operation',
      runId: 'undelivered-result-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
      abortSignal: controller.signal,
    }, db)).rejects.toMatchObject({ code: 'CONTENT_ENGINE_CLIENT_DISCONNECTED' });
    expect(db.prepare(`SELECT status, final_route, fallback_reason, provider, model_digest
      FROM skill_inference_runs WHERE run_id = ?`).get('undelivered-result-run')).toEqual({
      status: 'failed',
      final_route: 'none',
      fallback_reason: 'CONTENT_ENGINE_CLIENT_DISCONNECTED',
      provider: 'ollama',
      model_digest: 'sha256:test',
    });
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: 'undelivered-result-run', tenantId: 42, userId: 42,
    }, db)).toEqual({ allowed: false, reason: 'cancelled' });
    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'undelivered-result-run',
      tenantId: 42,
      userId: 42,
      outcome: 'success',
      provider: 'openai',
      fallbackReason: 'forbidden_after_disconnect',
      durationMs: 1,
    }, db)).toThrow(expect.objectContaining({ code: 'EXTERNAL_CLOUD_FALLBACK_STATE_INVALID' }));
    db.close();
  });

  it('does not start a schema repair after runtime routing turns off', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockImplementationOnce(async () => {
      db.prepare(`UPDATE local_inference_runtime_control
        SET mode = 'off', rollout_percent = 0 WHERE environment = 'staging'`).run();
      throw Object.assign(new Error('bad json'), { kind: 'invalid_json' });
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'structured_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'off-before-repair',
      prompt: 'Return JSON.',
      schemaId: 'generic_json',
      outputSchema: { type: 'object' },
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'structured_content' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db)).rejects.toMatchObject({ code: 'LOCAL_CAPACITY_BUSY' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('rejects a raw private cloud-escalation request before provider dispatch', async () => {
    const db = database();
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'private_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'private-cloud-operation',
      prompt: 'Private creator data.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: true,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'private_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db)).rejects.toMatchObject({ code: 'PRIVATE_CLOUD_ESCALATION_CLAIM_REQUIRED' });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(cloudBoundary).not.toHaveBeenCalled();
    db.close();
  });

  it('rejects mismatched schema identifiers before provider dispatch', async () => {
    const db = database();
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const baseRequest = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'schema_contract',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      operationId: 'schema-contract-operation',
      prompt: 'Return the requested output.',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'schema_contract' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    };

    await expect(executeSkillInference({
      ...baseRequest,
      schemaId: 'generic_json',
    }, db)).rejects.toMatchObject({ code: 'INFERENCE_SCHEMA_CONTRACT_INVALID' });
    await expect(executeSkillInference({
      ...baseRequest,
      operationId: 'schema-contract-text-operation',
      schemaId: 'text',
      outputSchema: { type: 'string' },
    }, db)).rejects.toMatchObject({ code: 'INFERENCE_SCHEMA_CONTRACT_INVALID' });
    expect(dispatchMock).not.toHaveBeenCalled();
    db.close();
  });

  it('does not force a public workload into cloud when escalation was not authorized', async () => {
    const db = database();
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'public_local_only_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'public-local-only-operation',
      prompt: 'Public but explicitly local-only content.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_local_only_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db)).rejects.toMatchObject({ code: 'CLOUD_ESCALATION_NOT_AUTHORIZED' });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT status, fallback_reason FROM skill_inference_runs
      WHERE operation_id = 'public-local-only-operation'`).get()).toEqual({
      status: 'failed',
      fallback_reason: 'CLOUD_ESCALATION_NOT_AUTHORIZED',
    });
    db.close();
  });

  it('owns delivery-bound cloud-primary routing without attempting the local lane', async () => {
    const db = database();
    dispatchMock.mockResolvedValue({
      text: 'cloud-primary answer',
      providerMetadata: {
        providerUsed: 'openai',
        modelUsed: 'gpt-5.6-luna',
        serviceTierUsed: 'flex',
      },
    });
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const request = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'cloud_primary_standard_script',
      riskClass: 'low' as const,
      executionClass: 'background' as const,
      operationId: 'cloud-primary-standard-operation',
      prompt: 'Generate the approved public script section.',
      schemaId: 'text' as const,
      containsPrivateData: false,
      allowCloudEscalation: true,
      redactionRequired: false,
      scriptDeliveryMode: 'standard' as const,
      requiredCloudProvider: 'openai' as const,
      routingPreference: 'cloud_primary' as const,
      requestSource: 'automation' as const,
      budgetRequest: {
        userId: 42,
        requestSource: 'automation' as const,
        baseCategory: 'cloud_primary_standard_script',
      },
      cloudBudgetBoundary: cloudBoundary,
    };

    await expect(executeSkillInference(request, db)).resolves.toMatchObject({
      route: 'cloud',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      serviceTier: 'flex',
    });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      localAdmission: 'force_cloud',
      routingPreference: 'cloud_primary',
      scriptDeliveryMode: 'standard',
      requiredCloudProvider: 'openai',
    }));

    await expect(executeSkillInference({
      ...request,
      operationId: 'invalid-private-cloud-primary-operation',
      containsPrivateData: true,
    }, db)).rejects.toMatchObject({ code: 'PRIVATE_CLOUD_ESCALATION_CLAIM_REQUIRED' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('stays cloud-capable and ledgered when the signed local manifest is unavailable', async () => {
    const db = database();
    modelPolicyMock.unavailable = true;
    dispatchMock.mockResolvedValue({
      text: 'cloud answer',
      providerMetadata: { providerUsed: 'openai', modelUsed: 'cloud-model' },
    });
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'public_manifest_outage',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'manifest-outage-cloud-operation',
      prompt: 'Public content that may use the authorized cloud fallback.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: true,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_manifest_outage' },
      cloudBudgetBoundary: cloudBoundary,
    }, db)).resolves.toMatchObject({
      route: 'cloud', provider: 'openai', fallbackReason: 'model_manifest_unavailable',
    });

    // The mocked provider router returns the cloud result directly. Verify
    // that the service selected the forced-cloud route and supplied the lazy
    // boundary; provider-fallback tests own its actual invocation ordering.
    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith(expect.objectContaining({
      localAdmission: 'force_cloud',
      cloudFallbackBoundary: expect.any(Function),
    }));
    expect(db.prepare(`SELECT status, final_route, local_admission_requested
      FROM skill_inference_runs WHERE operation_id = 'manifest-outage-cloud-operation'`).get()).toEqual({
      status: 'completed',
      final_route: 'cloud',
      local_admission_requested: 0,
    });
    expect(db.prepare(`SELECT route, outcome FROM skill_inference_attempts
      WHERE run_id IN (SELECT run_id FROM skill_inference_runs
        WHERE operation_id = 'manifest-outage-cloud-operation')`).get()).toEqual({
      route: 'cloud',
      outcome: 'success',
    });
    db.close();
  });

  it('rejects an oversized compiled context before provider dispatch instead of relying on truncation', async () => {
    const db = database();
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'oversized_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'oversized-operation',
      prompt: 'x'.repeat(60_000),
      schemaId: 'text',
      requestedOutputTokens: 512,
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'oversized_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db)).rejects.toMatchObject({ code: 'INFERENCE_CONTEXT_LIMIT_EXCEEDED' });

    expect(dispatchMock).not.toHaveBeenCalled();
    expect(cloudBoundary).not.toHaveBeenCalled();
    db.close();
  });

  it('counts fair use by visible operation while allowing repair stages of an admitted operation', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    const insert = db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested,
      profile_version, status, schema_id, context_limit_tokens, output_limit_tokens
    ) VALUES (?, ?, 42, 42, 'pro', 'content', 'chat_read_only_generation',
      'low', 'interactive', 'production', 1, 'v1', 'completed', 'text', 8192, 4096)`);
    for (let index = 0; index < 20; index += 1) {
      insert.run(`prior-run-${index}`, `prior-operation-${index}`);
    }
    dispatchMock.mockResolvedValue({
      text: 'same operation repair',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const baseRequest = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'chat_read_only_generation',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    };

    await expect(executeSkillInference({
      ...baseRequest,
      operationId: 'new-operation-over-limit',
      runId: 'new-run-over-limit',
    }, db)).rejects.toMatchObject({ code: 'LOCAL_FAIR_USE_REACHED' });
    await expect(executeSkillInference({
      ...baseRequest,
      operationId: 'prior-operation-0',
      runId: 'repair-run-for-prior-operation',
    }, db)).resolves.toMatchObject({ route: 'local' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('bounds fair-use admission to one day and does not revive an old operation identity', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    db.prepare(`UPDATE plan_configs
      SET local_operations_hourly = 1, local_operations_daily = 1
      WHERE plan_id = 'pro'`).run();
    const insert = db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested,
      profile_version, status, schema_id, context_limit_tokens, output_limit_tokens,
      created_at
    ) VALUES (?, ?, 42, 42, 'pro', 'content', 'chat_read_only_generation',
      'low', 'interactive', 'production', 1, 'v1', 'completed', 'text', 8192, 4096,
      '2000-01-01T00:00:00.000Z')`);
    for (let index = 0; index < 250; index += 1) {
      insert.run(`old-run-${index}`, `old-operation-${index}`);
    }
    dispatchMock.mockResolvedValue({
      text: 'recent local answer',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const request = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'chat_read_only_generation',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    };

    await expect(executeSkillInference({
      ...request,
      operationId: 'new-operation-after-history',
      runId: 'new-run-after-history',
    }, db)).resolves.toMatchObject({ route: 'local' });
    await expect(executeSkillInference({
      ...request,
      operationId: 'old-operation-0',
      runId: 'old-identity-new-run',
    }, db)).rejects.toMatchObject({ code: 'LOCAL_FAIR_USE_REACHED' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('does not charge operation fair use for local capacity or infrastructure failures', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    db.prepare(`UPDATE plan_configs
      SET local_operations_hourly = 1, local_operations_daily = 1
      WHERE plan_id = 'pro'`).run();
    const insert = db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested,
      profile_version, status, final_route, fallback_reason, schema_id,
      context_limit_tokens, output_limit_tokens
    ) VALUES (?, ?, 42, 42, 'pro', 'content', 'chat_read_only_generation',
      'low', 'interactive', 'production', 1, 'v1', 'failed', 'none', ?, 'text', 8192, 4096)`);
    dispatchMock.mockResolvedValue({
      text: 'capacity recovered',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const {
      executeSkillInference,
      LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS,
    } = await import('../../src/services/skill-inference-service');
    const { LOCAL_LLM_FAIR_USE_ACCOUNTING } = await import(
      '../../src/services/local-inference-failure-taxonomy'
    );
    const infrastructureReasons = [...LOCAL_FAIR_USE_EXEMPT_FAILURE_REASONS];
    for (const [kind, accounting] of Object.entries(LOCAL_LLM_FAIR_USE_ACCOUNTING)) {
      expect(infrastructureReasons.includes(kind)).toBe(accounting === 'exempt');
    }
    expect(infrastructureReasons).toContain('INFERENCE_EMPTY_OUTPUT');
    expect(infrastructureReasons).toContain('CONTENT_SCRIPT_CLOUD_GATE_UNAVAILABLE');
    expect(infrastructureReasons).toContain('model_manifest_unavailable');
    expect(infrastructureReasons).toContain('skill_profile_version_changed_requires_reactivation');

    for (const [index, reason] of infrastructureReasons.entries()) {
      insert.run(`infrastructure-run-${index}`, `infrastructure-operation-${index}`, reason);
      await expect(executeSkillInference({
        tenantId: 42,
        userId: 42,
        skillId: 'content',
        taskType: 'chat_read_only_generation',
        riskClass: 'low',
        executionClass: 'interactive',
        operationId: `operation-after-${reason}`,
        runId: `run-after-${reason}`,
        prompt: 'Answer locally after infrastructure recovers.',
        schemaId: 'text',
        containsPrivateData: true,
        allowCloudEscalation: false,
        requestSource: 'interactive',
        budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
        cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
      }, db)).resolves.toMatchObject({ route: 'local' });
      db.prepare('DELETE FROM skill_inference_attempts').run();
      db.prepare('DELETE FROM skill_inference_runs').run();
    }
    expect(dispatchMock).toHaveBeenCalledTimes(infrastructureReasons.length);
    db.close();
  });

  it('normalizes local provider failures into the policy taxonomy at the service boundary', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    const { LocalLLMError } = await import('../../src/services/local-llm-error');
    dispatchMock.mockRejectedValueOnce(new LocalLLMError('provider_unhealthy', { reason: 'daemon_down' }));
    const { executeSkillInference, SkillInferencePolicyError } = await import(
      '../../src/services/skill-inference-service'
    );

    const error = await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'script_section',
      riskClass: 'low',
      executionClass: 'background',
      operationId: 'provider-outage-operation',
      runId: 'provider-outage-run',
      prompt: 'Generate one section.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'content_engine_script' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db).catch((caught) => caught);

    expect(error).toBeInstanceOf(SkillInferencePolicyError);
    expect(error).toMatchObject({
      code: 'provider_unhealthy',
      status: 502,
      details: expect.objectContaining({
        localLlmKind: 'provider_unhealthy',
        retryable: true,
      }),
    });
    expect(db.prepare(`SELECT status, fallback_reason FROM skill_inference_runs
      WHERE run_id = 'provider-outage-run'`).get()).toEqual({
      status: 'failed',
      fallback_reason: 'provider_unhealthy',
    });
    db.close();
  });

  it('records an infrastructure-driven controller abort as an exempt failure, not user cancellation', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    const controller = new AbortController();
    const { createContentScriptInfrastructureAbort } = await import(
      '../../src/services/local-inference-failure-taxonomy'
    );
    dispatchMock.mockImplementationOnce(async () => {
      controller.abort(createContentScriptInfrastructureAbort('CONTENT_SCRIPT_SHUTDOWN_REQUEUE'));
      throw Object.assign(new Error('provider fetch aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    });
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'script_section',
      riskClass: 'low',
      executionClass: 'background',
      operationId: 'infrastructure-abort-operation',
      runId: 'infrastructure-abort-run',
      prompt: 'Generate a private local section.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'automation',
      budgetRequest: { userId: 42, requestSource: 'automation', baseCategory: 'content_script_job' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
      abortSignal: controller.signal,
    }, db)).rejects.toMatchObject({ code: 'ABORT_ERR' });

    expect(db.prepare(`SELECT status, fallback_reason FROM skill_inference_runs
      WHERE run_id = 'infrastructure-abort-run'`).get()).toEqual({
      status: 'failed',
      fallback_reason: 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
    });
    expect(db.prepare(`SELECT outcome, failure_reason FROM skill_inference_attempts
      WHERE run_id = 'infrastructure-abort-run'`).get()).toEqual({
      outcome: 'failure',
      failure_reason: 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
    });
    db.close();
  });

  it('supports a distinct authenticated tenant and threads a lazy cloud boundary after local failure', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockImplementation(async (task: { localAdmission: string }) => {
      if (task.localAdmission === 'local_only') throw Object.assign(new Error('timeout'), { kind: 'timeout' });
      return {
        text: 'cloud fallback',
        providerMetadata: { providerUsed: 'gemini', modelUsed: 'cloud-model' },
      };
    });
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');
    const result = await executeSkillInference({
      tenantId: 84,
      userId: 42,
      skillId: 'content',
      taskType: 'public_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'fallback-operation',
      prompt: 'Write public copy.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: true,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db);

    expect(result).toMatchObject({ route: 'cloud', fallbackReason: 'timeout' });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    expect(dispatchMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({
        tenantId: 84,
        localAdmission: 'local_only',
        cloudFallbackBoundary: expect.any(Function),
      }),
      expect.objectContaining({
        tenantId: 84,
        localAdmission: 'force_cloud',
        cloudFallbackBoundary: expect.any(Function),
      }),
    ]);
    // This test intentionally mocks the provider router, so it verifies that
    // the service passes the lazy boundary but does not pretend to execute it.
    // provider-fallback.test.ts owns the real local-failure -> budget -> cloud
    // ordering assertion.
    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(db.prepare(`SELECT route, outcome FROM skill_inference_attempts
      ORDER BY attempt_number`).all()).toEqual([
      { route: 'local', outcome: 'failure' },
      { route: 'cloud', outcome: 'success' },
    ]);
    db.close();
  });

  it('does not acquire cloud budget when cancellation races with a local failure', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    const controller = new AbortController();
    dispatchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw Object.assign(new Error('local transport failed'), { kind: 'timeout' });
    });
    const cloudBoundary = vi.fn(async (_request: unknown, call: () => Promise<unknown>) => call());
    const { executeSkillInference } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 84,
      userId: 42,
      skillId: 'content',
      taskType: 'public_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'cancelled-fallback-operation',
      prompt: 'Write public copy.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: true,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_content' },
      cloudBudgetBoundary: cloudBoundary,
      abortSignal: controller.signal,
    }, db)).rejects.toBeInstanceOf(Error);

    expect(cloudBoundary).not.toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(db.prepare(`SELECT status FROM skill_inference_runs WHERE operation_id = ?`)
      .get('cancelled-fallback-operation')).toEqual({ status: 'cancelled' });

    const insert = db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested,
      profile_version, status, schema_id, context_limit_tokens, output_limit_tokens
    ) VALUES (?, ?, 84, 42, 'pro', 'content', 'public_content',
      'low', 'interactive', 'production', 1, 'v1', 'completed', 'text', 8192, 4096)`);
    for (let index = 0; index < 19; index += 1) {
      insert.run(`completed-after-cancel-${index}`, `completed-operation-after-cancel-${index}`);
    }
    dispatchMock.mockResolvedValue({
      text: 'must not be reached',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control' },
    });
    await expect(executeSkillInference({
      tenantId: 84,
      userId: 42,
      skillId: 'content',
      taskType: 'public_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'operation-after-cancelled-limit',
      prompt: 'This operation must be blocked by fair use.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: true,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_content' },
      cloudBudgetBoundary: cloudBoundary,
    }, db)).rejects.toMatchObject({ code: 'LOCAL_FAIR_USE_REACHED' });
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('rejects every completed local repair stage when the visible operation fails application validation', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValue({
      text: 'local stage',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'control',
        modelDigest: 'sha256:test',
        generationTokensPerSec: 6,
      },
    });
    const {
      executeSkillInference,
      rejectSkillInferenceApplicationOperationResults,
    } = await import('../../src/services/skill-inference-service');
    const request = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'chat_read_only_generation',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      operationId: 'repaired-chat-operation',
      prompt: 'Create a local answer.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async <T>(_request: unknown, call: () => Promise<T>) => call(),
    };
    await executeSkillInference({ ...request, runId: 'chat-primary' }, db);
    await executeSkillInference({ ...request, runId: 'chat-repair' }, db);

    rejectSkillInferenceApplicationOperationResults({
      operationId: request.operationId,
      tenantId: 42,
      userId: 42,
      reason: 'final_composition_invalid',
    }, db);

    expect(db.prepare(`SELECT run_id, status, final_route, validation_status, fallback_reason
      FROM skill_inference_runs ORDER BY run_id`).all()).toEqual([
      {
        run_id: 'chat-primary', status: 'failed', final_route: 'none',
        validation_status: 'invalid', fallback_reason: 'final_composition_invalid',
      },
      {
        run_id: 'chat-repair', status: 'failed', final_route: 'none',
        validation_status: 'invalid', fallback_reason: 'final_composition_invalid',
      },
    ]);
    db.close();
  });

  it('attaches an external cloud fallback to the latest repair run in an operation', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValue({
      text: 'local stage',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: 'control',
        modelDigest: 'sha256:test',
        generationTokensPerSec: 6,
      },
    });
    const {
      executeSkillInference,
      getSkillInferenceExternalCloudFallbackEligibility,
      getLatestSkillInferenceOperationRunId,
      recordSkillInferenceExternalCloudAttempt,
      rejectSkillInferenceApplicationOperationResults,
    } = await import('../../src/services/skill-inference-service');
    const request = {
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'chat_read_only_generation',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      operationId: 'cloud-after-repair-operation',
      prompt: 'Create a local answer.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async <T>(_request: unknown, call: () => Promise<T>) => call(),
    };
    await executeSkillInference({ ...request, runId: 'chat-primary' }, db);
    await executeSkillInference({ ...request, runId: 'chat-repair' }, db);
    rejectSkillInferenceApplicationOperationResults({
      operationId: request.operationId,
      tenantId: 42,
      userId: 42,
      reason: 'local_application_validation_failed',
    }, db);

    const latestRunId = getLatestSkillInferenceOperationRunId({
      operationId: request.operationId,
      tenantId: 42,
      userId: 42,
    }, db);
    expect(latestRunId).toBe('chat-repair');
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: latestRunId!, tenantId: 42, userId: 42,
    }, db)).toEqual({ allowed: true });
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: latestRunId!, tenantId: 7, userId: 7,
    }, db)).toEqual({ allowed: false, reason: 'scope_mismatch' });
    expect(getSkillInferenceExternalCloudFallbackEligibility({
      runId: 'missing-run', tenantId: 42, userId: 42,
    }, db)).toEqual({ allowed: false, reason: 'run_missing' });
    recordSkillInferenceExternalCloudAttempt({
      runId: latestRunId!,
      tenantId: 42,
      userId: 42,
      outcome: 'success',
      provider: 'gemini',
      model: 'cloud-model',
      fallbackReason: 'INFERENCE_APPLICATION_VALIDATION_FAILED',
      durationMs: 25,
    }, db);

    expect(db.prepare(`SELECT run_id, status, final_route, provider, model_id,
        model_digest, generation_tokens_per_second
      FROM skill_inference_runs ORDER BY created_at, rowid`).all()).toEqual([
      {
        run_id: 'chat-primary', status: 'failed', final_route: 'none', provider: 'ollama',
        model_id: 'control', model_digest: 'sha256:test', generation_tokens_per_second: 6,
      },
      {
        run_id: 'chat-repair', status: 'completed', final_route: 'cloud', provider: 'gemini',
        model_id: 'cloud-model', model_digest: null, generation_tokens_per_second: null,
      },
    ]);
    db.close();
  });

  it('records an externally cancelled cloud attempt without inflating fallback failures', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
      WHERE environment = 'staging'`).run();
    dispatchMock.mockRejectedValueOnce(Object.assign(new Error('local timeout'), { kind: 'timeout' }));
    const {
      executeSkillInference,
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');

    await expect(executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'public_content',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'external-cancel-operation',
      runId: 'external-cancel-run',
      prompt: 'Write public copy.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'public_content' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db)).rejects.toBeInstanceOf(Error);

    recordSkillInferenceExternalCloudAttempt({
      runId: 'external-cancel-run',
      tenantId: 42,
      userId: 42,
      outcome: 'cancelled',
      provider: 'gemini',
      fallbackReason: 'CHAT_REQUEST_CANCELLED',
      durationMs: 12,
    }, db);

    expect(db.prepare(`SELECT status, final_route, fallback_reason FROM skill_inference_runs
      WHERE run_id = 'external-cancel-run'`).get()).toEqual({
      status: 'cancelled',
      final_route: 'none',
      fallback_reason: 'CHAT_REQUEST_CANCELLED',
    });
    expect(db.prepare(`SELECT route, outcome, failure_reason FROM skill_inference_attempts
      WHERE run_id = 'external-cancel-run' ORDER BY attempt_number DESC LIMIT 1`).get()).toEqual({
      route: 'cloud',
      outcome: 'cancelled',
      failure_reason: 'CHAT_REQUEST_CANCELLED',
    });
    db.close();
  });

  it('blocks post-delivery cloud fallback, records a typed incident, and immediately turns routing off', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValue({
      text: 'delivered local answer',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const {
      executeSkillInference,
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');
    const result = await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'delivered-operation',
      runId: 'delivered-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db);
    expect(result.route).toBe('local');

    let blockedError: unknown;
    try {
      recordSkillInferenceExternalCloudAttempt({
        runId: 'delivered-run',
        tenantId: 42,
        userId: 42,
        outcome: 'success',
        provider: 'gemini',
        fallbackReason: 'late_outer_fallback',
        durationMs: 10,
      }, db);
    } catch (error) {
      blockedError = error;
    }
    expect(blockedError).toMatchObject({ code: 'POST_DELIVERY_CLOUD_FALLBACK_FORBIDDEN' });
    expect(db.prepare(`SELECT incident_code, blocked FROM local_inference_safety_incidents`).get()).toEqual({
      incident_code: 'post_delivery_fallback_attempt',
      blocked: 1,
    });
    expect(db.prepare(`SELECT mode, rollout_percent FROM local_inference_runtime_control
      WHERE environment = 'staging'`).get()).toEqual({ mode: 'off', rollout_percent: 0 });
    db.close();
  });

  it('rejects external cloud telemetry unless the scoped run is still failed', async () => {
    const db = database();
    const {
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');
    const insertRun = db.prepare(`INSERT INTO skill_inference_runs (
      run_id, operation_id, tenant_id, user_id, plan_id, skill_id, task_type,
      risk_class, execution_class, evaluation_mode, local_admission_requested,
      profile_version, status, final_route, schema_id, context_limit_tokens,
      output_limit_tokens
    ) VALUES (?, ?, 42, 42, 'pro', 'content', 'chat_read_only_generation',
      'low', 'interactive', 'production', 1, 'nexus-skill-inference-v3', ?, ?,
      'text', 8192, 4096)`);
    insertRun.run('running-run', 'running-operation', 'running', 'none');
    insertRun.run('cloud-delivered-run', 'cloud-delivered-operation', 'completed', 'cloud');

    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'running-run',
      tenantId: 42,
      userId: 42,
      outcome: 'success',
      provider: 'gemini',
      fallbackReason: 'racing_fallback',
      durationMs: 10,
    }, db)).toThrow(expect.objectContaining({ code: 'EXTERNAL_CLOUD_FALLBACK_STATE_INVALID' }));
    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'cloud-delivered-run',
      tenantId: 42,
      userId: 42,
      outcome: 'success',
      provider: 'gemini',
      fallbackReason: 'duplicate_fallback',
      durationMs: 10,
    }, db)).toThrow(expect.objectContaining({ code: 'POST_DELIVERY_CLOUD_FALLBACK_FORBIDDEN' }));
    expect(db.prepare(`SELECT COUNT(*) AS count FROM skill_inference_attempts
      WHERE run_id IN ('running-run', 'cloud-delivered-run')`).get()).toEqual({ count: 0 });
    db.close();
  });

  it('blocks a cross-scope external fallback attachment and records an immediate-OFF incident', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValue({
      text: 'scoped local answer',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const {
      executeSkillInference,
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');
    await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'tenant-owned-operation',
      runId: 'tenant-owned-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db);

    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'tenant-owned-run',
      tenantId: 77,
      userId: 77,
      outcome: 'success',
      provider: 'gemini',
      fallbackReason: 'cross-scope-attempt',
      durationMs: 10,
    }, db)).toThrow(expect.objectContaining({ code: 'INFERENCE_SCOPE_INVALID' }));
    expect(db.prepare(`SELECT incident_code, blocked FROM local_inference_safety_incidents`).get()).toEqual({
      incident_code: 'tenant_isolation_escape',
      blocked: 1,
    });
    expect(db.prepare(`SELECT mode FROM local_inference_runtime_control
      WHERE environment = 'staging'`).get()).toEqual({ mode: 'off' });
    db.close();
  });

  it('preserves the typed caller policy error when incident persistence fails', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    dispatchMock.mockResolvedValue({
      text: 'scoped local answer',
      providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
    });
    const {
      executeSkillInference,
      recordSkillInferenceExternalCloudAttempt,
    } = await import('../../src/services/skill-inference-service');
    await executeSkillInference({
      tenantId: 42,
      userId: 42,
      skillId: 'content',
      taskType: 'chat_read_only_generation',
      riskClass: 'low',
      executionClass: 'interactive',
      operationId: 'storage-failure-operation',
      runId: 'storage-failure-run',
      prompt: 'Answer locally.',
      schemaId: 'text',
      containsPrivateData: true,
      allowCloudEscalation: false,
      requestSource: 'interactive',
      budgetRequest: { userId: 42, requestSource: 'interactive', baseCategory: 'ios_chat_message' },
      cloudBudgetBoundary: async () => { throw new Error('cloud forbidden'); },
    }, db);
    db.exec(`CREATE TEMP TRIGGER reject_incident_mode_off
      BEFORE UPDATE OF mode ON local_inference_runtime_control
      WHEN NEW.mode = 'off'
      BEGIN
        SELECT RAISE(FAIL, 'routing control storage unavailable');
      END;`);

    expect(() => recordSkillInferenceExternalCloudAttempt({
      runId: 'storage-failure-run',
      tenantId: 77,
      userId: 77,
      outcome: 'success',
      provider: 'gemini',
      fallbackReason: 'cross-scope-attempt',
      durationMs: 10,
    }, db)).toThrow(expect.objectContaining({ code: 'INFERENCE_SCOPE_INVALID' }));
    const { getLocalInferenceRuntimeControl } = await import('../../src/services/local-inference-runtime-control');
    expect(getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      reason: 'critical_safety_incident_storage_failed:tenant_isolation_escape',
    });
    db.close();
  });

  it('rolls back the incident record when the atomic routing-OFF transition cannot commit', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    db.exec(`CREATE TEMP TRIGGER reject_safety_mode_off
      BEFORE UPDATE OF mode ON local_inference_runtime_control
      WHEN NEW.mode = 'off'
      BEGIN
        SELECT RAISE(FAIL, 'routing control storage unavailable');
      END;`);
    const { recordCriticalLocalInferenceSafetyIncident } = await import(
      '../../src/services/local-inference-safety-incidents'
    );

    expect(() => recordCriticalLocalInferenceSafetyIncident({
      code: 'prompt_injection_escape',
      source: 'atomic-rollback-test',
      tenantId: 42,
      userId: 42,
      blocked: true,
    }, db)).toThrow('routing control storage unavailable');
    expect(db.prepare(`SELECT COUNT(*) AS count FROM local_inference_safety_incidents`).get())
      .toEqual({ count: 0 });
    expect(db.prepare(`SELECT mode, rollout_percent FROM local_inference_runtime_control
      WHERE environment = 'staging'`).get()).toEqual({ mode: 'active', rollout_percent: 100 });
    const { getLocalInferenceRuntimeControl } = await import('../../src/services/local-inference-runtime-control');
    expect(getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off',
      reason: 'critical_safety_incident_storage_failed:prompt_injection_escape',
    });
    db.close();
  });

  it('deduplicates repeated critical incidents within one five-minute source bucket', async () => {
    const db = database();
    const { recordCriticalLocalInferenceSafetyIncident } = await import(
      '../../src/services/local-inference-safety-incidents'
    );
    const incident = {
      code: 'unsafe_output_served' as const,
      source: 'same-final-validator',
      tenantId: 42,
      userId: 42,
      runId: 'same-run',
      blocked: true,
    };

    recordCriticalLocalInferenceSafetyIncident(incident, db);
    recordCriticalLocalInferenceSafetyIncident(incident, db);

    expect(db.prepare(`SELECT COUNT(*) AS count FROM local_inference_safety_incidents`).get())
      .toEqual({ count: 1 });

    recordCriticalLocalInferenceSafetyIncident({
      ...incident,
      tenantId: 84,
      userId: 84,
      runId: 'different-scope-run',
    }, db);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM local_inference_safety_incidents`).get())
      .toEqual({ count: 2 });
    db.close();
  });

  it('persists durable OFF for a critical incident even when contract drift already made routing effectively off', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100, model_manifest_version = 'superseded-manifest',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    const {
      getLocalInferenceRuntimeControl,
    } = await import('../../src/services/local-inference-runtime-control');
    const { recordCriticalLocalInferenceSafetyIncident } = await import(
      '../../src/services/local-inference-safety-incidents'
    );
    expect(getLocalInferenceRuntimeControl(db)).toMatchObject({
      mode: 'off', reason: 'manifest_version_changed_requires_reactivation',
    });

    expect(recordCriticalLocalInferenceSafetyIncident({
      code: 'unsafe_output_served',
      source: 'contract-drift-critical-incident',
      tenantId: 42,
      userId: 42,
      blocked: true,
    }, db)).toEqual({ routingDisabled: true });
    expect(db.prepare(`SELECT mode, rollout_percent FROM local_inference_runtime_control
      WHERE environment = 'staging'`).get()).toEqual({ mode: 'off', rollout_percent: 0 });
    db.close();
  });

  it('turns shadow evaluation off immediately for a critical boundary incident', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'shadow', rollout_percent = 0, model_manifest_version = 'test-v1',
          active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3',
          updated_by = 42
      WHERE environment = 'staging'`).run();
    const { recordCriticalLocalInferenceSafetyIncident } = await import(
      '../../src/services/local-inference-safety-incidents'
    );

    expect(recordCriticalLocalInferenceSafetyIncident({
      code: 'tenant_isolation_escape',
      source: 'shadow-boundary-test',
      tenantId: 42,
      userId: 42,
      blocked: true,
    }, db)).toEqual({ routingDisabled: true });
    expect(db.prepare(`SELECT mode, rollout_percent FROM local_inference_runtime_control
      WHERE environment = 'staging'`).get()).toEqual({ mode: 'off', rollout_percent: 0 });
    db.close();
  });

  it('normalizes invalid optional incident scope ids instead of tripping storage fail-closed', async () => {
    const db = database();
    const { recordCriticalLocalInferenceSafetyIncident } = await import(
      '../../src/services/local-inference-safety-incidents'
    );

    expect(() => recordCriticalLocalInferenceSafetyIncident({
      code: 'unsafe_output_served',
      source: 'invalid-optional-scope',
      tenantId: 0,
      userId: -1,
      blocked: true,
    }, db)).not.toThrow();
    expect(db.prepare(`SELECT tenant_id, user_id FROM local_inference_safety_incidents
      WHERE source = 'invalid-optional-scope'`).get()).toEqual({ tenant_id: null, user_id: null });
    db.close();
  });

  describe('free-tier local-only binding (NH-0040)', () => {
    const freeRequest = (overrides: Record<string, unknown> = {}) => ({
      tenantId: 42,
      userId: 42,
      skillId: 'content' as const,
      taskType: 'free_chat',
      riskClass: 'low' as const,
      executionClass: 'interactive' as const,
      operationId: `free-op-${String(overrides.operationId ?? 'default')}`,
      prompt: 'Answer briefly.',
      schemaId: 'text',
      containsPrivateData: false,
      allowCloudEscalation: false,
      requestSource: 'interactive' as const,
      budgetRequest: { userId: 42, requestSource: 'interactive' as const, baseCategory: 'free_chat' },
      cloudBudgetBoundary: async (_request: unknown, call: () => Promise<unknown>) => call(),
      ...overrides,
    });

    it('keeps free plans fully denied while the binding is OFF', async () => {
      entitlementMock.plan = 'free';
      entitlementMock.aiAccessAllowed = false;
      const db = database();
      const { executeSkillInference } = await import('../../src/services/skill-inference-service');
      await expect(executeSkillInference(freeRequest() as never, db))
        .rejects.toMatchObject({ code: 'LOCAL_PLAN_REQUIRED' });
      expect(dispatchMock).not.toHaveBeenCalled();
      db.close();
    });

    it('serves a bound free account on the local lane with cloud escalation forced off', async () => {
      entitlementMock.plan = 'free';
      entitlementMock.aiAccessAllowed = false;
      freeTierFlagMock.enabled = true;
      const db = database();
      db.prepare(`UPDATE local_inference_runtime_control
        SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
            active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
        WHERE environment = 'staging'`).run();
      dispatchMock.mockResolvedValueOnce({
        text: 'local answer',
        providerMetadata: { providerUsed: 'ollama', modelUsed: 'control', modelDigest: 'sha256:test' },
      });
      const { executeSkillInference } = await import('../../src/services/skill-inference-service');
      const result = await executeSkillInference(freeRequest({
        operationId: 'local-served',
        // Even a forged escalation request must not open the cloud path.
        allowCloudEscalation: true,
      }) as never, db);
      expect(result).toMatchObject({ route: 'local', text: 'local answer' });
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]?.[0]).toMatchObject({
        localAdmission: 'local_only',
        allowCloudEscalation: false,
      });
      db.close();
    });

    it('returns a retryable capacity response instead of cloud when the local route is unavailable', async () => {
      entitlementMock.plan = 'free';
      entitlementMock.aiAccessAllowed = false;
      freeTierFlagMock.enabled = true;
      const db = database();
      // Runtime control stays 'off': no local route for this account.
      const { executeSkillInference } = await import('../../src/services/skill-inference-service');
      await expect(executeSkillInference(freeRequest({
        operationId: 'capacity',
        allowCloudEscalation: true,
      }) as never, db)).rejects.toMatchObject({ code: 'FREE_TIER_LOCAL_CAPACITY', status: 503 });
      expect(dispatchMock).not.toHaveBeenCalled();
      db.close();
    });

    it('never escalates to cloud after a failed local attempt on a bound plan', async () => {
      entitlementMock.plan = 'beta';
      entitlementMock.aiAccessAllowed = false;
      freeTierFlagMock.enabled = true;
      const db = database();
      db.prepare(`UPDATE local_inference_runtime_control
        SET mode = 'active', rollout_percent = 100, model_manifest_version = 'test-v1',
            active_model_digest = 'sha256:test', skill_profile_version = 'nexus-skill-inference-v3'
        WHERE environment = 'staging'`).run();
      const localFailure = Object.assign(new Error('local timeout'), { code: 'ETIMEDOUT' });
      dispatchMock.mockRejectedValueOnce(localFailure);
      const { executeSkillInference } = await import('../../src/services/skill-inference-service');
      await expect(executeSkillInference(freeRequest({
        operationId: 'no-cloud-after-local',
        allowCloudEscalation: true,
      }) as never, db)).rejects.toBeTruthy();
      // Exactly one (local) dispatch: no force_cloud second attempt.
      expect(dispatchMock).toHaveBeenCalledTimes(1);
      expect(dispatchMock.mock.calls[0]?.[0]).toMatchObject({ localAdmission: 'local_only' });
      db.close();
    });

    it('reports bound accounts ineligible for the external cloud fallback', async () => {
      entitlementMock.plan = 'free';
      freeTierFlagMock.enabled = true;
      const db = database();
      const { getSkillInferenceExternalCloudFallbackEligibility } = await import(
        '../../src/services/skill-inference-service'
      );
      expect(getSkillInferenceExternalCloudFallbackEligibility({
        runId: 'any-run', tenantId: 42, userId: 42,
      }, db)).toEqual({ allowed: false, reason: 'free_tier_local_only' });
      db.close();
    });
  });
});
