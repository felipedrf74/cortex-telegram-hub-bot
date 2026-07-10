// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Autoresearch — prompt evaluation and operator-controlled optimization.
 *
 * Modes:
 * 1. evaluate_only scores the current prompt and never proposes or writes.
 * 2. propose scores and returns one candidate edit without writing it.
 * 3. apply evaluates mutations and may write/commit, but is limited to an
 *    explicitly non-production runtime.
 *
 * Production scheduling always uses evaluate_only. Its prompt+eval fingerprint
 * gate reuses any prior valid score when unchanged, yielding zero model calls.
 * Propose/apply retain the quality threshold gate; explicit operator runs can
 * bypass either gate with { force: true }.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { loadPrompt, writePrompt, getPromptPath } from '../utils/prompt-loader';
import { getEvalTarget, getAllTargets, EvalTarget, TestInput } from './eval-criteria';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';
import { sanitizeForPromptInterpolation } from '../utils/prompt-sanitizer';
import { withAiBudgetReservation } from './cost-guardrail';
import { rethrowAiUsageFailClosedError } from './api-usage-fallback';
import { hasValidLiveTopicFields } from './content-workflow';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

// Autoresearch is an operator/eval workload, not an end-user chat turn.
// Keep the system attribution explicit so future per-user quota audits do not
// mistake these optimization calls for a missing user scope.
const SYSTEM_AI_METERING_SCOPE = { userId: 0, tenantId: 0 } as const;

// ─── Types ───────────────────────────────────────────────────────────

export interface CriterionResult {
  criterionId: string;
  question: string;
  passed: boolean;
  weight: number;
}

export interface TestInputResult {
  inputId: string;
  output: string;
  criteria: CriterionResult[];
  score: number;
}

export interface EvalResult {
  target: string;
  score: number;
  details: TestInputResult[];
  weakestCriterion: string;
  weakestScore: number;
}

export interface RoundResult {
  round: number;
  baselineScore: number;
  newScore: number | null;
  improvement: number | null;
  mutationDescription: string | null;
  decision: 'kept' | 'reverted' | 'baseline_only' | 'proposed';
  durationMs: number;
}

export interface AutoresearchResult {
  targetId: string;
  runId: string;
  rounds: RoundResult[];
  finalScore: number;
  totalDurationMs: number;
  mode: AutoresearchMode;
  /**
   * Set when the pre-flight gate skipped the run because the prompt/config
   * fingerprint is unchanged since the last completed run and that run's
   * final score already met the re-score threshold. `finalScore` then
   * carries the stored score and `rounds` is empty; consumers that only
   * read rounds/finalScore/totalDurationMs are unaffected.
   */
  skipped?: 'skipped_unchanged';
}

export interface AutoresearchRunOptions {
  /**
   * Bypass the pre-flight skip gate. Manual/operator-triggered runs should
   * pass { force: true } so a re-run can always be demanded; the scheduled
   * cron path omits it and stays gated.
   */
  force?: boolean;
  /**
   * evaluate_only: score the current prompt without proposing or writing.
   * propose: score and return one candidate edit without writing it.
   * apply: evaluate mutations and write prompts; forbidden in production.
   */
  mode?: AutoresearchMode;
}

export type AutoresearchMode = 'evaluate_only' | 'propose' | 'apply';

type AutoresearchBudgetContext = {
  runId: string;
  baseCategory: string;
  jobNamePrefix: string;
};

function createAutoresearchBudgetContext(
  target: EvalTarget,
  runId = crypto.randomUUID(),
): AutoresearchBudgetContext {
  const workload = `autoresearch_${target.id}`;
  return {
    runId,
    baseCategory: workload,
    jobNamePrefix: workload,
  };
}

function autoresearchStageJobName(
  budgetContext: AutoresearchBudgetContext,
  stage: 'generate' | 'score' | 'propose',
): string {
  return `${budgetContext.jobNamePrefix}:${stage}`;
}

export class InvalidAutoresearchScorerOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAutoresearchScorerOutputError';
  }
}

// ─── Core: Generate output from a prompt ─────────────────────────────

