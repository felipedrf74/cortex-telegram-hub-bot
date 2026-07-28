// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Bounded flash-lite LLM judge for the chat eval llm_judge dimensions
// (wording_quality / groundedness / sufficiency / explanation_quality).
//
// Cost law (approved eval-spend waiver, < $2/month):
//   - runs ONLY in real_provider mode — fixture and local_engine runs make
//     ZERO LLM calls (mode is gated both by the caller and inside this module);
//   - at most ONE provider call per scenario;
//   - Gemini flash-lite tier, temperature 0, strict JSON output;
//   - projected spend is estimated BEFORE each call with the repo's
//     upper-bound pricing helper; once the projection would exceed the run
//     budget, remaining scenarios are skipped as 'skipped_budget'.
//
// The judge is deliberately Gemini-only (completeOneShot, the tracked
// cost-logging wrapper): a cross-provider fallback would break the
// flash-lite tier pin and the one-call-per-scenario cost law. Any provider
// failure or malformed/refused output degrades to status 'blocked' for the
// judge dims — it never crashes the eval run, and the attempted call's
// estimated cost stays counted against the budget.

import {
  CHAT_EVAL_SCORER_DIMENSIONS,
  type ChatEvalScorerDimensionId,
} from './chat-eval-scorer';
import { computeProviderCallCostUpperBoundUsd } from './model-pricing';

export type ChatEvalJudgeDimensionId = Extract<
  ChatEvalScorerDimensionId,
  'wording_quality' | 'groundedness' | 'sufficiency' | 'explanation_quality'
>;

export const CHAT_EVAL_JUDGE_DIMENSIONS: ChatEvalJudgeDimensionId[] =
  (Object.keys(CHAT_EVAL_SCORER_DIMENSIONS) as ChatEvalScorerDimensionId[])
    .filter((id): id is ChatEvalJudgeDimensionId => CHAT_EVAL_SCORER_DIMENSIONS[id].source === 'llm_judge');

export const CHAT_EVAL_JUDGE_CATEGORY = 'chat_eval_judge';
// Hard flash-lite pin, deliberately decoupled from config.gemini.classifierModel
// so an operator classifier retune can never silently move the judge onto a
// pricier tier. Explicit opts.model still wins.
export const DEFAULT_CHAT_EVAL_JUDGE_MODEL = 'gemini-2.5-flash-lite';
export const CHAT_EVAL_JUDGE_MAX_OUTPUT_TOKENS = 700;
// Matches the harness convention that a dimension passes at >= 1.5 / 2.
export const CHAT_EVAL_JUDGE_PASS_THRESHOLD = 1.5;
// Bounds prompt size (and therefore the pre-call cost estimate) per turn.
const JUDGE_MAX_TEXT_CHARS_PER_TURN = 1200;
const JUDGE_MAX_RATIONALE_CHARS = 300;

export interface ChatEvalJudgeTurnInput {
  turnId: string;
  userMessage: string;
  assistantText: string;
}

export interface ChatEvalJudgeScenarioRef {
  id: string;
  title?: string;
}

export type ChatEvalJudgeStatus = 'scored' | 'blocked' | 'skipped_budget' | 'skipped_mode';

export interface ChatEvalJudgeDimensionResult {
  /** 0..2 scale, same as deterministic dims. */
  score: number;
  passed: boolean;
  rationale: string;
}

export interface ChatEvalJudgeScenarioResult {
  scenarioId: string;
  status: ChatEvalJudgeStatus;
  /** Present only when status === 'scored'; one entry per judge dimension. */
  scores: Record<ChatEvalJudgeDimensionId, ChatEvalJudgeDimensionResult> | null;
  /** Estimated (upper-bound) USD attributed to this scenario; 0 when skipped. */
  estimatedCostUsd: number;
  detail: string;
}

/** Mutable budget state shared across the scenarios of one eval run. */
export interface ChatEvalJudgeBudgetState {
  maxUsd: number;
  callBudget: number;
  calls: number;
  estimatedSpendUsd: number;
  aborted: boolean;
}

export type ChatEvalJudgeCompletionFn = (input: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}) => Promise<string>;

export type ChatEvalJudgeCostEstimator = (input: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  maxOutputTokens: number;
}) => number;

export interface ChatEvalJudgeOptions {
  /** Hard USD ceiling for the whole run (the CLI's EVAL_MAX_USD_PER_RUN). */
  maxUsd: number;
  /** Max provider calls for the run; defaults to one per scenario. */
  callBudget?: number;
  /**
   * Defense-in-depth mode gate: anything other than an explicit
   * 'real_provider' (including an undefined mode) returns 'skipped_mode'
   * without touching the provider — the gate fails CLOSED. Callers gate too.
   */
  mode?: 'fixture' | 'local_engine' | 'real_provider';
  /** Judge model; defaults to the hardcoded DEFAULT_CHAT_EVAL_JUDGE_MODEL pin. */
  model?: string;
  /** Injectable completion seam (tests). Default: tracked Gemini one-shot. */
  complete?: ChatEvalJudgeCompletionFn;
  /** Injectable pre-call cost estimator (tests). Default: pricing upper bound. */
  estimateCallCostUsd?: ChatEvalJudgeCostEstimator;
  /** Shared budget state; created per call when omitted. */
  budget?: ChatEvalJudgeBudgetState;
}

