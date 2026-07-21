// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// Deterministic per-turn scorer for live (non-fixture) chat eval replays.
// Fixture mode keeps its historical self-scoring untouched; this module is
// layered on top of ChatEvalTurnResult envelopes returned by the real
// POST /message pipeline. Roughly 14 of the rubric dimensions are decidable
// without a model; the remaining wording/groundedness/sufficiency/explanation
// dims are declared with source 'llm_judge' and left unscored (score=null)
// for the bounded flash-lite judge (M2c) to fill in.

import type {
  ChatEvalSideEffectKind,
  ChatEvalTurnResult,
} from './chat-eval-executor';
import type { DayToDayFailureType } from './chat-day-to-day-simulation';
import { detectResponseLanguage } from './chat-language-detector';
import {
  textClaimsUnverifiedAction,
  textHasBareAppSuccessMarker,
} from './chat-success-claim-policy';

export type ChatEvalScoreSource = 'deterministic' | 'llm_judge';

export type ChatEvalScorerDimensionId =
  | 'routing_domain'
  | 'routing_method'
  | 'skills_used'
  | 'semantic_coverage'
  | 'forbidden_content'
  | 'clarification_flow'
  | 'confirmation_flow'
  | 'refusal_flow'
  | 'success_claim_verification'
  | 'side_effect_verification'
  | 'latency_budget'
  | 'provider_metadata'
  | 'ios_envelope_shape'
  | 'response_language'
  | 'wording_quality'
  | 'groundedness'
  | 'sufficiency'
  | 'explanation_quality';

// Every dimension declares its source and the DayToDayFailureType it maps to
// when failed, so failures merge into the existing simulation taxonomy.
export const CHAT_EVAL_SCORER_DIMENSIONS: Record<ChatEvalScorerDimensionId, {
  source: ChatEvalScoreSource;
  failureType: DayToDayFailureType;
}> = {
  routing_domain: { source: 'deterministic', failureType: 'wrong_skill_routing' },
  routing_method: { source: 'deterministic', failureType: 'wrong_skill_routing' },
  skills_used: { source: 'deterministic', failureType: 'wrong_skill_routing' },
  semantic_coverage: { source: 'deterministic', failureType: 'insufficient_answer' },
  forbidden_content: { source: 'deterministic', failureType: 'tenant_leak' },
  clarification_flow: { source: 'deterministic', failureType: 'missing_clarification' },
  confirmation_flow: { source: 'deterministic', failureType: 'missing_action_confirmation' },
  refusal_flow: { source: 'deterministic', failureType: 'unauthorized_tool_call' },
  success_claim_verification: { source: 'deterministic', failureType: 'hallucinated_context' },
  side_effect_verification: { source: 'deterministic', failureType: 'missing_tool_call' },
  latency_budget: { source: 'deterministic', failureType: 'model_routing_fallback_issue' },
  provider_metadata: { source: 'deterministic', failureType: 'model_routing_fallback_issue' },
  ios_envelope_shape: { source: 'deterministic', failureType: 'ios_rendering_incompatibility' },
  response_language: { source: 'deterministic', failureType: 'insufficient_answer' },
  wording_quality: { source: 'llm_judge', failureType: 'poor_explanation' },
  groundedness: { source: 'llm_judge', failureType: 'hallucinated_context' },
  sufficiency: { source: 'llm_judge', failureType: 'insufficient_answer' },
  explanation_quality: { source: 'llm_judge', failureType: 'poor_explanation' },
};

const DETERMINISTIC_DIMENSIONS = (Object.keys(CHAT_EVAL_SCORER_DIMENSIONS) as ChatEvalScorerDimensionId[])
  .filter((id) => CHAT_EVAL_SCORER_DIMENSIONS[id].source === 'deterministic');
const LLM_JUDGE_DIMENSIONS = (Object.keys(CHAT_EVAL_SCORER_DIMENSIONS) as ChatEvalScorerDimensionId[])
  .filter((id) => CHAT_EVAL_SCORER_DIMENSIONS[id].source === 'llm_judge');

// Matches the hybrid gate p95 threshold so a single slow turn is at least
// flagged even when the caller supplies no explicit budget.
export const CHAT_EVAL_DEFAULT_LATENCY_BUDGET_MS = 6000;

export interface ChatEvalSideEffectExpectation {
  kind: ChatEvalSideEffectKind;
  /** Case-insensitive substrings that must appear in the read-back body. */
  mustIncludeText?: readonly string[];
  /** Case-insensitive substrings that must NOT appear in the read-back body. */
  mustNotIncludeText?: readonly string[];
}