async function generateOutput(
  prompt: string,
  testInput: TestInput,
  target: EvalTarget,
  budgetContext: AutoresearchBudgetContext,
): Promise<string> {
  const userContent = testInput.stateContext
    ? `[Current State]\n${sanitizeForPromptInterpolation(testInput.stateContext)}\n\n${sanitizeForPromptInterpolation(testInput.userMessage)}`
    : sanitizeForPromptInterpolation(testInput.userMessage);

  // Provider-aware: try Gemini/OpenAI first, fall back to Anthropic
  const { text } = await withAiBudgetReservation({
    userId: 0,
    requestSource: 'system',
    baseCategory: budgetContext.baseCategory,
    jobName: autoresearchStageJobName(budgetContext, 'generate'),
    runId: budgetContext.runId,
  }, () => completeOneShotWithFallback(
    prompt,
    userContent,
    `autoresearch_gen_${target.id}`,
    async () => {
      const response = await trackedCreate(client, {
        model: target.model,
        max_tokens: target.maxTokens,
        system: prompt,
        messages: [{ role: 'user', content: userContent }],
      }, `autoresearch_gen_${target.id}`, SYSTEM_AI_METERING_SCOPE);
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    },
    { maxTokens: target.maxTokens, ...SYSTEM_AI_METERING_SCOPE },
  ));
  return text;
}

// ─── Core: deterministic checks + batched semantic scoring ──────────

function parseJsonOutput(output: string): unknown {
  const stripped = output.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(stripped);
}

function evaluateDeterministicCriterion(
  targetId: string,
  criterionId: string,
  output: string,
): boolean | null {
  try {
    if (targetId === 'topic_gen' && criterionId === 'complete_fields') {
      const parsed = parseJsonOutput(output);
      if (!Array.isArray(parsed) || parsed.length === 0) return false;
      return parsed.every(hasValidLiveTopicFields);
    }

    if (criterionId === 'valid_json') {
      const parsed = parseJsonOutput(output);
      if (targetId === 'classifier') {
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return false;
        const value = parsed as Record<string, unknown>;
        return Object.keys(value).sort().join(',') === 'confidence,domain'
          && typeof value.domain === 'string'
          && typeof value.confidence === 'number';
      }
      if (targetId === 'channel_learner') {
        const value = parsed as { channel_summary?: unknown; patterns?: unknown };
        return typeof value?.channel_summary === 'string' && Array.isArray(value?.patterns);
      }
      return true;
    }
  } catch {
    if (criterionId === 'valid_json' || (targetId === 'topic_gen' && criterionId === 'complete_fields')) {
      return false;
    }
  }
  return null;
}

type GeneratedEvalOutput = { testInput: TestInput; output: string };

