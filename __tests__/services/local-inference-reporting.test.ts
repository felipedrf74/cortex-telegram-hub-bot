// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

const modelPolicyState = vi.hoisted(() => ({ manifestAvailable: true }));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/database')>('../../src/services/database')),
  getDb: () => { throw new Error('explicit database required'); },
}));
vi.mock('../../src/services/entitlement', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/entitlement')>('../../src/services/entitlement')),
  getEffectiveEntitlement: () => ({ plan: 'pro' }),
}));
vi.mock('../../src/services/local-inference-scheduler', async () => ({
  ...(await vi.importActual<typeof import('../../src/services/local-inference-scheduler')>(
    '../../src/services/local-inference-scheduler',
  )),
  localInferenceScheduler: {
    snapshot: () => ({
      activeCount: 0, queuedCount: 0, interactiveQueuedCount: 0,
      backgroundQueuedCount: 0, maxConcurrency: 1, maxWaiting: 4,
    }),
  },
}));
vi.mock('../../src/services/ollama-model-policy', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/ollama-model-policy')>(
    '../../src/services/ollama-model-policy',
  );
  return {
    ...actual,
    tryGetLocalModelManifest: () => (
      modelPolicyState.manifestAvailable
        ? actual.tryGetLocalModelManifest()
        : { ok: false as const, code: 'model_manifest_unavailable' as const }
    ),
  };
});

import { buildLocalInferenceSummary } from '../../src/services/local-inference-reporting';

afterEach(() => {
  modelPolicyState.manifestAvailable = true;
});

