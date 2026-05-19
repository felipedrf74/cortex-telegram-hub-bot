// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { CHAT_BILINGUAL_EVAL_FIXTURES } from './chat-bilingual-eval-fixtures';
import { inferChatTurnContract } from './chat-turn-contract';

export type ChatBakeoffProvider = 'gemini' | 'openai' | 'external_eval_only';
export type ChatBakeoffServingMode = 'interactive' | 'batch' | 'flex';

export interface ChatModelBakeoffCandidate {
  id: string;
  provider: ChatBakeoffProvider;
  model: string;
  recommendedServingModes: ChatBakeoffServingMode[];
  productionEligible: boolean;
  evalOnlyReason?: string;
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  batchDiscount: number | null;
}

export interface ChatModelBakeoffCandidateResult {
  candidate: ChatModelBakeoffCandidate;
  fixtureTurns: number;
  skillPrecision: number;
  routePrecision: number;
  groundingPrecision: number;
  responseShapePrecision: number;
  riskPrecision: number;
  localReadCorrectness: number | null;
  noLocalTruthViolationPrecision: number | null;
  portugueseQualityPrecision: number | null;
  englishQualityPrecision: number | null;
  actionSafetyPrecision: number | null;
  successfulAnswerRate: number;
  p95LatencyMs: number | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedInteractiveCostUsd: number | null;
  estimatedBatchCostUsd: number | null;
  estimatedCostPerSuccessfulAnswerUsd: number | null;
  notes: string[];
  scoringSource: 'contract_baseline' | 'observed_model_outputs';
}

export interface ChatModelBakeoffReport {
  generatedAt: string;
  fixtureCount: number;
  turnCount: number;
  candidates: ChatModelBakeoffCandidateResult[];
}