export interface ChatEvalJudgeRunReport {
  model: string;
  maxUsd: number;
  callBudget: number;
  calls: number;
  estimatedSpendUsd: number;
  aborted: boolean;
  /** Present when aborted for a run-level reason (e.g. 'all_blocked'). */
  abortReason?: string;
  scenarios: ChatEvalJudgeScenarioResult[];
}

export function createChatEvalJudgeBudget(maxUsd: number, callBudget: number): ChatEvalJudgeBudgetState {
  return { maxUsd, callBudget, calls: 0, estimatedSpendUsd: 0, aborted: false };
}

export async function judgeChatEvalScenario(
  scenario: ChatEvalJudgeScenarioRef,
  turnsWithResults: readonly ChatEvalJudgeTurnInput[],
  opts: ChatEvalJudgeOptions,
): Promise<ChatEvalJudgeScenarioResult> {
  // Fail closed: only an explicit 'real_provider' arms the judge. An
  // undefined mode is treated as not-live and skipped.
  if (opts.mode !== 'real_provider') {
    return skipped(scenario.id, 'skipped_mode', `judge disabled in ${opts.mode ?? 'unspecified'} mode`);
  }
  const budget = opts.budget ?? createChatEvalJudgeBudget(opts.maxUsd, opts.callBudget ?? 1);
  if (budget.aborted) {
    return skipped(scenario.id, 'skipped_budget', 'judge budget exhausted by an earlier scenario');
  }
  if (budget.calls >= budget.callBudget) {
    budget.aborted = true;
    return skipped(scenario.id, 'skipped_budget', `call budget ${budget.callBudget} exhausted`);
  }

  const model = resolveJudgeModel(opts);
  const systemPrompt = buildJudgeSystemPrompt();
  const userPrompt = buildJudgeUserPrompt(scenario, turnsWithResults);
  const estimator = opts.estimateCallCostUsd ?? defaultEstimateCallCostUsd;
  const estimatedCostUsd = estimator({
    systemPrompt,
    userPrompt,
    model,
    maxOutputTokens: CHAT_EVAL_JUDGE_MAX_OUTPUT_TOKENS,
  });
  // Unresolved pricing estimates as +Infinity, so unregistered judge models
  // fail closed into skipped_budget instead of making unpriced calls.
  if (!Number.isFinite(estimatedCostUsd) || budget.estimatedSpendUsd + estimatedCostUsd > budget.maxUsd) {
    budget.aborted = true;
    return skipped(
      scenario.id,
      'skipped_budget',
      `projected spend ${formatUsd(budget.estimatedSpendUsd + estimatedCostUsd)} would exceed budget ${formatUsd(budget.maxUsd)}`,
    );
  }

  // Count the attempt before the call: a failed or malformed call still spent
  // real provider tokens, so its estimate must stay booked against the budget.
  budget.calls += 1;
  budget.estimatedSpendUsd += estimatedCostUsd;

  const complete = opts.complete ?? defaultComplete;
  let rawText: string;
  try {
    rawText = await complete({ systemPrompt, userPrompt, model });
  } catch (err) {
    return {
      scenarioId: scenario.id,
      status: 'blocked',
      scores: null,
      estimatedCostUsd,
      detail: `judge_call_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const scores = parseJudgeResponse(rawText);
  if (!scores) {
    return {
      scenarioId: scenario.id,
      status: 'blocked',
      scores: null,
      estimatedCostUsd,
      detail: 'malformed_judge_json: response was not the required strict JSON shape',
    };
  }
  return {
    scenarioId: scenario.id,
    status: 'scored',
    scores,
    estimatedCostUsd,
    detail: 'scored',
  };
}

export async function judgeChatEvalScenarios(
  scenarios: ReadonlyArray<{ scenario: ChatEvalJudgeScenarioRef; turns: readonly ChatEvalJudgeTurnInput[] }>,
  opts: ChatEvalJudgeOptions,
): Promise<ChatEvalJudgeRunReport> {
  const callBudget = opts.callBudget ?? scenarios.length;
  const budget = opts.budget ?? createChatEvalJudgeBudget(opts.maxUsd, callBudget);
  const results: ChatEvalJudgeScenarioResult[] = [];
  for (const entry of scenarios) {
    results.push(await judgeChatEvalScenario(entry.scenario, entry.turns, { ...opts, callBudget, budget }));
  }
  // A run where EVERY scenario blocked is a judge outage: surface it loudly
  // as an aborted report so the CLI can print it, while each turn's judge
  // dims stay honest skips (passed: null).
  const allBlocked = results.length > 0 && results.every((entry) => entry.status === 'blocked');
  return {
    model: opts.mode === 'real_provider' ? resolveJudgeModel(opts) : 'none',
    maxUsd: budget.maxUsd,
    callBudget: budget.callBudget,
    calls: budget.calls,
    estimatedSpendUsd: budget.estimatedSpendUsd,
    aborted: budget.aborted || allBlocked,
    ...(allBlocked ? { abortReason: 'all_blocked' } : {}),
    scenarios: results,
  };
}

function skipped(scenarioId: string, status: 'skipped_budget' | 'skipped_mode', detail: string): ChatEvalJudgeScenarioResult {
  return { scenarioId, status, scores: null, estimatedCostUsd: 0, detail };
}

function resolveJudgeModel(opts: ChatEvalJudgeOptions): string {
  return opts.model ?? DEFAULT_CHAT_EVAL_JUDGE_MODEL;
}

// Tracked Gemini one-shot: logs usage + cost to api_usage under the judge
// category and reserves budget via the existing provider-call guardrails.
// Dynamic import (not top-level) keeps fixture-mode consumers of this module
// from loading the provider stack at all.
const defaultComplete: ChatEvalJudgeCompletionFn = async ({ systemPrompt, userPrompt, model }) => {
  const gemini = await import('./gemini-provider');
  return gemini.completeOneShot(systemPrompt, userPrompt, CHAT_EVAL_JUDGE_CATEGORY, {
    model,
    maxTokens: CHAT_EVAL_JUDGE_MAX_OUTPUT_TOKENS,
    temperature: 0,
    jsonMode: true,
  });
};

const defaultEstimateCallCostUsd: ChatEvalJudgeCostEstimator = ({ systemPrompt, userPrompt, model, maxOutputTokens }) =>
  computeProviderCallCostUpperBoundUsd({
    provider: 'gemini',
    model,
    payload: { systemPrompt, userPrompt, maxTokens: maxOutputTokens, temperature: 0, jsonMode: true },
    maxOutputTokens,
  });

function buildJudgeSystemPrompt(): string {
  return [
    'You are a strict evaluation judge for a multi-skill personal assistant chat product.',
    'You are given one scenario: the user messages and the assistant replies, in order.',
    'Score the assistant replies for the WHOLE scenario on exactly these four dimensions:',
    '- wording_quality: clear, natural, appropriately concise wording for a chat UI.',
    '- groundedness: replies stay grounded in the conversation; no invented facts, data, or completed actions.',
    '- sufficiency: replies contain what the user needs to act (result, constraints, unresolved items, next step).',
    '- explanation_quality: reasoning and cause/effect are explained where the user needs them.',
    'Each score is an integer 0, 1, or 2 (0 = clear failure, 1 = weak, 2 = good).',
    'Respond with ONLY a JSON object — no markdown fences, no commentary — in exactly this shape:',
    '{"wording_quality":{"score":2,"rationale":"..."},"groundedness":{"score":2,"rationale":"..."},"sufficiency":{"score":2,"rationale":"..."},"explanation_quality":{"score":2,"rationale":"..."}}',
    'Keep each rationale under 200 characters. Do not add extra keys.',
  ].join('\n');
}

function buildJudgeUserPrompt(
  scenario: ChatEvalJudgeScenarioRef,
  turns: readonly ChatEvalJudgeTurnInput[],
): string {
  const lines: string[] = [`Scenario: ${scenario.title ?? scenario.id} (id=${scenario.id})`];
  turns.forEach((turn, index) => {
    lines.push('');
    lines.push(`Turn ${index + 1} (${turn.turnId})`);
    lines.push(`User: ${truncate(turn.userMessage, JUDGE_MAX_TEXT_CHARS_PER_TURN)}`);
    lines.push(`Assistant: ${truncate(turn.assistantText, JUDGE_MAX_TEXT_CHARS_PER_TURN)}`);
  });
  return lines.join('\n');
}

function parseJudgeResponse(rawText: string): Record<ChatEvalJudgeDimensionId, ChatEvalJudgeDimensionResult> | null {
  const stripped = rawText
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  const scores = {} as Record<ChatEvalJudgeDimensionId, ChatEvalJudgeDimensionResult>;
  for (const dimension of CHAT_EVAL_JUDGE_DIMENSIONS) {
    const entry = raw[dimension];
    const score = extractScore(entry);
    if (score === null) return null;
    const rationale = entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).rationale === 'string'
      ? truncate((entry as Record<string, unknown>).rationale as string, JUDGE_MAX_RATIONALE_CHARS)
      : '';
    scores[dimension] = {
      score,
      passed: score >= CHAT_EVAL_JUDGE_PASS_THRESHOLD,
      rationale,
    };
  }
  return scores;
}

function extractScore(entry: unknown): number | null {
  const value = typeof entry === 'number'
    ? entry
    : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).score === 'number'
      ? (entry as Record<string, unknown>).score as number
      : null;
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(2, Math.max(0, value));
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function formatUsd(value: number): string {
  return Number.isFinite(value) ? `$${value.toFixed(6)}` : '$unbounded';
}