async function scoreOutputsBatch(
  outputs: GeneratedEvalOutput[],
  target: EvalTarget,
  budgetContext: AutoresearchBudgetContext,
): Promise<Map<string, CriterionResult[]>> {
  const deterministic = new Map<string, Map<string, boolean>>();
  const semanticCriteria = target.criteria.filter((criterion) => {
    let semantic = false;
    for (const entry of outputs) {
      const result = evaluateDeterministicCriterion(target.id, criterion.id, entry.output);
      if (result === null) semantic = true;
      else {
        const perInput = deterministic.get(entry.testInput.id) ?? new Map<string, boolean>();
        perInput.set(criterion.id, result);
        deterministic.set(entry.testInput.id, perInput);
      }
    }
    return semantic;
  });

  const semanticResults = new Map<string, Map<string, boolean>>();
  if (semanticCriteria.length > 0) {
    const criteriaList = semanticCriteria
      .map((criterion, index) => `${index + 1}. [${criterion.id}] ${criterion.question}`)
      .join('\n');
    const cases = outputs.map((entry) => ({
      inputId: entry.testInput.id,
      userMessage: entry.testInput.userMessage,
      stateContext: entry.testInput.stateContext ?? null,
      description: entry.testInput.description,
      assistantOutput: entry.output,
    }));
    const scorerSystem = 'You are a strict eval scorer. Return only valid JSON. No markdown fences.';
    const scorerUser = `Evaluate every case against every semantic criterion.\n\nCRITERIA:\n${criteriaList}\n\nCASES:\n${JSON.stringify(cases)}\n\nReturn ONLY a JSON array shaped as [{"inputId":"case-id","criteria":[{"id":"criterion-id","passed":true}]}]. Include each input and each criterion exactly once.`;
    const maxTokens = Math.max(512, Math.min(4096, outputs.length * semanticCriteria.length * 48));
    const { text: scoreText } = await withAiBudgetReservation({
      userId: 0,
      requestSource: 'system',
      baseCategory: budgetContext.baseCategory,
      jobName: autoresearchStageJobName(budgetContext, 'score'),
      runId: budgetContext.runId,
    }, () => completeOneShotWithFallback(
      scorerSystem,
      scorerUser,
      'autoresearch_score',
      async () => {
        const response = await trackedCreate(client, {
          model: target.scorerModel,
          max_tokens: maxTokens,
          system: scorerSystem,
          messages: [{ role: 'user', content: scorerUser }],
        }, 'autoresearch_score', SYSTEM_AI_METERING_SCOPE);
        return response.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
      },
      { maxTokens, ...SYSTEM_AI_METERING_SCOPE },
    ));

    let parsed: unknown;
    try {
      parsed = parseJsonOutput(scoreText);
    } catch {
      throw new InvalidAutoresearchScorerOutputError('Scorer returned invalid JSON');
    }
    if (!Array.isArray(parsed)) {
      throw new InvalidAutoresearchScorerOutputError('Scorer response root must be an array');
    }
    const expectedInputIds = new Set(outputs.map((entry) => entry.testInput.id));
    if (
      parsed.length !== outputs.length
      || parsed.some((row: any) => !expectedInputIds.has(row?.inputId))
    ) {
      throw new InvalidAutoresearchScorerOutputError('Scorer response input set does not match the requested cases');
    }

    for (const entry of outputs) {
      const matching = parsed.filter((row: any) => row?.inputId === entry.testInput.id);
      if (matching.length !== 1 || !Array.isArray(matching[0]?.criteria)) {
        throw new InvalidAutoresearchScorerOutputError(`Scorer omitted or duplicated input ${entry.testInput.id}`);
      }
      const expectedCriterionIds = new Set(semanticCriteria.map((criterion) => criterion.id));
      if (
        matching[0].criteria.length !== semanticCriteria.length
        || matching[0].criteria.some((row: any) => !expectedCriterionIds.has(row?.id))
      ) {
        throw new InvalidAutoresearchScorerOutputError(
          `Scorer criterion set does not match ${entry.testInput.id}`,
        );
      }
      const perInput = new Map<string, boolean>();
      for (const criterion of semanticCriteria) {
        const matches = matching[0].criteria.filter((row: any) => row?.id === criterion.id);
        if (matches.length !== 1 || typeof matches[0]?.passed !== 'boolean') {
          throw new InvalidAutoresearchScorerOutputError(
            `Scorer omitted, duplicated, or invalidated ${entry.testInput.id}/${criterion.id}`,
          );
        }
        perInput.set(criterion.id, matches[0].passed);
      }
      semanticResults.set(entry.testInput.id, perInput);
    }
  }

  const merged = new Map<string, CriterionResult[]>();
  for (const entry of outputs) {
    const results = target.criteria.map((criterion) => {
      const passed = deterministic.get(entry.testInput.id)?.get(criterion.id)
        ?? semanticResults.get(entry.testInput.id)?.get(criterion.id);
      if (typeof passed !== 'boolean') {
        throw new InvalidAutoresearchScorerOutputError(
          `No deterministic or semantic result for ${entry.testInput.id}/${criterion.id}`,
        );
      }
      return {
        criterionId: criterion.id,
        question: criterion.question,
        passed,
        weight: criterion.weight,
      };
    });
    merged.set(entry.testInput.id, results);
  }
  return merged;
}

// ─── Core: Compute weighted score ────────────────────────────────────

