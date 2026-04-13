// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Autoresearch — automated prompt optimization loop.
 *
 * For each target prompt:
 * 1. Run test inputs against the current prompt, score with Haiku
 * 2. Ask Sonnet to propose a mutation to improve the weakest criterion
 * 3. Apply mutation, re-run, compare scores
 * 4. Keep if improved (git commit), revert if worse
 * 5. Store each round in the database
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { getDb } from './database';
import { logger } from '../utils/logger';
import { loadPrompt, writePrompt, getPromptPath } from '../utils/prompt-loader';
import { getEvalTarget, getAllTargets, EvalTarget, EvalCriterion, TestInput } from './eval-criteria';
import { trackedCreate } from '../portal/anthropic-hook';
import { completeOneShotWithFallback } from './gemini-provider';

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  maxRetries: 3,
});

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
  decision: 'kept' | 'reverted' | 'baseline_only';
  durationMs: number;
}

export interface AutoresearchResult {
  targetId: string;
  runId: string;
  rounds: RoundResult[];
  finalScore: number;
  totalDurationMs: number;
}

// ─── Core: Generate output from a prompt ─────────────────────────────

async function generateOutput(
  prompt: string,
  testInput: TestInput,
  target: EvalTarget,
): Promise<string> {
  const userContent = testInput.stateContext
    ? `[Current State]\n${testInput.stateContext}\n\n${testInput.userMessage}`
    : testInput.userMessage;

  // Provider-aware: try Gemini/OpenAI first, fall back to Anthropic
  const { text } = await completeOneShotWithFallback(
    prompt,
    userContent,
    `autoresearch_gen_${target.id}`,
    async () => {
      const response = await trackedCreate(client, {
        model: target.model,
        max_tokens: target.maxTokens,
        system: prompt,
        messages: [{ role: 'user', content: userContent }],
      }, `autoresearch_gen_${target.id}`);
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    },
    { maxTokens: target.maxTokens },
  );
  return text;
}

// ─── Core: Score a single output against criteria ────────────────────

async function scoreOutput(
  output: string,
  testInput: TestInput,
  criteria: EvalCriterion[],
  scorerModel: string,
): Promise<CriterionResult[]> {
  const criteriaList = criteria
    .map((c, i) => `${i + 1}. [${c.id}] ${c.question}`)
    .join('\n');

  const scoringPrompt = `You are an eval scorer. Given an AI assistant's output for a specific test input, evaluate each criterion with YES or NO.

TEST INPUT: "${testInput.userMessage}"
${testInput.stateContext ? `STATE CONTEXT: ${testInput.stateContext}` : ''}
TEST DESCRIPTION: ${testInput.description}

CRITERIA:
${criteriaList}

Return ONLY a JSON array of objects with "id" (criterion id) and "passed" (boolean). No other text.
Example: [{"id":"tool_efficiency","passed":true},{"id":"template_format","passed":false}]`;

  // Gemini-first scoring (small structured-JSON task — perfect for Flash)
  const scorerSystem = 'You are a strict eval scorer. Return only valid JSON. No markdown fences.';
  const scorerUser = `${scoringPrompt}\n\nASSISTANT OUTPUT TO EVALUATE:\n${output}`;
  const { text: scoreText } = await completeOneShotWithFallback(
    scorerSystem,
    scorerUser,
    'autoresearch_score',
    async () => {
      const response = await trackedCreate(client, {
        model: scorerModel,
        max_tokens: 512,
        system: scorerSystem,
        messages: [{ role: 'user', content: scorerUser }],
      }, 'autoresearch_score');
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    { maxTokens: 512 },
  );

  let text = scoreText;

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    const results: Array<{ id: string; passed: boolean }> = JSON.parse(text);
    return criteria.map((c) => {
      const result = results.find((r) => r.id === c.id);
      return {
        criterionId: c.id,
        question: c.question,
        passed: result?.passed ?? false,
        weight: c.weight,
      };
    });
  } catch (err) {
    logger.warn({ err, text }, 'Failed to parse scoring JSON, treating all as failed');
    return criteria.map((c) => ({
      criterionId: c.id,
      question: c.question,
      passed: false,
      weight: c.weight,
    }));
  }
}