export interface ChatEvalSideEffectObservation {
  kind: ChatEvalSideEffectKind;
  statusCode: number;
  body: unknown;
}

// Structural superset of DayToDayTurnExpectation so simulation turns can be
// scored directly; live-only fields (route method, latency, provider pins,
// side effects, language) are additive.
export interface ChatEvalTurnScoringExpectation {
  expectedDomain?: string;
  expectedRouteMethod?: string;
  expectedSkills?: readonly string[];
  semanticMustInclude?: readonly string[];
  forbiddenContent?: readonly string[];
  requiresClarification?: boolean;
  requiresConfirmation?: boolean;
  requiresRefusal?: boolean;
  expectedToolStatuses?: readonly string[];
  /** Explicit override; defaults to expectedToolStatuses containing succeeded/deduped. */
  expectsVerifiedMutation?: boolean;
  expectedSideEffects?: readonly ChatEvalSideEffectExpectation[];
  latencyBudgetMs?: number;
  expectedProvider?: string;
  expectedTier?: string;
  expectedModel?: string;
  /** Primary language subtag the response must be written in (e.g. 'pt'). */
  expectedLanguage?: string;
}

export interface ChatEvalDimensionScore {
  dimension: ChatEvalScorerDimensionId;
  source: ChatEvalScoreSource;
  /** 0..2 for deterministic dims; null for llm_judge dims awaiting M2c. */
  score: number | null;
  passed: boolean | null;
  failureType: DayToDayFailureType;
  detail: string;
}

export interface ChatEvalTurnScore {
  dimensions: ChatEvalDimensionScore[];
  /** Average over deterministic (scored) dims only, 0..2. */
  deterministicAverage: number;
  passed: boolean;
  failures: Array<{ type: DayToDayFailureType; detail: string }>;
  llmJudgeDimensions: ChatEvalScorerDimensionId[];
}

/** Returns the detected primary language subtag, or null when undecidable. */
export type ChatEvalLanguageDetector = (text: string) => string | null;

// Honest no-op detector for tests that opt out of language scoring.
export const stubLanguageDetector: ChatEvalLanguageDetector = () => null;

// Default detector: the milestone-3 deterministic confusable-aware detector.
// 'unknown' maps to null so short/ambiguous answers stay honest no-ops
// (fail-open) instead of false language failures.
export const defaultChatEvalLanguageDetector: ChatEvalLanguageDetector = (text) => {
  const detected = detectResponseLanguage(text);
  return detected.language === 'unknown' ? null : detected.language;
};

export interface ChatEvalScorerOptions {
  languageDetector?: ChatEvalLanguageDetector;
}

/**
 * Canonical expectation-space action statuses. Expectations (and the fixture
 * simulation) speak this vocabulary; the live /message pipeline speaks the
 * envelope vocabulary (needs_clarification / verified_success /
 * partial_success / verified_pending / blocked / confirmation_acknowledged).
 * `partial` and `pending` are their own states: a partial or pending action
 * must never be judged as a full verified success.
 */
export type NormalizedObservedActionStatus =
  | 'none'
  | 'needs_confirmation'
  | 'clarification'
  | 'refused'
  | 'succeeded'
  | 'partial'
  | 'pending'
  | 'failed'
  | 'deduped';

/**
 * Single canonical normalizer mapping BOTH actionStatus vocabularies (the
 * live /message envelope contract and the fixture-era simulation values)
 * into one expectation space. Unknown/absent values normalize to null so
 * callers can distinguish "not observed" from a real status.
 */
export function normalizeObservedActionStatus(raw: unknown): NormalizedObservedActionStatus | null {
  if (typeof raw !== 'string' || !raw) return null;
  switch (raw) {
    // Live /message envelope vocabulary (result-response.ts, plan-executor.ts,
    // chat-message-routes.ts).
    case 'needs_clarification': return 'clarification';
    case 'verified_success': return 'succeeded';
    case 'partial_success': return 'partial';
    case 'verified_pending': return 'pending';
    case 'blocked': return 'failed';
    case 'confirmation_acknowledged': return 'needs_confirmation';
    // Shared / fixture-era vocabulary passes through unchanged.
    case 'none':
    case 'needs_confirmation':
    case 'clarification':
    case 'refused':
    case 'succeeded':
    case 'partial':
    case 'pending':
    case 'failed':
    case 'deduped':
      return raw;
    default:
      return null;
  }
}