function computeScore(results: CriterionResult[]): number {
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight === 0) return 0;
  const weightedPassed = results.reduce((sum, r) => sum + (r.passed ? r.weight : 0), 0);
  return weightedPassed / totalWeight;
}

// ─── Core: Full eval run ─────────────────────────────────────────────

export async function runEval(
  target: EvalTarget,
  prompt?: string,
  budgetContext = createAutoresearchBudgetContext(target),
): Promise<EvalResult> {
  const currentPrompt = prompt ?? loadPrompt(target.promptFile);
  const details: TestInputResult[] = [];
  const generated: GeneratedEvalOutput[] = [];

  for (const testInput of target.testInputs) {
    const output = await generateOutput(currentPrompt, testInput, target, budgetContext);
    generated.push({ testInput, output });
  }

  const scored = await scoreOutputsBatch(generated, target, budgetContext);
  for (const { testInput, output } of generated) {
    const criteria = scored.get(testInput.id);
    if (!criteria) {
      throw new InvalidAutoresearchScorerOutputError(`Scorer omitted input ${testInput.id}`);
    }
    const score = computeScore(criteria);
    details.push({ inputId: testInput.id, output, criteria, score });
  }

  // Aggregate score across all test inputs
  const allCriteria = details.flatMap((d) => d.criteria);
  const overallScore = computeScore(allCriteria);

  // Find weakest criterion
  const criterionScores = new Map<string, { passed: number; total: number; weight: number }>();
  for (const cr of allCriteria) {
    const existing = criterionScores.get(cr.criterionId) ?? { passed: 0, total: 0, weight: cr.weight };
    existing.total++;
    if (cr.passed) existing.passed++;
    criterionScores.set(cr.criterionId, existing);
  }

  let weakestId = '';
  let weakestScore = 1;
  for (const [id, data] of criterionScores) {
    const rate = data.passed / data.total;
    if (rate < weakestScore) {
      weakestScore = rate;
      weakestId = id;
    }
  }

  return {
    target: target.id,
    score: overallScore,
    details,
    weakestCriterion: weakestId,
    weakestScore,
  };
}

// ─── Core: Propose mutation ──────────────────────────────────────────

async function proposeMutation(
  currentPrompt: string,
  evalResult: EvalResult,
  target: EvalTarget,
  budgetContext: AutoresearchBudgetContext,
): Promise<{ mutatedPrompt: string; description: string }> {
  const weakCriterion = target.criteria.find((c) => c.id === evalResult.weakestCriterion);
  const failingExamples = evalResult.details
    .filter((d) => d.criteria.some((c) => c.criterionId === evalResult.weakestCriterion && !c.passed))
    .map((d) => `Input: ${sanitizeForPromptInterpolation(target.testInputs.find(t => t.id === d.inputId)?.userMessage)}\nOutput snippet: ${sanitizeForPromptInterpolation(d.output.slice(0, 300))}`)
    .slice(0, 2)
    .join('\n---\n');

  const mutationPrompt = `You are a prompt engineer optimizing a system prompt. The current prompt scores ${(evalResult.score * 100).toFixed(1)}%.

The WEAKEST criterion is: "${weakCriterion?.question}" (pass rate: ${(evalResult.weakestScore * 100).toFixed(0)}%)

Examples where this criterion FAILED:
${failingExamples}

CURRENT PROMPT:
---
${currentPrompt}
---

Propose ONE small, surgical edit to the prompt that would improve the weakest criterion without degrading other criteria. The edit should be a minor addition, rewording, or emphasis — not a rewrite.

Return a JSON object with:
- "description": a one-line summary of the change
- "mutated_prompt": the full updated prompt text

Return ONLY valid JSON. No markdown fences.`;

  // Gemini-first prompt mutation (analytical, structured output)
  const mutateSystem = 'You are a prompt optimization expert. Return only valid JSON with "description" and "mutated_prompt" fields.';
  const { text: mutateText } = await withAiBudgetReservation({
    userId: 0,
    requestSource: 'system',
    baseCategory: budgetContext.baseCategory,
    jobName: autoresearchStageJobName(budgetContext, 'propose'),
    runId: budgetContext.runId,
  }, () => completeOneShotWithFallback(
    mutateSystem,
    mutationPrompt,
    'autoresearch_mutate',
    async () => {
      const response = await trackedCreate(client, {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: mutateSystem,
        messages: [{ role: 'user', content: mutationPrompt }],
      }, 'autoresearch_mutate', SYSTEM_AI_METERING_SCOPE);
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    { maxTokens: 4096, ...SYSTEM_AI_METERING_SCOPE },
  ));

  let text = mutateText;

  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const parsed = JSON.parse(text);
    return {
      mutatedPrompt: parsed.mutated_prompt || currentPrompt,
      description: parsed.description || 'Unknown mutation',
    };
  } catch (err) {
    logger.error({ err, text: text.slice(0, 200) }, 'Failed to parse mutation JSON');
    throw new Error('Mutation proposal returned invalid JSON');
  }
}