export interface ChatModelBakeoffObservation {
  candidateId: string;
  fixtureSkill: ChatBilingualFixtureSkill;
  scenario: string;
  language: 'pt' | 'en';
  successfulAnswer: boolean;
  skillPass?: boolean;
  routePass?: boolean;
  groundingPass?: boolean;
  responseShapePass?: boolean;
  riskPass?: boolean;
  localReadCorrect: boolean;
  noLocalTruthViolation: boolean;
  languageQualityPass: boolean;
  actionSafetyPass?: boolean;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

type ChatBilingualFixtureSkill = typeof CHAT_BILINGUAL_EVAL_FIXTURES[number]['skill'];

export const CHAT_MODEL_BAKEOFF_CANDIDATES: ChatModelBakeoffCandidate[] = [
  {
    id: 'gemini-flash-lite-router',
    provider: 'gemini',
    model: 'gemini-2.5-flash-lite',
    recommendedServingModes: ['interactive', 'batch'],
    productionEligible: true,
    inputUsdPerMillion: 0.10,
    outputUsdPerMillion: 0.40,
    batchDiscount: 0.5,
  },
  {
    id: 'openai-gpt-5-4-nano-structured-chat',
    provider: 'openai',
    model: 'gpt-5.4-nano',
    recommendedServingModes: ['interactive', 'batch', 'flex'],
    productionEligible: true,
    inputUsdPerMillion: 0.20,
    outputUsdPerMillion: 1.25,
    batchDiscount: 0.5,
  },
  {
    id: 'gemini-flash-baseline',
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    recommendedServingModes: ['interactive', 'batch'],
    productionEligible: true,
    inputUsdPerMillion: 0.30,
    outputUsdPerMillion: 2.50,
    batchDiscount: 0.5,
  },
  {
    id: 'openai-gpt-5-4-mini-escalation',
    provider: 'openai',
    model: 'gpt-5.4-mini',
    recommendedServingModes: ['interactive', 'batch', 'flex'],
    productionEligible: true,
    inputUsdPerMillion: 0.75,
    outputUsdPerMillion: 4.50,
    batchDiscount: 0.5,
  },
  {
    id: 'mistral-small-4-eval-only',
    provider: 'external_eval_only',
    model: 'mistral-small-4',
    recommendedServingModes: ['batch'],
    productionEligible: false,
    evalOnlyReason: 'No production provider adapter approved for private Nexus user data.',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    batchDiscount: null,
  },
  {
    id: 'cohere-command-r-eval-only',
    provider: 'external_eval_only',
    model: 'command-r',
    recommendedServingModes: ['batch'],
    productionEligible: false,
    evalOnlyReason: 'RAG/local-source challenger only; no production provider adapter approved.',
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
    batchDiscount: null,
  },
];

export function buildChatModelBakeoffReport(input: {
  generatedAt?: string;
  candidates?: ChatModelBakeoffCandidate[];
  observations?: ChatModelBakeoffObservation[];
} = {}): ChatModelBakeoffReport {
  const candidates = input.candidates ?? CHAT_MODEL_BAKEOFF_CANDIDATES;
  const turnChecks = evaluateFixtureContracts();
  const estimatedInputTokens = turnChecks.reduce((sum, turn) => sum + turn.inputTokens, 0);
  const estimatedOutputTokens = turnChecks.reduce((sum, turn) => sum + turn.maxOutputTokens, 0);
  const observationsByCandidate = groupObservationsByCandidate(input.observations ?? []);
  const aggregate = {
    fixtureTurns: turnChecks.length,
    skillPrecision: precision(turnChecks, 'skillPass'),
    routePrecision: precision(turnChecks, 'routePass'),
    groundingPrecision: precision(turnChecks, 'groundingPass'),
    responseShapePrecision: precision(turnChecks, 'shapePass'),
    riskPrecision: precision(turnChecks, 'riskPass'),
    localReadCorrectness: localReadCorrectness(turnChecks),
    noLocalTruthViolationPrecision: noLocalTruthViolationPrecision(turnChecks),
    portugueseQualityPrecision: null,
    englishQualityPrecision: null,
    actionSafetyPrecision: actionSafetyPrecision(turnChecks),
    successfulAnswerRate: precision(turnChecks, 'allPass'),
    p95LatencyMs: null,
    estimatedInputTokens,
    estimatedOutputTokens,
  };

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    fixtureCount: CHAT_BILINGUAL_EVAL_FIXTURES.length,
    turnCount: turnChecks.length,
    candidates: candidates.map((candidate) => {
      const observed = observationsByCandidate.get(candidate.id) ?? [];
      const observedMetrics = observed.length > 0
        ? summarizeObservedModelOutputs(candidate, observed, aggregate)
        : null;
      const inputTokens = observedMetrics?.estimatedInputTokens ?? estimatedInputTokens;
      const outputTokens = observedMetrics?.estimatedOutputTokens ?? estimatedOutputTokens;
      const estimatedInteractiveCostUsd = observedMetrics?.estimatedInteractiveCostUsd
        ?? estimateCost(candidate, inputTokens, outputTokens);
      const estimatedBatchCostUsd = estimatedInteractiveCostUsd != null && candidate.batchDiscount != null
        ? estimatedInteractiveCostUsd * candidate.batchDiscount
        : null;
      const successfulTurns = observedMetrics?.successfulTurns ?? turnChecks.filter((turn) => turn.allPass).length;
      return {
        candidate,
        ...(observedMetrics ?? aggregate),
        estimatedInteractiveCostUsd,
        estimatedBatchCostUsd,
        estimatedCostPerSuccessfulAnswerUsd: estimatedInteractiveCostUsd != null && successfulTurns > 0
          ? estimatedInteractiveCostUsd / successfulTurns
          : null,
        notes: buildCandidateNotes(candidate),
        scoringSource: observedMetrics ? 'observed_model_outputs' : 'contract_baseline',
      };
    }),
  };
}

