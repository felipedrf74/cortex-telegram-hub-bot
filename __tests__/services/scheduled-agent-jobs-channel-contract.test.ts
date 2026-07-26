import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  plan: vi.fn(),
  processScope: vi.fn(),
  runGoverned: vi.fn(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  adapters: [] as Array<{
    adapter: Record<string, unknown>;
    scope: { tenantId: number; userId: number };
  }>,
}));

class MockAgentJobOutputValidationError extends Error {}

vi.mock('../../src/utils/logger', () => ({
  logger: state.logger,
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/utils/request-context', () => ({
  runWithContext: (_context: unknown, work: () => unknown) => work(),
}));

vi.mock('../../src/services/channel-learner', () => ({
  planChannelRelearnScopes: () => state.plan(),
  processChannelRelearnScope: (...args: unknown[]) => state.processScope(...args),
}));

vi.mock('../../src/services/agent-job-runner', () => ({
  AgentJobOutputValidationError: MockAgentJobOutputValidationError,
  runGovernedAgentJob: (...args: unknown[]) => state.runGoverned(...args),
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

vi.mock('../../src/services/database', () => ({
  getDb: vi.fn(),
}));

vi.mock('../../src/services/eval-criteria', () => ({
  getEvalTarget: vi.fn(),
}));

vi.mock('../../src/services/agent-job-targets', () => ({
  listActiveAgentJobTenantTargets: vi.fn(() => []),
}));

vi.mock('../../src/services/ai-automation-policy', () => ({
  recordAiAutomationEligibilitySkip: vi.fn(),
  resolveAiAutomationEligibility: vi.fn(),
}));

vi.mock('../../src/services/entitlement', () => ({
  isPaidAiCostControlsEnforcementEnabled: vi.fn(() => false),
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: vi.fn(),
}));

type ChannelResult = {
  analyzed: number;
  failed: number;
  skipped_no_new_videos: number;
  synthesized: boolean;
  synthesis_skipped_all_unchanged: boolean;
  synthesis_deferred: boolean;
};

type ChannelAdapter = {
  jobId: string;
  providerRouting: string;
  prepare: (scope: { tenantId: number; userId: number }) => Record<string, unknown>;
  execute: (context: {
    scope: { tenantId: number; userId: number };
    input: Record<string, unknown>;
    runId: string;
  }) => Promise<ChannelResult>;
  validateOutput: (output: ChannelResult) => void;
  classifyOutput: (
    output: ChannelResult,
    input: Record<string, unknown>,
    usage: { providerCalls: number },
  ) => string;
};

function channelResult(overrides: Partial<ChannelResult> = {}): ChannelResult {
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

function capturedAdapter(index = -1): ChannelAdapter {
  const captured = index < 0 ? state.adapters.at(index) : state.adapters[index];
  if (!captured) throw new Error('expected captured channel adapter');
  return captured.adapter as unknown as ChannelAdapter;
}

describe('scheduled channel agent contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.adapters.length = 0;
    state.plan.mockReturnValue({ scopes: [], synthesisDeferred: false });
    state.processScope.mockResolvedValue(channelResult());
    state.runGoverned.mockImplementation(async (
      adapter: ChannelAdapter,
      scope: { tenantId: number; userId: number },
    ) => {
      state.adapters.push({
        adapter: adapter as unknown as Record<string, unknown>,
        scope,
      });
      const prepared = adapter.prepare(scope) as {
        kind: string;
        status?: string;
        input?: Record<string, unknown>;
      };
      if (prepared.kind === 'skip') {
        return {
          status: prepared.status,
          providerCalls: 0,
        };
      }
      const output = await adapter.execute({
        scope,
        input: prepared.input ?? {},
        runId: `channel-run-${scope.userId}`,
      });
      adapter.validateOutput(output);
      return {
        status: adapter.classifyOutput(
          output,
          prepared.input ?? {},
          { providerCalls: scope.userId === 0 ? 1 : 0 },
        ),
        providerCalls: scope.userId === 0 ? 1 : 0,
        output,
      };
    });
  });

  it('records the exact bounded skip when no channel scopes are eligible', async () => {
    state.plan.mockReturnValue({ scopes: [], synthesisDeferred: true });
    const { runScheduledChannelRelearn } = await import('../../src/services/scheduled-agent-jobs');

    await expect(runScheduledChannelRelearn(true)).resolves.toEqual(channelResult({
      synthesis_deferred: true,
    }));
    expect(state.runGoverned).toHaveBeenCalledTimes(1);
    expect(state.adapters[0]?.scope).toEqual({ tenantId: 0, userId: 0 });

    const adapter = capturedAdapter();
    expect(adapter.jobId).toBe('channel_relearn');
    expect(adapter.providerRouting).toBe(
      'gemini-primary-openai-fallback-anthropic-gated-last-resort',
    );
    expect(adapter.prepare({ tenantId: 0, userId: 0 })).toEqual({
      kind: 'skip',
      status: 'skipped_no_work',
      reason: 'no_eligible_channel_scopes',
      fingerprintMaterial: {
        force: true,
        scopes: 0,
      },
    });
    expect(state.processScope).not.toHaveBeenCalled();
  });

  it('merges platform and tenant results and propagates platform synthesis', async () => {
    state.plan.mockReturnValue({
      scopes: [undefined, 42],
      synthesisDeferred: false,
    });
    state.processScope.mockImplementation(async (
      force: boolean,
      scopeUserId: number | undefined,
      options: { runId: string; systemScopeChanged: boolean },
    ) => {
      expect(force).toBe(false);
      if (scopeUserId == null) {
        expect(options).toEqual({
          runId: 'channel-run-0',
          systemScopeChanged: false,
        });
        return channelResult({
          analyzed: 2,
          synthesized: true,
          synthesis_deferred: true,
        });
      }
      expect(options).toEqual({
        runId: 'channel-run-42',
        systemScopeChanged: true,
      });
      return channelResult({
        skipped_no_new_videos: 1,
        synthesis_skipped_all_unchanged: true,
      });
    });
    const { runScheduledChannelRelearn } = await import('../../src/services/scheduled-agent-jobs');

    await expect(runScheduledChannelRelearn()).resolves.toEqual({
      analyzed: 2,
      failed: 0,
      skipped_no_new_videos: 1,
      synthesized: true,
      synthesis_skipped_all_unchanged: true,
      synthesis_deferred: true,
    });
    expect(state.runGoverned).toHaveBeenCalledTimes(2);
    expect(state.adapters.map(({ scope }) => scope)).toEqual([
      { tenantId: 0, userId: 0 },
      { tenantId: 42, userId: 42 },
    ]);
    expect(capturedAdapter(0).prepare({ tenantId: 0, userId: 0 })).toEqual({
      kind: 'ready',
      input: {
        force: false,
        scopeUserId: undefined,
        systemScopeChanged: false,
      },
      fingerprintMaterial: {
        force: false,
        scope: 'platform',
        systemScopeChanged: false,
      },
    });
    expect(capturedAdapter(1).prepare({ tenantId: 42, userId: 42 })).toEqual({
      kind: 'ready',
      input: {
        force: false,
        scopeUserId: 42,
        systemScopeChanged: true,
      },
      fingerprintMaterial: {
        force: false,
        scope: 'tenant',
        systemScopeChanged: true,
      },
    });
  });

  it('merges a failed platform scope, warns exactly, and continues the tenant scope', async () => {
    state.plan.mockReturnValue({
      scopes: [undefined, 42],
      synthesisDeferred: false,
    });
    state.processScope.mockImplementation(async (
      _force: boolean,
      scopeUserId: number | undefined,
      options: { systemScopeChanged: boolean },
    ) => {
      if (scopeUserId == null) {
        return channelResult({
          failed: 1,
          synthesized: true,
        });
      }
      expect(options.systemScopeChanged).toBe(true);
      return channelResult({ analyzed: 1 });
    });
    const { runScheduledChannelRelearn } = await import('../../src/services/scheduled-agent-jobs');

    await expect(runScheduledChannelRelearn(true)).resolves.toEqual({
      analyzed: 1,
      failed: 1,
      skipped_no_new_videos: 0,
      synthesized: true,
      synthesis_skipped_all_unchanged: false,
      synthesis_deferred: false,
    });
    expect(state.processScope).toHaveBeenCalledTimes(2);
    expect(state.logger.warn).toHaveBeenCalledWith(
      { failed: 1, scopeUserId: null },
      'Channel re-learn governed scope completed with channel failures',
    );
  });

  it('validates every channel output field and classifies provider usage exactly', async () => {
    state.plan.mockReturnValue({ scopes: [42], synthesisDeferred: false });
    const { runScheduledChannelRelearn } = await import('../../src/services/scheduled-agent-jobs');
    await runScheduledChannelRelearn();
    const adapter = capturedAdapter();
    const valid = channelResult();

    expect(() => adapter.validateOutput(valid)).not.toThrow();
    for (const invalid of [
      channelResult({ analyzed: -1 }),
      channelResult({ analyzed: 1.5 }),
      channelResult({ failed: -1 }),
      channelResult({ failed: 1 }),
      channelResult({ skipped_no_new_videos: -1 }),
      { ...channelResult(), synthesized: 'yes' },
      { ...channelResult(), synthesis_skipped_all_unchanged: 1 },
      { ...channelResult(), synthesis_deferred: null },
    ]) {
      expect(() => adapter.validateOutput(invalid as ChannelResult)).toThrow(
        'Channel re-learn output failed validation',
      );
    }

    expect(adapter.classifyOutput(valid, {}, { providerCalls: 1 })).toBe('success');
    expect(adapter.classifyOutput(
      channelResult({ synthesis_skipped_all_unchanged: true }),
      {},
      { providerCalls: 0 },
    )).toBe('skipped_unchanged');
    expect(adapter.classifyOutput(
      channelResult({ skipped_no_new_videos: 1 }),
      {},
      { providerCalls: 0 },
    )).toBe('skipped_unchanged');
    expect(adapter.classifyOutput(valid, {}, { providerCalls: 0 })).toBe('skipped_no_work');
  });

  it('rethrows failures that are not the bounded channel result error', async () => {
    state.plan.mockReturnValue({ scopes: [42], synthesisDeferred: false });
    state.runGoverned.mockRejectedValue(new TypeError('governance unavailable'));
    const { runScheduledChannelRelearn } = await import('../../src/services/scheduled-agent-jobs');

    await expect(runScheduledChannelRelearn()).rejects.toThrow('governance unavailable');
    expect(state.logger.warn).not.toHaveBeenCalled();
  });
});