// ─── Core: Git operations ────────────────────────────────────────────

function gitCommitPrompt(target: EvalTarget, round: number, oldScore: number, newScore: number): string | null {
  // Gate: auto-commit only if explicitly enabled. Default is OFF to prevent
  // unreviewed prompt changes from landing on the default branch.
  if (process.env.AUTORESEARCH_AUTO_COMMIT !== 'true') {
    logger.info(
      { target: target.id, round },
      'Auto-commit skipped (set AUTORESEARCH_AUTO_COMMIT=true to enable)',
    );
    return null;
  }

  try {
    const promptPath = getPromptPath(target.promptFile);
    const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
    execSync(`git add "${promptPath}"`, { cwd: repoRoot, encoding: 'utf-8' });
    const msg = `autoresearch: ${target.id} round ${round} — score ${(oldScore * 100).toFixed(1)}%→${(newScore * 100).toFixed(1)}%`;
    execSync(`git commit -m "${msg}"`, { cwd: repoRoot, encoding: 'utf-8' });
    const hash = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf-8' }).trim();
    logger.info({ target: target.id, round, hash, msg }, 'Autoresearch git commit');
    return hash;
  } catch (err) {
    logger.error({ err, target: target.id, round }, 'Git commit failed');
    return null;
  }
}

// ─── Core: Store round in database ───────────────────────────────────

function storeRound(
  target: EvalTarget,
  round: number,
  runId: string,
  baselineScore: number,
  newScore: number | null,
  improvement: number | null,
  mutationDescription: string | null,
  promptDiff: string | null,
  decision: string,
  testInputsCount: number,
  evalDetails: unknown,
  gitHash: string | null,
  durationMs: number,
): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO autoresearch_experiments
        (target, round_number, run_id, baseline_score, new_score, improvement,
         mutation_description, prompt_diff, decision, test_inputs_count,
         eval_details, git_commit_hash, duration_ms, model_used, scorer_model)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      target.id, round, runId, baselineScore, newScore, improvement,
      mutationDescription, promptDiff, decision, testInputsCount,
      JSON.stringify(evalDetails), gitHash, durationMs,
      target.model, target.scorerModel,
    );
  } catch (err) {
    logger.error({ err, target: target.id, round }, 'Failed to store autoresearch round');
  }
}

// ─── Pre-flight skip gate ────────────────────────────────────────────

const DEFAULT_RESCORE_THRESHOLD = 0.9;

function getRescoreThreshold(): number {
  const raw = process.env.AUTORESEARCH_RESCORE_THRESHOLD;
  if (raw === undefined || raw.trim() === '') return DEFAULT_RESCORE_THRESHOLD;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    logger.warn({ raw }, 'Invalid AUTORESEARCH_RESCORE_THRESHOLD; using default');
    return DEFAULT_RESCORE_THRESHOLD;
  }
  return parsed;
}

/**
 * Stable sha256 fingerprint of everything a run mutates or judges: the
 * on-disk prompt content plus the eval-target configuration (criteria,
 * test inputs, models, token budget). If any of it changes, the
 * fingerprint changes and the skip gate lets the run proceed.
 */
