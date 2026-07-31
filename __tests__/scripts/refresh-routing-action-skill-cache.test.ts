// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  inspectRoutingActionSkillCacheRefresh,
  runRoutingActionSkillCacheRefresh,
  type RoutingActionSkillRefreshDependencies,
} from '../../scripts/refresh-routing-action-skill-cache';

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const MODEL = 'gemini-2.5-flash-lite';
const CORPUS_TEXT = 'Draft an email to the project group about tomorrow';
const MIGRATION = fs.readFileSync(
  path.resolve(
    __dirname,
    '..',
    '..',
    'migrations',
    '266_routing_manifest_skill_classify_cache.sql',
  ),
  'utf8',
);

function createDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE routing_corpus_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      utterance_hash TEXT NOT NULL UNIQUE,
      utterance_text TEXT,
      source TEXT NOT NULL,
      suggested_domain TEXT,
      suggested_skill TEXT,
      label_domain TEXT,
      label_skill TEXT,
      label_status TEXT NOT NULL,
      labeled_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      run_id TEXT,
      pricing_status TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      request_source TEXT,
      base_category TEXT,
      job_name TEXT,
      user_id INTEGER,
      tenant_id INTEGER
    );
  `);
  db.pragma('foreign_keys = ON');
  db.exec(MIGRATION);
  const insert = db.prepare(`
    INSERT INTO routing_corpus_items (
      tenant_id, user_id, utterance_hash, utterance_text, source,
      label_domain, label_skill, label_status, labeled_at, created_at
    ) VALUES (0, NULL, ?, ?, 'manual', 'secretary', 'mail',
      'labeled', '2026-07-31T00:00:00.000Z', ?)
  `);
  insert.run('1'.repeat(64), CORPUS_TEXT, '2026-07-31T00:00:01.000Z');
  insert.run(
    '2'.repeat(64),
    'Retry synchronizing my failed Google connection',
    '2026-07-31T00:00:02.000Z',
  );
  db.close();
}

describe('refresh-routing-action-skill-cache governed provider boundary', () => {
  let tempDir: string;
  let dbPath: string;
  let promptPath: string;
  let backupDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-skill-refresh-'));
    dbPath = path.join(tempDir, 'bot.db');
    promptPath = path.join(tempDir, 'classifier-manifest.md');
    backupDir = path.join(tempDir, 'protected-backups');
    fs.copyFileSync(
      path.resolve(__dirname, '..', '..', 'prompts', 'classifier-manifest.md'),
      promptPath,
    );
    fs.chmodSync(promptPath, 0o600);
    createDatabase(dbPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function inspect(overrides: Partial<Parameters<typeof inspectRoutingActionSkillCacheRefresh>[0]> = {}) {
    return inspectRoutingActionSkillCacheRefresh({
      dbPath,
      promptPath,
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planSequence: 1,
      model: MODEL,
      limit: 1,
      budgetUsd: 0.05,
      ...overrides,
    });
  }

  it('emits a deterministic read-only plan bound to corpus, prompt, requests, release, model, limit, and budget', () => {
    const first = inspect();
    const second = inspect();

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schemaVersion: 'routing_action_skill_cache_refresh_plan.v1',
      operation: 'populate_manifest_action_skill_classify_cache',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      provider: 'gemini',
      model: MODEL,
      usageCategory: 'gemini_classify',
      limit: 1,
      budgetUsd: 0.05,
      labeledItemCount: 2,
      cachedItemCount: 0,
      pendingItemCount: 2,
      selectedItemCount: 1,
      integrity: 'ok',
    });
    expect(first.releaseRunId).toBe(
      `routing-action-skill:${RUNTIME_SHA}:${ARTIFACT_DIGEST}`,
    );
    expect(first.providerAttemptCostCeilingUsd).toBeGreaterThan(0);
    expect(first.providerAttemptCostCeilingUsd).toBeLessThanOrEqual(first.budgetUsd);
    expect(first.pendingRows[0].providerAttemptCostCeilingUsd).toBe(
      first.providerAttemptCostCeilingUsd,
    );
    expect(first.planDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.corpusIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.promptArtifact.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.pendingRows).toHaveLength(1);
    expect(first.pendingRows[0]).toMatchObject({
      corpusItemId: 1,
      utteranceHash: '1'.repeat(64),
    });
    expect(first.pendingRows[0].requestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(JSON.stringify(first)).not.toContain(CORPUS_TEXT);

    expect(inspect({ runtimeSha: 'c'.repeat(40) }).planDigest).not.toBe(first.planDigest);
    expect(inspect({ artifactDigest: 'd'.repeat(64) }).planDigest).not.toBe(first.planDigest);
    expect(inspect({ limit: 2 }).planDigest).not.toBe(first.planDigest);
    expect(inspect({ budgetUsd: 0.04 }).planDigest).not.toBe(first.planDigest);
    expect(() => inspect({ budgetUsd: 0.000001 })).toThrow(
      /provider-attempt cost ceiling.*budget/i,
    );
    fs.appendFileSync(promptPath, 'changed\n');
    expect(() => inspect()).toThrow(/prompt artifact differs/i);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache').get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('rejects missing owner authorization or a stale acknowledgement before backup or provider access', async () => {
    const plan = inspect();
    const resolveProvider = vi.fn();
    const deps = { resolveProvider } as unknown as RoutingActionSkillRefreshDependencies;

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: false,
      acknowledgedPlanDigest: plan.planDigest,
    }, deps)).rejects.toThrow(/owner authorization/i);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(resolveProvider).not.toHaveBeenCalled();

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: `sha256:${'e'.repeat(64)}`,
    }, deps)).rejects.toThrow(/plan digest/i);
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('refuses a runtime classifier model mismatch before backup or provider access', async () => {
    const plan = inspect();
    const resolveProvider = vi.fn();
    const readConfiguredClassifierModel = vi.fn(async () => 'gemini-2.5-flash');

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider,
      readConfiguredClassifierModel,
    })).rejects.toThrow(/configured classifier model.*gemini-2\.5-flash-lite/i);

    expect(readConfiguredClassifierModel).toHaveBeenCalledOnce();
    expect(fs.existsSync(backupDir)).toBe(false);
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it('backs up before a direct one-attempt Gemini call, proves exact usage, and caches only the validated result', async () => {
    const plan = inspect();
    let classifyOptions: unknown;
    const provider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        classifyOptions = options;
        expect(fs.statSync(backupDir).mode & 0o777).toBe(0o700);
        expect(fs.readdirSync(backupDir)).toHaveLength(1);
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return { domain: 'secretary', skill: 'mail', confidence: 0.97 };
      }),
    };
    let budgetRequest: unknown;
    const result = await runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (request, callback) => {
        budgetRequest = request;
        return callback();
      },
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    });

    expect(provider.classify).toHaveBeenCalledTimes(1);
    expect(classifyOptions).toMatchObject({
      userId: 0,
      tenantId: 0,
      source: 'evaluation',
      maxProviderAttempts: 1,
      failClosedOnError: true,
      requestId: plan.releaseRunId,
    });
    expect(budgetRequest).toMatchObject({
      userId: 0,
      requestSource: 'system',
      baseCategory: 'routing_action_skill_cache_refresh',
      jobName: 'routing_action_skill_cache_refresh',
      runId: plan.releaseRunId,
      hardRunCostLimitUsd: 0.05,
      estimatedCostUsd: plan.providerAttemptCostCeilingUsd,
    });
    expect(result).toMatchObject({
      schemaVersion: 'routing_action_skill_cache_refresh_apply.v1',
      status: 'completed',
      planDigest: plan.planDigest,
      planSequence: 1,
      runId: plan.releaseRunId,
      hardBudgetUsd: 0.05,
      attempted: 1,
      cached: 1,
      remaining: 1,
      backupIntegrity: 'ok',
      integrity: 'ok',
    });
    expect(fs.statSync(result.backupPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain(CORPUS_TEXT);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare(`
      SELECT predicted_domain AS domain, predicted_skill AS skill,
             confidence, run_id AS runId
      FROM routing_manifest_skill_classify_cache
    `).get()).toEqual({
      domain: 'secretary',
      skill: 'mail',
      confidence: 0.97,
      runId: plan.releaseRunId,
    });
    expect(db.prepare(`
      SELECT runtime_sha AS runtimeSha, artifact_digest AS artifactDigest,
             plan_digest AS planDigest,
             corpus_identity_digest AS corpusIdentityDigest
      FROM routing_manifest_skill_classify_cache
    `).get()).toEqual({
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      planDigest: plan.planDigest,
      corpusIdentityDigest: plan.corpusIdentityDigest,
    });
    db.close();
  });

  it('aborts without caching when a result has no single matching successful usage row', async () => {
    const plan = inspect();
    const provider = {
      name: 'gemini',
      classify: vi.fn(async () => ({
        domain: 'secretary', skill: 'mail', confidence: 0.9,
      })),
    };

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (_request, callback) => callback(),
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    })).rejects.toThrow(/exactly one.*api_usage/i);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache').get())
      .toEqual({ count: 0 });
    db.close();

    const retryPlan = inspect();
    expect(retryPlan.planSequence).toBe(2);
    expect(retryPlan.planDigest).not.toBe(plan.planDigest);
    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
    })).rejects.toThrow(/plan digest/i);
    expect(provider.classify).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'unknown domain',
      prediction: (marker: string) => ({
        domain: marker,
        confidence: 0.9,
      }),
    },
    {
      label: 'unknown skill',
      prediction: (marker: string) => ({
        domain: 'secretary',
        skill: marker,
        confidence: 0.9,
      }),
    },
  ])('sanitizes a provider-supplied $label before any operator output or cache write', async ({
    prediction,
  }) => {
    const privateMarker = 'PRIVATE_PROVIDER_ROUTE_MARKER_71c0';
    const plan = inspect();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return prediction(privateMarker);
      }),
    };

    const outcome = await runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (_request, callback) => callback(),
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({
        error: {
          name: error instanceof Error ? error.name : 'NonError',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );

    expect(outcome).toEqual({
      error: {
        name: 'Error',
        message: 'Gemini action-skill classification was invalid; no cache row was written',
      },
    });

    // `main().catch(...)` writes this exact message to CLI stderr. Keep the
    // assertion here at the exported seam so the provider remains mocked and
    // the regression never performs network work.
    const cliStderr = 'error' in outcome
      ? outcome.error.message
      : 'Routing action-skill refresh failed';
    const observableOutput = JSON.stringify({
      outcome,
      cliStderr,
      consoleError: consoleError.mock.calls,
      consoleWarn: consoleWarn.mock.calls,
      consoleLog: consoleLog.mock.calls,
    });
    expect(observableOutput).not.toContain(privateMarker);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache').get())
      .toEqual({ count: 0 });
    expect(JSON.stringify(db.prepare('SELECT * FROM routing_manifest_skill_classify_cache').all()))
      .not.toContain(privateMarker);
    db.close();
  });

  it('sanitizes any downstream canonical-store failure before operator output', async () => {
    const privateMarker = 'PRIVATE_STORE_FAILURE_MARKER_2f93';
    const plan = inspect();
    const setupDb = new Database(dbPath);
    setupDb.exec(`
      CREATE TRIGGER reject_routing_prediction_for_test
      BEFORE INSERT ON routing_manifest_skill_classify_cache
      BEGIN
        SELECT RAISE(ABORT, '${privateMarker}');
      END
    `);
    setupDb.close();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const provider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return { domain: 'secretary', skill: 'mail', confidence: 0.97 };
      }),
    };

    const outcome = await runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (_request, callback) => callback(),
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    }).then(
      (value) => ({ value }),
      (error: unknown) => ({
        error: {
          name: error instanceof Error ? error.name : 'NonError',
          message: error instanceof Error ? error.message : String(error),
        },
      }),
    );

    expect(outcome).toEqual({
      error: {
        name: 'Error',
        message: 'Gemini action-skill prediction could not be retained; no cache row was written',
      },
    });
    const cliStderr = 'error' in outcome
      ? outcome.error.message
      : 'Routing action-skill refresh failed';
    expect(JSON.stringify({
      outcome,
      cliStderr,
      consoleError: consoleError.mock.calls,
      consoleWarn: consoleWarn.mock.calls,
      consoleLog: consoleLog.mock.calls,
    })).not.toContain(privateMarker);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare('SELECT COUNT(*) AS count FROM routing_manifest_skill_classify_cache').get())
      .toEqual({ count: 0 });
    db.close();
  });

  it('retains prior proven rows when a later item aborts and makes the remainder resumable', async () => {
    const plan = inspect({ limit: 2 });
    let calls = 0;
    let activeReservations = 0;
    const budgetRequests: Array<Record<string, unknown>> = [];
    const provider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        calls += 1;
        if (calls === 1) {
          const db = new Database(dbPath);
          db.prepare(`
            INSERT INTO api_usage (
              category, model, provider, run_id, pricing_status,
              input_tokens, output_tokens, cost_usd,
              request_source, base_category, job_name, user_id, tenant_id
            ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
              100, 12, 0.00002, 'system',
              'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
          `).run(MODEL, (options as { requestId: string }).requestId);
          db.close();
          return { domain: 'secretary', skill: 'mail', confidence: 0.97 };
        }
        return { domain: 'connections', skill: 'connections', confidence: 0.95 };
      }),
    };

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (request, callback) => {
        expect(activeReservations).toBe(0);
        budgetRequests.push(request as unknown as Record<string, unknown>);
        activeReservations += 1;
        try {
          return await callback();
        } finally {
          activeReservations -= 1;
        }
      },
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    })).rejects.toThrow(/exactly one.*api_usage/i);

    expect(provider.classify).toHaveBeenCalledTimes(2);
    expect(activeReservations).toBe(0);
    expect(budgetRequests).toHaveLength(2);
    expect(budgetRequests).toEqual(plan.pendingRows.map((row) => expect.objectContaining({
      userId: 0,
      requestSource: 'system',
      baseCategory: 'routing_action_skill_cache_refresh',
      jobName: 'routing_action_skill_cache_refresh',
      runId: plan.releaseRunId,
      hardRunCostLimitUsd: 0.05,
      estimatedCostUsd: row.providerAttemptCostCeilingUsd,
    })));
    expect(budgetRequests.reduce(
      (sum, request) => sum + Number(request.estimatedCostUsd),
      0,
    )).toBeCloseTo(plan.providerAttemptCostCeilingUsd, 9);
    for (const call of provider.classify.mock.calls) {
      expect(call[2]).toMatchObject({
        source: 'evaluation',
        maxProviderAttempts: 1,
        failClosedOnError: true,
      });
    }
    const resumed = inspect({ limit: 2 });
    expect(resumed).toMatchObject({
      planSequence: 2,
      cachedItemCount: 1,
      pendingItemCount: 1,
      selectedItemCount: 1,
    });
    expect(resumed.pendingRows[0].utteranceHash).toBe('2'.repeat(64));
    expect(() => inspect({ limit: 2, budgetUsd: 0.04 })).toThrow(
      /existing release.*hard budget.*0\.05/i,
    );

    const resumedBudgetRequests: Array<Record<string, unknown>> = [];
    const resumedProvider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return { domain: 'secretary', skill: 'mail', confidence: 0.96 };
      }),
    };
    const resumedResult = await runRoutingActionSkillCacheRefresh({
      ...resumed,
      dbPath,
      promptPath,
      backupDir: `${backupDir}-resume`,
      ownerAuthorized: true,
      acknowledgedPlanDigest: resumed.planDigest,
    }, {
      resolveProvider: async () => resumedProvider,
      withBudgetReservation: async (request, callback) => {
        resumedBudgetRequests.push(request as unknown as Record<string, unknown>);
        return callback();
      },
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    });
    expect(resumedResult.runId).toBe(plan.releaseRunId);
    expect(resumedBudgetRequests).toEqual([
      expect.objectContaining({
        runId: plan.releaseRunId,
        hardRunCostLimitUsd: 0.05,
      }),
    ]);
    const evidenceDb = new Database(dbPath, { readonly: true });
    expect(evidenceDb.prepare(`
      SELECT COUNT(DISTINCT run_id) AS runCount,
             COUNT(DISTINCT runtime_sha) AS runtimeCount,
             COUNT(DISTINCT artifact_digest) AS artifactCount,
             COUNT(DISTINCT plan_digest) AS planCount
      FROM routing_manifest_skill_classify_cache
    `).get()).toEqual({
      runCount: 1,
      runtimeCount: 1,
      artifactCount: 1,
      planCount: 2,
    });
    evidenceDb.close();
  });

  it('atomically refuses a concurrent replay of the exact claimed plan before a second provider call', async () => {
    const plan = inspect();
    let releaseProvider!: () => void;
    let markProviderEntered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { markProviderEntered = resolve; });
    const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const provider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        markProviderEntered();
        await providerRelease;
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return { domain: 'secretary', skill: 'mail', confidence: 0.97 };
      }),
    };
    const dependencies = {
      resolveProvider: async () => provider,
      withBudgetReservation: async (_request: unknown, callback: () => Promise<unknown>) => callback(),
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    } as RoutingActionSkillRefreshDependencies;

    const first = runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, dependencies);
    await providerEntered;

    let replayError: unknown;
    try {
      await runRoutingActionSkillCacheRefresh({
        ...plan,
        dbPath,
        promptPath,
        backupDir: `${backupDir}-concurrent`,
        ownerAuthorized: true,
        acknowledgedPlanDigest: plan.planDigest,
      }, dependencies);
    } catch (error) {
      replayError = error;
    } finally {
      releaseProvider();
    }
    expect(replayError).toBeInstanceOf(Error);
    expect((replayError as Error).message).toMatch(
      /plan digest|already active|sequence.*already/i,
    );
    expect(provider.classify).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toMatchObject({ status: 'completed', cached: 1 });
    expect(provider.classify).toHaveBeenCalledTimes(1);
  });

  it('completes an empty next-sequence receipt without duplicating valid failed-plan provider rows', async () => {
    const plan = inspect({ limit: 2 });
    const firstProvider = {
      name: 'gemini',
      classify: vi.fn(async (_message: string, _context: unknown, options: unknown) => {
        const db = new Database(dbPath);
        db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, (options as { requestId: string }).requestId);
        db.close();
        return { domain: 'secretary', skill: 'mail', confidence: 0.97 };
      }),
    };
    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => firstProvider,
      withBudgetReservation: async (_request, callback) => callback(),
      enterManifestPromptScope: async () => () => {
        throw new Error('simulated post-cache failure');
      },
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    })).rejects.toThrow(/simulated post-cache failure/i);
    expect(firstProvider.classify).toHaveBeenCalledTimes(2);

    const receiptPlan = inspect({ limit: 2 });
    expect(receiptPlan).toMatchObject({
      planSequence: 2,
      cachedItemCount: 2,
      pendingItemCount: 0,
      selectedItemCount: 0,
    });
    const receiptProvider = { name: 'gemini', classify: vi.fn() };
    const receipt = await runRoutingActionSkillCacheRefresh({
      ...receiptPlan,
      dbPath,
      promptPath,
      backupDir: `${backupDir}-receipt`,
      ownerAuthorized: true,
      acknowledgedPlanDigest: receiptPlan.planDigest,
    }, {
      resolveProvider: async () => receiptProvider,
      withBudgetReservation: async () => {
        throw new Error('empty receipt must not reserve provider budget');
      },
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    });
    expect(receipt).toMatchObject({ attempted: 0, cached: 0, remaining: 0 });
    expect(receiptProvider.classify).not.toHaveBeenCalled();
    const evidenceDb = new Database(dbPath, { readonly: true });
    expect(evidenceDb.prepare(`
      SELECT status, COUNT(*) AS count
      FROM routing_manifest_skill_refresh_plan_claims
      GROUP BY status ORDER BY status
    `).all()).toEqual([
      { status: 'completed', count: 1 },
      { status: 'failed', count: 1 },
    ]);
    evidenceDb.close();
  });

  it('rechecks the exact release-bound cache inside the budget reservation before provider access', async () => {
    const plan = inspect();
    const provider = {
      name: 'gemini',
      classify: vi.fn(),
    };
    const result = await runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (request, callback) => {
        const db = new Database(dbPath);
        const usageId = Number(db.prepare(`
          INSERT INTO api_usage (
            category, model, provider, run_id, pricing_status,
            input_tokens, output_tokens, cost_usd,
            request_source, base_category, job_name, user_id, tenant_id
          ) VALUES ('gemini_classify', ?, 'gemini', ?, 'resolved',
            100, 12, 0.00002, 'system',
            'routing_action_skill_cache_refresh', 'routing_action_skill_cache_refresh', 0, 0)
        `).run(MODEL, request.runId).lastInsertRowid);
        db.prepare(`
          INSERT INTO routing_manifest_skill_classify_cache (
            runtime_sha, artifact_digest, plan_digest, corpus_identity_digest,
            utterance_hash, prompt_sha256, request_builder_version, request_sha256,
            provider, model, usage_category, predicted_domain, predicted_skill,
            confidence, api_usage_id, run_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'gemini', ?, 'gemini_classify',
            'secretary', 'mail', 0.98, ?, ?)
        `).run(
          RUNTIME_SHA,
          ARTIFACT_DIGEST,
          plan.planDigest,
          plan.corpusIdentityDigest,
          plan.pendingRows[0].utteranceHash,
          plan.promptArtifact.sha256.slice('sha256:'.length),
          plan.requestBuilderVersion,
          plan.pendingRows[0].requestSha256.slice('sha256:'.length),
          MODEL,
          usageId,
          request.runId,
        );
        db.close();
        return callback();
      },
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => fs.readFileSync(promptPath, 'utf8'),
    });

    expect(provider.classify).not.toHaveBeenCalled();
    expect(result).toMatchObject({ attempted: 0, cached: 0, remaining: 1 });
  });

  it('refuses provider access when the active classifier system prompt is not the inspected artifact', async () => {
    const plan = inspect();
    const provider = {
      name: 'gemini',
      classify: vi.fn(async () => ({
        domain: 'secretary', skill: 'mail', confidence: 0.9,
      })),
    };

    await expect(runRoutingActionSkillCacheRefresh({
      ...plan,
      dbPath,
      promptPath,
      backupDir,
      ownerAuthorized: true,
      acknowledgedPlanDigest: plan.planDigest,
    }, {
      resolveProvider: async () => provider,
      withBudgetReservation: async (_request, callback) => callback(),
      enterManifestPromptScope: async () => () => undefined,
      readActiveClassifierSystemPrompt: async () => 'legacy classifier prompt',
    })).rejects.toThrow(/active classifier.*prompt.*artifact/i);
    expect(provider.classify).not.toHaveBeenCalled();
  });
});
