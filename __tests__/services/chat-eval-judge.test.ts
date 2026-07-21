import { beforeEach, describe, expect, it, vi } from 'vitest';

const completeOneShotMock = vi.fn();

vi.mock('../../src/services/gemini-provider', () => ({
  completeOneShot: (...args: unknown[]) => completeOneShotMock(...args),
}));

import {
  CHAT_EVAL_JUDGE_CATEGORY,
  CHAT_EVAL_JUDGE_DIMENSIONS,
  CHAT_EVAL_JUDGE_MAX_OUTPUT_TOKENS,
  DEFAULT_CHAT_EVAL_JUDGE_MODEL,
  createChatEvalJudgeBudget,
  judgeChatEvalScenario,
  judgeChatEvalScenarios,
  type ChatEvalJudgeTurnInput,
} from '../../src/services/chat-eval-judge';
import { runChatEvaluationSuite } from '../../src/services/chat-evaluation-harness';
import type { ChatEvalTurnResult, ChatTurnExecutor } from '../../src/services/chat-eval-executor';

const VALID_JUDGE_JSON = JSON.stringify({
  wording_quality: { score: 2, rationale: 'Clear and concise.' },
  groundedness: { score: 2, rationale: 'No invented facts.' },
  sufficiency: { score: 1, rationale: 'Next step missing on turn 2.' },
  explanation_quality: { score: 2, rationale: 'Cause and effect explained.' },
});

function turns(): ChatEvalJudgeTurnInput[] {
  return [
    { turnId: 't1', userMessage: 'What do I need to do today?', assistantText: 'Here is your agenda.' },
    { turnId: 't2', userMessage: 'Move the workout.', assistantText: 'I need confirmation first.' },
  ];
}

function liveResult(text: string): ChatEvalTurnResult {
  return {
    ok: true,
    statusCode: 200,
    text,
    domain: 'secretary',
    routeMethod: 'context',
    metadata: { actionStatus: 'none', skillsUsed: ['secretary'] },
    envelope: {
      id: 'live-1',
      text,
      domain: 'secretary',
      routeMethod: 'context',
      confidence: 0.9,
      buttons: null,
      metadata: null,
      timestamp: '2026-07-20T08:00:00.000Z',
    },
    latencyMs: 120,
    providerTrace: { provider: 'gemini', tier: 'chat', model: 'gemini-2.5-flash' },
  };
}

beforeEach(() => {
  completeOneShotMock.mockReset();
});