export function formatChatModelBakeoffMarkdown(report: ChatModelBakeoffReport): string {
  const lines: string[] = [];
  lines.push('# Chat Model Bake-Off Baseline');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Fixtures: ${report.fixtureCount}`);
  lines.push(`Bilingual turns: ${report.turnCount}`);
  lines.push('');
  lines.push('Rows whose Source column is `contract_baseline` are identical across candidates by construction: they score the bilingual contract fixtures and do not call a model. Use `--observations <jsonl>` to merge real model outputs.');
  lines.push('');
  lines.push('| Candidate | Production | Modes | Source | Skill | Route | Risk | Local read | No local-truth violation | PT quality | EN quality | Action safety | p95 ms | Cost/success | Batch cost | Notes |');
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const result of report.candidates) {
    lines.push([
      `| ${result.candidate.model}`,
      result.candidate.productionEligible ? 'yes' : 'eval-only',
      result.candidate.recommendedServingModes.join(', '),
      result.scoringSource,
      pct(result.skillPrecision),
      pct(result.routePrecision),
      pct(result.riskPrecision),
      pctOrNA(result.localReadCorrectness),
      pctOrNA(result.noLocalTruthViolationPrecision),
      pctOrNA(result.portugueseQualityPrecision),
      pctOrNA(result.englishQualityPrecision),
      pctOrNA(result.actionSafetyPrecision),
      result.p95LatencyMs == null ? 'n/a' : String(Math.round(result.p95LatencyMs)),
      money(result.estimatedCostPerSuccessfulAnswerUsd),
      money(result.estimatedBatchCostUsd),
      `${result.notes.join('; ') || 'none'} |`,
    ].join(' | '));
  }
  lines.push('');
  lines.push('Batch/Flex modes are for offline evals and backfills only. Live chat should use interactive APIs so latency, fallback, and user-visible reliability stay predictable.');
  return lines.join('\n');
}

interface FixtureTurnCheck {
  fixtureSkill: ChatBilingualFixtureSkill;
  scenario: string;
  language: 'pt' | 'en';
  expectedGrounding: string;
  expectedRouteKind: string;
  inputTokens: number;
  maxOutputTokens: number;
  skillPass: boolean;
  routePass: boolean;
  groundingPass: boolean;
  shapePass: boolean;
  riskPass: boolean;
  allPass: boolean;
}

function evaluateFixtureContracts(): FixtureTurnCheck[] {
  const checks: FixtureTurnCheck[] = [];
  for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
    for (const [language, text] of [['pt', fixture.pt], ['en', fixture.en]] as const) {
      const contract = inferChatTurnContract({ message: text });
      const skillPass = contract.skill === fixture.expectedOwnerSkill;
      const routePass = contract.routeKind === fixture.expectedRouteKind;
      const groundingPass = contract.groundingRequired === fixture.expectedGrounding;
      const shapePass = contract.expectedResponseShape === fixture.expectedResponseShape;
      const riskPass = contract.riskClass === fixture.expectedRiskClass;
      checks.push({
        fixtureSkill: fixture.skill,
        scenario: fixture.scenario,
        language,
        expectedGrounding: fixture.expectedGrounding,
        expectedRouteKind: fixture.expectedRouteKind,
        inputTokens: estimateTokens(text),
        maxOutputTokens: fixture.maxOutputTokens,
        skillPass,
        routePass,
        groundingPass,
        shapePass,
        riskPass,
        allPass: skillPass && routePass && groundingPass && shapePass && riskPass,
      });
    }
  }
  return checks;
}

function estimateCost(candidate: ChatModelBakeoffCandidate, inputTokens: number, outputTokens: number): number | null {
  if (candidate.inputUsdPerMillion == null || candidate.outputUsdPerMillion == null) return null;
  return (inputTokens / 1_000_000) * candidate.inputUsdPerMillion
    + (outputTokens / 1_000_000) * candidate.outputUsdPerMillion;
}

function precision(checks: FixtureTurnCheck[], key: keyof Pick<FixtureTurnCheck, 'skillPass' | 'routePass' | 'groundingPass' | 'shapePass' | 'riskPass' | 'allPass'>): number {
  if (!checks.length) return 0;
  return checks.filter((check) => check[key]).length / checks.length;
}

function localReadCorrectness(checks: FixtureTurnCheck[]): number | null {
  const localTurns = checks.filter((check) => check.expectedGrounding === 'local' || check.expectedGrounding === 'local_and_web');
  if (localTurns.length === 0) return null;
  return localTurns.filter((check) => check.groundingPass).length / localTurns.length;
}

function noLocalTruthViolationPrecision(checks: FixtureTurnCheck[]): number | null {
  const nonLocalTurns = checks.filter((check) => check.expectedGrounding === 'none' || check.expectedGrounding === 'web');
  if (nonLocalTurns.length === 0) return null;
  return nonLocalTurns.filter((check) => check.groundingPass).length / nonLocalTurns.length;
}

function actionSafetyPrecision(checks: FixtureTurnCheck[]): number | null {
  const actionTurns = checks.filter((check) => check.expectedRouteKind === 'action');
  if (actionTurns.length === 0) return null;
  return actionTurns.filter((check) => check.routePass && check.riskPass && check.groundingPass).length / actionTurns.length;
}

function groupObservationsByCandidate(observations: ChatModelBakeoffObservation[]): Map<string, ChatModelBakeoffObservation[]> {
  const grouped = new Map<string, ChatModelBakeoffObservation[]>();
  for (const observation of observations) {
    const rows = grouped.get(observation.candidateId) ?? [];
    rows.push(observation);
    grouped.set(observation.candidateId, rows);
  }
  return grouped;
}

function summarizeObservedModelOutputs(
  candidate: ChatModelBakeoffCandidate,
  observations: ChatModelBakeoffObservation[],
  fallback: Omit<ChatModelBakeoffCandidateResult, 'candidate' | 'estimatedInteractiveCostUsd' | 'estimatedBatchCostUsd' | 'estimatedCostPerSuccessfulAnswerUsd' | 'notes' | 'scoringSource'>,
) {
  const inputTokens = sumNumeric(observations.map((observation) => observation.inputTokens));
  const outputTokens = sumNumeric(observations.map((observation) => observation.outputTokens));
  const observedCostUsd = sumNumeric(observations.map((observation) => observation.costUsd));
  const successfulTurns = observations.filter((observation) => observation.successfulAnswer).length;
  return {
    fixtureTurns: observations.length,
    skillPrecision: optionalObservationPrecision(observations, 'skillPass') ?? fallback.skillPrecision,
    routePrecision: optionalObservationPrecision(observations, 'routePass') ?? fallback.routePrecision,
    groundingPrecision: optionalObservationPrecision(observations, 'groundingPass') ?? fallback.groundingPrecision,
    responseShapePrecision: optionalObservationPrecision(observations, 'responseShapePass') ?? fallback.responseShapePrecision,
    riskPrecision: optionalObservationPrecision(observations, 'riskPass') ?? fallback.riskPrecision,
    localReadCorrectness: observationPrecision(observations, 'localReadCorrect'),
    noLocalTruthViolationPrecision: observationPrecision(observations, 'noLocalTruthViolation'),
    portugueseQualityPrecision: observationPrecision(observations.filter((observation) => observation.language === 'pt'), 'languageQualityPass'),
    englishQualityPrecision: observationPrecision(observations.filter((observation) => observation.language === 'en'), 'languageQualityPass'),
    actionSafetyPrecision: observationPrecision(observations.filter((observation) => observation.actionSafetyPass !== undefined), 'actionSafetyPass'),
    successfulAnswerRate: observationPrecision(observations, 'successfulAnswer') ?? 0,
    p95LatencyMs: percentile(observations.map((observation) => observation.latencyMs).filter(isFiniteNumber), 0.95),
    estimatedInputTokens: inputTokens ?? fallback.estimatedInputTokens,
    estimatedOutputTokens: outputTokens ?? fallback.estimatedOutputTokens,
    estimatedInteractiveCostUsd: observedCostUsd ?? estimateCost(candidate, inputTokens ?? fallback.estimatedInputTokens, outputTokens ?? fallback.estimatedOutputTokens),
    successfulTurns,
  };
}

function optionalObservationPrecision<T extends keyof ChatModelBakeoffObservation>(
  observations: ChatModelBakeoffObservation[],
  key: T,
): number | null {
  return observationPrecision(observations.filter((observation) => typeof observation[key] === 'boolean'), key);
}

function observationPrecision<T extends keyof ChatModelBakeoffObservation>(
  observations: ChatModelBakeoffObservation[],
  key: T,
): number | null {
  if (!observations.length) return null;
  return observations.filter((observation) => observation[key] === true).length / observations.length;
}

function sumNumeric(values: Array<number | undefined>): number | null {
  const numeric = values.filter(isFiniteNumber);
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0);
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function buildCandidateNotes(candidate: ChatModelBakeoffCandidate): string[] {
  const notes: string[] = [];
  if (!candidate.productionEligible && candidate.evalOnlyReason) notes.push(candidate.evalOnlyReason);
  if (candidate.recommendedServingModes.includes('flex')) notes.push('Flex is non-urgent/background only, not live Telegram chat.');
  if (candidate.recommendedServingModes.includes('batch')) notes.push('Batch is eligible for eval/backfill workloads.');
  return notes;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctOrNA(value: number | null): string {
  return value == null ? 'n/a' : pct(value);
}

function money(value: number | null): string {
  return value == null ? 'n/a' : `$${value.toFixed(6)}`;
}