export function scoreChatEvalTurn(
  expectation: ChatEvalTurnScoringExpectation,
  result: ChatEvalTurnResult,
  sideEffects?: readonly ChatEvalSideEffectObservation[],
  options: ChatEvalScorerOptions = {},
): ChatEvalTurnScore {
  const dimensions: ChatEvalDimensionScore[] = [];
  const record = (dimension: ChatEvalScorerDimensionId, passed: boolean, detail: string): void => {
    dimensions.push({
      dimension,
      source: 'deterministic',
      score: passed ? 2 : 0,
      passed,
      failureType: CHAT_EVAL_SCORER_DIMENSIONS[dimension].failureType,
      detail,
    });
  };

  if (!result.ok) {
    const blockedDetail = `turn blocked before scoring: ${result.blockedReason ?? `http_${result.statusCode}`}`;
    for (const dimension of DETERMINISTIC_DIMENSIONS) {
      record(dimension, false, blockedDetail);
    }
    appendLlmJudgePlaceholders(dimensions);
    return aggregate(dimensions);
  }

  const metadata = (result.metadata && typeof result.metadata === 'object' ? result.metadata : {}) as Record<string, unknown>;
  const rawActionStatus = typeof metadata.actionStatus === 'string' ? metadata.actionStatus : null;
  const actionStatus = normalizeObservedActionStatus(rawActionStatus);
  const lowerText = result.text.toLowerCase();

  // routing_domain
  if (!expectation.expectedDomain) {
    record('routing_domain', true, 'no domain expectation');
  } else if (result.domain === expectation.expectedDomain) {
    record('routing_domain', true, `domain ${result.domain}`);
  } else {
    record('routing_domain', false, `expected domain ${expectation.expectedDomain}, got ${result.domain ?? 'none'}`);
  }

  // routing_method
  if (!expectation.expectedRouteMethod) {
    record('routing_method', true, 'no route-method expectation');
  } else if (result.routeMethod === expectation.expectedRouteMethod) {
    record('routing_method', true, `routeMethod ${result.routeMethod}`);
  } else {
    record('routing_method', false, `expected routeMethod ${expectation.expectedRouteMethod}, got ${result.routeMethod ?? 'none'}`);
  }

  // skills_used — observability policy: a dim never fails on MISSING
  // evidence, only on CONTRADICTING evidence. The live /message envelope
  // metadata carries no skillsUsed field, so absence is an honest pass;
  // fixture-fabricated (present) fields keep being scored strictly.
  if (!expectation.expectedSkills?.length) {
    record('skills_used', true, 'no skills expectation');
  } else {
    const skillsUsed = Array.isArray(metadata.skillsUsed)
      ? metadata.skillsUsed.filter((skill): skill is string => typeof skill === 'string')
      : null;
    if (!skillsUsed) {
      record('skills_used', true, 'skillsUsed not observable in live envelope');
    } else {
      const missing = expectation.expectedSkills.filter((skill) => !skillsUsed.includes(skill));
      if (missing.length) {
        record('skills_used', false, `expected skills not used: ${missing.join(', ')}`);
      } else {
        record('skills_used', true, `skills ${skillsUsed.join(', ')}`);
      }
    }
  }

  // semantic_coverage
  const missingTokens = (expectation.semanticMustInclude ?? []).filter((token) => !lowerText.includes(token.toLowerCase()));
  if (missingTokens.length) {
    record('semantic_coverage', false, `missing semantic tokens: ${missingTokens.join(', ')}`);
  } else {
    record('semantic_coverage', true, expectation.semanticMustInclude?.length ? 'all required tokens present' : 'no semantic expectation');
  }

  // forbidden_content
  const leakedTokens = (expectation.forbiddenContent ?? []).filter((token) => lowerText.includes(token.toLowerCase()));
  if (leakedTokens.length) {
    record('forbidden_content', false, `forbidden content present: ${leakedTokens.join(', ')}`);
  } else {
    record('forbidden_content', true, expectation.forbiddenContent?.length ? 'no forbidden content' : 'no forbidden-content expectation');
  }

  // clarification_flow / confirmation_flow / refusal_flow — compared in the
  // normalized expectation space so live envelope statuses count.
  recordFlow(record, 'clarification_flow', expectation.requiresClarification, actionStatus, rawActionStatus, 'clarification');
  recordFlow(record, 'confirmation_flow', expectation.requiresConfirmation, actionStatus, rawActionStatus, 'needs_confirmation');
  recordFlow(record, 'refusal_flow', expectation.requiresRefusal, actionStatus, rawActionStatus, 'refused');

  // side_effect_verification (computed before success_claim so the claim
  // check can reference read-back verification honestly)
  const sideEffectIssues = verifySideEffects(expectation.expectedSideEffects ?? [], sideEffects ?? []);
  if (!expectation.expectedSideEffects?.length) {
    record('side_effect_verification', true, 'no side-effect expectation');
  } else if (sideEffectIssues.length) {
    record('side_effect_verification', false, sideEffectIssues.join('; '));
  } else {
    record('side_effect_verification', true, 'read-back state matched expectations');
  }

  // success_claim_verification — reuse the quality-gate success-claim
  // heuristics (chat-success-claim-policy) rather than copying regexes.
  const claimsSuccess = textClaimsUnverifiedAction(result.text) || textHasBareAppSuccessMarker(result.text);
  const mutationExpected = expectation.expectsVerifiedMutation
    ?? (expectation.expectedToolStatuses ?? []).some((status) => status === 'succeeded' || status === 'deduped');
  // Observed partial/pending/failed statuses CONTRADICT a full-success claim:
  // partial_success and verified_pending are their own states and must never
  // count as a verified full success.
  const observedContradictsFullSuccess = actionStatus === 'partial' || actionStatus === 'pending' || actionStatus === 'failed';
  if (!claimsSuccess) {
    record('success_claim_verification', true, 'no success/state-write claim in response');
  } else if (!mutationExpected) {
    record('success_claim_verification', false, 'response claims a completed action but no verified mutation was expected on this turn');
  } else if (observedContradictsFullSuccess) {
    record('success_claim_verification', false, `response claims full success but envelope actionStatus ${rawActionStatus} is not a verified full success`);
  } else if (expectation.expectedSideEffects?.length && sideEffectIssues.length) {
    record('success_claim_verification', false, 'response claims success but side-effect read-back did not verify the expected state');
  } else {
    record('success_claim_verification', true, 'success claim consistent with expected verified mutation');
  }

  // latency_budget
  const latencyBudgetMs = expectation.latencyBudgetMs ?? CHAT_EVAL_DEFAULT_LATENCY_BUDGET_MS;
  if (result.latencyMs > latencyBudgetMs) {
    record('latency_budget', false, `latency ${result.latencyMs}ms exceeded budget ${latencyBudgetMs}ms`);
  } else {
    record('latency_budget', true, `latency ${result.latencyMs}ms within ${latencyBudgetMs}ms`);
  }

  // provider_metadata — observability policy: the live envelope carries no
  // providerTrace, so missing trace/fields are an honest pass; a PRESENT
  // field with the wrong value is contradicting evidence and fails.
  const providerCheck = verifyProviderTrace(expectation, result.providerTrace ?? null);
  if (providerCheck === null) {
    record('provider_metadata', true, 'no provider/tier/model expectation');
  } else if (providerCheck.issues.length) {
    record('provider_metadata', false, providerCheck.issues.join('; '));
  } else if (providerCheck.unobservable) {
    record('provider_metadata', true, 'provider trace not observable in live envelope');
  } else {
    record('provider_metadata', true, 'provider trace matched expectations');
  }

  // ios_envelope_shape
  const envelopeIssue = checkIosEnvelopeShape(result.envelope);
  if (envelopeIssue) {
    record('ios_envelope_shape', false, envelopeIssue);
  } else {
    record('ios_envelope_shape', true, 'envelope shape is iOS-renderable');
  }

  // response_language — deterministic milestone-3 detector by default;
  // null (undecidable) stays an honest pass so short answers never
  // false-positive the locale gate.
  if (!expectation.expectedLanguage) {
    record('response_language', true, 'no language expectation');
  } else {
    const detector = options.languageDetector ?? defaultChatEvalLanguageDetector;
    const detected = detector(result.text);
    if (detected === null) {
      record('response_language', true, 'response language undecidable; fail-open');
    } else if (primarySubtag(detected) === primarySubtag(expectation.expectedLanguage)) {
      record('response_language', true, `response language ${detected}`);
    } else {
      record('response_language', false, `expected language ${expectation.expectedLanguage}, detected ${detected}`);
    }
  }

  appendLlmJudgePlaceholders(dimensions);
  return aggregate(dimensions);
}

