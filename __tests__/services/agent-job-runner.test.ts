import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAgentJobManifestEntry } from '../../src/services/agent-job-manifest';
import {
  AgentJobAuditUnavailableError,
  AgentJobGovernanceError,
  AgentJobOutputValidationError,
  AgentJobProviderAttributionError,
  AgentJobUsageScopeError,
  resetAgentJobRunnerForTests,
  runGovernedAgentJob,
  type AgentJobRunnerDependencies,
  type GovernedAgentJobAdapter,
} from '../../src/services/agent-job-runner';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

type TestInput = { promptState: string };
type TestOutput = { accepted: boolean; score: number };

const AUTORESEARCH_ROUTE = 'gemini-or-openai-primary-anthropic-fallback';
const CONTENT_ROUTE = 'grounded-provider-fallback-route';

function insertUsage(
  db: Database.Database,
  runId: string,
  scope = { tenantId: 0, userId: 0 },
  costUsd = 0.0125,
): void {
  db.prepare(`
    INSERT INTO api_usage (
      category, model, tenant_id, user_id, cost_usd, provider,
      request_source, job_name, base_category, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'agent_job_runner_test',
    'test-provider-model',
    scope.tenantId,
    scope.userId,
    costUsd,
    'gemini',
    'automation',
    'agent_job_runner_test',
    'agent_job_runner_test',
    runId,
  );
}

function deterministicDependencies(
  db: Database.Database,
  prefix = 'runner-test',
): AgentJobRunnerDependencies {
  let sequence = 0;
  return {
    db,
    randomUUID: () => `${prefix}-${++sequence}`,
    sleep: async () => {},
  };
}

function autoresearchAdapter(
  db: Database.Database,
  execute = vi.fn(async ({ runId }: { runId: string }) => {
    insertUsage(db, runId);
    return { accepted: true, score: 0.9 };
  }),
): GovernedAgentJobAdapter<TestInput, TestOutput> {
  return {
    jobId: 'autoresearch',
    providerRouting: AUTORESEARCH_ROUTE,
    prepare: () => ({
      kind: 'ready',
      input: { promptState: 'private prompt material' },
      fingerprintMaterial: { promptState: 'private prompt material' },
    }),
    execute,
    validateOutput(output) {
      if (!output.accepted || output.score < 0 || output.score > 1) {
        throw new AgentJobOutputValidationError();
      }
    },
  };
}

describe('shared governed agent job runner', () => {
  let db: Database.Database;

  beforeEach(() => {
    resetAgentJobRunnerForTests();
    db = createMigratedTestDatabase();
  });

  afterEach(() => {
    resetAgentJobRunnerForTests();
    db.close();
  });

  it('binds provider usage to one audited run and skips an unchanged fingerprint with zero calls', async () => {
    const execute = vi.fn(async ({ runId }: { runId: string }) => {
      insertUsage(db, runId);
      return { accepted: true, score: 0.9 };
    });
    const adapter = autoresearchAdapter(db, execute);
    const dependencies = deterministicDependencies(db, 'fingerprint');

    const first = await runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 }, dependencies);
    const second = await runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 }, dependencies);

    expect(first).toMatchObject({ status: 'success', providerCalls: 1, costUsd: 0.0125 });
    expect(second).toMatchObject({
      status: 'skipped_unchanged',
      providerCalls: 0,
      costUsd: 0,
      skipReason: 'runtime_fingerprint_unchanged',
    });
    expect(execute).toHaveBeenCalledTimes(1);

    const rows = db.prepare(`
      SELECT status, provider_calls, input_fingerprint, output_fingerprint, skip_reason
        FROM agent_job_runs
       ORDER BY id
    `).all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(['success', 'skipped_unchanged']);
    expect(rows[0]?.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]?.output_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain('private prompt material');
  });

  it('honors an output-inventory gate before the provider adapter', async () => {
    let inventoryFull = false;
    const execute = vi.fn(async ({ runId, scope }: { runId: string; scope: { tenantId: number; userId: number } }) => {
      insertUsage(db, runId, scope);
      inventoryFull = true;
      return { accepted: true, score: 0.8 };
    });
    const adapter: GovernedAgentJobAdapter<TestInput, TestOutput> = {
      jobId: 'tuesday_reels',
      providerRouting: CONTENT_ROUTE,
      prepare: () => inventoryFull
        ? {
          kind: 'skip',
          status: 'skipped_unchanged',
          reason: 'output_inventory_full',
          fingerprintMaterial: { missingCount: 0 },
        }
        : {
          kind: 'ready',
          input: { promptState: 'inventory-needed' },
          fingerprintMaterial: { missingCount: 5 },
        },
      execute,
      validateOutput: () => {},
    };
    const dependencies = deterministicDependencies(db, 'inventory');

    const first = await runGovernedAgentJob(adapter, { tenantId: 9, userId: 9 }, dependencies);
    const second = await runGovernedAgentJob(adapter, { tenantId: 9, userId: 9 }, dependencies);

    expect(first.status).toBe('success');
    expect(second).toMatchObject({
      status: 'skipped_unchanged',
      skipReason: 'output_inventory_full',
      providerCalls: 0,
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails closed on invalid tenant scope or unavailable audit stores before execution', async () => {
    const execute = vi.fn(async () => ({ accepted: true, score: 0.5 }));
    const tenantAdapter: GovernedAgentJobAdapter<TestInput, TestOutput> = {
      jobId: 'tuesday_reels',
      providerRouting: CONTENT_ROUTE,
      prepare: () => ({
        kind: 'ready',
        input: { promptState: 'x' },
        fingerprintMaterial: { state: 'x' },
      }),
      execute,
      validateOutput: () => {},
    };

    await expect(runGovernedAgentJob(
      tenantAdapter,
      { tenantId: 10, userId: 11 },
      deterministicDependencies(db, 'scope'),
    )).rejects.toBeInstanceOf(AgentJobGovernanceError);

    const emptyDb = new Database(':memory:');
    try {
      await expect(runGovernedAgentJob(
        autoresearchAdapter(emptyDb, execute),
        { tenantId: 0, userId: 0 },
        deterministicDependencies(emptyDb, 'missing-store'),
      )).rejects.toBeInstanceOf(AgentJobAuditUnavailableError);
    } finally {
      emptyDb.close();
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('audits a bounded preparation failure before any provider work', async () => {
    const execute = vi.fn(async () => ({ accepted: true, score: 0.5 }));
    const adapter = autoresearchAdapter(db, execute);
    adapter.prepare = () => {
      throw new RangeError('private inventory detail that must not be persisted');
    };

    await expect(runGovernedAgentJob(
      adapter,
      { tenantId: 0, userId: 0 },
      deterministicDependencies(db, 'prepare-failure'),
    )).rejects.toBeInstanceOf(RangeError);

    expect(db.prepare(`
      SELECT status, input_fingerprint, provider_calls, cost_usd, error_code
        FROM agent_job_runs
    `).get()).toEqual({
      status: 'failed',
      input_fingerprint: null,
      provider_calls: 0,
      cost_usd: 0,
      error_code: 'RangeError',
    });
    expect(JSON.stringify(db.prepare('SELECT * FROM agent_job_runs').all()))
      .not.toContain('private inventory detail');
    expect(execute).not.toHaveBeenCalled();
  });

  it('records an overlapping invocation without entering the provider adapter twice', async () => {
    let releasePreparation: (() => void) | undefined;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const execute = vi.fn(async ({ runId }: { runId: string }) => {
      insertUsage(db, runId);
      return { accepted: true, score: 0.7 };
    });
    const adapter = autoresearchAdapter(db, execute);
    adapter.prepare = async () => {
      await preparationGate;
      return {
        kind: 'ready',
        input: { promptState: 'overlap' },
        fingerprintMaterial: { promptState: 'overlap' },
      };
    };
    const dependencies = deterministicDependencies(db, 'overlap');

    const firstPromise = runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 }, dependencies);
    const overlapping = await runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 }, dependencies);
    releasePreparation?.();
    const first = await firstPromise;

    expect(overlapping).toMatchObject({
      status: 'skipped_overlap',
      skipReason: 'runtime_process_lock',
      providerCalls: 0,
    });
    expect(first.status).toBe('success');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('uses bounded manifest retries and audits each attempt independently', async () => {
    const entry = getAgentJobManifestEntry('autoresearch');
    const retryEntry = {
      ...entry,
      sharedRunner: { ...entry.sharedRunner!, maxAttempts: 2, retryBackoffMs: 10 },
    };
    const execute = vi.fn(async ({ runId, attempt }: { runId: string; attempt: number }) => {
      if (attempt === 1) throw new TypeError('transient provider failure with private detail');
      insertUsage(db, runId);
      return { accepted: true, score: 0.95 };
    });
    const adapter = autoresearchAdapter(db, execute);
    adapter.isRetryable = () => true;
    const dependencies = {
      ...deterministicDependencies(db, 'retry'),
      manifestEntry: retryEntry,
      sleep: vi.fn(async () => {}),
    };

    const outcome = await runGovernedAgentJob(adapter, { tenantId: 0, userId: 0 }, dependencies);

    expect(outcome).toMatchObject({ status: 'success', attempt: 2, providerCalls: 1 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(dependencies.sleep).toHaveBeenCalledWith(10);
    const attempts = db.prepare(`
      SELECT attempt, status, error_code FROM agent_job_runs ORDER BY id
    `).all();
    expect(attempts).toEqual([
      { attempt: 1, status: 'failed', error_code: 'TypeError' },
      { attempt: 2, status: 'success', error_code: null },
    ]);
  });

  it('fails invalid or unattributed output without creating a reusable checkpoint', async () => {
    const execute = vi.fn(async () => ({ accepted: true, score: 0.5 }));
    const adapter = autoresearchAdapter(db, execute);
    const dependencies = deterministicDependencies(db, 'unattributed');

    await expect(runGovernedAgentJob(
      adapter,
      { tenantId: 0, userId: 0 },
      dependencies,
    )).rejects.toBeInstanceOf(AgentJobProviderAttributionError);

    const row = db.prepare(`
      SELECT status, provider_calls, output_fingerprint, error_code
        FROM agent_job_runs
    `).get();
    expect(row).toEqual({
      status: 'failed',
      provider_calls: 0,
      output_fingerprint: null,
      error_code: 'AgentJobProviderAttributionError',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects provider usage attributed outside the governed tenant scope', async () => {
    const execute = vi.fn(async ({ runId }: { runId: string }) => {
      insertUsage(db, runId, { tenantId: 99, userId: 99 });
      return { accepted: true, score: 0.5 };
    });
    const adapter: GovernedAgentJobAdapter<TestInput, TestOutput> = {
      jobId: 'tuesday_reels',
      providerRouting: CONTENT_ROUTE,
      prepare: () => ({
        kind: 'ready',
        input: { promptState: 'tenant-7' },
        fingerprintMaterial: { promptState: 'tenant-7' },
      }),
      execute,
      validateOutput: () => {},
    };

    await expect(runGovernedAgentJob(
      adapter,
      { tenantId: 7, userId: 7 },
      deterministicDependencies(db, 'scope-attribution'),
    )).rejects.toBeInstanceOf(AgentJobUsageScopeError);

    expect(db.prepare(`
      SELECT status, provider_calls, cost_usd, error_code FROM agent_job_runs
    `).get()).toEqual({
      status: 'failed',
      provider_calls: 1,
      cost_usd: 0.0125,
      error_code: 'AgentJobUsageScopeError',
    });
  });

  it('records bounded notification state without persisting output content', async () => {
    const notify = vi.fn(async () => {});
    const adapter = autoresearchAdapter(db);
    adapter.notify = notify;

    const outcome = await runGovernedAgentJob(
      adapter,
      { tenantId: 0, userId: 0 },
      deterministicDependencies(db, 'notify'),
    );

    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      runId: outcome.runId,
      status: 'success',
      providerCalls: 1,
    }));
    const row = db.prepare(`
      SELECT notification_status, output_fingerprint FROM agent_job_runs WHERE run_id = ?
    `).get(outcome.runId);
    expect(row).toEqual({
      notification_status: 'sent',
      output_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });
});
