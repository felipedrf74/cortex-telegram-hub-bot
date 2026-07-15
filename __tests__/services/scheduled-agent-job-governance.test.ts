import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let testDb: Database.Database;

const channelMocks = vi.hoisted(() => ({
  plan: vi.fn(),
  processScope: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/channel-learner', () => ({
  planChannelRelearnScopes: (...args: unknown[]) => channelMocks.plan(...args),
  processChannelRelearnScope: (...args: unknown[]) => channelMocks.processScope(...args),
}));

vi.mock('../../src/services/autoresearch', () => ({
  computePromptStateHash: vi.fn(),
  getScheduledTarget: vi.fn(),
  runAutoresearch: vi.fn(),
}));

vi.mock('../../src/services/content-workflow', () => ({
  generateAndStoreTopicCandidates: vi.fn(),
  generateWeeklyPackage: vi.fn(),
  getMissingScheduledInventoryCount: vi.fn(),
}));

vi.mock('../../src/services/eval-criteria', () => ({ getEvalTarget: vi.fn() }));
vi.mock('../../src/services/agent-job-targets', () => ({ listActiveAgentJobTenantTargets: vi.fn(() => []) }));
vi.mock('../../src/services/ai-automation-policy', () => ({
  recordAiAutomationEligibilitySkip: vi.fn(),
  resolveAiAutomationEligibility: vi.fn(),
}));
vi.mock('../../src/services/entitlement', () => ({ isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false) }));
vi.mock('../../src/services/operator-alerts', () => ({ recordOperatorAlert: vi.fn() }));
vi.mock('../../src/utils/request-context', () => ({ runWithContext: vi.fn((_ctx, work) => work()) }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  LOGGER_REDACTION_PATHS: [],
}));

import { runScheduledChannelRelearn } from '../../src/services/scheduled-agent-jobs';

function channelResult(overrides: Record<string, unknown> = {}) {
  return {
    analyzed: 0,
    failed: 0,
    skipped_no_new_videos: 0,
    synthesized: false,
    synthesis_skipped_all_unchanged: false,
    synthesis_deferred: false,
    ...overrides,
  };
}

function insertUsage(runId: string, tenantId: number, userId: number): void {
  testDb.prepare(`
    INSERT INTO api_usage (
      category, model, tenant_id, user_id, cost_usd, provider,
      request_source, job_name, base_category, run_id
    ) VALUES ('channel_learning', 'test-model', ?, ?, 0.03, 'gemini',
              'automation', 'channel_relearn', 'channel_learning', ?)
  `).run(tenantId, userId, runId);
}

describe('remaining scheduled agent-job governance', () => {
  beforeEach(() => {
    testDb = createMigratedTestDatabase();
    channelMocks.plan.mockReset();
    channelMocks.processScope.mockReset();
  });

  afterEach(() => {
    testDb.close();
  });

  it('audits platform and tenant channel scopes independently and preserves domain unchanged gates', async () => {
    channelMocks.plan.mockReturnValue({ scopes: [undefined, 42], synthesisDeferred: false });
    channelMocks.processScope.mockImplementation(async (
      _force: boolean,
      scopeUserId: number | undefined,
      options: { runId: string; systemScopeChanged: boolean },
    ) => {
      if (scopeUserId == null) {
        insertUsage(options.runId, 0, 0);
        return channelResult({ analyzed: 1, synthesized: true });
      }
      expect(options.systemScopeChanged).toBe(true);
      return channelResult({
        skipped_no_new_videos: 1,
        synthesis_skipped_all_unchanged: true,
      });
    });

    const result = await runScheduledChannelRelearn();

    expect(result).toMatchObject({
      analyzed: 1,
      failed: 0,
      skipped_no_new_videos: 1,
      synthesized: true,
      synthesis_skipped_all_unchanged: true,
    });
    expect(testDb.prepare(`
      SELECT tenant_id, user_id, status, provider_calls, skip_reason
        FROM agent_job_runs
       WHERE job_id = 'channel_relearn'
       ORDER BY id
    `).all()).toEqual([
      { tenant_id: 0, user_id: 0, status: 'success', provider_calls: 1, skip_reason: null },
      {
        tenant_id: 42,
        user_id: 42,
        status: 'skipped_unchanged',
        provider_calls: 0,
        skip_reason: 'domain_fingerprint_unchanged',
      },
    ]);
  });

  it('records a failed channel scope while retaining the bounded aggregate result', async () => {
    channelMocks.plan.mockReturnValue({ scopes: [42], synthesisDeferred: false });
    channelMocks.processScope.mockResolvedValue(channelResult({ failed: 1 }));

    await expect(runScheduledChannelRelearn()).resolves.toMatchObject({ failed: 1 });

    expect(testDb.prepare(`
      SELECT status, tenant_id, user_id, provider_calls, error_code
        FROM agent_job_runs
       WHERE job_id = 'channel_relearn'
    `).get()).toEqual({
      status: 'failed',
      tenant_id: 42,
      user_id: 42,
      provider_calls: 0,
      error_code: 'ChannelRelearnScopeExecutionError',
    });
  });
});