// ─── Core: Compute weighted score ────────────────────────────────────

function computeScore(results: CriterionResult[]): number {
  const totalWeight = results.reduce((sum, r) => sum + r.weight, 0);
  if (totalWeight === 0) return 0;
  const weightedPassed = results.reduce((sum, r) => sum + (r.passed ? r.weight : 0), 0);
  return weightedPassed / totalWeight;
}

// ─── Core: Full eval run ─────────────────────────────────────────────

export async function runEval(target: EvalTarget, prompt?: string): Promise<EvalResult> {
  const currentPrompt = prompt ?? loadPrompt(target.promptFile);
  const details: TestInputResult[] = [];

  for (const testInput of target.testInputs) {
    const output = await generateOutput(currentPrompt, testInput, target);
    const criteria = await scoreOutput(output, testInput, target.criteria, target.scorerModel);
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
): Promise<{ mutatedPrompt: string; description: string }> {
  const weakCriterion = target.criteria.find((c) => c.id === evalResult.weakestCriterion);
  const failingExamples = evalResult.details
    .filter((d) => d.criteria.some((c) => c.criterionId === evalResult.weakestCriterion && !c.passed))
    .map((d) => `Input: "${target.testInputs.find(t => t.id === d.inputId)?.userMessage}"\nOutput snippet: ${d.output.slice(0, 300)}`)
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
  const { text: mutateText } = await completeOneShotWithFallback(
    mutateSystem,
    mutationPrompt,
    'autoresearch_mutate',
    async () => {
      const response = await trackedCreate(client, {
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: mutateSystem,
        messages: [{ role: 'user', content: mutationPrompt }],
      }, 'autoresearch_mutate');
      return response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    },
    { maxTokens: 4096 },
  );

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

// ─── Main Loop ───────────────────────────────────────────────────────

export async function runAutoresearch(
  targetId: string,
  maxRounds: number,
  dryRun: boolean,
  onProgress?: (msg: string) => Promise<void>,
): Promise<AutoresearchResult> {
  const target = getEvalTarget(targetId);
  if (!target) throw new Error(`Unknown eval target: ${targetId}`);

  const runId = crypto.randomUUID();
  const rounds: RoundResult[] = [];
  const startTime = Date.now();

  const report = async (msg: string) => {
    logger.info({ target: targetId, runId }, msg);
    if (onProgress) await onProgress(msg).catch(() => {});
  };

  await report(`Starting autoresearch for <b>${targetId}</b> — ${maxRounds} rounds${dryRun ? ' (DRY RUN)' : ''}`);

  let currentScore = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const roundStart = Date.now();

    try {
      // Step 1: Evaluate current prompt
      await report(`Round ${round}/${maxRounds}: evaluating current prompt...`);
      const baselineEval = await runEval(target);
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
      const mutation = await proposeMutation(originalPrompt, baselineEval, target);

      await report(`Round ${round}: mutation — "${mutation.description}"`);

      // Step 3: Apply mutation and re-evaluate
      writePrompt(target.promptFile, mutation.mutatedPrompt);

      await report(`Round ${round}: evaluating mutated prompt...`);
      const mutatedEval = await runEval(target);
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
        if (!dryRun) {
          gitHash = gitCommitPrompt(target, round, currentScore, newScore);
        }
        currentScore = newScore;
        await report(`Round ${round}: <b>KEPT</b> — score improved${gitHash ? ` (${gitHash})` : ''}`);
      } else {
        decision = 'reverted';
        writePrompt(target.promptFile, originalPrompt);
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
    } catch (err) {
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

  return { targetId, runId, rounds, finalScore: currentScore, totalDurationMs };
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
