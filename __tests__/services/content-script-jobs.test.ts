// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const inferenceMock = vi.hoisted(() => vi.fn());
const budgetReservationMock = vi.hoisted(() => vi.fn(
  async (_request: unknown, providerCall: () => Promise<unknown>) => providerCall(),
));
const contentJobMocks = vi.hoisted(() => ({
  scriptSafetyBlocked: false,
  userLanguage: 'en',
  rejectApplicationResult: vi.fn(),
  rejectApplicationOperationResults: vi.fn(),
  isEnrolled: vi.fn(() => true),
  accountDeletionFenced: false,
  outputLanguageMismatchesRemaining: 0,
  publicOutputLanguageMismatchesRemaining: 0,
}));
const localPrimaryConfigMock = vi.hoisted(() => ({
  scriptJobsEnabled: true,
  contentProxyEnabled: true,
  scriptJobEncryptionKey: 'test-content-script-job-key-000000000000000000000000',
  scriptJobPreviousEncryptionKeys: [] as string[],
}));
const MockSkillInferencePolicyError = vi.hoisted(() => class extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
});
const MockContentOutputLanguageMismatchError = vi.hoisted(() => class extends Error {
  readonly code = 'CONTENT_OUTPUT_LOCALE_MISMATCH';
});
const ACTIVE_MODEL_TAG = 'qwen2.5:3b-instruct-q4_K_M';
const ACTIVE_MODEL_DIGEST = 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b';

vi.mock('../../src/services/local-primary-config', () => ({
  localPrimaryInferenceConfig: localPrimaryConfigMock,
}));
vi.mock('../../src/services/local-inference-runtime-control', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-runtime-control')>(
    '../../src/services/local-inference-runtime-control',
  )),
  getLocalInferenceRuntimeControl: (db?: {
    prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
  }) => {
    const row = db?.prepare(`SELECT mode, rollout_percent
      FROM local_inference_runtime_control WHERE environment = 'staging'`).get() as {
        mode?: 'off' | 'shadow' | 'canary' | 'active';
        rollout_percent?: number;
      } | undefined;
    return {
      mode: row?.mode ?? 'active',
      rolloutPercent: row?.rollout_percent ?? 100,
      environment: 'staging',
      manifestVersion: '2026-08-12.1',
      activeModelId: 'qwen2.5-3b-control',
      activeModelDigest: ACTIVE_MODEL_DIGEST,
      reason: 'test_control',
      updatedAt: null,
    };
  },
}));
vi.mock('../../src/utils/logger', async () => ({
  ...(await vi.importActual<typeof import('../../src/utils/logger')>('../../src/utils/logger')),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/entitlement', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/entitlement')>('../../src/services/entitlement')),
  getEffectiveEntitlement: () => ({ plan: 'pro', aiAccessAllowed: true }),
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/user-service')>('../../src/services/user-service')),
  getUserLanguageById: () => contentJobMocks.userLanguage,
}));
vi.mock('../../src/state/content-references', async () => ({
  ...(await vi.importActual<typeof import('../../src/state/content-references')>(
    '../../src/state/content-references',
  )),
  getAllKnowledge: () => [],
}));
vi.mock('../../src/services/content-engine', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-engine')>('../../src/services/content-engine')),
  __esModule: true,
}));
vi.mock('../../src/services/skill-inference-service', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/skill-inference-service')>(
    '../../src/services/skill-inference-service',
  );
  return {
    ...actual,
    executeSkillInference: (...args: unknown[]) => inferenceMock(...args),
    isSkillInferenceAccountDeletionFenced: () => contentJobMocks.accountDeletionFenced,
    isLocalInferenceUserEnrolled: (...args: unknown[]) => contentJobMocks.isEnrolled(...args),
    rejectSkillInferenceApplicationResult: (...args: unknown[]) => contentJobMocks.rejectApplicationResult(...args),
    rejectSkillInferenceApplicationOperationResults: (...args: unknown[]) => (
      contentJobMocks.rejectApplicationOperationResults(...args)
    ),
    SkillInferencePolicyError: MockSkillInferencePolicyError,
  };
});
vi.mock('../../src/services/cost-guardrail', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/cost-guardrail')>(
    '../../src/services/cost-guardrail',
  )),
  withAiBudgetReservation: (...args: unknown[]) => budgetReservationMock(...args),
}));
vi.mock('../../src/api/routes/content-script-route-utils', async () => ({
  ...(await vi.importActual<typeof import('../../src/api/routes/content-script-route-utils')>(
    '../../src/api/routes/content-script-route-utils',
  )),
  buildUserVoiceMemory: () => 'pinned creator voice',
  resolveScriptGenerationMode: (value: unknown) => value === 'deep' ? 'deep' : 'standard',
  resolveScriptRenderMode: () => 'structured',
  resolveScriptStyle: (value: unknown) => value === 'bullets' ? 'bullets' : 'detailed',
  resolveScriptTargetLanguage: (value: unknown) => (
    typeof value === 'string' && value.trim() ? value : contentJobMocks.userLanguage
  ),
  buildScriptSuccessResponse: ({ result }: { result: Record<string, unknown> }) => {
    if (contentJobMocks.publicOutputLanguageMismatchesRemaining > 0) {
      contentJobMocks.publicOutputLanguageMismatchesRemaining -= 1;
      throw new MockContentOutputLanguageMismatchError();
    }
    return {
      ...result,
      scriptSafety: { blocked: contentJobMocks.scriptSafetyBlocked },
    };
  },
}));
vi.mock('../../src/services/content-output-language', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/content-output-language')>(
    '../../src/services/content-output-language',
  )),
  ContentOutputLanguageMismatchError: MockContentOutputLanguageMismatchError,
  assertContentOutputLanguageFields: vi.fn(() => {
    if (contentJobMocks.outputLanguageMismatchesRemaining > 0) {
      contentJobMocks.outputLanguageMismatchesRemaining -= 1;
      throw new MockContentOutputLanguageMismatchError();
    }
  }),
}));