function recordFlow(
  record: (dimension: ChatEvalScorerDimensionId, passed: boolean, detail: string) => void,
  dimension: Extract<ChatEvalScorerDimensionId, 'clarification_flow' | 'confirmation_flow' | 'refusal_flow'>,
  required: boolean | undefined,
  normalizedStatus: NormalizedObservedActionStatus | null,
  rawStatus: string | null,
  expectedStatus: NormalizedObservedActionStatus,
): void {
  if (!required) {
    record(dimension, true, `no ${expectedStatus} expectation`);
    return;
  }
  if (normalizedStatus === expectedStatus) {
    record(dimension, true, `actionStatus ${rawStatus ?? normalizedStatus}`);
  } else {
    record(dimension, false, `expected actionStatus ${expectedStatus}, got ${rawStatus ?? 'none'}`);
  }
}

function verifySideEffects(
  expected: readonly ChatEvalSideEffectExpectation[],
  observations: readonly ChatEvalSideEffectObservation[],
): string[] {
  const issues: string[] = [];
  for (const expectation of expected) {
    const observation = observations.find((entry) => entry.kind === expectation.kind);
    if (!observation) {
      issues.push(`no ${expectation.kind} read-back observation was provided`);
      continue;
    }
    if (observation.statusCode < 200 || observation.statusCode >= 300) {
      issues.push(`${expectation.kind} read-back returned http_${observation.statusCode}`);
      continue;
    }
    const serialized = safeSerialize(observation.body).toLowerCase();
    for (const token of expectation.mustIncludeText ?? []) {
      if (!serialized.includes(token.toLowerCase())) {
        issues.push(`${expectation.kind} read-back is missing expected state "${token}"`);
      }
    }
    for (const token of expectation.mustNotIncludeText ?? []) {
      if (serialized.includes(token.toLowerCase())) {
        issues.push(`${expectation.kind} read-back still contains forbidden state "${token}"`);
      }
    }
  }
  return issues;
}