describe('chat eval judge', () => {
  it('exposes exactly the llm_judge dims from the scorer mapping table', () => {
    expect(CHAT_EVAL_JUDGE_DIMENSIONS).toEqual([
      'wording_quality',
      'groundedness',
      'sufficiency',
      'explanation_quality',
    ]);
  });

  it('happy path: one flash-lite call, temperature 0, strict JSON mode, scored dims with pass threshold', async () => {
    completeOneShotMock.mockResolvedValueOnce(VALID_JUDGE_JSON);
    const result = await judgeChatEvalScenario(
      { id: 'morning_planning', title: 'Scenario A - Morning planning' },
      turns(),
      {
        maxUsd: 2,
        mode: 'real_provider',
        model: 'gemini-2.5-flash-lite',
        estimateCallCostUsd: () => 0.0004,
      },
    );

    expect(result.status).toBe('scored');
    expect(result.estimatedCostUsd).toBeCloseTo(0.0004, 10);
    expect(result.scores).toMatchObject({
      wording_quality: { score: 2, passed: true },
      groundedness: { score: 2, passed: true },
      sufficiency: { score: 1, passed: false },
      explanation_quality: { score: 2, passed: true },
    });

    expect(completeOneShotMock).toHaveBeenCalledTimes(1);
    const [systemPrompt, userPrompt, category, options] = completeOneShotMock.mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect(systemPrompt).toContain('ONLY a JSON object');
    expect(userPrompt).toContain('morning_planning');
    expect(userPrompt).toContain('Move the workout.');
    expect(category).toBe(CHAT_EVAL_JUDGE_CATEGORY);
    expect(options).toEqual({
      model: 'gemini-2.5-flash-lite',
      maxTokens: CHAT_EVAL_JUDGE_MAX_OUTPUT_TOKENS,
      temperature: 0,
      jsonMode: true,
    });
  });

  it('malformed JSON marks the scenario blocked without crashing and still counts the cost', async () => {
    completeOneShotMock.mockResolvedValueOnce('Sorry, I cannot evaluate this conversation.');
    const budget = createChatEvalJudgeBudget(2, 5);
    const result = await judgeChatEvalScenario(
      { id: 'morning_planning' },
      turns(),
      { maxUsd: 2, mode: 'real_provider', model: 'gemini-2.5-flash-lite', estimateCallCostUsd: () => 0.0005, budget },
    );

    expect(result.status).toBe('blocked');
    expect(result.scores).toBeNull();
    expect(result.detail).toContain('malformed_judge_json');
    expect(result.estimatedCostUsd).toBeCloseTo(0.0005, 10);
    expect(budget.calls).toBe(1);
    expect(budget.estimatedSpendUsd).toBeCloseTo(0.0005, 10);
  });

  it('provider failure marks the scenario blocked without crashing and still counts the cost', async () => {
    completeOneShotMock.mockRejectedValueOnce(new Error('RESOURCE_EXHAUSTED'));
    const budget = createChatEvalJudgeBudget(2, 5);
    const result = await judgeChatEvalScenario(
      { id: 'morning_planning' },
      turns(),
      { maxUsd: 2, mode: 'real_provider', model: 'gemini-2.5-flash-lite', estimateCallCostUsd: () => 0.0005, budget },
    );

    expect(result.status).toBe('blocked');
    expect(result.detail).toContain('judge_call_failed');
    expect(budget.calls).toBe(1);
    expect(budget.estimatedSpendUsd).toBeCloseTo(0.0005, 10);
  });

  it('aborts further judge calls once the projected total would exceed the budget; remaining scenarios are skipped_budget', async () => {
    completeOneShotMock.mockResolvedValue(VALID_JUDGE_JSON);
    const report = await judgeChatEvalScenarios(
      [
        { scenario: { id: 's1' }, turns: turns() },
        { scenario: { id: 's2' }, turns: turns() },
        { scenario: { id: 's3' }, turns: turns() },
      ],
      {
        maxUsd: 1,
        mode: 'real_provider',
        model: 'gemini-2.5-flash-lite',
        estimateCallCostUsd: () => 0.6,
      },
    );

    expect(report.scenarios.map((entry) => entry.status)).toEqual(['scored', 'skipped_budget', 'skipped_budget']);
    expect(report.calls).toBe(1);
    expect(report.estimatedSpendUsd).toBeCloseTo(0.6, 10);
    expect(report.aborted).toBe(true);
    expect(completeOneShotMock).toHaveBeenCalledTimes(1);
    expect(report.scenarios[1].estimatedCostUsd).toBe(0);
    expect(report.scenarios[1].detail).toContain('would exceed budget');
  });

  it('enforces the call budget independently of USD spend', async () => {
    completeOneShotMock.mockResolvedValue(VALID_JUDGE_JSON);
    const report = await judgeChatEvalScenarios(
      [
        { scenario: { id: 's1' }, turns: turns() },
        { scenario: { id: 's2' }, turns: turns() },
      ],
      {
        maxUsd: 10,
        callBudget: 1,
        mode: 'real_provider',
        model: 'gemini-2.5-flash-lite',
        estimateCallCostUsd: () => 0.0001,
      },
    );
    expect(report.scenarios.map((entry) => entry.status)).toEqual(['scored', 'skipped_budget']);
    expect(completeOneShotMock).toHaveBeenCalledTimes(1);
  });

  it('makes zero provider calls when the mode is not real_provider (defense in depth)', async () => {
    for (const mode of ['fixture', 'local_engine'] as const) {
      const result = await judgeChatEvalScenario(
        { id: 'morning_planning' },
        turns(),
        { maxUsd: 2, mode, model: 'gemini-2.5-flash-lite' },
      );
      expect(result.status).toBe('skipped_mode');
      expect(result.estimatedCostUsd).toBe(0);
    }
    expect(completeOneShotMock).toHaveBeenCalledTimes(0);
  });

  it('fails CLOSED when the mode is undefined: skipped_mode with zero provider calls', async () => {
    const result = await judgeChatEvalScenario(
      { id: 'morning_planning' },
      turns(),
      { maxUsd: 2, model: 'gemini-2.5-flash-lite' },
    );
    expect(result.status).toBe('skipped_mode');
    expect(result.detail).toContain('unspecified');
    expect(result.estimatedCostUsd).toBe(0);
    expect(completeOneShotMock).toHaveBeenCalledTimes(0);

    const report = await judgeChatEvalScenarios(
      [{ scenario: { id: 's1' }, turns: turns() }],
      { maxUsd: 2, model: 'gemini-2.5-flash-lite' },
    );
    expect(report.scenarios.map((entry) => entry.status)).toEqual(['skipped_mode']);
    expect(report.model).toBe('none');
    expect(completeOneShotMock).toHaveBeenCalledTimes(0);
  });

  it('pins the default judge model to gemini-2.5-flash-lite independent of config.gemini.classifierModel', async () => {
    expect(DEFAULT_CHAT_EVAL_JUDGE_MODEL).toBe('gemini-2.5-flash-lite');
    completeOneShotMock.mockResolvedValueOnce(VALID_JUDGE_JSON);
    const result = await judgeChatEvalScenario(
      { id: 'morning_planning' },
      turns(),
      { maxUsd: 2, mode: 'real_provider', estimateCallCostUsd: () => 0.0004 },
    );
    expect(result.status).toBe('scored');
    const [, , , options] = completeOneShotMock.mock.calls[0] as [string, string, string, Record<string, unknown>];
    expect(options.model).toBe('gemini-2.5-flash-lite');

    // Explicit opts.model still wins over the pin.
    completeOneShotMock.mockResolvedValueOnce(VALID_JUDGE_JSON);
    await judgeChatEvalScenario(
      { id: 'morning_planning' },
      turns(),
      { maxUsd: 2, mode: 'real_provider', model: 'gemini-override', estimateCallCostUsd: () => 0.0004 },
    );
    const [, , , overridden] = completeOneShotMock.mock.calls[1] as [string, string, string, Record<string, unknown>];
    expect(overridden.model).toBe('gemini-override');
  });

  describe('suite wiring', () => {
    it('fixture and local_engine suite runs make zero judge LLM calls even when judge options are supplied', async () => {
      const fixtureSuite = await runChatEvaluationSuite({
        mode: 'fixture',
        judgeOptions: { maxUsd: 5, model: 'gemini-2.5-flash-lite' },
      });
      expect(fixtureSuite.judge).toBeUndefined();
      expect(fixtureSuite.passed).toBe(true);

      const stubExecutor: ChatTurnExecutor = {
        mode: 'local_engine',
        executeTurn: async () => liveResult('Generic local engine reply.'),
      };
      const localSuite = await runChatEvaluationSuite({
        mode: 'local_engine',
        executor: stubExecutor,
        judgeOptions: { maxUsd: 5, model: 'gemini-2.5-flash-lite' },
      });
      expect(localSuite.judge).toBeUndefined();

      expect(completeOneShotMock).toHaveBeenCalledTimes(0);
    });

    it('real_provider suite runs invoke the judge once per scenario and fill llm_judge dims on live turns', async () => {
      completeOneShotMock.mockResolvedValue(VALID_JUDGE_JSON);
      const stubExecutor: ChatTurnExecutor = {
        mode: 'real_provider',
        executeTurn: async () => liveResult('Generic live reply for judging.'),
      };
      const suite = await runChatEvaluationSuite({
        mode: 'real_provider',
        executor: stubExecutor,
        judgeOptions: { maxUsd: 2, model: 'gemini-2.5-flash-lite', estimateCallCostUsd: () => 0.0004 },
      });

      expect(suite.judge).toBeDefined();
      expect(suite.judge?.model).toBe('gemini-2.5-flash-lite');
      expect(suite.judge?.scenarios.length).toBe(suite.dayToDay.scenarios.length);
      // Cost law: at most ONE call per scenario.
      expect(completeOneShotMock.mock.calls.length).toBe(suite.dayToDay.scenarios.length);
      expect(suite.judge?.calls).toBe(suite.dayToDay.scenarios.length);
      expect(suite.judge?.estimatedSpendUsd).toBeCloseTo(0.0004 * suite.dayToDay.scenarios.length, 10);

      const firstTurn = suite.dayToDay.scenarios[0]?.turns[0];
      const judged = firstTurn?.scorerDimensions?.filter((entry) => entry.source === 'llm_judge') ?? [];
      expect(judged.length).toBe(4);
      expect(judged.every((entry) => entry.score !== null && entry.passed !== null)).toBe(true);
      const sufficiency = judged.find((entry) => entry.dimension === 'sufficiency');
      expect(sufficiency?.score).toBe(1);
      expect(sufficiency?.passed).toBe(false);
      // Failing judge dims surface as turn failures with the mapped type.
      expect(firstTurn?.failures.some((failure) => failure.type === 'insufficient_answer' && failure.detail.includes('[sufficiency]'))).toBe(true);
    });

    it('a blocked judge never crashes the real_provider suite and skips judge dims honestly (passed: null)', async () => {
      completeOneShotMock.mockResolvedValue('not json at all');
      const stubExecutor: ChatTurnExecutor = {
        mode: 'real_provider',
        executeTurn: async () => liveResult('Generic live reply for judging.'),
      };
      const suite = await runChatEvaluationSuite({
        mode: 'real_provider',
        executor: stubExecutor,
        judgeOptions: { maxUsd: 2, model: 'gemini-2.5-flash-lite', estimateCallCostUsd: () => 0.0004 },
      });
      // The outage stays visible at suite level...
      expect(suite.judge?.scenarios.every((entry) => entry.status === 'blocked')).toBe(true);
      expect(suite.judge?.aborted).toBe(true);
      expect(suite.judge?.abortReason).toBe('all_blocked');
      // ...and cost of the attempted calls is still counted.
      expect(suite.judge?.estimatedSpendUsd).toBeCloseTo(0.0004 * suite.dayToDay.scenarios.length, 10);
      // Per-turn judge dims are honest skips: they never fail the turn.
      for (const scenario of suite.dayToDay.scenarios) {
        for (const turn of scenario.turns) {
          const judged = turn.scorerDimensions?.filter((entry) => entry.source === 'llm_judge') ?? [];
          expect(judged.length).toBe(4);
          expect(judged.every((entry) => entry.score === null && entry.passed === null && entry.detail.includes('judge blocked'))).toBe(true);
          expect(turn.failures.some((failure) => failure.detail.toLowerCase().includes('judge'))).toBe(false);
        }
      }
    });

    it('a partially blocked judge run is not marked all_blocked', async () => {
      completeOneShotMock
        .mockResolvedValueOnce(VALID_JUDGE_JSON)
        .mockResolvedValue('not json at all');
      const report = await judgeChatEvalScenarios(
        [
          { scenario: { id: 's1' }, turns: turns() },
          { scenario: { id: 's2' }, turns: turns() },
        ],
        { maxUsd: 2, mode: 'real_provider', model: 'gemini-2.5-flash-lite', estimateCallCostUsd: () => 0.0001 },
      );
      expect(report.scenarios.map((entry) => entry.status)).toEqual(['scored', 'blocked']);
      expect(report.aborted).toBe(false);
      expect(report.abortReason).toBeUndefined();
    });
  });
});