export function computePromptStateHash(target: EvalTarget): string {
  const fingerprintSource = JSON.stringify({
    promptContent: loadPrompt(target.promptFile),
    criteria: target.criteria,
    testInputs: target.testInputs,
    model: target.model,
    scorerModel: target.scorerModel,
    maxTokens: target.maxTokens,
  });
  return crypto.createHash('sha256').update(fingerprintSource).digest('hex');
}

function readLastRunFingerprint(
  targetId: string,
): { promptHash: string | null; finalScore: number | null } | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT prompt_hash AS promptHash, final_score AS finalScore
      FROM autoresearch_experiments
      WHERE target = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(targetId) as { promptHash: string | null; finalScore: number | null } | undefined;
    return row ?? null;
  } catch (err) {
    logger.warn(
      { err, target: targetId },
      'Autoresearch pre-flight history lookup failed; running without skip gate',
    );
    return null;
  }
}

/**
 * Stamps every row of the just-completed run with the END-of-run prompt
 * fingerprint and final score. Hashing after the run matters: kept
 * mutations change the prompt on disk, and the stored score belongs to
 * that final prompt state.
 */
function persistRunFingerprint(target: EvalTarget, runId: string, finalScore: number): void {
  try {
    const promptHash = computePromptStateHash(target);
    const db = getDb();
    db.prepare(`
      UPDATE autoresearch_experiments
      SET prompt_hash = ?, final_score = ?
      WHERE run_id = ?
    `).run(promptHash, finalScore, runId);
  } catch (err) {
    logger.error({ err, target: target.id, runId }, 'Failed to persist autoresearch run fingerprint');
  }
}

// ─── Main Loop ───────────────────────────────────────────────────────