const migrationSql = readFileSync(
  resolve(__dirname, '../../migrations/284_local_primary_inference_foundation.sql'),
  'utf8',
) + readFileSync(
  resolve(__dirname, '../../migrations/287_content_script_delivery_modes.sql'),
  'utf8',
);

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
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
    INSERT INTO plan_configs (plan_id, display_name) VALUES ('pro', 'Pro');
  `);
  db.exec(migrationSql);
  db.prepare(`UPDATE local_inference_runtime_control
    SET mode = 'active', rollout_percent = 100, model_manifest_version = '2026-08-12.1',
        active_model_digest = 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
        skill_profile_version = 'nexus-skill-inference-v1'
    WHERE environment = 'staging'`).run();
  return db;
}

function localResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'ok',
    provider: 'ollama',
    route: 'local',
    model: ACTIVE_MODEL_TAG,
    modelDigest: ACTIVE_MODEL_DIGEST,
    runId: `run-${Math.random()}`,
    operationId: 'operation',
    validationStatus: 'valid',
    queueWaitMs: 0,
    durationMs: 10,
    ...overrides,
  };
}

function outlineLocalResult(count: number): Record<string, unknown> {
  return localResult({
    parsed: {
      hook: 'Start with a concrete promise.',
      titleOptions: ['Title one', 'Title two', 'Title three'],
      sections: Array.from({ length: count }, (_, index) => ({
        key: `draft_${index + 1}`,
        title: `Section ${index + 1}`,
        instructions: `Develop section ${index + 1} clearly.`,
      })),
    },
  });
}

function cloudResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: 'ok',
    provider: 'openai',
    route: 'cloud',
    model: 'gpt-5.6-luna',
    runId: `run-${Math.random()}`,
    operationId: 'operation',
    validationStatus: 'valid',
    queueWaitMs: 0,
    durationMs: 10,
    ...overrides,
  };
}

function outlineCloudResult(count: number): Record<string, unknown> {
  return cloudResult({
    parsed: {
      hook: 'Start with a concrete promise.',
      titleOptions: ['Title one', 'Title two', 'Title three'],
      sections: Array.from({ length: count }, (_, index) => ({
        key: `draft_${index + 1}`,
        title: `Section ${index + 1}`,
        instructions: `Develop section ${index + 1} clearly.`,
      })),
    },
  });
}

function parsedPrompt(raw: string): Record<string, unknown> {
  return JSON.parse(raw.split('\n')[0]) as Record<string, unknown>;
}

describe('durable Content script jobs', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { resetContentScriptJobShutdownForTests } = await import('../../src/services/content-script-jobs');
    resetContentScriptJobShutdownForTests();
    inferenceMock.mockReset();
    budgetReservationMock.mockClear();
    contentJobMocks.scriptSafetyBlocked = false;
    contentJobMocks.userLanguage = 'en';
    contentJobMocks.rejectApplicationResult.mockReset();
    contentJobMocks.rejectApplicationOperationResults.mockReset();
    contentJobMocks.isEnrolled.mockReset();
    contentJobMocks.isEnrolled.mockReturnValue(true);
    contentJobMocks.accountDeletionFenced = false;
    contentJobMocks.outputLanguageMismatchesRemaining = 0;
    contentJobMocks.publicOutputLanguageMismatchesRemaining = 0;
    localPrimaryConfigMock.scriptJobsEnabled = true;
    localPrimaryConfigMock.contentProxyEnabled = true;
    localPrimaryConfigMock.scriptJobEncryptionKey = 'test-content-script-job-key-000000000000000000000000';
    localPrimaryConfigMock.scriptJobPreviousEncryptionKeys = [];
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });
  });

  afterEach(() => vi.useRealTimers());

  it('fails recovery-worker startup before reading queued jobs when encryption is unavailable', async () => {
    const service = await import('../../src/services/content-script-jobs');
    localPrimaryConfigMock.scriptJobEncryptionKey = '';

    expect(() => service.startContentScriptJobRecoveryLoop())
      .toThrow('CONTENT_SCRIPT_JOB_ENCRYPTION_KEY must be at least 32 bytes');
  });

  it('fails recovery-worker startup when the local-only Content proxy is disabled', async () => {
    const service = await import('../../src/services/content-script-jobs');
    localPrimaryConfigMock.contentProxyEnabled = false;

    expect(() => service.startContentScriptJobRecoveryLoop())
      .toThrow(expect.objectContaining({ code: 'LOCAL_PRIMARY_CONTENT_PROXY_REQUIRED' }));
  });

  it('encrypts tenant-owned requests and enforces idempotency', async () => {
    const db = database();
    const { createContentScriptJob, getContentScriptJob } = await import('../../src/services/content-script-jobs');
    const input = {
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'same-operation',
      request: {
        topic: 'Durable local script',
        format: 'YouTube',
        maxDurationMinutes: 8,
        language: 'en',
        sources: [{
          title: 'Pinned source',
          url: 'https://example.com/source',
          source_type: 'user_supplied',
          relevance_note: 'Use this evidence.',
        }],
      },
    };
    const created = createContentScriptJob(input, db);
    const replay = createContentScriptJob(input, db);

    expect(created.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.job.jobId).toBe(created.job.jobId);
    const stored = db.prepare('SELECT request_json FROM content_script_jobs').get() as { request_json: string };
    expect(stored.request_json).not.toContain('Durable local script');
    const { decryptContentScriptJobJson } = await import('../../src/services/content-script-job-encryption');
    expect(decryptContentScriptJobJson(stored.request_json, 42)).toMatchObject({
      pinnedManifestVersion: '2026-08-12.1',
      pinnedModelId: 'qwen2.5-3b-control',
      pinnedModelTag: ACTIVE_MODEL_TAG,
      pinnedModelDigest: ACTIVE_MODEL_DIGEST,
      pinnedCreatorVoice: 'pinned creator voice',
      pinnedSources: [{ title: 'Pinned source', url: 'https://example.com/source' }],
    });
    expect(created.job.modelDigest).toBe(ACTIVE_MODEL_DIGEST);
    expect(getContentScriptJob(7, 7, created.job.jobId, db)).toBeNull();
    db.close();
  });

  it('blocks new and retried Content work while account erasure is fenced', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'account-deletion-fence-existing',
      request: { topic: 'Existing job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', last_error_code = 'test_failure'
      WHERE job_id = ?`).run(created.job.jobId);
    contentJobMocks.accountDeletionFenced = true;

    expect(() => service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'account-deletion-fence-new',
      request: { topic: 'New job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db)).toThrow(expect.objectContaining({ code: 'ACCOUNT_DELETION_IN_PROGRESS' }));
    expect(() => service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: created.job.jobId,
    }, db)).toThrow(expect.objectContaining({ code: 'ACCOUNT_DELETION_IN_PROGRESS' }));
    expect(inferenceMock).not.toHaveBeenCalled();
    db.close();
  });

  it('uses compiled Content limits when persisted active and daily limits are malformed', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    db.prepare(`UPDATE plan_configs
      SET active_content_jobs = 999, longform_scripts_daily = 9999
      WHERE plan_id = 'pro'`).run();

    service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'malformed-plan-first-job',
      request: { topic: 'First safe job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    expect(() => service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'malformed-plan-second-job',
      request: { topic: 'Second blocked job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_ACTIVE_LIMIT' }));
    db.close();
  });

  it('replays an omitted-language request after the user profile language changes', async () => {
    const db = database();
    const { createContentScriptJob } = await import('../../src/services/content-script-jobs');
    const input = {
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'profile-language-independent-idempotency',
      request: { topic: 'Stable operation', format: 'YouTube', maxDurationMinutes: 8 },
    };
    const created = createContentScriptJob(input, db);
    contentJobMocks.userLanguage = 'pt-BR';

    const replay = createContentScriptJob(input, db);

    expect(replay).toMatchObject({ replayed: true, job: { jobId: created.job.jobId } });
    const { decryptContentScriptJobJson } = await import('../../src/services/content-script-job-encryption');
    const stored = db.prepare('SELECT request_json FROM content_script_jobs WHERE job_id = ?')
      .get(created.job.jobId) as { request_json: string };
    expect(decryptContentScriptJobJson<{ language: string }>(stored.request_json, 42).language).toBe('en');
    db.close();
  });

  it('replays the winning row when a concurrent idempotent insert wins the race', async () => {
    const db = database();
    db.exec(`CREATE TEMP TRIGGER simulate_script_job_race
      BEFORE INSERT ON content_script_jobs
      WHEN NEW.idempotency_key = 'concurrent-operation'
      BEGIN
        INSERT INTO content_script_jobs (
          job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
          operation_id, request_json, status, stage, progress_percent
        ) VALUES (
          'script_job_concurrent_winner', NEW.tenant_id, NEW.owner_user_id, NEW.plan_id,
          NEW.idempotency_key, NEW.request_hash, 'content-script:concurrent-winner',
          NEW.request_json, 'queued', 'queued', 0
        );
      END;`);
    const { createContentScriptJob } = await import('../../src/services/content-script-jobs');

    const result = createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'concurrent-operation',
      request: { topic: 'Concurrent script', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);

    expect(result).toMatchObject({ replayed: true, job: { jobId: 'script_job_concurrent_winner' } });
    expect((db.prepare('SELECT COUNT(*) AS count FROM content_script_jobs').get() as { count: number }).count).toBe(1);
    db.close();
  });

  it('completes locally and checkpoints the outline plus each validated section', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'local-success',
      request: { topic: 'Local success', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', route: 'local', progress: 100 });
    expect(inferenceMock).toHaveBeenCalledTimes(7);
    for (const [request] of inferenceMock.mock.calls) {
      expect(request).toMatchObject({
        containsPrivateData: false,
        allowCloudEscalation: true,
        redactionRequired: false,
        executionClass: 'background',
        scriptDeliveryMode: 'standard',
        requiredCloudProvider: 'openai',
      });
      await expect(request.cloudBudgetBoundary(
        request.budgetRequest,
        async () => 'budgeted-cloud-call',
      )).resolves.toBe('budgeted-cloud-call');
    }
    expect(budgetReservationMock).toHaveBeenCalledTimes(7);
    const checkpoints = db.prepare(`SELECT section_key, output_json, route
      FROM content_script_job_checkpoints ORDER BY section_index`).all() as Array<Record<string, string>>;
    expect(checkpoints).toHaveLength(7);
    expect(checkpoints[0]).toMatchObject({ section_key: 'outline', route: 'local' });
    expect(checkpoints[1]).toMatchObject({ section_key: 'section_1', route: 'local' });
    expect(checkpoints[1].output_json).not.toContain('word1');
    db.close();
  });

  it('accepts an approved cloud-only script and records cloud provenance', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'cloud-success',
      request: {
        topic: 'Cloud script',
        format: 'YouTube',
        maxDurationMinutes: 8,
        language: 'en',
        deliveryMode: 'priority',
      },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineCloudResult(Number(prompt.exactSectionCount));
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `cloud${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return cloudResult({ text: tokens.join(' ') });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', route: 'cloud', modelDigest: null });
    expect(inferenceMock.mock.calls.every(([request]) => (
      request.scriptDeliveryMode === 'priority'
      && request.requiredCloudProvider === 'openai'
      && request.containsPrivateData === false
      && request.allowCloudEscalation === true
    ))).toBe(true);
    expect(db.prepare(`SELECT DISTINCT route FROM content_script_job_checkpoints
      WHERE job_id = ? ORDER BY route`).all(created.job.jobId)).toEqual([{ route: 'cloud' }]);
    db.close();
  });

  it('records mixed provenance when a local outline is followed by cloud sections', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'mixed-success',
      request: { topic: 'Mixed script', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `mixed${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return cloudResult({ text: tokens.join(' ') });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', route: 'mixed', modelDigest: null });
    expect(db.prepare(`SELECT DISTINCT route FROM content_script_job_checkpoints
      WHERE job_id = ? ORDER BY route`).all(created.job.jobId)).toEqual([
      { route: 'cloud' },
      { route: 'local' },
    ]);
    db.close();
  });

  it('fails cloud stages that omit the approved provider/model identity', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'cloud-identity-missing',
      request: { topic: 'Missing identity', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockResolvedValueOnce(outlineCloudResult(6));
    inferenceMock.mockResolvedValueOnce(cloudResult({ model: '   ' }));

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_SCRIPT_CLOUD_IDENTITY_MISSING' });
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'failed', errorCode: 'CONTENT_SCRIPT_CLOUD_IDENTITY_MISSING' });
    expect(contentJobMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'content_script_cloud_identity_missing' }),
      db,
    );
    db.close();
  });

  it('accepts complete bullet speaking notes without requiring sentence punctuation', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'bullet-style-script',
      request: {
        topic: 'Bullet speaking notes',
        format: 'YouTube',
        maxDurationMinutes: 8,
        language: 'en',
        scriptStyle: 'bullets',
      },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      const targetWords = Number(prompt.targetWords);
      const markers = 4;
      const words = Array.from({ length: targetWords - markers }, (_, index) => `point${index + 1}`);
      const perLine = Math.ceil(words.length / markers);
      const lines = Array.from({ length: markers }, (_, index) => (
        `- ${words.slice(index * perLine, (index + 1) * perLine).join(' ')}`
      ));
      return localResult({ text: lines.join('\n'), stopReason: 'stop' });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', route: 'local' });
    expect(String((completed?.result as { script?: unknown })?.script ?? '')).toContain('- point1');
    db.close();
  });

  it('supports the existing fifteen-second Reel duration contract without long-form padding', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'reel-script-job',
      request: {
        topic: 'Fifteen-second short-form script',
        format: 'Reel',
        targetDurationSeconds: 15,
        language: 'en',
      },
    }, db);

    const completed = await service.runContentScriptJob(created.job.jobId, db);
    const script = String((completed?.result as { script?: unknown })?.script ?? '');
    const words = script.trim().split(/\s+/u).filter(Boolean).length;

    expect(completed).toMatchObject({ status: 'completed', route: 'local' });
    expect(script).toContain('word1');
    expect(words).toBeGreaterThanOrEqual(30);
    expect(words).toBeLessThanOrEqual(50);
    db.close();
  });

  it('continues a capped section from its last complete sentence before checkpointing it', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'section-continuation',
      request: { topic: 'Continuation', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let truncated = false;
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      if (input.taskType === 'script_section' && !truncated) {
        truncated = true;
        const words = Number(prompt.targetWords) - 20;
        const tokens = Array.from({ length: words }, (_, index) => `prefix${index + 1}`);
        tokens[tokens.length - 1] += '.';
        return localResult({ text: tokens.join(' '), stopReason: 'length' });
      }
      if (input.taskType === 'script_section_continuation') {
        const words = Number(prompt.targetAdditionalWords);
        const tokens = Array.from({ length: words }, (_, index) => `continued${index + 1}`);
        tokens[tokens.length - 1] += '.';
        return localResult({ text: tokens.join(' '), stopReason: 'stop' });
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' '), stopReason: 'stop' });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);
    expect(completed).toMatchObject({ status: 'completed', route: 'local' });
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_section_continuation'
    ))).toHaveLength(1);
    const { decryptContentScriptJobJson } = await import('../../src/services/content-script-job-encryption');
    const checkpoint = db.prepare(`SELECT output_json FROM content_script_job_checkpoints
      WHERE job_id = ? AND section_index = 1`).get(created.job.jobId) as { output_json: string };
    expect(decryptContentScriptJobJson<{ text: string }>(checkpoint.output_json, 42).text)
      .toContain('continued1');
    db.close();
  });

  it('assembles a complete fifteen-minute script inside the 1,900-2,400 spoken-word gate', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'fifteen-minute-script',
      request: { topic: 'Long-form episode', format: 'YouTube', maxDurationMinutes: 15, language: 'en' },
    }, db);

    const completed = await service.runContentScriptJob(created.job.jobId, db);
    const script = String((completed?.result as { script?: unknown } | undefined)?.script ?? '');
    const words = script.trim().split(/\s+/).filter(Boolean).length;
    expect(completed).toMatchObject({ status: 'completed', route: 'local' });
    expect(words).toBeGreaterThanOrEqual(1_900);
    expect(words).toBeLessThanOrEqual(2_400);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM content_script_job_checkpoints
      WHERE job_id = ?`).get(created.job.jobId) as { count: number }).count).toBe(9);
    db.close();
  });

  it('reserves title words so a fifteen-minute assembled artifact remains in range', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'fifteen-minute-word-count-failure',
      request: { topic: 'Overlong final artifact', format: 'YouTube', maxDurationMinutes: 15, language: 'en' },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        const result = outlineLocalResult(Number(prompt.exactSectionCount));
        const parsed = result.parsed as { sections: Array<Record<string, unknown>> };
        parsed.sections = parsed.sections.map((section) => ({
          ...section,
          title: Array.from({ length: 80 }, () => 'x').join(' '),
        }));
        return result;
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'completed', warnings: [] });
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db)).toMatchObject({
      status: 'completed',
      warnings: [],
    });
    const final = service.getContentScriptJob(42, 42, created.job.jobId, db)?.result as { script: string };
    expect(final.script.trim().split(/\s+/u)).toHaveLength(2_100);
    expect(contentJobMocks.rejectApplicationOperationResults).not.toHaveBeenCalled();
    db.close();
  });

  it('regenerates the offending checkpoint once when final validation finds an unsupported URL', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const encryption = await import('../../src/services/content-script-job-encryption');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'unsupported-url-final-repair',
      request: { topic: 'Repair invented source', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let inventedUrlEmitted = false;
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      if (!inventedUrlEmitted && input.taskType === 'script_section') {
        inventedUrlEmitted = true;
        tokens[Math.min(10, tokens.length - 2)] = 'https://invented.example/source';
      }
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'completed', warnings: [] });
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_section_final_repair'
    ))).toHaveLength(1);
    const checkpoint = db.prepare(`SELECT state, output_json, validation_json
      FROM content_script_job_checkpoints WHERE job_id = ? AND section_index = 1`)
      .get(created.job.jobId) as { state: string; output_json: string; validation_json: string };
    expect(checkpoint.state).toBe('validated');
    expect(encryption.decryptContentScriptJobJson<{ text: string }>(checkpoint.output_json, 42).text)
      .not.toContain('invented.example');
    expect(JSON.parse(checkpoint.validation_json)).toMatchObject({ valid: true });
    db.close();
  });

  it('regenerates the outline and all sections when an unsupported URL originates in the outline', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'unsupported-outline-url-final-repair',
      request: { topic: 'Repair invented outline source', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        const result = outlineLocalResult(Number(prompt.exactSectionCount));
        if (input.taskType === 'script_outline') {
          const parsed = result.parsed as { sections: Array<Record<string, unknown>> };
          parsed.sections[0] = {
            ...parsed.sections[0],
            title: 'Invented source https://invented.example/outline',
          };
        }
        return result;
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);
    expect(completed).toMatchObject({ status: 'completed', warnings: [] });
    expect(String((completed?.result as { script?: unknown } | undefined)?.script ?? ''))
      .not.toContain('invented.example');
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ))).toHaveLength(1);
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_section_final_repair'
    ))).toHaveLength(6);
    db.close();
  });

  it('validates and repairs unsupported URLs in delivered hook and title fields', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'unsupported-outline-delivery-fields',
      request: { topic: 'Repair delivered outline fields', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        const result = outlineLocalResult(Number(prompt.exactSectionCount));
        if (input.taskType === 'script_outline') {
          const parsed = result.parsed as { hook: string; titleOptions: string[] };
          parsed.hook = 'Open https://invented.example/hook before we begin.';
          parsed.titleOptions[0] = 'A title with https://invented.example/title';
        }
        return result;
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);
    const delivered = completed?.result as { hook: string; title_options: string[] };
    expect(completed).toMatchObject({ status: 'completed', warnings: [] });
    expect(`${delivered.hook}\n${delivered.title_options.join('\n')}`).not.toContain('invented.example');
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ))).toHaveLength(1);
    db.close();
  });

  it('ignores echoed source URLs while preserving pinned URLs with commas and parentheses', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const pinnedUrl = 'https://example.test/evidence_(alpha,beta)';
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'source-metadata-url-projection',
      request: {
        topic: 'Use the pinned source safely',
        format: 'YouTube',
        maxDurationMinutes: 8,
        language: 'en',
        sources: [{
          title: 'Imported title mentions https://unrelated.example/title',
          url: pinnedUrl,
          source_type: 'user_supplied',
          relevance_note: 'User note mentions https://unrelated.example/note',
        }],
      },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        const result = outlineLocalResult(Number(prompt.exactSectionCount));
        (result.parsed as { hook: string }).hook = `Read ${pinnedUrl}.`;
        return result;
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', warnings: [] });
    expect(inferenceMock.mock.calls.some(([request]) => (
      request.taskType === 'script_outline_final_repair'
      || request.taskType === 'script_section_final_repair'
    ))).toBe(false);
    db.close();
  });

  it('regenerates the outline and every dependent section after a language mismatch', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'outline-language-final-repair',
      request: { topic: 'Repair language', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    contentJobMocks.outputLanguageMismatchesRemaining = 1;

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', warnings: [] });
    const outlineRepairs = inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ));
    expect(outlineRepairs).toHaveLength(1);
    expect(parsedPrompt(outlineRepairs[0][0].prompt)).toMatchObject({
      finalRepairWarnings: ['content_script_output_language_mismatch'],
    });
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_section_final_repair'
    ))).toHaveLength(6);
    db.close();
  });

  it('repairs a language mismatch raised while building the public response', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'public-response-language-final-repair',
      request: { topic: 'Repair public language', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    contentJobMocks.publicOutputLanguageMismatchesRemaining = 1;

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'completed', warnings: [] });
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ))).toHaveLength(1);
    expect(db.prepare(`SELECT final_repair_count FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ final_repair_count: 1 });
    db.close();
  });

  it('fails closed without cloud when a private section cannot pass bounded repair', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'bounded-local-repair',
      request: { topic: 'Fallback', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      const prompt = parsedPrompt(input.prompt);
      return input.taskType.startsWith('script_outline')
        ? outlineLocalResult(Number(prompt.exactSectionCount))
        : localResult({ text: 'too short' });
    });

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_SCRIPT_SECTION_INVALID' });

    expect(inferenceMock).toHaveBeenCalledTimes(3);
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'failed', errorCode: 'CONTENT_SCRIPT_SECTION_INVALID' });
    expect(db.prepare(`SELECT section_index, state FROM content_script_job_checkpoints
      WHERE job_id = ? ORDER BY section_index`).all(created.job.jobId)).toEqual([
      { section_index: 0, state: 'validated' },
      { section_index: 1, state: 'invalid' },
      { section_index: 2, state: 'planned' },
      { section_index: 3, state: 'planned' },
      { section_index: 4, state: 'planned' },
      { section_index: 5, state: 'planned' },
      { section_index: 6, state: 'planned' },
    ]);
    expect(db.prepare(`SELECT progress_percent FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ progress_percent: 18 });
    db.close();
  });

  it('rejects and regenerates the outline plus contributing sections after a final safety block', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'final-safety-rejection',
      request: { topic: 'Blocked final script', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    contentJobMocks.scriptSafetyBlocked = true;

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_SCRIPT_OUTPUT_BLOCKED' });

    expect(contentJobMocks.rejectApplicationOperationResults).not.toHaveBeenCalled();
    expect(contentJobMocks.rejectApplicationResult).toHaveBeenCalledTimes(14);
    expect(contentJobMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 42,
        userId: 42,
        reason: 'content_script_output_safety_blocked',
      }),
      db,
    );
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'failed', errorCode: 'CONTENT_SCRIPT_OUTPUT_BLOCKED' });
    const safetyRepairs = inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_section_final_repair'
    ));
    expect(safetyRepairs).toHaveLength(6);
    expect(parsedPrompt(safetyRepairs[0][0].prompt)).toMatchObject({
      finalRepairWarnings: ['content_script_output_safety_blocked'],
    });
    const outlineSafetyRepairs = inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ));
    expect(outlineSafetyRepairs).toHaveLength(1);
    expect(parsedPrompt(outlineSafetyRepairs[0][0].prompt)).toMatchObject({
      finalRepairWarnings: ['content_script_output_safety_blocked'],
    });
    db.close();
  });

  it('returns a checkpointed job to durable capacity wait when routing turns off', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'runtime-off-checkpoint',
      request: { topic: 'Checkpoint on rollback', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock
      .mockResolvedValueOnce(outlineLocalResult(6))
      .mockRejectedValueOnce(new MockSkillInferencePolicyError(
        'PRIVATE_LOCAL_ROUTE_UNAVAILABLE',
        'Local routing was disabled.',
        503,
      ));

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'waiting_capacity', stage: 'waiting_capacity' });
    expect(db.prepare(`SELECT attempt_count FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ attempt_count: 0 });
    expect(db.prepare(`SELECT section_index, state FROM content_script_job_checkpoints
      WHERE job_id = ? ORDER BY section_index`).all(created.job.jobId)).toEqual([
      { section_index: 0, state: 'validated' },
      { section_index: 1, state: 'generating' },
      { section_index: 2, state: 'planned' },
      { section_index: 3, state: 'planned' },
      { section_index: 4, state: 'planned' },
      { section_index: 5, state: 'planned' },
      { section_index: 6, state: 'planned' },
    ]);
    db.close();
  });

  it('requeues raw local-provider outages under their stable infrastructure kind', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'raw-local-provider-outage',
      request: { topic: 'Resume after outage', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockRejectedValueOnce(Object.assign(new Error('ollama unavailable'), {
      name: 'LocalLLMError',
      kind: 'provider_unhealthy',
    }));

    await expect(service.runContentScriptJob(created.job.jobId, db)).resolves.toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'provider_unhealthy',
    });
    expect(db.prepare(`SELECT infrastructure_requeue_count, attempt_count
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
      infrastructure_requeue_count: 1,
      attempt_count: 0,
    });
    db.close();
  });

  it('persists the one-pass final repair budget across an infrastructure requeue', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'durable-final-repair-budget',
      request: { topic: 'Bound repair across restart', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    contentJobMocks.outputLanguageMismatchesRemaining = 2;
    let outageInjected = false;
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      if (input.taskType === 'script_outline_final_repair' && !outageInjected) {
        outageInjected = true;
        throw Object.assign(new Error('gateway unavailable'), {
          name: 'LocalLLMError',
          kind: 'transport_unavailable',
        });
      }
      const prompt = parsedPrompt(input.prompt);
      if (input.taskType.startsWith('script_outline')) {
        return outlineLocalResult(Number(prompt.exactSectionCount));
      }
      const words = Number(prompt.targetWords);
      const tokens = Array.from({ length: words }, (_, index) => `word${index + 1}`);
      tokens[tokens.length - 1] += '.';
      return localResult({ text: tokens.join(' ') });
    });

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'waiting_capacity', errorCode: 'transport_unavailable' });
    expect(db.prepare(`SELECT final_repair_count FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ final_repair_count: 1 });
    db.prepare(`UPDATE content_script_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(created.job.jobId);

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
    expect(inferenceMock.mock.calls.filter(([request]) => (
      request.taskType === 'script_outline_final_repair'
    ))).toHaveLength(2);
    expect(db.prepare(`SELECT final_repair_count FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ final_repair_count: 1 });
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'failed', errorCode: 'CONTENT_OUTPUT_LOCALE_MISMATCH' });
    db.close();
  });

  it('backs off and terminates after three consecutive infrastructure requeues', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'bounded-infrastructure-requeues',
      request: { topic: 'Bound infrastructure retries', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockRejectedValue(new MockSkillInferencePolicyError(
      'LOCAL_QUEUE_FULL',
      'Local queue is full.',
      503,
    ));

    await expect(service.runContentScriptJob(created.job.jobId, db)).resolves.toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'LOCAL_QUEUE_FULL',
    });
    expect(db.prepare(`SELECT infrastructure_requeue_count, attempt_count
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
      infrastructure_requeue_count: 1,
      attempt_count: 0,
    });

    db.prepare(`UPDATE content_script_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(created.job.jobId);
    await expect(service.runContentScriptJob(created.job.jobId, db)).resolves.toMatchObject({
      status: 'waiting_capacity',
    });
    db.prepare(`UPDATE content_script_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(created.job.jobId);
    await expect(service.runContentScriptJob(created.job.jobId, db)).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED',
      warnings: expect.arrayContaining([
        'content_script_infrastructure_retry_exhausted',
        'LOCAL_QUEUE_FULL',
      ]),
    });
    expect(db.prepare(`SELECT infrastructure_requeue_count, next_attempt_at, attempt_count
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
      infrastructure_requeue_count: 3,
      next_attempt_at: null,
      attempt_count: 0,
    });
    expect(inferenceMock).toHaveBeenCalledTimes(3);
    db.close();
  });

  it('does not rewrite a durable waiting job on every recovery pass while routing stays off', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'stable-capacity-wait',
      request: { topic: 'Wait without churn', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'off', rollout_percent = 0 WHERE environment = 'staging'`).run();

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'waiting_capacity' });
    const first = db.prepare(`SELECT updated_at FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId) as { updated_at: string };
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(service.runContentScriptJob(created.job.jobId, db))
      .resolves.toMatchObject({ status: 'waiting_capacity' });
    const second = db.prepare(`SELECT updated_at FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId) as { updated_at: string };

    expect(second.updated_at).toBe(first.updated_at);
    expect(inferenceMock).not.toHaveBeenCalled();
    db.close();
  });

  it('fails without validating a checkpoint when a stage reports the wrong model digest', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'model-pin-mismatch',
      request: { topic: 'Pinned model', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    inferenceMock.mockResolvedValueOnce(outlineLocalResult(6));
    inferenceMock.mockResolvedValueOnce(localResult({
      model: 'unexpected:model',
      modelDigest: 'sha256:unexpected-model',
    }));

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_SCRIPT_PINNED_MODEL_MISMATCH' });
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'failed', errorCode: 'CONTENT_SCRIPT_PINNED_MODEL_MISMATCH' });
    expect(db.prepare(`SELECT section_index, state FROM content_script_job_checkpoints
      WHERE job_id = ? ORDER BY section_index`).all(created.job.jobId)).toEqual([
      { section_index: 0, state: 'validated' },
      { section_index: 1, state: 'invalid' },
      { section_index: 2, state: 'planned' },
      { section_index: 3, state: 'planned' },
      { section_index: 4, state: 'planned' },
      { section_index: 5, state: 'planned' },
      { section_index: 6, state: 'planned' },
    ]);
    db.close();
  });

  it('does not persist checkpoints after another worker clears the lease', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'lease-fence',
      request: { topic: 'Lease fence', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const discardedRunId = 'run-discarded-by-lease-fence';
    inferenceMock.mockImplementation(async (input: { taskType: string; prompt: string }) => {
      service.cancelContentScriptJob({ tenantId: 42, userId: 42, jobId: created.job.jobId }, db);
      const prompt = parsedPrompt(input.prompt);
      return {
        ...outlineLocalResult(Number(prompt.exactSectionCount)),
        runId: discardedRunId,
      };
    });

    await expect(service.runContentScriptJob(created.job.jobId, db))
      .rejects.toMatchObject({ code: 'CONTENT_SCRIPT_JOB_LEASE_LOST' });
    expect(db.prepare(`SELECT section_index, state FROM content_script_job_checkpoints
      WHERE job_id = ?`).all(created.job.jobId)).toEqual([
      { section_index: 0, state: 'cancelled' },
    ]);
    expect(contentJobMocks.rejectApplicationResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: discardedRunId,
        tenantId: 42,
        userId: 42,
        reason: 'content_script_checkpoint_not_committed_content_script_job_lease_lost',
      }),
      db,
    );
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db)?.status).toBe('cancelled');
    db.close();
  });

  it('renews the token-fenced lease while a provider stage is still running', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'lease-heartbeat',
      request: { topic: 'Lease heartbeat', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let releaseOutline!: (value: unknown) => void;
    inferenceMock.mockImplementationOnce(() => new Promise((resolvePending) => {
      releaseOutline = resolvePending;
    }));

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(inferenceMock).toHaveBeenCalledTimes(1));
    const before = db.prepare(`SELECT lease_expires_at FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId) as { lease_expires_at: string };
    await vi.advanceTimersByTimeAsync(60_000);
    const after = db.prepare(`SELECT lease_expires_at FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId) as { lease_expires_at: string };
    expect(after.lease_expires_at > before.lease_expires_at).toBe(true);

    releaseOutline(outlineLocalResult(6));
    await expect(running).resolves.toMatchObject({ status: 'completed' });
    db.close();
  });

  it('requeues without fabricating cancellation when a lease heartbeat cannot reach storage', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'lease-heartbeat-failure',
      request: { topic: 'Lease failure', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let releaseOutline!: (value: unknown) => void;
    let providerSignal: AbortSignal | undefined;
    inferenceMock.mockImplementationOnce((input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal;
      return new Promise((resolvePending) => { releaseOutline = resolvePending; });
    });

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    db.exec(`CREATE TEMP TRIGGER fail_script_job_heartbeat
      BEFORE UPDATE OF lease_expires_at ON content_script_jobs
      WHEN NEW.status = 'running' AND NEW.lease_expires_at IS NOT NULL
        AND OLD.lease_expires_at IS NOT NEW.lease_expires_at
      BEGIN
        SELECT RAISE(FAIL, 'heartbeat storage unavailable');
      END;`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(providerSignal?.aborted).toBe(true);
    releaseOutline(outlineLocalResult(6));
    await expect(running).resolves.toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'CONTENT_SCRIPT_HEARTBEAT_FAILED',
    });
    expect(db.prepare(`SELECT cancellation_requested_at FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({ cancellation_requested_at: null });
    db.close();
  });

  it('requeues without fabricating cancellation when the lease expires at final commit', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'completion-lease-expiry',
      request: { topic: 'Recover final commit', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.exec(`CREATE TEMP TRIGGER expire_script_job_before_completion
      AFTER UPDATE OF stage ON content_script_jobs
      WHEN NEW.job_id = '${created.job.jobId}' AND NEW.stage = 'final_validation'
      BEGIN
        UPDATE content_script_jobs
        SET lease_expires_at = '2000-01-01T00:00:00.000Z'
        WHERE job_id = NEW.job_id;
      END;`);

    await expect(service.runContentScriptJob(created.job.jobId, db)).resolves.toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'CONTENT_SCRIPT_JOB_LEASE_LOST',
    });
    expect(db.prepare(`SELECT status, cancellation_requested_at, last_error_code
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
      status: 'waiting_capacity',
      cancellation_requested_at: null,
      last_error_code: 'CONTENT_SCRIPT_JOB_LEASE_LOST',
    });
    db.close();
  });

  it('requeues this process active lease before graceful shutdown closes storage', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'graceful-shutdown-requeue',
      request: { topic: 'Shutdown recovery', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let releaseOutline!: (value: unknown) => void;
    inferenceMock.mockImplementationOnce(() => new Promise((resolvePending) => {
      releaseOutline = resolvePending;
    }));

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(inferenceMock).toHaveBeenCalledTimes(1));
    expect(service.stopContentScriptJobRecoveryLoop(db)).toBe(1);
    expect(db.prepare(`SELECT status, cancellation_requested_at, last_error_code,
        infrastructure_requeue_count, next_attempt_at, attempt_count
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
        status: 'waiting_capacity',
        cancellation_requested_at: null,
        last_error_code: 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
        infrastructure_requeue_count: 1,
        next_attempt_at: new Date(Date.now() + 15_000).toISOString(),
        attempt_count: 0,
      });
    releaseOutline(outlineLocalResult(6));
    await expect(running).rejects.toBeInstanceOf(Error);
    await expect(service.waitForContentScriptJobWorkersToStop(100)).resolves.toBe(0);
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'waiting_capacity', errorCode: 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE' });
    db.close();
  });

  it('terminates a repeatedly shutdown-requeued lease at the durable infrastructure cap', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'graceful-shutdown-requeue-cap',
      request: { topic: 'Bound shutdown recovery', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs SET infrastructure_requeue_count = 2
      WHERE job_id = ?`).run(created.job.jobId);
    let releaseOutline!: (value: unknown) => void;
    inferenceMock.mockImplementationOnce(() => new Promise((resolvePending) => {
      releaseOutline = resolvePending;
    }));

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(inferenceMock).toHaveBeenCalledTimes(1));
    expect(service.stopContentScriptJobRecoveryLoop(db)).toBe(1);
    expect(db.prepare(`SELECT status, last_error_code, infrastructure_requeue_count,
        next_attempt_at, attempt_count, warning_codes_json
      FROM content_script_jobs WHERE job_id = ?`).get(created.job.jobId)).toEqual({
        status: 'failed',
        last_error_code: 'CONTENT_SCRIPT_INFRASTRUCTURE_RETRY_EXHAUSTED',
        infrastructure_requeue_count: 3,
        next_attempt_at: null,
        attempt_count: 0,
        warning_codes_json: JSON.stringify([
          'content_script_infrastructure_retry_exhausted',
          'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
        ]),
      });
    releaseOutline(outlineLocalResult(6));
    await expect(running).rejects.toBeInstanceOf(Error);
    await expect(service.waitForContentScriptJobWorkersToStop(100)).resolves.toBe(0);
    db.close();
  });

  it('keeps pending and new script work fenced once graceful shutdown begins', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'shutdown-pending-dispatch',
      request: { topic: 'Stay queued', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);

    service.beginContentScriptJobShutdown();
    await vi.advanceTimersByTimeAsync(0);

    expect(inferenceMock).not.toHaveBeenCalled();
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db))
      .toMatchObject({ status: 'queued' });
    expect(() => service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'shutdown-new-admission',
      request: { topic: 'Do not admit', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_JOBS_SHUTTING_DOWN' }));
    db.close();
  });

  it('still aborts active provider work when shutdown requeue storage is unavailable', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'shutdown-storage-unavailable',
      request: { topic: 'Fence provider despite storage loss', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let providerSignal: AbortSignal | undefined;
    inferenceMock.mockImplementationOnce((input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal;
      return new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(input.abortSignal?.reason), { once: true });
      });
    });

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    const unavailableDb = {
      prepare: () => { throw new Error('shutdown storage unavailable'); },
    } as unknown as Database.Database;

    expect(service.stopContentScriptJobRecoveryLoop(unavailableDb)).toBe(0);
    expect(providerSignal?.aborted).toBe(true);
    await expect(running).resolves.toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'CONTENT_SCRIPT_SHUTDOWN_REQUEUE',
    });
    db.close();
  });

  it('does not clear a replacement lease during graceful-shutdown overlap', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'shutdown-replacement-lease-fence',
      request: { topic: 'Release overlap', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let releaseOutline!: (value: unknown) => void;
    inferenceMock.mockImplementationOnce(() => new Promise((resolvePending) => {
      releaseOutline = resolvePending;
    }));

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(inferenceMock).toHaveBeenCalledTimes(1));
    db.prepare(`UPDATE content_script_jobs
      SET lease_token = 'replacement-worker-token',
          lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'`)
      .run(
        new Date(Date.now() + 15 * 60_000).toISOString(),
        new Date().toISOString(),
        created.job.jobId,
      );

    expect(service.stopContentScriptJobRecoveryLoop(db)).toBe(0);
    expect(db.prepare(`SELECT status, lease_token FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({
        status: 'running',
        lease_token: 'replacement-worker-token',
      });

    releaseOutline(outlineLocalResult(6));
    await expect(running).rejects.toBeInstanceOf(Error);
    expect(db.prepare(`SELECT status, lease_token FROM content_script_jobs WHERE job_id = ?`)
      .get(created.job.jobId)).toEqual({
        status: 'running',
        lease_token: 'replacement-worker-token',
      });
    db.close();
  });

  it('resumes from the last validated section without regenerating completed stages', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const encryption = await import('../../src/services/content-script-job-encryption');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'resume-checkpoint',
      request: { topic: 'Resume', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const outline = (outlineLocalResult(6).parsed as Record<string, unknown>);
    const normalizedOutline = {
      ...outline,
      sections: (outline.sections as Array<Record<string, unknown>>).map((section, index) => ({
        ...section,
        key: `section_${index + 1}`,
        wordBudget: index < 4 ? 187 : 186,
      })),
    };
    const firstSection = {
      index: 1,
      key: 'section_1',
      title: 'Section 1',
      text: Array.from({ length: 187 }, (_, index) => `saved${index + 1}`).join(' '),
      wordBudget: 187,
      modelDigest: ACTIVE_MODEL_DIGEST,
      // Legacy/corrupt route arrays must fall back to the validated checkpoint
      // column instead of erasing provenance during resume.
      routes: ['unsupported-route'],
    };
    const insert = db.prepare(`INSERT INTO content_script_job_checkpoints (
      job_id, section_index, section_key, state, word_budget, output_json, validation_json, route
    ) VALUES (?, ?, ?, 'validated', ?, ?, '{"valid":true}', 'local')`);
    insert.run(created.job.jobId, 0, 'outline', 1120, encryption.encryptContentScriptJobJson(normalizedOutline, 42));
    insert.run(created.job.jobId, 1, 'section_1', 187, encryption.encryptContentScriptJobJson(firstSection, 42));

    const completed = await service.runContentScriptJob(created.job.jobId, db);

    expect(completed).toMatchObject({ status: 'completed', route: 'local' });
    expect(inferenceMock).toHaveBeenCalledTimes(5);
    expect(inferenceMock.mock.calls.every(([request]) => request.taskType === 'script_section')).toBe(true);
    db.close();
  });

  it('recovers an expired lease with backoff before scheduling the durable job', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'recover-expired-lease',
      request: { topic: 'Recover lease', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'running', stage = 'final_validation', progress_percent = 95,
          lease_token = 'expired-token', lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(created.job.jobId);
    const scheduled: string[] = [];

    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(1);
    expect(scheduled).toEqual([]);
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db)).toMatchObject({
      status: 'waiting_capacity',
      progress: 95,
      errorCode: 'recovered_expired_lease',
    });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(scheduled).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(scheduled).toEqual([created.job.jobId]);
    db.close();
  });

  it('sweep requeues never clobber a scheduled deferral: the batch window still gates dispatch (NH-0041)', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const scheduledJob = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'sweep-respects-scheduled-window',
      request: { topic: 'Tomorrow batch', format: 'YouTube', maxDurationMinutes: 8, language: 'en', deliveryMode: 'scheduled' },
    }, db);
    const windowBefore = (db.prepare('SELECT next_attempt_at FROM content_script_jobs WHERE job_id = ?')
      .get(scheduledJob.job.jobId) as { next_attempt_at: string | null }).next_attempt_at;
    expect(windowBefore).not.toBeNull();
    expect(new Date(windowBefore as string).getTime()).toBeGreaterThan(Date.now());

    // The scheduled job occupies the plan's active-job slot, so the crashed
    // job is forged directly as a running row instead of a second admission.
    const crashedJobId = 'script_job_sweep-crashed-standard';
    db.prepare(`INSERT INTO content_script_jobs (
        job_id, tenant_id, owner_user_id, plan_id, idempotency_key, request_hash,
        operation_id, request_json, target_duration_seconds,
        status, stage, progress_percent, model_digest, delivery_mode,
        lease_token, lease_expires_at
      ) SELECT ?, tenant_id, owner_user_id, plan_id, ?, ?, ?, request_json,
               target_duration_seconds, 'running', 'final_validation', 95,
               model_digest, 'standard', 'expired-token', '2000-01-01T00:00:00.000Z'
        FROM content_script_jobs WHERE job_id = ?`)
      .run(crashedJobId, 'sweep-crashed-standard', 'a'.repeat(64), 'content-script:sweep-crashed', scheduledJob.job.jobId);
    const crashed = { job: { jobId: crashedJobId } };

    const scheduled: string[] = [];
    // Sweep pass: requeues the crashed job with backoff; the scheduled job's
    // deferral is untouched and nothing dispatches before its window.
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(1);
    expect(scheduled).toEqual([]);
    const windowAfterSweep = (db.prepare('SELECT next_attempt_at FROM content_script_jobs WHERE job_id = ?')
      .get(scheduledJob.job.jobId) as { next_attempt_at: string | null }).next_attempt_at;
    expect(windowAfterSweep).toBe(windowBefore);

    // Past the infra backoff (well past 24h of repeated sweeps), only the
    // requeued standard job dispatches; the scheduled window still gates.
    await vi.advanceTimersByTimeAsync(15_000);
    service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) });
    expect(scheduled).toEqual([crashed.job.jobId]);
    expect((db.prepare('SELECT next_attempt_at FROM content_script_jobs WHERE job_id = ?')
      .get(scheduledJob.job.jobId) as { next_attempt_at: string | null }).next_attempt_at).toBe(windowBefore);

    // Once the batch window arrives, the scheduled job dispatches normally.
    db.prepare(`UPDATE content_script_jobs
      SET status = 'cancelled', stage = 'cancelled',
          cancellation_requested_at = '2026-08-19T12:00:00.000Z'
      WHERE job_id = ?`).run(crashed.job.jobId);
    const untilWindow = new Date(windowBefore as string).getTime() - Date.now() + 1_000;
    await vi.advanceTimersByTimeAsync(untilWindow);
    scheduled.length = 0;
    service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) });
    expect(scheduled).toContain(scheduledJob.job.jobId);
    db.close();
  });

  it('recovers a stale heartbeat before lease expiry without stealing a fresh lease', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const stale = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'recover-stale-heartbeat',
      request: { topic: 'Recover stale worker', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'running', stage = 'section_2_generation', progress_percent = 35,
          lease_token = 'stale-token', lease_expires_at = ?, updated_at = ?
      WHERE job_id = ?`).run(
      new Date(Date.now() + 10 * 60_000).toISOString(),
      new Date(Date.now() - 4 * 60_000).toISOString(),
      stale.job.jobId,
    );
    const scheduled: string[] = [];

    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(1);
    expect(service.getContentScriptJob(42, 42, stale.job.jobId, db)).toMatchObject({
      status: 'waiting_capacity',
      progress: 35,
      errorCode: 'recovered_stale_heartbeat',
    });
    expect(scheduled).toEqual([]);

    db.prepare(`UPDATE content_script_jobs
      SET status = 'running', stage = 'section_2_generation',
          lease_token = 'fresh-token', lease_expires_at = ?, updated_at = ?
      WHERE job_id = ?`).run(
      new Date(Date.now() + 10 * 60_000).toISOString(),
      new Date().toISOString(),
      stale.job.jobId,
    );
    scheduled.length = 0;
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(db.prepare(`SELECT status, lease_token FROM content_script_jobs WHERE job_id = ?`)
      .get(stale.job.jobId)).toEqual({ status: 'running', lease_token: 'fresh-token' });
    expect(scheduled).toEqual([]);
    db.close();
  });

  it('aborts this process stale worker when durable recovery supersedes its lease', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'abort-superseded-local-worker',
      request: { topic: 'Stop stale generation', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let providerSignal: AbortSignal | undefined;
    inferenceMock.mockImplementationOnce((input: { abortSignal?: AbortSignal }) => {
      providerSignal = input.abortSignal;
      return new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener('abort', () => reject(input.abortSignal?.reason), { once: true });
      });
    });

    const running = service.runContentScriptJob(created.job.jobId, db);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    db.prepare(`UPDATE content_script_jobs
      SET lease_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'`).run(
      new Date(Date.now() + 10 * 60_000).toISOString(),
      new Date(Date.now() - 4 * 60_000).toISOString(),
      created.job.jobId,
    );

    expect(service.recoverContentScriptJobs(db, { schedule: vi.fn() })).toBe(1);
    expect(providerSignal?.aborted).toBe(true);
    await expect(running).rejects.toMatchObject({ code: 'CONTENT_SCRIPT_JOB_LEASE_LOST' });
    expect(service.getContentScriptJob(42, 42, created.job.jobId, db)).toMatchObject({
      status: 'waiting_capacity',
      errorCode: 'recovered_stale_heartbeat',
    });
    db.close();
  });

  it('does not dispatch recovery work while routing is off or scheduler capacity is occupied', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const { localInferenceScheduler } = await import('../../src/services/local-inference-scheduler');
    service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'recover-capacity-guard',
      request: { topic: 'Wait for capacity', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const scheduled: string[] = [];
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'off', rollout_percent = 0 WHERE environment = 'staging'`).run();
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(scheduled).toEqual([]);

    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'active', rollout_percent = 100 WHERE environment = 'staging'`).run();
    let release!: () => void;
    const occupied = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 30_000,
      run: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await Promise.resolve();
    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(scheduled).toEqual([]);
    release();
    await occupied;
    localInferenceScheduler.resetForTests();
    db.close();
  });

  it('dispatches the oldest durable job as soon as shared inference becomes idle', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const { localInferenceScheduler } = await import('../../src/services/local-inference-scheduler');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'recover-on-scheduler-idle',
      request: { topic: 'Resume immediately', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    let release!: () => void;
    const occupied = localInferenceScheduler.schedule({
      weight: 1,
      executionClass: 'interactive',
      deadlineMs: 30_000,
      run: () => new Promise<void>((resolve) => { release = resolve; }),
    });
    await Promise.resolve();
    const scheduled: string[] = [];

    service.startContentScriptJobRecoveryLoop(db, {
      schedule: (jobId) => scheduled.push(jobId),
    });
    expect(scheduled).toEqual([]);
    release();
    await occupied;
    await Promise.resolve();

    expect(scheduled).toEqual([created.job.jobId]);
    service.stopContentScriptJobRecoveryLoop(db);
    localInferenceScheduler.resetForTests();
    db.close();
  });

  it('skips ineligible canary owners and dispatches only the first eligible durable job', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const ineligible = service.createContentScriptJob({
      tenantId: 7,
      userId: 7,
      idempotencyKey: 'canary-ineligible-job',
      request: { topic: 'Not enrolled', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const eligible = service.createContentScriptJob({
      tenantId: 84,
      userId: 84,
      idempotencyKey: 'canary-eligible-job',
      request: { topic: 'Enrolled', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs SET updated_at = ? WHERE job_id = ?`)
      .run('2026-08-13T00:00:00.000Z', ineligible.job.jobId);
    db.prepare(`UPDATE content_script_jobs SET updated_at = ? WHERE job_id = ?`)
      .run('2026-08-13T00:01:00.000Z', eligible.job.jobId);
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'canary', rollout_percent = 50 WHERE environment = 'staging'`).run();
    contentJobMocks.isEnrolled.mockImplementation((userId: number) => userId === 84);
    const scheduled: string[] = [];

    expect(service.recoverContentScriptJobs(db, { schedule: (jobId) => scheduled.push(jobId) })).toBe(0);
    expect(scheduled).toEqual([eligible.job.jobId]);
    db.close();
  });

  it('routes create-time dispatch through one durable weighted worker', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    inferenceMock.mockImplementationOnce((input: { abortSignal: AbortSignal }) => (
      new Promise((_resolve, reject) => {
        input.abortSignal.addEventListener('abort', () => {
          reject(input.abortSignal.reason ?? new Error('aborted'));
        }, { once: true });
      })
    ));
    const olderPro = service.createContentScriptJob({
      tenantId: 43,
      userId: 43,
      idempotencyKey: 'create-dispatch-pro',
      request: { topic: 'Older Pro', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const newerMax = service.createContentScriptJob({
      tenantId: 44,
      userId: 44,
      idempotencyKey: 'create-dispatch-max',
      request: { topic: 'Newer Max', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs SET plan_id = 'max' WHERE job_id = ?`)
      .run(newerMax.job.jobId);

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(inferenceMock).toHaveBeenCalledTimes(1));

    expect(service.getContentScriptJob(43, 43, olderPro.job.jobId, db)?.status).toBe('queued');
    expect(service.getContentScriptJob(44, 44, newerMax.job.jobId, db)?.status).toBe('running');
    service.cancelContentScriptJob({ tenantId: 44, userId: 44, jobId: newerMax.job.jobId }, db);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await expect(service.waitForContentScriptJobWorkersToStop(0)).resolves.toBe(0);
    db.close();
  });

  it('selects durable Max and Pro jobs with a restart-safe two-to-one priority', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const maxOne = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'priority-max-one',
      request: { topic: 'Max one', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const pro = service.createContentScriptJob({
      tenantId: 43,
      userId: 43,
      idempotencyKey: 'priority-pro',
      request: { topic: 'Pro', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const maxTwo = service.createContentScriptJob({
      tenantId: 44,
      userId: 44,
      idempotencyKey: 'priority-max-two',
      request: { topic: 'Max two', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs SET plan_id = 'max', updated_at = ?
      WHERE job_id = ?`).run('2026-08-13T00:00:00.000Z', maxOne.job.jobId);
    db.prepare(`UPDATE content_script_jobs SET updated_at = ? WHERE job_id = ?`)
      .run('2026-08-13T00:01:00.000Z', pro.job.jobId);
    db.prepare(`UPDATE content_script_jobs SET plan_id = 'max', updated_at = ?
      WHERE job_id = ?`).run('2026-08-13T00:02:00.000Z', maxTwo.job.jobId);
    db.prepare(`UPDATE plan_configs SET local_queue_weight = 999 WHERE plan_id = 'pro'`).run();

    const scheduled: string[] = [];
    const schedule = (jobId: string): void => { scheduled.push(jobId); };
    const finishSelection = (jobId: string, startedAt: string): void => {
      db.prepare(`UPDATE content_script_jobs SET status = 'failed', started_at = ?, updated_at = ?
        WHERE job_id = ?`).run(startedAt, startedAt, jobId);
    };

    service.recoverContentScriptJobs(db, { schedule });
    finishSelection(scheduled[0]!, '2026-08-13T01:00:00.000Z');
    service.recoverContentScriptJobs(db, { schedule });
    finishSelection(scheduled[1]!, '2026-08-13T01:01:00.000Z');
    service.recoverContentScriptJobs(db, { schedule });

    expect(scheduled).toEqual([maxOne.job.jobId, maxTwo.job.jobId, pro.job.jobId]);
    db.close();
  });

  it('keeps recovery inert when either durable jobs or the Content proxy is disabled', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const schedule = vi.fn();
    localPrimaryConfigMock.scriptJobsEnabled = false;
    expect(service.recoverContentScriptJobs(db, { schedule })).toBe(0);
    localPrimaryConfigMock.scriptJobsEnabled = true;
    localPrimaryConfigMock.contentProxyEnabled = false;
    expect(service.recoverContentScriptJobs(db, { schedule })).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
    db.close();
  });

  it('rejects new job admission while runtime mode is off', async () => {
    const db = database();
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'off', rollout_percent = 0 WHERE environment = 'staging'`).run();
    const service = await import('../../src/services/content-script-jobs');
    expect(() => service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'mode-off',
      request: { topic: 'Wait safely', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db)).toThrow(expect.objectContaining({ code: 'LOCAL_INFERENCE_NOT_ADMITTING' }));
    expect((db.prepare('SELECT COUNT(*) AS count FROM content_script_jobs').get() as { count: number }).count).toBe(0);
    expect(inferenceMock).not.toHaveBeenCalled();
    db.close();
  });

  it('preserves exact create and active retry replays after runtime mode turns off', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const input = {
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'accepted-before-mode-off',
      request: { topic: 'Keep the accepted operation', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    };
    const created = service.createContentScriptJob(input, db);
    db.prepare(`UPDATE local_inference_runtime_control
      SET mode = 'off', rollout_percent = 0 WHERE environment = 'staging'`).run();

    expect(service.createContentScriptJob(input, db)).toMatchObject({
      replayed: true,
      job: { jobId: created.job.jobId, status: 'queued' },
    });
    expect(service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: created.job.jobId,
    }, db)).toMatchObject({ jobId: created.job.jobId, status: 'queued' });
    expect(() => service.createContentScriptJob({
      ...input,
      idempotencyKey: 'new-after-mode-off',
    }, db)).toThrow(expect.objectContaining({ code: 'LOCAL_INFERENCE_NOT_ADMITTING' }));
    db.close();
  });

  it('cancels a queued job idempotently inside its tenant and never starts inference', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const created = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'cancel-queued-job',
      request: { topic: 'Cancel me', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);

    expect(service.cancelContentScriptJob({
      tenantId: 42, userId: 42, jobId: created.job.jobId,
    }, db)).toMatchObject({ status: 'cancelled' });
    expect(service.cancelContentScriptJob({
      tenantId: 42, userId: 42, jobId: created.job.jobId,
    }, db)).toMatchObject({ status: 'cancelled' });
    expect(() => service.cancelContentScriptJob({
      tenantId: 7, userId: 7, jobId: created.job.jobId,
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_JOB_NOT_FOUND' }));
    expect(inferenceMock).not.toHaveBeenCalled();
    db.close();
  });

  it('fences only the deleted account\'s unfinished jobs before durable erasure', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const owned = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'account-deletion-owned-job',
      request: { topic: 'Erase this job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    const other = service.createContentScriptJob({
      tenantId: 7,
      userId: 7,
      idempotencyKey: 'account-deletion-other-job',
      request: { topic: 'Keep this job', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);

    expect(service.cancelContentScriptJobsForAccountDeletion(42, db)).toBe(1);
    expect(service.getContentScriptJob(42, 42, owned.job.jobId, db)).toMatchObject({
      status: 'cancelled',
      stage: 'cancelled',
    });
    expect(service.getContentScriptJob(7, 7, other.job.jobId, db)).toMatchObject({
      status: 'queued',
    });
    expect(() => service.cancelContentScriptJobsForAccountDeletion(0, db)).toThrow();
    db.close();
  });

  it('keeps retry progress monotonic instead of resetting a resumable job to zero', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const failed = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'retry-progress',
      request: { topic: 'Resume retry', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', progress_percent = 70,
          last_error_code = 'LOCAL_INFERENCE_FAILED',
          warning_codes_json = '["fifteen_minute_word_count_out_of_range"]',
          infrastructure_requeue_count = 2,
          next_attempt_at = '2099-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(failed.job.jobId);

    expect(service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: failed.job.jobId,
    }, db)).toMatchObject({ status: 'queued', progress: 70, warnings: [] });
    expect(db.prepare(`SELECT infrastructure_requeue_count, next_attempt_at
      FROM content_script_jobs WHERE job_id = ?`).get(failed.job.jobId)).toEqual({
      infrastructure_requeue_count: 0,
      next_attempt_at: null,
    });
    db.close();
  });

  it('re-defers a scheduled job to the next batch window on user retry', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const failed = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'retry-scheduled-deferral',
      request: { topic: 'Scheduled retry keeps its window', format: 'YouTube', maxDurationMinutes: 8, language: 'en', deliveryMode: 'scheduled' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', last_error_code = 'LOCAL_INFERENCE_FAILED',
          next_attempt_at = NULL
      WHERE job_id = ?`).run(failed.job.jobId);

    expect(service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: failed.job.jobId,
    }, db)).toMatchObject({ status: 'queued' });
    // The persisted delivery_mode column is the source of truth: the retry
    // re-defers instead of letting a scheduled job jump the standard queue.
    expect(db.prepare(`SELECT delivery_mode, next_attempt_at
      FROM content_script_jobs WHERE job_id = ?`).get(failed.job.jobId)).toEqual({
      delivery_mode: 'scheduled',
      next_attempt_at: service.scheduledBatchWindowStart(new Date()),
    });
    db.close();
  });

  it('bounds explicit regeneration retries for one durable job', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const failed = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'bounded-explicit-retries',
      request: { topic: 'Bound retry loop', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', attempt_count = 2,
          last_error_code = 'LOCAL_SCRIPT_FINAL_VALIDATION_FAILED'
      WHERE job_id = ?`).run(failed.job.jobId);

    expect(() => service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: failed.job.jobId,
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_JOB_RETRY_LIMIT' }));
    expect(service.getContentScriptJob(42, 42, failed.job.jobId, db)?.status).toBe('failed');
    db.close();
  });

  it('does not let a retry exceed the plan active-job entitlement', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const failed = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'failed-before-retry',
      request: { topic: 'Retry later', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', last_error_code = 'LOCAL_INFERENCE_FAILED'
      WHERE job_id = ?`).run(failed.job.jobId);
    service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'occupies-pro-slot',
      request: { topic: 'Already queued', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);

    expect(() => service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: failed.job.jobId,
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_ACTIVE_LIMIT' }));
    expect(service.getContentScriptJob(42, 42, failed.job.jobId, db)?.status).toBe('failed');
    db.close();
  });

  it('does not let an old failed job retry bypass the rolling daily limit', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    const old = service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'old-job-retry',
      request: { topic: 'Old failed script', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db);
    db.prepare(`UPDATE content_script_jobs
      SET status = 'failed', stage = 'failed', last_error_code = 'LOCAL_INFERENCE_FAILED',
          fair_use_admitted_at = '2000-01-01T00:00:00.000Z', created_at = '2000-01-01T00:00:00.000Z'
      WHERE job_id = ?`).run(old.job.jobId);
    for (let index = 0; index < 6; index += 1) {
      const recent = service.createContentScriptJob({
        tenantId: 42,
        userId: 42,
        idempotencyKey: `recent-daily-operation-${index}`,
        request: { topic: `Recent script ${index}`, format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
      }, db);
      db.prepare(`UPDATE content_script_jobs
        SET status = 'failed', stage = 'failed', last_error_code = 'LOCAL_INFERENCE_FAILED'
        WHERE job_id = ?`).run(recent.job.jobId);
    }

    expect(() => service.retryContentScriptJob({
      tenantId: 42,
      userId: 42,
      jobId: old.job.jobId,
    }, db)).toThrow(expect.objectContaining({ code: 'CONTENT_SCRIPT_DAILY_LIMIT' }));
    expect(service.getContentScriptJob(42, 42, old.job.jobId, db)?.status).toBe('failed');
    db.close();
  });

  it('does not charge short async scripts against the long-form daily allowance', async () => {
    const db = database();
    const service = await import('../../src/services/content-script-jobs');
    for (let index = 0; index < 7; index += 1) {
      const short = service.createContentScriptJob({
        tenantId: 42,
        userId: 42,
        idempotencyKey: `short-script-${index}`,
        request: {
          topic: `Short script ${index}`,
          format: 'Reel',
          maxDurationMinutes: 1,
          targetDurationSeconds: 60,
          language: 'en',
        },
      }, db);
      db.prepare(`UPDATE content_script_jobs
        SET status = 'failed', stage = 'failed', last_error_code = 'TEST_TERMINAL'
        WHERE job_id = ?`).run(short.job.jobId);
    }

    expect(() => service.createContentScriptJob({
      tenantId: 42,
      userId: 42,
      idempotencyKey: 'long-form-after-short-scripts',
      request: { topic: 'Long form remains available', format: 'YouTube', maxDurationMinutes: 8, language: 'en' },
    }, db)).not.toThrow();
    db.close();
  });
});

describe('delivery modes (Addendum C)', () => {
  it('validates delivery modes, defaults to standard, and keeps the plan labels', async () => {
    const { resolveScriptDeliveryMode, CONTENT_SCRIPT_DELIVERY_LABELS } = await import('../../src/services/content-script-jobs');
    expect(resolveScriptDeliveryMode(undefined)).toBe('standard');
    expect(resolveScriptDeliveryMode('scheduled')).toBe('scheduled');
    expect(resolveScriptDeliveryMode('priority')).toBe('priority');
    expect(() => resolveScriptDeliveryMode('rush')).toThrow(/deliveryMode/);
    expect(CONTENT_SCRIPT_DELIVERY_LABELS).toEqual({
      standard: "We'll notify you when your script is ready.",
      scheduled: 'Have it ready tomorrow.',
      priority: 'Starts immediately.',
    });
  });

  it('defers scheduled delivery to the next 03:00 UTC batch window', async () => {
    const { scheduledBatchWindowStart } = await import('../../src/services/content-script-jobs');
    expect(scheduledBatchWindowStart(new Date('2026-08-18T12:00:00.000Z'))).toBe('2026-08-19T03:00:00.000Z');
    expect(scheduledBatchWindowStart(new Date('2026-08-18T02:59:59.000Z'))).toBe('2026-08-18T03:00:00.000Z');
    expect(scheduledBatchWindowStart(new Date('2026-08-18T03:00:00.000Z'))).toBe('2026-08-19T03:00:00.000Z');
  });
});