function verifyProviderTrace(
  expectation: ChatEvalTurnScoringExpectation,
  trace: Record<string, unknown> | null,
): { issues: string[]; unobservable: boolean } | null {
  const checks: Array<[label: 'provider' | 'tier' | 'model', expected: string | undefined]> = [
    ['provider', expectation.expectedProvider],
    ['tier', expectation.expectedTier],
    ['model', expectation.expectedModel],
  ];
  if (checks.every(([, expected]) => expected === undefined)) return null;
  const issues: string[] = [];
  let unobservable = false;
  for (const [label, expected] of checks) {
    if (expected === undefined) continue;
    const actual = trace?.[label];
    // Missing evidence (no trace, or field absent) never fails the dim; only
    // a present field with a different value is a contradiction.
    if (actual === undefined || actual === null) {
      unobservable = true;
      continue;
    }
    if (actual !== expected) {
      issues.push(`expected ${label} ${expected}, got ${typeof actual === 'string' ? actual : String(actual)}`);
    }
  }
  return { issues, unobservable };
}

function checkIosEnvelopeShape(envelope: unknown): string | null {
  if (!envelope || typeof envelope !== 'object') return 'envelope is not an object';
  const raw = envelope as Record<string, unknown>;
  if (typeof raw.id !== 'string' || !raw.id) return 'envelope.id must be a non-empty string';
  if (typeof raw.text !== 'string' || !raw.text) return 'envelope.text must be a non-empty string';
  if (typeof raw.domain !== 'string' || !raw.domain) return 'envelope.domain must be a non-empty string';
  if (typeof raw.routeMethod !== 'string' || !raw.routeMethod) return 'envelope.routeMethod must be a non-empty string';
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence)) return 'envelope.confidence must be a finite number';
  if (raw.buttons !== null && !Array.isArray(raw.buttons)) return 'envelope.buttons must be null or an array';
  if (raw.metadata !== null && (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata))) return 'envelope.metadata must be null or an object';
  if (typeof raw.timestamp !== 'string' || Number.isNaN(Date.parse(raw.timestamp))) return 'envelope.timestamp must be a parseable ISO timestamp';
  return null;
}

function appendLlmJudgePlaceholders(dimensions: ChatEvalDimensionScore[]): void {
  for (const dimension of LLM_JUDGE_DIMENSIONS) {
    dimensions.push({
      dimension,
      source: 'llm_judge',
      score: null,
      passed: null,
      failureType: CHAT_EVAL_SCORER_DIMENSIONS[dimension].failureType,
      detail: 'awaiting bounded llm_judge scoring (M2c)',
    });
  }
}

function aggregate(dimensions: ChatEvalDimensionScore[]): ChatEvalTurnScore {
  const deterministic = dimensions.filter((entry) => entry.source === 'deterministic');
  const failures = deterministic
    .filter((entry) => entry.passed === false)
    .map((entry) => ({ type: entry.failureType, detail: `[${entry.dimension}] ${entry.detail}` }));
  const scores = deterministic.map((entry) => entry.score ?? 0);
  return {
    dimensions,
    deterministicAverage: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0,
    passed: failures.length === 0,
    failures,
    llmJudgeDimensions: [...LLM_JUDGE_DIMENSIONS],
  };
}

function primarySubtag(language: string): string {
  return language.toLowerCase().split(/[-_]/)[0] ?? '';
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