function database(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE skill_inference_runs (
      run_id TEXT PRIMARY KEY, operation_id TEXT, tenant_id INTEGER, user_id INTEGER,
      plan_id TEXT, skill_id TEXT, task_type TEXT, schema_id TEXT, profile_version TEXT,
      status TEXT, final_route TEXT, fallback_reason TEXT, validation_status TEXT,
      queue_wait_ms INTEGER, first_token_ms INTEGER,
      generation_tokens_per_second REAL, duration_ms INTEGER, created_at TEXT,
      evaluation_mode TEXT, risk_class TEXT, execution_class TEXT
    );
    CREATE TABLE skill_inference_attempts (
      id INTEGER PRIMARY KEY, run_id TEXT, route TEXT, outcome TEXT, failure_reason TEXT,
      model_digest TEXT
    );
    CREATE TABLE content_script_jobs (
      plan_id TEXT, owner_user_id INTEGER, status TEXT, route TEXT,
      target_duration_seconds INTEGER, created_at TEXT, completed_at TEXT,
      warning_codes_json TEXT
    );
    CREATE TABLE subscriptions (user_id INTEGER PRIMARY KEY, plan TEXT NOT NULL);
    CREATE TABLE api_usage (
      run_id TEXT, user_id INTEGER, provider TEXT, cost_usd REAL, provider_tool_cost_usd REAL, ts TEXT,
      category TEXT, base_category TEXT, request_source TEXT,
      input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, job_name TEXT
    );
    CREATE TABLE script_generation_runs (
      ts INTEGER, validation_status TEXT, fallback_used INTEGER
    );
    CREATE TABLE content_agent_jobs (
      status TEXT, created_at TEXT, id INTEGER, job_key TEXT,
      tenant_id INTEGER, owner_user_id INTEGER, completed_at TEXT
    );
    CREATE TABLE content_agent_job_steps (
      id INTEGER PRIMARY KEY, job_id INTEGER, tenant_id INTEGER, owner_user_id INTEGER,
      status TEXT, output_summary_json TEXT
    );
    CREATE TABLE local_inference_runtime_control (
      environment TEXT PRIMARY KEY, mode TEXT, rollout_percent INTEGER,
      model_manifest_version TEXT, active_model_digest TEXT, skill_profile_version TEXT,
      non_ai_p95_baseline_ms INTEGER, non_ai_baseline_sample_count INTEGER,
      non_ai_baseline_captured_at TEXT, end_user_error_rate_baseline_percent REAL,
      end_user_error_baseline_sample_count INTEGER, reason TEXT, updated_at TEXT,
      activation_evidence_reference TEXT, activation_payload_sha256 TEXT,
      activation_source_binding_sha256 TEXT, activation_producer_source_sha TEXT
    );
    CREATE TABLE plan_configs (plan_id TEXT PRIMARY KEY, active INTEGER, updated_at TEXT);
    INSERT INTO plan_configs VALUES
      ('pro', 1, '2026-01-01T00:00:00.000Z'),
      ('max', 1, '2026-01-01T00:00:00.000Z');
    INSERT INTO local_inference_runtime_control VALUES (
      'staging', 'off', 0, '2026-08-24.1',
      'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b',
      'nexus-skill-inference-v1', NULL, NULL, NULL, NULL, NULL,
      'test_default_off', '2026-08-12T00:00:00.000Z', NULL, NULL, NULL, NULL
    );
  `);
  return db;
}

describe('local inference owner reporting', () => {
  it('keeps aggregate reporting available but fails pricing proof closed without the manifest', () => {
    const db = database();
    modelPolicyState.manifestAvailable = false;

    const summary = buildLocalInferenceSummary(24 * 30, db);

    expect(summary.host.minimumMemoryAvailableBytes).toBe(6 * 1024 ** 3);
    expect(summary.pricingProof.modelDigestStablePass).toBe(false);
    expect(summary.pricingProof.stableActiveConfigurationPass).toBe(false);
    expect(summary.pricingProof.repositoryMeasurementsPass).toBe(false);
    db.close();
  });

  it('separates cloud-model spend from tools and applies Chat/script metrics to the right workloads', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('chat-local', 'chat-operation', 42, 42, 'pro', 'content', 'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed', 'local', NULL, 'valid', 50, 11000, 8, 30000, ?, 'production', 'low', 'interactive'),
      ('chat-local-repair', 'chat-operation', 42, 42, 'pro', 'content', 'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed', 'local', NULL, 'valid', 20, 9000, 9, 15000, ?, 'production', 'low', 'interactive'),
      ('script-local', 'script-operation', 42, 42, 'pro', 'content', 'script_section', 'text', 'nexus-skill-inference-v1', 'completed', 'local', NULL, 'valid', 10, 25000, 5, 60000, ?, 'production', 'low', 'background'),
      ('chat-fallback', 'fallback-operation', 42, 42, 'pro', 'content', 'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed', 'cloud', 'timeout', 'not_requested', 100, NULL, NULL, 20000, ?, 'production', 'low', 'interactive')
    `).run(now, now, now, now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'chat-local', 'local', 'success', NULL, 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b'),
      (2, 'chat-local-repair', 'local', 'success', NULL, 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b'),
      (3, 'script-local', 'local', 'success', NULL, 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b'),
      (4, 'chat-fallback', 'local', 'failure', 'timeout', NULL),
      (5, 'chat-fallback', 'cloud', 'success', NULL, NULL)
    `).run();
    db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('pro', 42, 'completed', 'local', 900, now, now, '[]');
    db.prepare(`INSERT INTO subscriptions VALUES (42, 'pro')`).run();
    db.prepare(`INSERT INTO api_usage VALUES
      ('chat-fallback', 42, 'gemini', 0.40, 0.15, ?, 'ios_chat_message_fallback', 'ios_chat_message', 'interactive', 100, 80, 1000, NULL),
      ('tool-only', 42, 'gemini', 0.00, 0.20, ?, 'content_search', 'content_search', 'interactive', 20, 10, 500, NULL),
      ('chat-local', 42, 'ollama', 0.00, 0.00, ?, 'ios_chat_message', 'ios_chat_message', 'interactive', 120, 90, 30000, NULL)
    `).run(now, now, now);
    db.prepare('INSERT INTO script_generation_runs VALUES (?, ?, ?)')
      .run(Math.floor(Date.now() / 1000), 'passed', 1);
    db.prepare('INSERT INTO content_agent_jobs (status, created_at) VALUES (?, ?)').run('completed', now);

    const summary = buildLocalInferenceSummary(24, db);
    expect(summary.operations).toMatchObject({
      total: 2,
      localCompleted: 1,
      locallyAttempted: 2,
      eligibleFallbackPercent: 50,
      cloudFallbackAttempts: 1,
      cloudFallbackReliabilityAttempts: 1,
      cloudFallbackSuccessPercent: 100,
      scriptOperations: 1,
      locallyCompletedScripts: 1,
    });
    expect(summary.latency).toMatchObject({
      ordinaryChatFirstTokenP95Ms: 9_000,
      // Repository reporting uses the nearest-rank percentile convention.
      // With two samples, p95 is therefore the upper (20s) observation.
      ordinaryChatTotalP95Ms: 20_000,
      scriptThroughputAverageTokensPerSecond: 5,
      scriptJobP95DurationMs: 0,
      ordinaryChatFirstTokenSampleCount: 1,
      ordinaryChatTotalSampleCount: 2,
      scriptThroughputSampleCount: 1,
      scriptJobDurationSampleCount: 1,
    });
    expect(summary.baseline).toMatchObject({
      providerCompletions: 3,
      activeUsers: 1,
      contentScriptRuns: 1,
      contentScriptValidationPassed: 1,
      contentScriptFallbacks: 1,
      contentSpecialistJobs: 1,
      contentSpecialistJobsCompleted: 1,
      contentSpecialistJobsFailed: 0,
    });
    expect(summary.baseline.providerWorkloads).toContainEqual(expect.objectContaining({
      provider: 'gemini',
      baseCategory: 'ios_chat_message',
      fallbackCompletions: 1,
      activeUsers: 1,
    }));
    expect(summary.economics).toMatchObject({
      actualCloudSpendUsd: 0.25,
      actualSearchToolSpendUsd: 0.35,
    });
    expect(summary.economics.estimateMethod).toContain('estimate:');
    expect(summary.plans).toEqual([expect.objectContaining({
      plan: 'pro', activeTesterDays: 1, scriptOperations: 1, locallyCompletedScripts: 1,
      actualCloudSpendUsd: 0.25, actualSearchToolSpendUsd: 0.35,
    })]);
    expect(summary.pricingProof.tierConfigurationStablePass).toBe(true);
    expect(summary.pricingProof.observedLongFormScripts).toBe(1);
    db.close();
  });

  it('includes SQLite-space timestamps alongside ISO timestamps in the same reporting window', () => {
    const db = database();
    const isoNow = new Date().toISOString();
    const sqliteNow = isoNow.replace('T', ' ').replace('Z', '');
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('sqlite-time-run', 'sqlite-time-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed',
       'local', NULL, 'valid', 5, 1000, 6, 3000, ?, 'production', 'low', 'interactive')
    `).run(sqliteNow);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'sqlite-time-run', 'local', 'success', NULL,
       'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b')
    `).run();
    db.prepare(`INSERT INTO api_usage VALUES
      ('sqlite-time-run', 42, 'ollama', 0, 0, ?, 'ios_chat_message',
       'ios_chat_message', 'interactive', 100, 50, 3000, NULL)
    `).run(sqliteNow);
    db.prepare(`INSERT INTO content_agent_jobs (status, created_at, completed_at)
      VALUES ('completed', ?, ?)`)
      .run(sqliteNow, isoNow);
    db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('pro', 42, 'completed', 'local', 900, sqliteNow, isoNow, '[]');

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations).toMatchObject({ total: 1, localCompleted: 1 });
    expect(summary.baseline).toMatchObject({
      providerCompletions: 1,
      contentSpecialistJobs: 1,
      contentSpecialistJobsCompleted: 1,
    });
    expect(summary.operations.completedScriptOperations).toBe(1);
    db.close();
  });

  it('does not count completed short-form jobs toward the 100 long-form pricing gate', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('pro', 42, 'completed', 'local', 180, now, now, '[]');

    const summary = buildLocalInferenceSummary(24 * 30, db);

    expect(summary.operations.completedScriptOperations).toBe(1);
    expect(summary.pricingProof.observedLongFormScripts).toBe(0);
    expect(summary.pricingProof.repositoryMeasurementsPass).toBe(false);
    db.close();
  });

  it('attributes a script completed inside the window even when it was queued before the window', () => {
    const db = database();
    const createdBeforeWindow = new Date(Date.now() - 48 * 60 * 60 * 1_000).toISOString();
    const completedInsideWindow = new Date().toISOString();
    const insertJob = db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertJob.run(
        'pro', 42, 'completed', 'local', 900,
        createdBeforeWindow, completedInsideWindow, '[]',
      );
    // A second operation on the same in-window day proves the older queue
    // date is not counted as a separate active tester-day.
    insertJob.run(
      'pro', 42, 'completed', 'local', 900,
      completedInsideWindow, completedInsideWindow, '[]',
    );

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations.completedScriptOperations).toBe(2);
    expect(summary.operations.locallyCompletedScripts).toBe(2);
    expect(summary.plans).toContainEqual(expect.objectContaining({
      plan: 'pro', activeTesterDays: 1,
    }));
    expect(summary.pricingProof.observedLongFormScripts).toBe(2);
    db.close();
  });

  it('does not count a reviewable script with final quality warnings as a successful local script', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO content_script_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        'pro', 42, 'completed', 'local', 900, now, now,
        JSON.stringify(['fifteen_minute_word_count_out_of_range']),
      );

    const summary = buildLocalInferenceSummary(24 * 30, db);

    expect(summary.operations).toMatchObject({
      completedScriptOperations: 1,
      locallyCompletedScripts: 0,
      localScriptPercent: 0,
    });
    expect(summary.pricingProof.observedLongFormScripts).toBe(0);
    db.close();
  });

  it('uses each specialist profile when computing local-eligible operation share', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('content-local', 'content-local-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed',
       'local', NULL, 'not_requested', 5, 1000, 6, 3000, ?, 'production', 'low', 'interactive'),
      ('finance-guarded', 'finance-guarded-operation', 42, 42, 'pro', 'finance',
       'finance_explanation', 'text', 'nexus-skill-inference-v1', 'completed',
       'cloud', 'risk_guarded', 'not_requested', 5, NULL, NULL, 3000, ?, 'production', 'medium', 'interactive')
    `).run(now, now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'content-local', 'local', 'success', NULL,
       'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b'),
      (2, 'finance-guarded', 'cloud', 'success', NULL, NULL)
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    // Medium-risk Finance is explicitly cloud-guarded by its profile and must
    // not dilute the local-served denominator for eligible operations.
    expect(summary.operations.localServedPercent).toBe(100);
    db.close();
  });

  it('counts an infrastructure-routed cloud call as fallback without counting guarded cloud-only work', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('manifest-cloud', 'manifest-cloud-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed',
       'cloud', 'model_manifest_unavailable', 'not_requested', 5, NULL, NULL, 3000,
       ?, 'production', 'low', 'interactive'),
      ('finance-cloud', 'finance-cloud-operation', 42, 42, 'pro', 'finance',
       'finance_explanation', 'text', 'nexus-skill-inference-v1', 'completed',
       'cloud', 'risk_guarded', 'not_requested', 5, NULL, NULL, 3000,
       ?, 'production', 'medium', 'interactive')
    `).run(now, now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'manifest-cloud', 'cloud', 'success', NULL, NULL),
      (2, 'finance-cloud', 'cloud', 'success', NULL, NULL)
    `).run();

    expect(buildLocalInferenceSummary(24, db).operations).toMatchObject({
      locallyAttempted: 0,
      localRoutingDecisions: 1,
      cloudFallbackAttempts: 1,
      eligibleFallbackPercent: 100,
      cloudFallbackSuccessPercent: 100,
      localSuccessPercent: 0,
    });
    db.close();
  });

  it('excludes cloud-repaired script throughput from the local-model performance gate', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('script-cloud', 'script-cloud-operation', 42, 42, 'pro', 'content',
       'script_section', 'text', 'nexus-skill-inference-v1', 'completed', 'cloud',
       'timeout', 'valid', 10, 1000, 100, 1000, ?, 'production', 'low', 'background')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'script-cloud', 'local', 'failure', 'timeout', NULL),
      (2, 'script-cloud', 'cloud', 'success', NULL, NULL)
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.latency.scriptThroughputSampleCount).toBe(0);
    expect(summary.latency.scriptThroughputAverageTokensPerSecond).toBeNull();
    db.close();
  });

  it('resets pricing-proof eligibility after a Pro or Max configuration change', () => {
    const db = database();
    db.prepare("UPDATE plan_configs SET updated_at = ? WHERE plan_id = 'max'")
      .run(new Date().toISOString());

    const summary = buildLocalInferenceSummary(24 * 30, db);

    expect(summary.pricingProof.tierConfigurationStablePass).toBe(false);
    expect(summary.pricingProof.repositoryMeasurementsPass).toBe(false);
    db.close();
  });

  it('counts a failed cloud fallback in the automatic fallback-rate denominator', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('failed-fallback', 'failed-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'failed', 'none', 'cloud_timeout', 'not_requested',
       100, NULL, NULL, 45000, ?, 'production', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'failed-fallback', 'local', 'failure', 'timeout', NULL),
      (2, 'failed-fallback', 'cloud', 'failure', 'cloud_timeout', NULL)
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations).toMatchObject({
      locallyAttempted: 1,
      eligibleFallbackPercent: 100,
      cloudFallbackAttempts: 1,
      cloudFallbackReliabilityAttempts: 1,
      cloudFallbackSuccessPercent: 0,
    });
    db.close();
  });

  it('tracks a cancelled cloud attempt without treating user cancellation as fallback unreliability', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('cancelled-fallback', 'cancelled-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'cancelled', 'none',
       'CHAT_REQUEST_CANCELLED', 'not_requested', 100, NULL, NULL, 1000, ?,
       'production', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'cancelled-fallback', 'local', 'failure', 'timeout', NULL),
      (2, 'cancelled-fallback', 'cloud', 'cancelled', 'CHAT_REQUEST_CANCELLED', NULL)
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations).toMatchObject({
      cancelled: 1,
      locallyAttempted: 1,
      eligibleFallbackPercent: 100,
      cloudFallbackAttempts: 1,
      cloudFallbackReliabilityAttempts: 0,
      cloudFallbackSuccessPercent: null,
    });
    db.close();
  });

  it('does not count detached shadow comparisons as eligible production completions', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('shadow-run', 'shadow-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'text', 'nexus-skill-inference-v1', 'completed',
       'none', NULL, 'not_requested', 5, 1000, 6, 3000, ?, 'shadow', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'shadow-run', 'local', 'success', NULL,
       'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b'),
      (2, 'shadow-run', 'cloud', 'success', NULL, NULL)
    `).run();
    db.prepare(`INSERT INTO api_usage VALUES
      ('shadow-run', 42, 'ollama', 0.00, 0.00, ?,
       'local_primary_shadow:ios_chat_message', 'local_primary_shadow:ios_chat_message',
       'interactive', 100, 50, 3000, 'local_primary_shadow'),
      (NULL, 42, 'ollama', 0.00, 0.00, ?,
       'classify_shadow', 'classify_shadow', 'interactive', 20, 10, 500, 'classify_shadow')
    `).run(now, now);

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations).toMatchObject({
      completed: 0,
      locallyAttempted: 0,
      eligibleCompleted: 0,
      ordinaryChatOperations: 0,
    });
    expect(summary.baseline.providerCompletions).toBe(0);
    expect(summary.pricingProof.repositoryMeasurementsPass).toBe(false);
    db.close();
  });

  it('does not let a valid cloud fallback hide an invalid local schema attempt', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('schema-fallback', 'schema-operation', 42, 42, 'pro', 'content',
       'chat_read_only_generation', 'generic_json', 'nexus-skill-inference-v1', 'completed', 'cloud', 'invalid_json', 'valid',
       10, 1000, 5, 5000, ?, 'production', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'schema-fallback', 'local', 'failure', 'invalid_json', NULL),
      (2, 'schema-fallback', 'cloud', 'success', NULL, NULL)
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.quality).toMatchObject({
      structuredRuns: 1,
      invalidRuns: 1,
      schemaValidityPercent: 0,
    });
    db.close();
  });

  it('counts application-rejected structured output as invalid', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('schema-rejected', 'schema-rejected-operation', 42, 42, 'pro', 'content',
       'content_specialist_group', 'generic_json', 'nexus-skill-inference-v1', 'failed', 'none',
       'content_specialist_group_semantic_invalid', 'invalid', 5, 500, 6, 1000, ?, 'production', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'schema-rejected', 'local', 'success', NULL, 'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b')
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.quality).toMatchObject({
      structuredRuns: 1,
      invalidRuns: 1,
      schemaValidityPercent: 0,
    });
    db.close();
  });

  it('does not hide an earlier cloud fallback when a later run shares the operation id', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('group-one', 'specialist-operation', 42, 42, 'pro', 'content',
       'content_specialist_group', 'generic_json', 'nexus-skill-inference-v1', 'completed', 'cloud',
       'timeout', 'valid', 5, 1000, 5, 3000, ?, 'production', 'low', 'interactive'),
      ('group-two', 'specialist-operation', 42, 42, 'pro', 'content',
       'content_specialist_group', 'generic_json', 'nexus-skill-inference-v1', 'completed', 'local',
       NULL, 'valid', 5, 900, 6, 2500, ?, 'production', 'low', 'interactive')
    `).run(now, now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'group-one', 'local', 'failure', 'timeout', NULL),
      (2, 'group-one', 'cloud', 'success', NULL, NULL),
      (3, 'group-two', 'local', 'success', NULL,
       'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b')
    `).run();

    const summary = buildLocalInferenceSummary(24, db);

    expect(summary.operations).toMatchObject({
      total: 1,
      localCompleted: 0,
      cloudCompleted: 1,
      locallyAttempted: 1,
      eligibleFallbackPercent: 100,
      cloudFallbackSuccessPercent: 100,
    });
    db.close();
  });

  it('counts a specialist workflow as local only when all seven logical roles completed through Ollama', () => {
    const db = database();
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO skill_inference_runs VALUES
      ('specialist-local', 'specialist-job-key', 42, 42, 'pro', 'content',
       'content_specialist_group', 'generic_json', 'nexus-skill-inference-v1', 'completed',
       'local', NULL, 'valid', 5, 1000, 6, 3000, ?, 'production', 'low', 'interactive')
    `).run(now);
    db.prepare(`INSERT INTO skill_inference_attempts VALUES
      (1, 'specialist-local', 'local', 'success', NULL,
       'sha256:357c53fb659c5076de1d65ccb0b397446227b71a42be9d1603d46168015c9e4b')
    `).run();
    db.prepare(`INSERT INTO content_agent_jobs
      (status, created_at, id, job_key, tenant_id, owner_user_id, completed_at)
      VALUES ('completed', ?, 7, 'specialist-job-key', 42, 42, ?)`)
      .run(now, now);
    const insertStep = db.prepare(`INSERT INTO content_agent_job_steps
      (id, job_id, tenant_id, owner_user_id, status, output_summary_json)
      VALUES (?, 7, 42, 42, 'completed', ?)`);
    for (let index = 1; index <= 7; index += 1) {
      insertStep.run(index, JSON.stringify(index === 7
        ? { basis: 'package_derived', provider: null }
        : { basis: 'provider_routed', provider: 'ollama' }));
    }

    expect(buildLocalInferenceSummary(24, db).operations).toMatchObject({
      localCompleted: 0,
      localServedPercent: 0,
    });

    db.prepare(`UPDATE content_agent_job_steps
      SET output_summary_json = ? WHERE id = 7`)
      .run(JSON.stringify({ basis: 'provider_routed', provider: 'ollama' }));
    expect(buildLocalInferenceSummary(24, db).operations).toMatchObject({
      localCompleted: 1,
      localServedPercent: 100,
    });
    db.close();
  });
});