export async function runAutoresearch(
  targetId: string,
  maxRounds: number,
  dryRun: boolean,
  onProgress?: (msg: string) => Promise<void>,
  options?: AutoresearchRunOptions,
): Promise<AutoresearchResult> {
  const target = getEvalTarget(targetId);
  if (!target) throw new Error(`Unknown eval target: ${targetId}`);
  const mode: AutoresearchMode = options?.mode ?? (dryRun ? 'propose' : 'apply');
  // Apply is an explicitly non-production capability. Fail closed when the
  // runtime identity is missing or unfamiliar so a misconfigured production
  // process can never write prompt files or invoke Git operations.
  if (mode === 'apply' && !['development', 'test'].includes(process.env.NODE_ENV ?? '')) {
    throw new Error('AUTORESEARCH_APPLY_DISABLED_IN_PRODUCTION');
  }

  const runId = crypto.randomUUID();
  const budgetContext = createAutoresearchBudgetContext(target, runId);
  const rounds: RoundResult[] = [];
  const startTime = Date.now();

  const report = async (msg: string) => {
    logger.info({ target: targetId, runId }, msg);
    if (onProgress) await onProgress(msg).catch(() => {});
  };

  // Pre-flight skip gate: a scheduled run is pure LLM cost when nothing it
  // would optimize has changed and the last completed run already scored
  // at/above the re-score threshold. Any gate failure (missing history,
  // legacy NULL columns, hash/lookup error) falls through to a normal run.
  if (!options?.force) {
    let currentHash: string | null = null;
    try {
      currentHash = computePromptStateHash(target);
    } catch (err) {
      logger.warn(
        { err, target: targetId },
        'Autoresearch pre-flight hash failed; running without skip gate',
      );
    }
    const lastRun = currentHash !== null ? readLastRunFingerprint(targetId) : null;
    const threshold = getRescoreThreshold();
    const priorScoreIsValid = typeof lastRun?.finalScore === 'number'
      && Number.isFinite(lastRun.finalScore)
      && lastRun.finalScore >= 0
      && lastRun.finalScore <= 1;
    const unchangedScoreIsReusable = mode === 'evaluate_only'
      ? priorScoreIsValid
      : priorScoreIsValid && (lastRun?.finalScore ?? -1) >= threshold;
    if (
      currentHash !== null &&
      lastRun !== null &&
      lastRun.promptHash !== null &&
      lastRun.promptHash === currentHash &&
      unchangedScoreIsReusable
    ) {
      const finalScore = lastRun.finalScore ?? 0;
      await report(
        `Autoresearch skipped for <b>${targetId}</b> — prompt unchanged since last run and ` +
        `stored score <b>${(finalScore * 100).toFixed(1)}%</b> is reusable for ${mode} (0 LLM calls)`,
      );
      return {
        targetId,
        runId,
        rounds: [],
        finalScore,
        totalDurationMs: Date.now() - startTime,
        mode,
        skipped: 'skipped_unchanged',
      };
    }
  }

  await report(`Starting autoresearch for <b>${targetId}</b> — mode ${mode}`);

  let currentScore = 0;

  if (mode === 'evaluate_only' || mode === 'propose') {
    const roundStart = Date.now();
    const baselineEval = await runEval(target, undefined, budgetContext);
    currentScore = baselineEval.score;
    let mutationDescription: string | null = null;
    let promptDiff: string | null = null;
    let decision: RoundResult['decision'] = 'baseline_only';

    if (mode === 'propose' && currentScore < 0.99) {
      const originalPrompt = loadPrompt(target.promptFile);
      const mutation = await proposeMutation(originalPrompt, baselineEval, target, budgetContext);
      mutationDescription = mutation.description;
      promptDiff = `${originalPrompt.length} chars → ${mutation.mutatedPrompt.length} chars`;
      decision = 'proposed';
      await report(`Proposed mutation for <b>${targetId}</b>: "${mutation.description}" (prompt not written)`);
    }

    const durationMs = Date.now() - roundStart;
    storeRound(
      target,
      1,
      runId,
      currentScore,
      null,
      null,
      mutationDescription,
      promptDiff,
      decision,
      target.testInputs.length,
      baselineEval.details,
      null,
      durationMs,
    );
    rounds.push({
      round: 1,
      baselineScore: currentScore,
      newScore: null,
      improvement: null,
      mutationDescription,
      decision,
      durationMs,
    });
    persistRunFingerprint(target, runId, currentScore);
    const totalDurationMs = Date.now() - startTime;
    await report(
      `Autoresearch <b>${targetId}</b> ${mode} complete: score <b>${(currentScore * 100).toFixed(1)}%</b> ` +
      `(${(totalDurationMs / 1000).toFixed(0)}s)`,
    );
    return { targetId, runId, rounds, finalScore: currentScore, totalDurationMs, mode };
  }

  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = Date.now();

    try {
      // Step 1: Evaluate current prompt
      await report(`Round ${round}/${maxRounds}: evaluating current prompt...`);
      const baselineEval = await runEval(target, undefined, budgetContext);
      currentScore = baselineEval.score;

      await report(
        `Round ${round}: baseline score = <b>${(currentScore * 100).toFixed(1)}%</b> ` +
        `(weakest: ${baselineEval.weakestCriterion} at ${(baselineEval.weakestScore * 100).toFixed(0)}%)`,
      );

      // If perfect score, stop early
      if (currentScore >= 0.99) {
        await report(`Score is already near-perfect. Stopping early.`);
        storeRound(target, round, runId, currentScore, null, null, null, null,
          'baseline_only', target.testInputs.length, baselineEval.details, null, Date.now() - roundStart);
        rounds.push({
          round,
          baselineScore: currentScore,
          newScore: null,
          improvement: null,
          mutationDescription: null,
          decision: 'baseline_only',
          durationMs: Date.now() - roundStart,
        });
        break;
      }

      // Step 2: Propose mutation
      await report(`Round ${round}: proposing mutation...`);
      const originalPrompt = loadPrompt(target.promptFile);
      const mutation = await proposeMutation(originalPrompt, baselineEval, target, budgetContext);

      await report(`Round ${round}: mutation — "${mutation.description}"`);

      // Step 3: Apply mutation and re-evaluate
      writePrompt(target.promptFile, mutation.mutatedPrompt);
      let keepMutation = false;
      try {
        await report(`Round ${round}: evaluating mutated prompt...`);
        const mutatedEval = await runEval(target, undefined, budgetContext);
        const newScore = mutatedEval.score;
        const improvement = newScore - currentScore;

        await report(
          `Round ${round}: new score = <b>${(newScore * 100).toFixed(1)}%</b> ` +
          `(${improvement >= 0 ? '+' : ''}${(improvement * 100).toFixed(1)}%)`,
        );

        // Step 4: Decide keep or revert
        let decision: 'kept' | 'reverted';
        let gitHash: string | null = null;

        // Compute a simple diff description (character count change)
        const promptDiff = `${originalPrompt.length} chars → ${mutation.mutatedPrompt.length} chars`;

        if (improvement > 0) {
          decision = 'kept';
          gitHash = gitCommitPrompt(target, round, currentScore, newScore);
          keepMutation = true;
          currentScore = newScore;
          await report(`Round ${round}: <b>KEPT</b> — score improved${gitHash ? ` (${gitHash})` : ''}`);
        } else {
          decision = 'reverted';
          await report(`Round ${round}: <b>REVERTED</b> — no improvement`);
        }

        // Step 5: Store round
        storeRound(
          target, round, runId, baselineEval.score, newScore, improvement,
          mutation.description, promptDiff, decision, target.testInputs.length,
          { baseline: baselineEval.details, mutated: mutatedEval.details },
          gitHash, Date.now() - roundStart,
        );

        rounds.push({
          round,
          baselineScore: baselineEval.score,
          newScore,
          improvement,
          mutationDescription: mutation.description,
          decision,
          durationMs: Date.now() - roundStart,
        });
      } finally {
        if (!keepMutation) writePrompt(target.promptFile, originalPrompt);
      }
    } catch (err) {
      // Budget denials and usage-persistence failures are terminal for the
      // run. Continuing would either obscure the deferral or risk an
      // unmetered follow-up provider call in a later round.
      rethrowAiUsageFailClosedError(err);
      if (err instanceof InvalidAutoresearchScorerOutputError) {
        logger.error({ err, target: targetId, round }, 'Autoresearch aborted: invalid scorer output');
        throw err;
      }
      logger.error({ err, target: targetId, round }, 'Autoresearch round failed');
      await report(`Round ${round}: ERROR — ${(err as Error).message}`);
      rounds.push({
        round,
        baselineScore: currentScore,
        newScore: null,
        improvement: null,
        mutationDescription: null,
        decision: 'reverted',
        durationMs: Date.now() - roundStart,
      });
    }
  }

  const totalDurationMs = Date.now() - startTime;
  const summary = `Autoresearch <b>${targetId}</b> complete: ${rounds.length} rounds, ` +
    `final score <b>${(currentScore * 100).toFixed(1)}%</b>, ` +
    `kept ${rounds.filter(r => r.decision === 'kept').length}/${rounds.length} mutations ` +
    `(${(totalDurationMs / 1000).toFixed(0)}s)`;
  await report(summary);

  // Stamp this run's rows with the end-of-run fingerprint + final score so
  // the next scheduled run can skip when nothing has changed.
  persistRunFingerprint(target, runId, currentScore);

  return { targetId, runId, rounds, finalScore: currentScore, totalDurationMs, mode };
}

// ─── Single eval (no mutation) ───────────────────────────────────────

export async function runEvalOnly(targetId: string): Promise<EvalResult> {
  const target = getEvalTarget(targetId);
  if (!target) throw new Error(`Unknown eval target: ${targetId}`);
  return runEval(target);
}

// ─── Scheduled rotation helper ───────────────────────────────────────

const ROTATION_ORDER = ['secretary', 'content', 'triathlon', 'classifier', 'topic_gen', 'channel_learner'];

export function getScheduledTarget(): string {
  // Determine which target to run based on ISO week number
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86400000);
  const weekNumber = Math.ceil((dayOfYear + startOfYear.getDay() + 1) / 7);
  return ROTATION_ORDER[weekNumber % ROTATION_ORDER.length];
}
