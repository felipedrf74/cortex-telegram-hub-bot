// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Ollama Provider — local LLM backend running on this VPS at
 * 127.0.0.1:11434. Implements the `AIProvider` interface and adds two
 * optional methods (`generateScript`, `localReason`) for the new task
 * types introduced by WO-ollama-local-llm.
 *
 * Design notes (see plan Revision 4):
 * - Configuration is read once at construct time from `config.ollama`.
 *   `isOllamaConfigured()` is config-only — it does NOT probe the daemon
 *   so that registration in `provider-registry.ts` doesn't depend on the
 *   daemon being up. Health lives in `getProviderHealth()`.
 * - In-process bounded queue per task type. `capacity_exceeded` errors
 *   do NOT increment the circuit breaker (busy ≠ broken).
 * - PM2 cluster-mode guard at construct time: with the memory queue
 *   backend, only `NODE_APP_INSTANCE=0` (or unset) is valid.
 * - Thinking traces (`message.thinking` field and any inline
 *   `<think>...</think>` blocks) are stripped at the provider boundary
 *   and NEVER written to logs or the returned text. Defensive layered:
 *   we strip even when `think: false`, in case the model emits any.
 * - Tool calling is deferred to v2; `continueWithToolResults` throws
 *   `LocalLLMError('unsupported_capability')`. The routing layer catches
 *   that and routes to the configured fallback provider.
 * - Exactly one `api_usage` row per successful call. `cost_usd=0`,
 *   `pricing_status='zero-cost'`, `local_request_units=1`.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { getDb } from './database';
import { pushEvent } from '../portal/telemetry';
import {
  AIProvider,
  AICallResult,
  AIToolResultMessage,
  CallDomainOptions,
  ClassifyOptions,
  ProviderHealthSnapshot,
  isProviderRequestCancellation,
  normalizeCallDomainOptions,
} from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { getClassifierSystemPrompt, getDomainSystemPrompt, getOllamaClassifierSystemPromptCompact } from './anthropic';
import { LocalLLMError, type LocalLLMErrorKind } from './local-llm-error';
import { estimateTokens, estimateTokensTotal } from './token-estimator';
import { insertApiUsageFallback, tripApiUsagePersistenceFailure } from './api-usage-fallback';
import { resolveApiUsageAttribution } from './api-usage-attribution';
import { assertAiBudgetReservationForProvider } from './cost-guardrail';
import {
  checkAndConsumeLocalLLMRateLimit,
  type LocalLLMRateLimitScope,
} from './local-llm-rate-limiter';
import { buildScopedStateContextPrefix } from './provider-state-context';
import {
  assertSmallOnlyOllamaModel,
  getActiveLocalModel,
  getLocalModelManifest,
  tryGetLocalModelManifest,
} from './ollama-model-policy';
import { OllamaTransportError, ollamaTransportFetch } from './ollama-transport';
import { localPrimaryInferenceConfig } from './local-primary-config';
import { validateStructuredOutputValue } from './structured-output-schema';
import { detectResponseLanguage } from './chat-language-detector';
import { getCurrentChatRequestLocale } from './chat-request-locale-context';
import { assessChatResearchAnswerCompleteness } from './chat-research-answer-quality';
import { getCurrentChatLiveEvalSeedFacts } from './chat-live-evaluation-context';
import type { ContentFormatId } from './content-domain-ontology';
import {
  getNlReachableCapabilities,
  isManifestClassifierPromptEnabled,
  resolveManifestClassifierDisposition,
} from '../router/classifier-prompt-builder';
import {
  normalizeOllamaModelDigest,
  ollamaModelDigestsEqual,
} from './ollama-model-digest';
import { CLASSIFIER_SHADOW_JOB_NAME } from './local-inference-vocabulary';

// ─── Public types for the new task dispatch paths ──────────────────

/** Task type identifiers spoken by the routing layer. */
export type OllamaTaskType =
  | 'classify'
  | 'chat'             // callDomain (non-tool domains)
  | 'tool-use'         // callDomain / continueWithToolResults — UNSUPPORTED in v1
  | 'scriptGeneration'
  | 'localReasoning';

/**
 * Explicit workload identity enforced at the final boundary before an
 * Ollama HTTP request is admitted. Production local inference is deliberately
 * limited to the calibrated roles below and the one active signed-manifest
 * model. Generic work must never acquire a local role by inference from a
 * category string or task type.
 */
export type OllamaWorkloadRole =
  | 'validated_local_chat'
  | 'classifier_shadow'
  | 'skill_inference'
  | 'offline_evaluation';

export interface ScriptGenTask {
  description: string;
  targetPath?: string;          // hint where artifacts will live (relative)
  domainContext?: string;       // additional context to inject into the system prompt
  userId?: number;
  tenantId?: number;
  /** Run id used for sandbox directory naming. Caller may pass a UUID. */
  runId?: string;
  /** Caller lifecycle; cancellation stops local passes, validators, and persistence. */
  abortSignal?: AbortSignal;
}

export interface GeneratedArtifact {
  path: string;
  kind: 'shell_script' | 'typescript' | 'sql_migration' | 'markdown' | 'json' | 'patch';
  content: string;
  executable: boolean;
}

export interface ScriptGenPlan {
  plan: string[];
  files_to_create: string[];
  files_to_modify: string[];
  commands_to_run: string[];
  risk_level: 'low' | 'medium' | 'high';
  requires_cloud_reasoning: boolean;
  requires_human_approval: boolean;
}

export interface ScriptGenResult extends ScriptGenPlan {
  artifacts: GeneratedArtifact[];
  validation_steps: string[];
  validation_status: 'passed' | 'failed' | 'skipped';
  validation_details: Array<{ command: string; ok: boolean; output?: string }>;
  sandbox_path?: string;
  run_id: string;
}

export interface LocalReasoningTask {
  /** Required local workload identity; unknown/missing roles fail closed. */
  workloadRole: OllamaWorkloadRole;
  prompt: string;
  systemContext?: string;
  userId?: number;
  tenantId?: number;
  /** If true, requests can be escalated to cloud through the gate. */
  allowCloudEscalation?: boolean;
  containsPrivateData?: boolean;
  redactionRequired?: boolean;
  /** Optional JSON schema enforced via Ollama format=. */
  outputSchema?: unknown;
  /** Optional per-call model override for bounded ChatCoreV2 planner/composer paths. */
  modelOverride?: string;
  /** Optional per-call thinking toggle. Defaults to true for legacy localReasoning. */
  think?: boolean;
  /** Optional per-call context window. Defaults to the localReasoning cap. */
  numCtx?: number;
  /** Optional per-call output cap. Defaults to outputCapFor('localReasoning'). */
  numPredict?: number;
  /** Optional per-call temperature. Defaults to 0.2. */
  temperature?: number;
  /** Optional per-call timeout override. Defaults to config.ollama.timeoutMs. */
  timeoutMs?: number;
  /** Optional Ollama model residency, in seconds, for the outbound keep_alive field. */
  keepAliveSeconds?: number;
  /** Optional caller abort signal composed into the Ollama fetch. */
  abortSignal?: AbortSignal;
  /** Server-owned routing hint; never trusted from a public request body. */
  localAdmission?: 'eligible' | 'force_cloud' | 'local_only';
  /** Applied only around an actual cloud provider attempt. */
  cloudFallbackBoundary?: <T>(providerCall: () => Promise<T>) => Promise<T>;
}

function assertAllowedOllamaWorkloadRole(
  workloadRole: unknown,
  taskType: OllamaTaskType,
): asserts workloadRole is OllamaWorkloadRole {
  if (workloadRole === 'validated_local_chat'
      || workloadRole === 'classifier_shadow'
      || workloadRole === 'skill_inference') {
    return;
  }
  if (workloadRole === 'offline_evaluation') {
    const evaluationEnabled = config.localLLMEvaluation.enabled === true;
    const scriptLocalRequired = taskType !== 'scriptGeneration'
      || config.localLLMEvaluation.requireLocalForScriptGen === true;
    if (evaluationEnabled && scriptLocalRequired) return;
  }
  throw new LocalLLMError('unsupported_capability', {
    taskType,
    capability: 'local_workload_role_not_allowed',
    workloadRole: typeof workloadRole === 'string' ? workloadRole : 'missing',
  });
}

export interface LocalReasoningResult {
  /** Free-text reasoning (always present). */
  text: string;
  /** When outputSchema is set, parsed structured payload (best-effort). */
  parsed?: unknown;
  /** Ollama completion stop reason, when available. */
  stopReason?: string;
  requires_cloud_reasoning?: boolean;
  providerMetadata?: AICallResult['providerMetadata'];
}

// ─── Low-level Ollama chat HTTP types ───────────────────────────────

interface OllamaChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  think?: boolean;
  format?: unknown;
  stream: false;
  keep_alive?: number;
  options?: {
    num_ctx?: number;
    num_predict?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
  };
}

interface OllamaChatResponse {
  model: string;
  created_at?: string;
  message: { role: string; content: string; thinking?: string };
  done: boolean;
  done_reason?: string;
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  prompt_eval_duration?: number;
  eval_count?: number;
  eval_duration?: number;
}

// ─── Configured? (config-only — no network probe) ──────────────────

/**
 * O3-A14: env-driven positive integer helper used for classifier knobs
 * (`OLLAMA_CLASSIFIER_NUM_CTX`, `OLLAMA_CLASSIFIER_NUM_PREDICT`). Read at
 * each call so operators can adjust without restarting nexus-hub during
 * tuning (the wider config.ts uses build-time `optionalInt`, but the
 * classifier path benefits from being live-tunable for shadow eval).
 */
function readPositiveInt(envKey: string, defaultValue: number): number {
  const raw = process.env[envKey];
  if (!raw) return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

export function isOllamaConfigured(): boolean {
  const cfg = (config as { ollama?: { enabled?: boolean; baseUrl?: string; model?: string } }).ollama;
  return !!(cfg && cfg.enabled && cfg.baseUrl && cfg.model);
}

// ─── Defensive thinking-trace strip (fail-closed depth parser) ────
//
// v2.6 (angry-QA-found): the previous regex `/<think>[\s\S]*?<\/think>/g`
// missed case-insensitive tags, unclosed tags, and nested tags. With
// nested input the non-greedy match consumed the inner-close, leaving
// outer-thinking content visible as orphan-after-close. The fix is a
// proper depth-tracking parser that tracks `<think>` / `</think>` pairs
// case-insensitively, swallows any character while depth > 0, and
// fails-closed on any unclosed open tag (everything from the open to
// end-of-string is dropped).
//
// Semantics:
//   - `<think>X</think>Y`       → `Y`
//   - `<THINK>X</THINK>Y`       → `Y` (case-insensitive)
//   - `<think>X` (unclosed)     → `` (fail-closed)
//   - `<think>A<think>B</think>C</think>D` → `D` (depth tracked)
//   - `<think >X</think >Y`     → `Y` (whitespace inside tag tolerated)
//   - orphan `</think>` without prior open is silently consumed (no
//     content before it is hidden — we have no signal it was thinking)

const THINK_OPEN_RE = /^<think\b[^>]*>/i;
const THINK_CLOSE_RE = /^<\/think\s*>/i;

// Phase K (2026-05-26, Operator A10 + amendment items 11–12):
// domain-specific prompt suffixes appended to the system prompt for
// answer-only Ollama-routed domains. These are FALLBACK safety layers
// beyond the chat-response-quality-gate exemption — they bias the
// model away from past-tense self-success claims that would trigger
// the gate in the first place.
//
// Cooking + content: lenient creative-output directive in English +
// Portuguese; lists verbs to avoid.
// Finance: STRICTER directive — finance must not fabricate access
// to accounts/balances/transactions/prices/tax rules. Finance is
// NOT in CREATIVE_TEXT_OWNERS in the quality gate; this suffix
// reinforces the model bias.
const PHASE_K_ANSWER_ONLY_GUARD = [
  '',
  '— OUTPUT STYLE —',
  'Answer directly. Do not preface your answer with self-success claims',
  "(English: 'I created', 'I scheduled', 'I completed', 'I saved',",
  "'I updated', 'I published', 'I posted', 'I sent', 'I uploaded';",
  "Portuguese: 'criei', 'agendei', 'marquei', 'salvei', 'completei',",
  "'atualizei', 'publiquei', 'postei', 'enviei', 'subi', 'cadastrei',",
  "'programei', 'adicionei') unless a tool result explicitly verifies",
  "the action. Present creative outputs (recipes, drafts, ideas)",
  "directly. Always answer in the user's language unless they request",
  "another.",
].join('\n');

type RoutineContentNoticeLocale = 'en-US' | 'pt-BR' | 'pt-PT';
type RoutineContentAnswerKey = 'answer_en_us' | 'answer_pt_br' | 'answer_pt_pt';

function routineContentAnswerKey(
  locale: RoutineContentNoticeLocale,
): RoutineContentAnswerKey {
  if (locale === 'pt-PT') return 'answer_pt_pt';
  if (locale === 'pt-BR') return 'answer_pt_br';
  return 'answer_en_us';
}

const PHASE_K_FINANCE_GUARD = [
  '',
  '— FINANCE OUTPUT STYLE —',
  'For finance answers: do NOT claim you accessed accounts, balances,',
  'transactions, prices, tax rules, or current law unless that',
  'information is explicitly present in the provided context. If',
  'information is not provided, state the assumption or ask for',
  'clarification. Do NOT claim to have marked, paid, saved, updated,',
  'categorized, or changed any financial record. Always answer in the',
  "user's language unless they request another.",
].join('\n');

function phaseKDomainSystemPromptSuffix(
  domain: DomainName,
): string {
  if (domain === 'content') return PHASE_K_ANSWER_ONLY_GUARD;
  if (domain === 'cooking') return PHASE_K_ANSWER_ONLY_GUARD;
  if (domain === 'finance') return PHASE_K_FINANCE_GUARD;
  return '';
}

const ROUTINE_CONTENT_ANSWER_MIN_CHARS = 24;

function normalizeRoutineContentSubjectStem(token: string): string {
  const lower = token.toLowerCase();
  return lower.length > 5 && lower.endsWith('s')
    ? lower.slice(0, -1)
    : lower;
}

function resolveRoutineContentNoticeLanguage(
  currentMessage: string,
): RoutineContentNoticeLocale {
  const requestLocale = getCurrentChatRequestLocale();
  if (/^pt-pt$/iu.test(requestLocale ?? '')) return 'pt-PT';
  if (/^pt(?:-br)?$/iu.test(requestLocale ?? '')) return 'pt-BR';
  if (/^en(?:-[a-z0-9]{2,3})?$/iu.test(requestLocale ?? '')) return 'en-US';
  return detectResponseLanguage(currentMessage).language === 'pt' ? 'pt-BR' : 'en-US';
}

const MODEL_AUTHORED_CONTENT_MAX_CHARS = 480;
const MODEL_AUTHORED_CONTENT_MAX_OUTPUT_TOKENS = 192;
const MODEL_AUTHORED_SHORT_COMPARISON_MAX_CHARS = 66;
const MODEL_AUTHORED_SHORT_COMPARISON_MAX_OUTPUT_TOKENS = 24;
const MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_MAX_CHARS = 64;
const MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_MAX_OUTPUT_TOKENS = 32;

const MODEL_AUTHORED_SHORT_COMPARISON_SYSTEM_PROMPT = [
  'JSON only: one model-written `a`.',
  'Use two different concrete conditions.',
].join('\n');

const MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_SYSTEM_PROMPT = [
  'JSON only: model-written `a`.',
].join('\n');

interface ModelAuthoredContentComparison {
  sharedStems: ReadonlySet<string>;
  leftUniqueStems: ReadonlySet<string>;
  rightUniqueStems: ReadonlySet<string>;
}

interface ModelAuthoredContentAuthorizedIdeas {
  requiredStems: ReadonlySet<string>;
  groundingStems: ReadonlySet<string>;
}

interface ParsedModelAuthoredAuthorizedIdeasAnswer {
  groundingStem: string;
  formatAStems: ReadonlySet<string>;
  formatBStems: ReadonlySet<string>;
}

type ModelAuthoredContentShortMode =
  | 'authorizedIdeas'
  | 'comparison'
  | null;

const MODEL_AUTHORED_COMPARISON_STOP_WORDS = new Set([
  'a', 'an', 'the', 'one', 'several', 'some', 'my', 'our', 'your',
]);

const MODEL_AUTHORED_LONG_FORM_MARKERS =
  /\b(?:article|calendar|comprehensive|detailed|essay|full|in[- ]depth|long[- ]form|multi[- ]paragraph|outline|plan|script)\b/iu;
const MODEL_AUTHORED_NORMALIZED_LONG_FORM_MARKERS =
  /\b(?:artigo|calendario|completo|detalhado|ensaio|esboco|plano|roteiro)\b/u;
const MODEL_AUTHORED_AUTHORIZED_CONTEXT_REQUEST =
  /\b(?:(?:use|using)\s+only\s+(?:the\s+)?authorized\s+context|(?:usando|use|usa)\s+(?:apenas|somente)\s+(?:o\s+)?contexto\s+autorizado)\b/u;
const MODEL_AUTHORED_IDEA_STEMS = new Set(['idea', 'ideas', 'ideia']);
const MODEL_AUTHORED_CONTENT_STEMS = new Set(['content', 'conteudo']);
const MODEL_AUTHORED_SHORT_SOURCE_MAX_ESTIMATED_TOKENS = 560;
const MODEL_AUTHORED_GROUNDING_STOP_WORDS = new Set([
  'active', 'assistant', 'atencao', 'attention', 'authorized', 'available', 'begin',
  'campaign', 'content', 'context', 'current', 'end', 'eval', 'evaluation',
  'disponivel', 'evidence', 'fact', 'ideas', 'launch', 'message', 'needs', 'nexus',
  'precisa', 'project', 'publication', 'publishing', 'remain', 'remains', 'request', 'scoped',
  'state', 'synthetic', 'tenant', 'using', 'user', 'workspace',
]);
const MODEL_AUTHORED_CONDITION_STOP_WORDS = new Set([
  'a', 'an', 'and', 'approach', 'are', 'as', 'be', 'best', 'better', 'but',
  'each', 'first', 'fit', 'fits', 'for', 'ideal', 'is', 'it', 'option', 'or',
  'prefer', 'preferable', 'preferred', 'second', 'suit', 'suits', 'the',
  'to', 'use', 'versus', 'when', 'whereas', 'while',
]);
const MODEL_AUTHORED_AUTHORIZED_IDEAS_FORMAT_STOP_WORDS = new Set([
  ...MODEL_AUTHORED_CONDITION_STOP_WORDS,
  'about', 'ao', 'aos', 'at', 'because', 'com', 'como', 'content', 'conteudo',
  'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'format', 'formato', 'idea',
  'ideas', 'ideia', 'in', 'na', 'nas', 'no', 'nos', 'o', 'of', 'on', 'onde',
  'os', 'ou', 'para', 'por', 'que', 'quando', 'um', 'uma', 'umas', 'uns', 'with',
]);
const MODEL_AUTHORED_AUTHORIZED_IDEAS_INTERNAL_CONNECTORS = new Set([
  'com', 'da', 'das', 'de', 'do', 'dos', 'for', 'of', 'para', 'with',
]);
type ModelAuthoredAuthorizedIdeasHeadEntry = readonly [
  spokenStem: string,
  canonicalStem: string,
];
const MODEL_AUTHORED_AUTHORIZED_IDEAS_SPOKEN_HEADS_BY_FORMAT = {
  youtube_long_form: [['video', 'video']],
  youtube_shorts: [['short', 'video'], ['video', 'video']],
  instagram_reel: [['reel', 'reel']],
  tiktok: [['tiktok', 'tiktok']],
  linkedin_post: [['post', 'post']],
  x_thread: [['thread', 'thread']],
  newsletter: [['newsletter', 'newsletter']],
  blog: [['blog', 'blog']],
  podcast_outline: [['outline', 'podcast'], ['podcast', 'podcast']],
  carousel: [['carousel', 'carousel']],
  generic_script: [['script', 'script']],
  caption: [['caption', 'caption']],
} satisfies Record<ContentFormatId, readonly ModelAuthoredAuthorizedIdeasHeadEntry[]>;
const MODEL_AUTHORED_AUTHORIZED_IDEAS_HEAD_CANONICAL_STEMS: ReadonlyMap<string, string> = new Map([
  ...Object.values(MODEL_AUTHORED_AUTHORIZED_IDEAS_SPOKEN_HEADS_BY_FORMAT).flat(),
  ['animacao', 'video'], ['animation', 'video'],
  ['article', 'article'], ['artigo', 'article'],
  ['audio', 'audio'],
  ['bastidor', 'behind_scenes'],
  ['carrossel', 'carousel'],
  ['case', 'case'], ['study', 'case'],
  ['checklist', 'checklist'],
  ['citation', 'quote'], ['citacao', 'quote'], ['quote', 'quote'],
  ['clip', 'video'], ['clipe', 'video'],
  ['demo', 'video'], ['demonstracao', 'video'],
  ['dica', 'tip'], ['tip', 'tip'],
  ['documentario', 'video'], ['documentary', 'video'],
  ['ebook', 'ebook'],
  ['enquete', 'poll'], ['poll', 'poll'],
  ['entrevista', 'interview'], ['interview', 'interview'],
  ['faq', 'faq'],
  ['fio', 'thread'],
  ['foto', 'photo'], ['photo', 'photo'],
  ['gallery', 'gallery'], ['galeria', 'gallery'],
  ['graphic', 'graphic'], ['grafico', 'graphic'],
  ['guide', 'guide'], ['guia', 'guide'],
  ['historia', 'story'], ['story', 'story'],
  ['infografico', 'infographic'], ['infographic', 'infographic'],
  ['list', 'list'], ['lista', 'list'],
  ['live', 'livestream'], ['livestream', 'livestream'], ['stream', 'livestream'],
  ['meme', 'meme'],
  ['serie', 'series'], ['series', 'series'],
  ['slide', 'slide'],
  ['text', 'text'], ['texto', 'text'],
  ['tutorial', 'video'],
  ['webinar', 'webinar'],
  ['whitepaper', 'whitepaper'],
]);
const MODEL_AUTHORED_AUTHORIZED_IDEAS_MODIFIER_CANONICAL_STEMS: ReadonlyMap<string, string> = new Map([
  ['animated', 'animated'], ['animado', 'animated'],
  ['brief', 'brief'], ['breve', 'brief'],
  ['cliente', 'customer'], ['customer', 'customer'],
  ['creative', 'creative'], ['criativo', 'creative'],
  ['curto', 'short'],
  ['daily', 'daily'], ['diario', 'daily'],
  ['digital', 'digital'], ['editorial', 'editorial'],
  ['educational', 'educational'], ['educativo', 'educational'],
  ['estatico', 'static'], ['static', 'static'],
  ['horizontal', 'horizontal'],
  ['informative', 'informative'], ['informativo', 'informative'],
  ['interactive', 'interactive'], ['interativo', 'interactive'],
  ['long', 'long'], ['longo', 'long'], ['mini', 'mini'],
  ['promocional', 'promotional'], ['promotional', 'promotional'],
  ['quick', 'quick'], ['rapido', 'quick'],
  ['semanal', 'weekly'], ['weekly', 'weekly'],
  ['short', 'short'],
  ['simple', 'simple'], ['simples', 'simple'],
  ['social', 'social'], ['vertical', 'vertical'], ['visual', 'visual'],
]);
const MODEL_AUTHORED_AUTHORIZED_IDEAS_IRREGULAR_FORMAT_STEMS: ReadonlyMap<string, string> = new Map([
  ['bastidores', 'bastidor'],
  ['carrosseis', 'carrossel'],
  ['serie', 'series'],
  ['series', 'series'],
  ['stories', 'story'],
] as const);

function normalizeModelAuthoredText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function modelAuthoredComparisonStems(text: string): Set<string> {
  return new Set(
    (normalizeModelAuthoredText(text)
      .match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => !MODEL_AUTHORED_COMPARISON_STOP_WORDS.has(token))
      .map(normalizeRoutineContentSubjectStem),
  );
}

function modelAuthoredComparisonWordCount(text: string): number {
  return text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
}

function parseModelAuthoredContentComparison(
  currentMessage: string,
): ModelAuthoredContentComparison | null {
  if (MODEL_AUTHORED_LONG_FORM_MARKERS.test(currentMessage)) return null;
  const firstClause = currentMessage.split(/[.!?;:\n]/u, 1)[0]?.trim() ?? '';
  const match = firstClause.match(
    /^(?:compare|contrast)\s+(.+?)\s+(?:with|versus|vs)\s+(.+)$/iu,
  );
  if (!match) return null;
  if (
    modelAuthoredComparisonWordCount(match[1] ?? '') > 8
    || modelAuthoredComparisonWordCount(match[2] ?? '') > 8
  ) {
    return null;
  }
  const left = modelAuthoredComparisonStems(match[1] ?? '');
  const right = modelAuthoredComparisonStems(match[2] ?? '');
  if (left.size === 0 || right.size === 0 || left.size > 8 || right.size > 8) return null;
  const sharedStems = new Set([...left].filter((stem) => right.has(stem)));
  const leftUniqueStems = new Set([...left].filter((stem) => !right.has(stem)));
  const rightUniqueStems = new Set([...right].filter((stem) => !left.has(stem)));
  if (leftUniqueStems.size === 0 || rightUniqueStems.size === 0) return null;
  return { sharedStems, leftUniqueStems, rightUniqueStems };
}

function parseModelAuthoredContentAuthorizedIdeas(
  currentMessage: string,
  history: readonly DomainMessage[],
  stateContext: string,
): ModelAuthoredContentAuthorizedIdeas | null {
  const normalized = normalizeModelAuthoredText(currentMessage);
  if (
    MODEL_AUTHORED_LONG_FORM_MARKERS.test(currentMessage)
    || MODEL_AUTHORED_NORMALIZED_LONG_FORM_MARKERS.test(normalized)
    || !MODEL_AUTHORED_AUTHORIZED_CONTEXT_REQUEST.test(normalized)
    || modelAuthoredComparisonWordCount(currentMessage) > 32
  ) {
    return null;
  }
  const requestStems = modelAuthoredComparisonStems(currentMessage);
  const ideaStem = [...MODEL_AUTHORED_IDEA_STEMS].find((stem) => requestStems.has(stem));
  const contentStem = [...MODEL_AUTHORED_CONTENT_STEMS].find((stem) => requestStems.has(stem));
  if (!ideaStem || !contentStem) return null;
  const liveEvalSeedFacts = getCurrentChatLiveEvalSeedFacts();
  const contextParts = liveEvalSeedFacts.length > 0
    ? [...liveEvalSeedFacts]
    : [
      ...history.map((message) => (
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content)
      )),
      stateContext,
    ];
  if (
    estimateTokensTotal([...contextParts, currentMessage])
    > MODEL_AUTHORED_SHORT_SOURCE_MAX_ESTIMATED_TOKENS
  ) {
    return null;
  }
  const groundingStems = new Set(
    [...modelAuthoredComparisonStems(contextParts.join('\n'))]
      .filter((stem) => (
        stem.length >= 5
        && stem.length <= 20
        && /^[a-z]+$/u.test(stem)
        && !MODEL_AUTHORED_GROUNDING_STOP_WORDS.has(stem)
        && !requestStems.has(stem)
      ))
      .slice(0, 64),
  );
  if (groundingStems.size === 0) return null;
  return {
    requiredStems: new Set([ideaStem, contentStem]),
    groundingStems: new Set([[...groundingStems].sort()[0] as string]),
  };
}

function modelAuthoredComparisonRequiredOpening(
  comparison: ModelAuthoredContentComparison | null,
): string {
  if (!comparison) return 'Comparison:';
  const left = [...comparison.leftUniqueStems][0] ?? 'first';
  const shared = [...comparison.sharedStems][0];
  const capitalizedLeft = `${left.slice(0, 1).toUpperCase()}${left.slice(1)}`;
  return shared
    ? `${capitalizedLeft} ${shared}`
    : capitalizedLeft;
}

function modelAuthoredComparisonSecondLabel(
  comparison: ModelAuthoredContentComparison | null,
): string {
  return [...(comparison?.rightUniqueStems ?? [])][0] ?? 'second';
}

function modelAuthoredAuthorizedIdeasPrefix(
  locale: RoutineContentNoticeLocale,
  groundingStem: string,
): string {
  const heading = locale === 'en-US' ? 'Ideas for content' : 'Ideias de conteúdo';
  const connector = locale === 'en-US' ? 'in' : 'em';
  return `${heading}: ${groundingStem} ${connector}`;
}

function modelAuthoredContentLanguageInstruction(
  locale: RoutineContentNoticeLocale,
  shortMode: ModelAuthoredContentShortMode,
  comparison: ModelAuthoredContentComparison | null = null,
  authorizedIdeasPrefix: string | null = null,
): string {
  const answerKey = routineContentAnswerKey(locale);
  const visibleAnswerKey = shortMode === null ? answerKey : 'a';
  const language = locale === 'en-US'
    ? 'English (en-US)'
    : locale === 'pt-PT'
      ? 'European Portuguese (pt-PT)'
      : 'Brazilian Portuguese (pt-BR)';
  const comparisonOpening = modelAuthoredComparisonRequiredOpening(comparison);
  if (shortMode === 'comparison') {
    const secondLabel = modelAuthoredComparisonSecondLabel(comparison);
    return [
      `Use ${language}. Write “${comparisonOpening} is for <condition>; ${secondLabel} fits <condition>.”`,
      'Replace both `<condition>` markers with different concrete one-word conditions.',
      'End with `.`; maximum 64 characters.',
    ].join(' ');
  }
  if (shortMode === 'authorizedIdeas') {
    if (!authorizedIdeasPrefix) {
      throw new Error('Authorized-ideas output prefix is required');
    }
    return [
      `Use ${language}.`,
      `Start \`a\` exactly "${authorizedIdeasPrefix} ". Then add 2 different real 1-3-word media-format names joined by ", ". End "."; nothing else; max 62 chars.`,
    ].join(' ');
  }
  return [
    `Write \`${visibleAnswerKey}\` only in ${language}.`,
    'The value must be a complete, directly useful answer rather than a heading or fragment.',
    'Use no more than 90 words.',
  ].join(' ');
}

function modelAuthoredContentSystemSuffix(
  locale: RoutineContentNoticeLocale,
): string {
  return [
    PHASE_K_ANSWER_ONLY_GUARD,
    '',
    '— MANDATORY STRUCTURED RESPONSE —',
    'Return only the JSON object required by the response schema.',
    modelAuthoredContentLanguageInstruction(locale, null),
  ].join('\n');
}

function buildModelAuthoredContentResponseFormat(
  locale: RoutineContentNoticeLocale,
  shortMode: ModelAuthoredContentShortMode,
): Record<string, unknown> {
  const answerKey = routineContentAnswerKey(locale);
  const visibleAnswerKey = shortMode === null ? answerKey : 'a';
  const language = locale === 'en-US'
      ? 'English (en-US)'
      : locale === 'pt-PT'
        ? 'European Portuguese (pt-PT)'
        : 'Brazilian Portuguese (pt-BR)';
  return {
    type: 'object',
    properties: {
      [visibleAnswerKey]: {
        type: 'string',
        ...(shortMode === null
          ? { description: `Complete model-authored answer in ${language}.` }
          : {}),
        minLength: ROUTINE_CONTENT_ANSWER_MIN_CHARS,
        maxLength: shortMode === 'comparison'
          ? MODEL_AUTHORED_SHORT_COMPARISON_MAX_CHARS
          : shortMode === 'authorizedIdeas'
            ? MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_MAX_CHARS
            : MODEL_AUTHORED_CONTENT_MAX_CHARS,
      },
    },
    required: [visibleAnswerKey],
    additionalProperties: false,
  };
}

function modelAuthoredContentLanguageDoesNotContradict(
  answer: string,
  locale: RoutineContentNoticeLocale,
): boolean {
  const expected = locale === 'en-US' ? 'en' : 'pt';
  const detected = detectResponseLanguage(answer).language;
  return detected === expected || detected === 'unknown';
}

function modelAuthoredComparisonSemanticsMatch(
  answer: string,
  comparison: ModelAuthoredContentComparison,
): boolean {
  const answerStems = modelAuthoredComparisonStems(answer);
  const overlaps = (candidates: ReadonlySet<string>): boolean =>
    candidates.size === 0 || [...candidates].some((stem) => answerStems.has(stem));
  const preferenceExplained =
    /\b(?:best|better|fit|fits|ideal|prefer|preferable|preferred|suit|suits|use|when|while)\b/iu
      .test(answer);
  const body = answer.includes(':')
    ? answer.slice(answer.indexOf(':') + 1)
    : answer;
  const conditionMatch = body.match(
    /^(.+?)(?:(?:,\s*|\s+)(?:while|whereas|but)\s+|;\s*)(.+)$/iu,
  );
  const requestStems = new Set([
    ...comparison.sharedStems,
    ...comparison.leftUniqueStems,
    ...comparison.rightUniqueStems,
  ]);
  const conditionStems = (clause: string): Set<string> => new Set(
    [...modelAuthoredComparisonStems(clause)]
      .filter((stem) => (
        !requestStems.has(stem)
        && !MODEL_AUTHORED_CONDITION_STOP_WORDS.has(stem)
      )),
  );
  const distinctConditions = conditionMatch
    ? (() => {
      const leftConditions = conditionStems(conditionMatch[1] ?? '');
      const rightConditions = conditionStems(conditionMatch[2] ?? '');
      return [...leftConditions].some((stem) => !rightConditions.has(stem))
        && [...rightConditions].some((stem) => !leftConditions.has(stem));
    })()
    : false;
  return overlaps(comparison.sharedStems)
    && overlaps(comparison.leftUniqueStems)
    && overlaps(comparison.rightUniqueStems)
    && preferenceExplained
    && distinctConditions;
}

function modelAuthoredAuthorizedIdeasFormatStems(
  value: string,
): ReadonlySet<string> | null {
  if (!/^\p{L}+(?: \p{L}+){0,2}$/u.test(value)) return null;
  const tokens = normalizeModelAuthoredText(value).split(' ');
  if (
    MODEL_AUTHORED_AUTHORIZED_IDEAS_FORMAT_STOP_WORDS.has(tokens[0] ?? '')
    || MODEL_AUTHORED_AUTHORIZED_IDEAS_FORMAT_STOP_WORDS.has(tokens.at(-1) ?? '')
  ) {
    return null;
  }
  const normalizedStems = tokens.map((token) => {
    const irregular = MODEL_AUTHORED_AUTHORIZED_IDEAS_IRREGULAR_FORMAT_STEMS.get(token);
    if (irregular) return irregular;
    if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
    if (
      token.length > 3
      && token.endsWith('s')
      && !token.endsWith('ss')
      && token !== 'news'
    ) {
      return token.slice(0, -1);
    }
    return token;
  });
  const canonicalHeadStems = new Set(
    normalizedStems
      .map((stem) => MODEL_AUTHORED_AUTHORIZED_IDEAS_HEAD_CANONICAL_STEMS.get(stem))
      .filter((stem): stem is string => typeof stem === 'string'),
  );
  if (
    canonicalHeadStems.size !== 1
    || normalizedStems.some((stem, index) => (
      !MODEL_AUTHORED_AUTHORIZED_IDEAS_HEAD_CANONICAL_STEMS.has(stem)
      && !MODEL_AUTHORED_AUTHORIZED_IDEAS_MODIFIER_CANONICAL_STEMS.has(stem)
      && !(
        index > 0
        && index < normalizedStems.length - 1
        && MODEL_AUTHORED_AUTHORIZED_IDEAS_INTERNAL_CONNECTORS.has(stem)
      )
    ))
  ) {
    return null;
  }
  const stems = new Set(
    normalizedStems
      .filter((stem) => !MODEL_AUTHORED_AUTHORIZED_IDEAS_FORMAT_STOP_WORDS.has(stem))
      .flatMap((stem) => {
        const headStem = MODEL_AUTHORED_AUTHORIZED_IDEAS_HEAD_CANONICAL_STEMS.get(stem);
        const modifierStem = MODEL_AUTHORED_AUTHORIZED_IDEAS_MODIFIER_CANONICAL_STEMS.get(stem);
        if (headStem && modifierStem && headStem !== modifierStem) {
          return [headStem, modifierStem];
        }
        return [headStem ?? modifierStem ?? stem];
      }),
  );
  return stems.size > 0 ? stems : null;
}

function parseModelAuthoredAuthorizedIdeasAnswer(
  answer: string,
  locale: RoutineContentNoticeLocale,
  authorizedIdeas: ModelAuthoredContentAuthorizedIdeas,
): ParsedModelAuthoredAuthorizedIdeasAnswer | null {
  if (/[\r\n\u2028\u2029]/u.test(answer) || authorizedIdeas.groundingStems.size !== 1) {
    return null;
  }
  const [selectedGroundingStem] = authorizedIdeas.groundingStems;
  if (!selectedGroundingStem) return null;

  const outputPrefix = `${modelAuthoredAuthorizedIdeasPrefix(locale, selectedGroundingStem)} `;
  if (!answer.startsWith(outputPrefix)) return null;
  const answerStems = modelAuthoredComparisonStems(answer);
  if (![...authorizedIdeas.requiredStems].every((stem) => answerStems.has(stem))) return null;

  let formats = answer.slice(outputPrefix.length);
  if (formats.endsWith('.')) formats = formats.slice(0, -1);
  if (
    formats.length === 0
    || formats !== formats.trim()
    || /[.!?。！？]/u.test(formats)
  ) {
    return null;
  }

  const hasSlash = formats.includes('/');
  const hasComma = formats.includes(',');
  if (hasSlash === hasComma) return null;
  const separator = hasSlash ? '/' : ',';
  const items = formats.split(separator).map((item) => item.trim());
  if (items.length !== 2 || items.some((item) => item.length === 0)) return null;

  const formatAStems = modelAuthoredAuthorizedIdeasFormatStems(items[0] ?? '');
  const formatBStems = modelAuthoredAuthorizedIdeasFormatStems(items[1] ?? '');
  if (!formatAStems || !formatBStems) return null;
  if (
    ![...formatAStems].some((stem) => !formatBStems.has(stem))
    || ![...formatBStems].some((stem) => !formatAStems.has(stem))
  ) {
    return null;
  }
  return {
    groundingStem: selectedGroundingStem,
    formatAStems,
    formatBStems,
  };
}

function parseModelAuthoredContentResult(input: {
  text: string;
  locale: RoutineContentNoticeLocale;
  shortComparison: ModelAuthoredContentComparison | null;
  shortAuthorizedIdeas: ModelAuthoredContentAuthorizedIdeas | null;
}): string | null {
  try {
    const parsed = JSON.parse(input.text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const answerKey = routineContentAnswerKey(input.locale);
    const record = parsed as Record<string, unknown>;
    const expectedKeys = input.shortComparison || input.shortAuthorizedIdeas
      ? ['a']
      : [answerKey];
    if (
      Object.keys(record).sort().join(',')
      !== [...expectedKeys].sort().join(',')
    ) {
      return null;
    }
    const answer = record[
      input.shortComparison || input.shortAuthorizedIdeas ? 'a' : answerKey
    ];
    const maxChars = input.shortComparison
      ? MODEL_AUTHORED_SHORT_COMPARISON_MAX_CHARS
      : input.shortAuthorizedIdeas
        ? MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_MAX_CHARS
        : MODEL_AUTHORED_CONTENT_MAX_CHARS;
    const genericCompleteness = typeof answer === 'string'
      ? assessChatResearchAnswerCompleteness(answer)
      : null;
    const authorizedIdeasAnswer = typeof answer === 'string' && input.shortAuthorizedIdeas
      ? parseModelAuthoredAuthorizedIdeasAnswer(
        answer,
        input.locale,
        input.shortAuthorizedIdeas,
      )
      : null;
    const answerComplete = typeof answer === 'string'
      && (
        genericCompleteness?.ok === true
        || (
          input.shortAuthorizedIdeas !== null
          && authorizedIdeasAnswer !== null
          && genericCompleteness?.reason === 'mid_sentence_cutoff'
        )
      );
    if (
      typeof answer !== 'string'
      || answer.trim().length < ROUTINE_CONTENT_ANSWER_MIN_CHARS
      || answer.length > maxChars
      || !modelAuthoredContentLanguageDoesNotContradict(answer, input.locale)
      || !answerComplete
      || (
        input.shortComparison
        && !modelAuthoredComparisonSemanticsMatch(answer, input.shortComparison)
      )
      || (
        input.shortAuthorizedIdeas
        && authorizedIdeasAnswer === null
      )
    ) {
      return null;
    }
    return answer;
  } catch {
    return null;
  }
}

function describeModelAuthoredContentValidation(input: {
  text: string;
  locale: RoutineContentNoticeLocale;
  shortComparison: ModelAuthoredContentComparison | null;
  shortAuthorizedIdeas: ModelAuthoredContentAuthorizedIdeas | null;
}): Record<string, boolean | number> {
  const diagnostics: Record<string, boolean | number> = {
    structuredJsonComplete: false,
    structuredExactKeys: false,
    structuredAnswerTypeValid: false,
    structuredAnswerLanguageValid: false,
    structuredAnswerComplete: false,
    structuredCertificateFieldsTyped:
      input.shortComparison === null && input.shortAuthorizedIdeas === null,
    structuredComparisonSemanticsValid: input.shortComparison === null,
    structuredAuthorizedIdeasSemanticsValid: input.shortAuthorizedIdeas === null,
  };
  try {
    const parsed = JSON.parse(input.text) as unknown;
    diagnostics.structuredJsonComplete = true;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return diagnostics;
    const answerKey = routineContentAnswerKey(input.locale);
    const record = parsed as Record<string, unknown>;
    const expectedKeys = input.shortComparison || input.shortAuthorizedIdeas
      ? ['a']
      : [answerKey];
    diagnostics.structuredExactKeys = Object.keys(record).sort().join(',')
      === [...expectedKeys].sort().join(',');
    const answer = record[
      input.shortComparison || input.shortAuthorizedIdeas ? 'a' : answerKey
    ];
    diagnostics.structuredAnswerTypeValid = typeof answer === 'string';
    diagnostics.structuredCertificateFieldsTyped = true;
    if (typeof answer === 'string') {
      const genericCompleteness = assessChatResearchAnswerCompleteness(answer);
      const authorizedIdeasAnswer = input.shortAuthorizedIdeas
        ? parseModelAuthoredAuthorizedIdeasAnswer(
          answer,
          input.locale,
          input.shortAuthorizedIdeas,
        )
        : null;
      diagnostics.structuredAnswerChars = answer.length;
      diagnostics.structuredAnswerCommaCount = answer.match(/,/gu)?.length ?? 0;
      diagnostics.structuredAnswerHasColon = answer.includes(':');
      diagnostics.structuredAnswerMidSentenceCutoff =
        !genericCompleteness.ok
        && genericCompleteness.reason === 'mid_sentence_cutoff';
      diagnostics.structuredAuthorizedIdeasListShapeValid =
        input.shortAuthorizedIdeas !== null
        && authorizedIdeasAnswer !== null;
      diagnostics.structuredAnswerLanguageValid =
        modelAuthoredContentLanguageDoesNotContradict(answer, input.locale);
      diagnostics.structuredAnswerComplete =
        genericCompleteness.ok
        || (
          input.shortAuthorizedIdeas !== null
          && authorizedIdeasAnswer !== null
          && genericCompleteness.reason === 'mid_sentence_cutoff'
        );
      diagnostics.structuredComparisonSemanticsValid = input.shortComparison
        ? modelAuthoredComparisonSemanticsMatch(answer, input.shortComparison)
        : true;
      diagnostics.structuredAuthorizedIdeasSemanticsValid =
        input.shortAuthorizedIdeas ? authorizedIdeasAnswer !== null : true;
    }
  } catch {
    // Aggregate diagnostics only. Raw provider output is never logged.
  }
  return diagnostics;
}

export function stripThinkBlocks(text: string | undefined | null): string {
  if (!text) return '';
  const src = String(text);
  let out = '';
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const open = rest.match(THINK_OPEN_RE);
    if (open) {
      depth++;
      i += open[0].length;
      continue;
    }
    const close = rest.match(THINK_CLOSE_RE);
    if (close) {
      if (depth > 0) depth--;
      // else: orphan close — consume without emitting
      i += close[0].length;
      continue;
    }
    if (depth === 0) out += src[i];
    // else: inside a think block — swallow
    i++;
  }
  // If depth > 0 at end-of-string, an unclosed <think> swallowed the
  // remainder (fail-closed). Output is whatever made it through above
  // the open tag — i.e., nothing past the unclosed open.
  return out.trim();
}

// ─── Derived metrics from Ollama response ──────────────────────────

interface DerivedMetrics {
  totalDurationNs?: number;
  loadDurationNs?: number;
  promptEvalCount?: number;
  promptEvalDurationNs?: number;
  evalCount?: number;
  evalDurationNs?: number;
  promptTokensPerSec?: number;
  generationTokensPerSec?: number;
  totalTokensPerSec?: number;
  isColdLoad?: boolean;
  warmGenerationMs?: number;
  firstTokenMs?: number;
}

interface DeferredOllamaUsage {
  model: string;
  modelDigest?: string;
  durationMs: number;
  metrics: DerivedMetrics;
  userId: number;
  tenantId: number;
}

function deriveMetrics(resp: OllamaChatResponse): DerivedMetrics {
  const m: DerivedMetrics = {
    totalDurationNs: resp.total_duration,
    loadDurationNs: resp.load_duration,
    promptEvalCount: resp.prompt_eval_count,
    promptEvalDurationNs: resp.prompt_eval_duration,
    evalCount: resp.eval_count,
    evalDurationNs: resp.eval_duration,
  };

  if (resp.prompt_eval_count && resp.prompt_eval_duration && resp.prompt_eval_duration > 0) {
    m.promptTokensPerSec = Math.round(resp.prompt_eval_count / (resp.prompt_eval_duration / 1e9));
  }
  if (resp.eval_count && resp.eval_duration && resp.eval_duration > 0) {
    m.generationTokensPerSec = Math.round(resp.eval_count / (resp.eval_duration / 1e9));
  }
  if (resp.eval_count && resp.total_duration && resp.total_duration > 0) {
    m.totalTokensPerSec = Math.round(resp.eval_count / (resp.total_duration / 1e9));
  }
  if (resp.load_duration !== undefined) {
    m.isColdLoad = resp.load_duration > 1e9; // > 1s
  }
  if (resp.eval_duration !== undefined) {
    m.warmGenerationMs = Math.round(resp.eval_duration / 1e6);
  }
  if (resp.total_duration !== undefined && resp.eval_duration !== undefined) {
    // Ollama's non-streaming response does not expose an on-chunk timestamp.
    // total_duration - eval_duration is its native prefill/load approximation
    // and is the closest server-side time-to-first-token signal available.
    m.firstTokenMs = Math.max(0, Math.round((resp.total_duration - resp.eval_duration) / 1e6));
  }
  return m;
}

// ─── Model digest cache (proves what actually ran) ─────────────────

interface ModelDigestEntry { digest: string; ts: number }
const modelDigestCache = new Map<string, ModelDigestEntry>();
const DIGEST_CACHE_MS = 5 * 60 * 1000;

async function getModelDigest(
  baseUrl: string,
  model: string,
  options: { allowCache?: boolean } = {},
): Promise<string | undefined> {
  const allowCache = options.allowCache !== false;
  const cached = modelDigestCache.get(model);
  if (allowCache && cached && (Date.now() - cached.ts) < DIGEST_CACHE_MS) return cached.digest;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  timeout.unref?.();
  try {
    const resp = await ollamaTransportFetch({
      baseUrl,
      socketPath: localPrimaryInferenceConfig.gatewaySocketPath,
    }, '/api/tags', { method: 'GET', signal: controller.signal });
    if (!resp.ok) return allowCache ? cached?.digest : undefined;
    const json = await resp.json() as {
      models?: Array<{ name?: unknown; model?: unknown; digest?: unknown }>;
    };
    const matches = Array.isArray(json.models)
      ? json.models.filter((entry) => entry?.name === model || entry?.model === model)
      : [];
    const freshDigest = matches.length === 1
      ? normalizeOllamaModelDigest(matches[0]?.digest)
      : null;
    if (!freshDigest) {
      // A successful authoritative inventory response supersedes any prior
      // cache entry. Missing, duplicate, or malformed target identity must not
      // make allowCache=false silently reuse an older signed digest.
      modelDigestCache.delete(model);
      return undefined;
    }
    modelDigestCache.set(model, { digest: freshDigest, ts: Date.now() });
    return freshDigest;
  } catch (error) {
    if (!allowCache && error instanceof OllamaTransportError) {
      throw new LocalLLMError('transport_unavailable', {
        reason: 'governed_gateway_socket_unavailable',
        code: error.systemCode,
        model,
      });
    }
    return allowCache ? cached?.digest : undefined;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Bounded in-process queue (single-flight; per-task depths) ─────

interface QueueState {
  classifyDepth: number;
  scriptGenDepth: number;
  localReasoningDepth: number;
  chatDepth: number;
  totalDepth: number;
  chain: Promise<unknown>;
}

type TaskQueueDepthKey =
  | 'classifyDepth'
  | 'scriptGenDepth'
  | 'localReasoningDepth'
  | 'chatDepth';

const queueState: QueueState = {
  classifyDepth: 0,
  scriptGenDepth: 0,
  localReasoningDepth: 0,
  chatDepth: 0,
  totalDepth: 0,
  chain: Promise.resolve(),
};

function depthFor(taskType: OllamaTaskType): { depth: number; cap: number; key: TaskQueueDepthKey } {
  const cfg = config.ollama.queue;
  switch (taskType) {
    case 'classify':         return { depth: queueState.classifyDepth, cap: cfg.classifyDepth, key: 'classifyDepth' };
    case 'scriptGeneration': return { depth: queueState.scriptGenDepth, cap: cfg.scriptGenDepth, key: 'scriptGenDepth' };
    case 'localReasoning':   return { depth: queueState.localReasoningDepth, cap: cfg.localReasoningDepth, key: 'localReasoningDepth' };
    case 'chat':             return { depth: queueState.chatDepth, cap: cfg.classifyDepth, key: 'chatDepth' };
    default:                 return { depth: queueState.chatDepth, cap: cfg.classifyDepth, key: 'chatDepth' };
  }
}

function maxWaitMs(taskType: OllamaTaskType): number {
  const cfg = config.ollama.queue;
  switch (taskType) {
    case 'classify':         return cfg.classifyMaxWaitMs;
    case 'scriptGeneration': return cfg.scriptGenMaxWaitMs;
    case 'localReasoning':   return cfg.localReasoningMaxWaitMs;
    default:                 return cfg.classifyMaxWaitMs;
  }
}

async function withQueueSlot<T>(taskType: OllamaTaskType, fn: () => Promise<T>): Promise<T> {
  const { depth, cap, key } = depthFor(taskType);
  const globalCap = config.ollama.queue.globalMaxDepth;

  if (depth >= cap || queueState.totalDepth >= globalCap) {
    throw new LocalLLMError('capacity_exceeded', {
      taskType,
      queueDepth: queueState.totalDepth,
      reason: depth >= cap ? 'task_queue_full' : 'global_queue_full',
    });
  }

  // Avoid postfix updates on a type assertion: Stryker's UpdateOperator
  // mutant can otherwise emit invalid TypeScript (`(value as number)--`).
  // Explicit arithmetic remains mutation-testable without parser failures.
  queueState[key] = (queueState[key] as number) + 1;
  queueState.totalDepth = queueState.totalDepth + 1;

  const wait = maxWaitMs(taskType);
  const enqueuedAt = Date.now();

  // Chain serializes execution (single-flight).
  const chainBefore = queueState.chain;
  let release!: () => void;
  const slot = new Promise<void>((res) => { release = res; });
  queueState.chain = chainBefore.then(() => slot);

  try {
    // Wait for previous work to drain, but bound by max wait.
    let waitTimer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      waitTimer = setTimeout(() => reject(new LocalLLMError('capacity_exceeded', {
        taskType,
        queueDepth: queueState.totalDepth,
        reason: 'wait_timeout',
      })), Math.max(0, wait));
    });
    try {
      await Promise.race([chainBefore, timedOut]);
    } finally {
      if (waitTimer) clearTimeout(waitTimer);
    }

    const startedAt = Date.now();
    const queueWaitMs = startedAt - enqueuedAt;
    if (queueWaitMs > 0) {
      logger.debug({ taskType, queueWaitMs, queueDepth: queueState.totalDepth }, 'OllamaProvider: queue wait');
    }
    return await fn();
  } finally {
    queueState[key] = (queueState[key] as number) - 1;
    queueState.totalDepth = queueState.totalDepth - 1;
    release();
  }
}

// ─── HTTP chat call with AbortController-driven timeout ────────────

/**
 * Send an Ollama /api/chat request bounded by:
 *   - `timeoutMs`: internal per-call cap (always enforced).
 *   - `externalSignal` (O3-A18): a caller-side AbortSignal used by
 *     shadow-classify timeouts so cancellation actually aborts the
 *     underlying fetch (not just resolves the promise race). Without
 *     this, shadow timeouts would orphan in-flight generations on the
 *     Ollama daemon, holding CPU + KV cache indefinitely.
 *
 * The two signals are composed: whichever fires first aborts the fetch.
 */
async function ollamaChat(
  req: OllamaChatRequest,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<OllamaChatResponse> {
  const ctrl = new AbortController();
  const tHandle = setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs));
  // O3-A18: chain the caller's external signal so caller-side cancellation
  // actually terminates the HTTP request. If the caller signal fires
  // (e.g., shadow timeout), abort the local controller — fetch will reject
  // with AbortError and the daemon receives the disconnect.
  let externalAbortListener: (() => void) | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) {
      ctrl.abort(externalSignal.reason);
    } else {
      externalAbortListener = () => ctrl.abort(externalSignal.reason);
      externalSignal.addEventListener('abort', externalAbortListener, { once: true });
    }
  }
  try {
    // A caller can cancel while this request is waiting in the application
    // scheduler or resolving the signed model digest. Native fetch rejects a
    // pre-aborted signal, but transports and test doubles are not required to
    // install that behavior themselves. Preserve the caller's exact reason
    // before dispatch so cancellation cannot become an orphaned request.
    if (externalSignal?.aborted) {
      throw externalSignal.reason ?? Object.assign(new Error('ollama_request_cancelled'), {
        name: 'AbortError',
        code: 'CHAT_REQUEST_CANCELLED',
      });
    }
    const resp = await ollamaTransportFetch({
      baseUrl: config.ollama.baseUrl,
      socketPath: localPrimaryInferenceConfig.gatewaySocketPath,
    }, '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      // 404 from Ollama means model not loaded / not in library. Gateway 503
      // responses are typed by their safe error body; residency/upstream
      // failures must never masquerade as queue pressure.
      const text = await resp.text().catch(() => '');
      if (resp.status === 404 || /model.*not.*found/i.test(text)) {
        throw new LocalLLMError('model_missing', { model: req.model, status: resp.status, body: text.slice(0, 400) });
      }
      if (resp.status === 503) {
        let gatewayError = '';
        try {
          const parsed = JSON.parse(text) as { error?: unknown };
          gatewayError = typeof parsed.error === 'string' ? parsed.error : '';
        } catch { /* safe plain-text classification below */ }
        if (gatewayError === 'active_model_not_resident') {
          throw new LocalLLMError('provider_unhealthy', {
            reason: 'active_model_not_resident',
            status: 503,
          });
        }
        if (gatewayError === 'ollama_upstream_unavailable') {
          throw new LocalLLMError('provider_unhealthy', {
            reason: 'ollama_upstream_unavailable',
            status: 503,
          });
        }
        if (gatewayError === 'daemon_queue_full' || /(?:queue|capacity).*(?:full|exceeded)|overloaded/iu.test(text)) {
          throw new LocalLLMError('capacity_exceeded', { reason: 'daemon_queue_full', status: 503 });
        }
        throw new LocalLLMError('provider_unhealthy', {
          reason: 'gateway_service_unavailable',
          status: 503,
          body: text.slice(0, 400),
        });
      }
      throw new LocalLLMError('provider_unhealthy', { status: resp.status, body: text.slice(0, 400) });
    }
    return await resp.json() as OllamaChatResponse;
  } catch (err) {
    if (externalSignal?.aborted) {
      if (isProviderRequestCancellation(externalSignal.reason)) throw externalSignal.reason;
      throw Object.assign(new Error('ollama_request_cancelled'), {
        name: 'AbortError',
        code: 'CHAT_REQUEST_CANCELLED',
      });
    }
    if (err instanceof LocalLLMError) throw err;
    if (err instanceof OllamaTransportError) {
      throw new LocalLLMError('transport_unavailable', {
        reason: 'governed_gateway_socket_unavailable',
        code: err.systemCode,
        model: req.model,
      });
    }
    const code = (err as { name?: string; code?: string }).name;
    if (code === 'AbortError') {
      throw new LocalLLMError('timeout', { timeoutMs, model: req.model });
    }
    const sysCode = (err as { code?: string }).code;
    if (sysCode === 'ECONNREFUSED' || sysCode === 'ENOTFOUND' || sysCode === 'ECONNRESET') {
      throw new LocalLLMError('provider_unhealthy', { code: sysCode, model: req.model });
    }
    throw new LocalLLMError('provider_unhealthy', { error: String(err) });
  } finally {
    clearTimeout(tHandle);
    if (externalSignal && externalAbortListener) {
      externalSignal.removeEventListener('abort', externalAbortListener);
    }
  }
}

// ─── api_usage write (cost_usd=0, local_request_units=1) ───────────

async function logOllamaUsage(
  category: string,
  model: string,
  modelDigest: string | undefined,
  durationMs: number,
  metrics: DerivedMetrics,
  userId: number,
  tenantId: number,
): Promise<void> {
  try {
    const db = getDb();
    const attribution = resolveApiUsageAttribution(category, userId);
    db.prepare(`
      INSERT INTO api_usage (
        category, model, tenant_id, user_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, duration_ms, provider, pricing_status, pricing_model_key,
        local_request_units, request_source, job_name, base_category, run_id
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'ollama', 'zero-cost', ?, 1, ?, ?, ?, ?)
    `).run(
      category,
      model,
      tenantId,
      userId,
      metrics.promptEvalCount ?? 0,
      metrics.evalCount ?? 0,
      durationMs,
      modelDigest ?? model,
      attribution.requestSource,
      attribution.jobName,
      attribution.baseCategory,
      attribution.runId,
    );
  } catch (err) {
    // Fall back to the shared inserter. It tolerates schema drift if the
    // local_request_units column is missing on an older DB.
    try {
      const db = getDb();
      insertApiUsageFallback(db, {
        category, model, provider: 'ollama',
        tenantId, userId,
        inputTokens: metrics.promptEvalCount ?? 0,
        outputTokens: metrics.evalCount ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs,
        pricingStatus: 'zero-cost',
        // v2.6 (angry-QA-found): must match the primary INSERT's
        // local_request_units=1 so the rate-limiter doesn't undercount
        // when the primary path's catch handler fires.
        localRequestUnits: 1,
      });
    } catch (fallbackErr) {
      const persistenceError = tripApiUsagePersistenceFailure('ollama', category);
      logger.error({ err: fallbackErr, code: persistenceError.code }, 'Failed to log Ollama usage; AI usage persistence degraded');
      throw persistenceError;
    }
  }

  // Telemetry is best-effort and intentionally outside the INSERT fallback
  // boundary so a post-insert event failure cannot duplicate the usage row.
  try {
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Ollama ${model}: ${metrics.promptEvalCount ?? 0}+${metrics.evalCount ?? 0} tokens (local, $0)`,
      durationMs,
    });
  } catch (eventErr) {
    logger.warn({ err: eventErr, userId, category }, 'Failed to publish Ollama usage telemetry');
  }
}

// ─── Per-task token-cap enforcement ─────────────────────────────────

function enforceInputTokenCap(
  taskType: OllamaTaskType,
  parts: ReadonlyArray<string | null | undefined>,
  capOverride?: number,
): void {
  const caps = config.ollama.tokenCaps;
  let cap: number | undefined;
  switch (taskType) {
    case 'classify':         cap = caps.classifyMaxInput; break;
    case 'scriptGeneration': cap = caps.scriptGenMaxInput; break;
    case 'localReasoning':   cap = caps.localReasoningMaxInput; break;
    case 'chat':             cap = caps.localReasoningMaxInput; break; // chat reuses the larger cap
    default:                 cap = caps.classifyMaxInput; break;
  }
  cap = capOverride ?? cap;
  if (cap === undefined) return;
  const estimated = estimateTokensTotal(parts);
  if (estimated > cap) {
    throw new LocalLLMError('input_token_overflow', {
      taskType,
      estimatedInputTokens: estimated,
      cap,
      capReason: 'per_task_input_cap',
    });
  }
}

function outputCapFor(taskType: OllamaTaskType): number {
  const caps = config.ollama.tokenCaps;
  switch (taskType) {
    case 'classify':         return caps.classifyMaxOutput;
    case 'scriptGeneration': return caps.scriptGenMaxOutput;
    case 'localReasoning':   return caps.localReasoningMaxOutput;
    default:                 return caps.localReasoningMaxOutput;
  }
}

// ─── Rate-limit guard (call-count, not $) ──────────────────────────

function rateLimitScope(taskType: OllamaTaskType): LocalLLMRateLimitScope {
  return taskType === 'scriptGeneration' ? 'script' : 'general';
}

// ─── Classification JSON schema ────────────────────────────────────

const VALID_DOMAINS = ['secretary', 'triathlon', 'content', 'finance', 'cooking'] as const;
type ValidDomain = typeof VALID_DOMAINS[number];

const CLASSIFICATION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    domain: { type: 'string', enum: VALID_DOMAINS as unknown as string[] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
  required: ['domain', 'confidence'],
} as const;

function getManifestValidClassificationDomains(): string[] {
  return [...new Set([
    ...getNlReachableCapabilities().map((entry) => entry.runtimeRouting.domain),
    'clarify',
    'none',
  ])];
}

function buildManifestClassificationJsonSchema(validDomains: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      domain: { type: 'string', enum: [...validDomains] },
      skill: { type: 'string' },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
    required: ['domain', 'confidence'],
  } as const;
}

/**
 * v1.1 hardening suffix appended to the upstream getClassifierSystemPrompt()
 * output. The live smoke (2026-05-26) showed Qwen3.6 ignores Ollama's
 * `format` enum constraint and invents free-form domain names. Listing
 * the 5 valid values inline AND in plain English (not just in the
 * schema) cuts that failure mode dramatically.
 */
const CLASSIFY_HARDENING_SUFFIX = [
  'CRITICAL OUTPUT CONTRACT — NON-NEGOTIABLE:',
  '',
  'The "domain" field MUST be EXACTLY one of these 5 strings, character-for-character:',
  '  - "secretary"   — calendar, tasks, email, reminders, notifications',
  '  - "triathlon"   — running, cycling, swimming, gym, recovery, readiness, workouts',
  '  - "content"     — youtube, linkedin, instagram, tiktok, scripts, posts, captions',
  '  - "finance"     — invoices, expenses, budget, subscriptions, fiscal',
  '  - "cooking"     — meals, recipes, grocery, food prep, nutrition fueling',
  '',
  'DO NOT invent any other domain string (e.g., NOT "sports_fitness", NOT "social_media",',
  'NOT "fitness_tracking", NOT "Health & Fitness", NOT capitalized or hyphenated variants).',
  'If a request fits none of the 5 above, return "secretary" with a low confidence (< 0.5).',
  '',
  'The "confidence" field is REQUIRED and must be a number between 0 and 1.',
  '',
  'Return ONLY the JSON object. No prose, no markdown, no backticks.',
].join('\n');

function buildManifestClassifyHardeningSuffix(validDomains: readonly string[]): string {
  return [
    'CRITICAL OUTPUT CONTRACT — NON-NEGOTIABLE:',
    '',
    `The "domain" field MUST be EXACTLY one of: ${validDomains.join(', ')}.`,
    'Use "clarify" only for ambiguity between supported actions.',
    'Use "none" only when no supported Nexus capability applies.',
    'Omit "skill" for "clarify" and "none".',
    'The "confidence" field is REQUIRED and must be a number between 0 and 1.',
    '',
    'Return ONLY the JSON object. No prose, no markdown, no backticks.',
  ].join('\n');
}

function isValidClassificationPayload(
  o: unknown,
  validDomains: readonly string[] = VALID_DOMAINS,
): o is ClassificationResult {
  if (!o || typeof o !== 'object') return false;
  const obj = o as Record<string, unknown>;
  if (typeof obj.confidence !== 'number') return false;
  if (typeof obj.domain !== 'string') return false;
  return validDomains.includes(obj.domain);
}

/**
 * v1.1 defensive normalizer. When the model returns a drifted domain
 * name (e.g., "sports_fitness", "social_media"), try to map it to the
 * closest valid Nexus Hub domain via keyword matching. Confidence is
 * clamped to 0.5 to signal "best-effort normalization, treat with care".
 *
 * Returns null when no plausible mapping exists OR when the parsed
 * payload doesn't carry a string `domain` field at all.
 */
const DOMAIN_KEYWORD_MAP: Array<[RegExp, ValidDomain]> = [
  // triathlon: any fitness / training / sport / endurance keyword
  [/\b(triathlon|run|running|bike|cycling|swim|gym|workout|training|fitness|sport|cardio|athletic|endurance|hr_zone|readiness|recovery)\b/i, 'triathlon'],
  // content: any social / publishing / writing keyword
  [/\b(content|social|youtube|linkedin|instagram|tiktok|reel|script|caption|hook|video|post|blog|article|writing|publish)\b/i, 'content'],
  // finance: money / bill / invoice / subscription
  [/\b(finance|fiscal|invoice|expense|budget|subscription|payment|bill|tax|cost|spend|revenue|profit|money|euro|dollar|usd|eur)\b/i, 'finance'],
  // cooking: food / meal / recipe / grocery
  [/\b(cook|cooking|meal|recipe|grocery|food|prep|nutrition|fuel|protein|carb|breakfast|lunch|dinner|snack|diet)\b/i, 'cooking'],
  // secretary: catch-all / calendar / task / reminder / email
  [/\b(secretary|calendar|task|reminder|email|meeting|schedule|todo|inbox|notification|brief)\b/i, 'secretary'],
];

export function normalizeClassificationPayload(parsed: unknown): ClassificationResult | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  const rawDomain = typeof obj.domain === 'string' ? obj.domain.toLowerCase().replace(/[_-\s]+/g, '_') : '';
  if (!rawDomain) return null;
  for (const [pattern, target] of DOMAIN_KEYWORD_MAP) {
    if (pattern.test(rawDomain)) {
      const rawConf = typeof obj.confidence === 'number' ? obj.confidence : 0.5;
      // Clamp normalized confidence to ≤ 0.5 so downstream callers can
      // see this was a fuzzy match and decide whether to fall through.
      return { domain: target, confidence: Math.min(0.5, Math.max(0, rawConf)) };
    }
  }
  return null;
}

// ─── OllamaProvider implementation ─────────────────────────────────

export class OllamaProvider implements AIProvider {
  readonly name = 'ollama';

  constructor() {
    // Plan A5 + A6: PM2 cluster-mode guard. With the memory queue backend,
    // multi-instance deployments would each think they have concurrency=1
    // and starve / overlap calls. Fail fast at startup with a clear message.
    const instance = process.env.NODE_APP_INSTANCE;
    const backend = config.ollama.queue.backend;
    if (backend !== 'memory') {
      throw new Error(
        `OllamaProvider: LOCAL_LLM_QUEUE_BACKEND=${backend} is not implemented in v1. ` +
        `Only 'memory' is supported. PM2 must be single-instance.`,
      );
    }
    if (instance && instance !== '0') {
      throw new Error(
        `OllamaProvider: LOCAL_LLM_QUEUE_BACKEND=memory is single-instance only. ` +
        `Detected NODE_APP_INSTANCE=${instance}. Set instances=1 in ecosystem.config.js ` +
        `or implement a shared queue backend (deferred to v2).`,
      );
    }
    logger.info(
      {
        baseUrl: config.ollama.baseUrl,
        model: config.ollama.model,
        timeoutMs: config.ollama.timeoutMs,
        queueClassify: config.ollama.queue.classifyDepth,
        queueScriptGen: config.ollama.queue.scriptGenDepth,
        queueLocalReasoning: config.ollama.queue.localReasoningDepth,
      },
      'OllamaProvider initialized',
    );
  }

  // ── AIProvider: classify ──────────────────────────────────────────
  //
  // v1.1 hardening: the live smoke (2026-05-26) showed Qwen3.6 ignores
  // Ollama's `format` enum constraint 4/5 times. Three mitigations layered:
  //   1. Emphatic system prompt that lists the 5 valid domains inline so
  //      the model sees them in plain English (not just in the schema).
  //   2. Retry-once on schema mismatch with the prior bad output echoed
  //      back to the model as feedback (similar pattern to script-gen).
  //   3. Defensive domain normalizer that maps common drifted values
  //      (sports_fitness → triathlon, social_media → content, etc.) to
  //      valid Nexus Hub domains. Runs AFTER retry — only if the model
  //      keeps producing close-but-wrong domain names.

  async classify(
    message: string,
    activeContext?: { domain: DomainName; lastAssistantMessage: string },
    options?: ClassifyOptions,
  ): Promise<ClassificationResult> {
    void activeContext;

    const manifestPromptEnabled = isManifestClassifierPromptEnabled();
    const classificationDomains = manifestPromptEnabled
      ? getManifestValidClassificationDomains()
      : VALID_DOMAINS;

    // O3-A14: prefer the compact (<400-token) classifier prompt when set.
    // Falls back to the long Gemini prompt+hardening suffix when the
    // compact prompt is not provided (back-compat for tests / non-classifier
    // model use). The compact prompt is the path that lets a small
    // dedicated classifier model run sub-3s on this CPU.
    // Compact prompts encode only the five legacy domains. Never use them
    // while the manifest prompt is active because their output contract
    // contradicts the declared `clarify` / `none` outcomes.
    const compact = manifestPromptEnabled ? null : getOllamaClassifierSystemPromptCompact();
    const sys = compact
      ? compact
      : `${getClassifierSystemPrompt()}\n\n${manifestPromptEnabled
        ? buildManifestClassifyHardeningSuffix(classificationDomains)
        : CLASSIFY_HARDENING_SUFFIX}`;
    enforceInputTokenCap('classify', [sys, message]);

    // O3-A14: classifier-specific request body knobs. Defaults sized for
    // The compact classifier contract fits in num_ctx=2048 and normally emits
    // fewer than 32 tokens. Both remain env-overridable for measured tuning of
    // the signed active model.
    const classifierNumCtx = Math.min(4096, readPositiveInt('OLLAMA_CLASSIFIER_NUM_CTX', 2048));
    const classifierNumPredict = readPositiveInt('OLLAMA_CLASSIFIER_NUM_PREDICT', 32);

    const baseRequest = {
      model: config.ollama.classifierModel,
      think: false,
      format: manifestPromptEnabled
        ? buildManifestClassificationJsonSchema(classificationDomains)
        : CLASSIFICATION_JSON_SCHEMA,
      stream: false as const,
      keep_alive: -1,
      options: {
        num_ctx: classifierNumCtx,
        num_predict: classifierNumPredict,
        temperature: 0,
      },
    };

    // Shadow calls are explicitly metered by classify-shadow.ts under their
    // own reservation. Keep `recordUsage:false` only as an operator/offline
    // escape hatch; the source label alone must never make a model call
    // invisible to canonical usage accounting.
    const recordUsage = options?.recordUsage !== false;

    let lastBadText = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages: OllamaChatRequest['messages'] = attempt === 0
        ? [
            { role: 'system', content: sys },
            { role: 'user', content: message },
          ]
        : [
            { role: 'system', content: sys },
            { role: 'user', content: message },
            { role: 'assistant', content: lastBadText.slice(0, 400) },
            { role: 'user', content: manifestPromptEnabled
              ? `Your previous reply did not match the schema. The "domain" value MUST be EXACTLY one of: ` +
                `${classificationDomains.join(', ')}. The "confidence" field is REQUIRED. ` +
                `Return ONLY JSON of shape: {"domain":"<allowed value>","confidence":<0..1>}.`
              : `Your previous reply did not match the schema. The "domain" value MUST be EXACTLY one of: ` +
                `${VALID_DOMAINS.join(', ')}. The "confidence" field is REQUIRED. ` +
                `Return ONLY JSON of shape: {"domain":"<one of the 5>","confidence":<0..1>}.`,
            },
          ];

      const result = await this.callOllamaForTask({
        taskType: 'classify',
        workloadRole: options?.source === 'shadow'
          ? 'classifier_shadow'
          : options?.source === 'evaluation'
            ? 'offline_evaluation'
            : undefined,
        category: options?.source === 'shadow'
          ? CLASSIFIER_SHADOW_JOB_NAME
          : options?.source === 'evaluation'
            ? 'classify_evaluation'
            : 'classify_message',
        request: { ...baseRequest, messages },
        userId: options?.userId,
        tenantId: options?.tenantId,
        recordUsage,
        externalSignal: options?.abortSignal,
        timeoutMsOverride: options?.timeoutMs,
      });

      const text = stripThinkBlocks(result.response.message?.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        lastBadText = text;
        if (attempt === 0) continue;
        throw new LocalLLMError('invalid_json', { taskType: 'classify', body: text.slice(0, 400) });
      }
      if (isValidClassificationPayload(parsed, classificationDomains)) {
        const disposition = resolveManifestClassifierDisposition(parsed.domain);
        if (disposition) return { domain: disposition, confidence: parsed.confidence };
        return parsed;
      }

      // Schema mismatch — try the normalizer before giving up on this attempt.
      const normalized = normalizeClassificationPayload(parsed);
      if (normalized) return normalized;

      lastBadText = text;
      if (attempt === 0) continue;
      throw new LocalLLMError('invalid_json', { taskType: 'classify', body: text.slice(0, 400), reason: 'schema_mismatch_after_retry' });
    }
    // Unreachable, but TypeScript can't prove the loop always returns/throws.
    throw new LocalLLMError('invalid_json', { taskType: 'classify', reason: 'unreachable' });
  }

  // ── AIProvider: callDomain (non-tool only in v1) ─────────────────

  async callDomain(
    domain: DomainName,
    history: DomainMessage[],
    currentMessage: string,
    stateContext: string,
    optionsOrMaxTokens?: number | CallDomainOptions,
  ): Promise<AICallResult> {
    const options = normalizeCallDomainOptions(optionsOrMaxTokens);

    // Phase K Codex round-9 fix (F1): `filteredTools` is auto-populated
    // by TaskRoutingProvider.buildOptimizedOptions from
    // `getToolsForDomainCached(domain)` — it represents AVAILABLE tools
    // for the domain, NOT intent to use them this turn. Previously this
    // check threw `unsupported_capability` for every cooking/content/
    // finance request because those domains have non-empty tool lists,
    // which sent all traffic to OpenAI. Phase K v1 silently ignores
    // available tools: Ollama generates text-only and the existing
    // request payload never passes the tools array to /api/chat.
    //
    // Real tool-USE intent is caught upstream by the runtime hard-block
    // in provider-fallback.ts (`shouldBypassOllamaForToolOrWrite`),
    // which routes to cloud when:
    //   - domain ∈ {secretary, triathlon}
    //   - ownerSkill ∈ {secretary, training}
    //   - taskType === 'tool-use'
    //   - executeIntent === true
    //   - finance + ownerSkill not 'finance' (fail-closed)
    //
    // If a tool-use request somehow reaches here, the model returns
    // text without tool_calls; the downstream tool-loop sees zero
    // toolCalls and proceeds with the text response. Degraded but not
    // broken — and v2 OllamaProvider with tool calling is the proper
    // fix path.
    if (options.filteredTools && Array.isArray(options.filteredTools) && options.filteredTools.length > 0) {
      logger.debug(
        { domain, tool_count: options.filteredTools.length },
        'ollama-provider: ignoring auto-populated filteredTools (v1 has no tool calling; text-only response)',
      );
    }

    // Phase K (Operator A10 + amendment items 11–12): inject domain-
    // specific prompt guards. Answer-only creative domains (cooking,
    // content) get a directive telling the model to present output
    // directly without past-tense self-success claims. Finance gets a
    // STRICTER directive forbidding fabricated access to accounts /
    // balances / transactions / prices / tax rules. Other domains
    // (secretary, triathlon — which actually never reach here in v1
    // because of the runtime hard-block) get the bare system prompt.
    const routineContent = domain === 'content'
      && options.maxTokensOverride === undefined;
    const currentTurnOnly = options.currentTurnOnly === true;
    const routineContentLocale = routineContent
      ? resolveRoutineContentNoticeLanguage(currentMessage)
      : null;
    const shortContentComparison = routineContent && currentTurnOnly
      ? parseModelAuthoredContentComparison(currentMessage)
      : null;
    const shortAuthorizedContentIdeas = routineContent && !currentTurnOnly
      ? parseModelAuthoredContentAuthorizedIdeas(currentMessage, history, stateContext)
      : null;
    const shortContentMode: ModelAuthoredContentShortMode = shortContentComparison
      ? 'comparison'
      : shortAuthorizedContentIdeas
        ? 'authorizedIdeas'
        : null;
    const shortAuthorizedContentOutputPrefix = shortAuthorizedContentIdeas
      ? modelAuthoredAuthorizedIdeasPrefix(
        routineContentLocale ?? 'en-US',
        [...shortAuthorizedContentIdeas.groundingStems][0] ?? '',
      )
      : null;
    const routineContentResponseFormat = routineContent && routineContentLocale
      ? buildModelAuthoredContentResponseFormat(
        routineContentLocale,
        shortContentMode,
      )
      : null;
    const baseSys = shortContentComparison
      ? MODEL_AUTHORED_SHORT_COMPARISON_SYSTEM_PROMPT
      : shortAuthorizedContentIdeas
        ? MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_SYSTEM_PROMPT
      : getDomainSystemPrompt(
        domain,
        currentMessage,
        { currentTurnOnly },
      );
    const domainPromptSuffix = routineContent && routineContentLocale
      ? (
        shortContentComparison
          ? modelAuthoredContentLanguageInstruction(
            routineContentLocale,
            'comparison',
            shortContentComparison,
          )
          : shortAuthorizedContentIdeas
            ? modelAuthoredContentLanguageInstruction(
              routineContentLocale,
              'authorizedIdeas',
              null,
              shortAuthorizedContentOutputPrefix,
            )
          : modelAuthoredContentSystemSuffix(routineContentLocale)
      )
      : phaseKDomainSystemPromptSuffix(
        domain,
      );
    const sys = domainPromptSuffix
      ? `${baseSys}\n${domainPromptSuffix}`
      : baseSys;

    const messages: OllamaChatRequest['messages'] = [{ role: 'system', content: sys }];
    if (shortAuthorizedContentIdeas) {
      messages.push({
        role: 'user',
        content: currentMessage,
      });
    } else if (!currentTurnOnly) {
      for (const h of history) {
        messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) });
      }
      const contextPrefix = buildScopedStateContextPrefix(stateContext);
      messages.push({ role: 'user', content: `${contextPrefix}${currentMessage}` });
    } else {
      messages.push({ role: 'user', content: currentMessage });
    }

    // Account only for content that is actually sent. Current-turn-only
    // privacy removes both saved state and history before this boundary.
    enforceInputTokenCap('chat', messages.map((message) => message.content));

    const model = options.modelOverride ?? config.ollama.model;
    // Routine Content answers are latency-sensitive interactive chat, not
    // long-form generation. The shared local-reasoning cap is intentionally
    // large enough for offline workloads, so applying it here allowed a
    // simple Content turn to emit hundreds of tokens and miss the live-chat
    // 6s budget. Keep caller-requested long-form overrides intact, while
    // bounding the default path to a concise, coherent answer.
    const providerDefaultMaxOutput = outputCapFor('chat');
    const maxOutput = options.maxTokensOverride
      ?? (
        routineContent
          ? Math.min(
            providerDefaultMaxOutput,
            shortContentComparison
              ? MODEL_AUTHORED_SHORT_COMPARISON_MAX_OUTPUT_TOKENS
              : shortAuthorizedContentIdeas
                ? MODEL_AUTHORED_SHORT_AUTHORIZED_IDEAS_MAX_OUTPUT_TOKENS
                : MODEL_AUTHORED_CONTENT_MAX_OUTPUT_TOKENS,
          )
          : providerDefaultMaxOutput
      );

    // Phase K: build request options once so providerMetadata reflects
    // exactly what went over the wire. Future per-domain temperature
    // overrides (Phase 3) plug in here.
    const requestOptions = {
      num_ctx: shortContentMode ? 1024 : 4096,
      num_predict: maxOutput,
      temperature: routineContent ? 0 : 0.3,
    };
    const providerCallCategory = shortContentComparison
      ? 'chat_content_model_authored_short_attempt'
      : shortAuthorizedContentIdeas
        ? 'chat_content_model_authored_authorized_ideas_attempt'
        : `chat_${domain}`;

    const result = await this.callOllamaForTask({
      taskType: 'chat',
      workloadRole: 'validated_local_chat',
      category: providerCallCategory,
      userId: options.userId,
      tenantId: options.tenantId,
      deferUsage: shortContentMode !== null,
      request: {
        model,
        messages,
        think: false,
        ...(routineContentResponseFormat ? { format: routineContentResponseFormat } : {}),
        stream: false,
        keep_alive: -1,
        options: requestOptions,
      },
    });

    const text = stripThinkBlocks(result.response.message?.content);
    const providerStopReason = result.response.done === true
      ? (result.response.done_reason ?? 'stop')
      : 'length';
    const modelAuthoredContentAnswer = routineContent && routineContentLocale
      ? parseModelAuthoredContentResult({
        text,
        locale: routineContentLocale,
        shortComparison: shortContentComparison,
        shortAuthorizedIdeas: shortAuthorizedContentIdeas,
      })
      : null;
    const routineContentInvalid = routineContent
      && (
        ['length', 'LENGTH'].includes(providerStopReason)
        || modelAuthoredContentAnswer === null
      );
    if (result.deferredUsage) {
      const validatedCategory = shortContentComparison
        ? (
          routineContentInvalid
            ? 'chat_content_model_authored_short_rejected'
            : 'chat_content_model_authored_short'
        )
        : (
          routineContentInvalid
            ? 'chat_content_model_authored_authorized_ideas_rejected'
            : 'chat_content_model_authored_authorized_ideas'
        );
      await logOllamaUsage(
        validatedCategory,
        result.deferredUsage.model,
        result.deferredUsage.modelDigest,
        result.deferredUsage.durationMs,
        result.deferredUsage.metrics,
        result.deferredUsage.userId,
        result.deferredUsage.tenantId,
      );
    }
    const responseText = routineContent
      ? (routineContentInvalid ? '' : (modelAuthoredContentAnswer ?? ''))
      : text;
    const responseStopReason = routineContentInvalid
      ? 'length'
      : providerStopReason;
    if (routineContentInvalid) {
      logger.warn(
        {
          domain,
          originalStopReason: providerStopReason,
          outputBoundApplied: false,
          completePrefixKept: !routineContentInvalid && modelAuthoredContentAnswer !== null,
          boundedTextChars: responseText.length,
          ...describeModelAuthoredContentValidation({
            text,
            locale: routineContentLocale ?? 'en-US',
            shortComparison: shortContentComparison,
            shortAuthorizedIdeas: shortAuthorizedContentIdeas,
          }),
        },
        'ollama-provider: rejected invalid model-authored Content output',
      );
    }
    const md = deriveMetrics(result.response);
    return {
      text: responseText,
      toolCalls: [],
      stopReason: responseStopReason,
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: model,
        modelDigest: result.modelDigest,
        fallbackUsed: false,
        totalDurationNs: md.totalDurationNs,
        loadDurationNs: md.loadDurationNs,
        promptEvalCount: md.promptEvalCount,
        evalCount: md.evalCount,
        promptTokensPerSec: md.promptTokensPerSec,
        generationTokensPerSec: md.generationTokensPerSec,
        totalTokensPerSec: md.totalTokensPerSec,
        isColdLoad: md.isColdLoad,
        warmGenerationMs: md.warmGenerationMs,
        // Phase K observability — actual values from the request payload.
        domain,
        temperature: requestOptions.temperature,
        think: false,
        numCtx: requestOptions.num_ctx,
        numPredict: requestOptions.num_predict,
        ...(routineContent
          ? {
            outputBoundApplied: false,
            originalStopReason: providerStopReason,
            completePrefixKept: !routineContentInvalid && modelAuthoredContentAnswer !== null,
            responseConstruction: 'model_authored_structured_answer' as const,
            responseMode: shortContentComparison
              ? 'short_current_turn_comparison' as const
              : shortAuthorizedContentIdeas
                ? 'short_authorized_context_ideas' as const
                : 'routine_content' as const,
          }
          : {
            responseConstruction: 'model_authored_text' as const,
          }),
      },
    };
  }

  // ── AIProvider: continueWithToolResults (UNSUPPORTED in v1) ──────

  async continueWithToolResults(
    _domain: DomainName,
    _history: DomainMessage[],
    _currentMessage: string,
    _stateContext: string,
    _toolConversation: AIToolResultMessage[],
    _options?: CallDomainOptions,
  ): Promise<AICallResult> {
    throw new LocalLLMError('unsupported_capability', { capability: 'tool-use' });
  }

  // ── Optional: generateScript (delegates to script-generation.ts) ─

  async generateScript(task: ScriptGenTask): Promise<ScriptGenResult> {
    if (!config.localLLMEvaluation.enabled || !config.localLLMEvaluation.requireLocalForScriptGen) {
      throw new LocalLLMError('unsupported_capability', {
        taskType: 'scriptGeneration',
        capability: 'production_script_generation_requires_approved_cloud_reasoning',
      });
    }
    // Delayed require to avoid a circular import at module load.
    const { runScriptGenerationPipeline } = require('./script-generation') as
      typeof import('./script-generation');
    return runScriptGenerationPipeline(task, this);
  }

  // ── Optional: localReason (single-shot, think:true) ──────────────

  async localReason(task: LocalReasoningTask): Promise<LocalReasoningResult> {
    assertAllowedOllamaWorkloadRole(task.workloadRole, 'localReasoning');
    if (task.workloadRole === 'skill_inference'
        && process.env.NODE_ENV === 'production'
        && !localPrimaryInferenceConfig.gatewaySocketPath.trim()) {
      throw new LocalLLMError('provider_unhealthy', {
        reason: 'production_gateway_socket_required',
      });
    }
    const sys = task.systemContext ?? 'You are an expert reasoning assistant.';
    const governedSkillInference = task.workloadRole === 'skill_inference';
    let numCtx: number;
    let numPredict: number;
    if (governedSkillInference) {
      const modelContextCap = Math.min(
        getActiveLocalModel().maxContextTokens,
        localPrimaryInferenceConfig.maxContextTokens,
      );
      numCtx = Number.isFinite(task.numCtx) && (task.numCtx ?? 0) > 0
        ? Math.min(modelContextCap, Math.floor(task.numCtx!))
        : modelContextCap;
      const requestedNumPredict = Number.isFinite(task.numPredict) && (task.numPredict ?? 0) > 0
        ? Math.min(Math.floor(task.numPredict!), localPrimaryInferenceConfig.maxOutputTokens)
        : outputCapFor('localReasoning');
      const estimatedInputTokens = estimateTokensTotal([sys, task.prompt]);
      const generationHeadroom = 128;
      const availableOutputTokens = numCtx - estimatedInputTokens - generationHeadroom;
      if (availableOutputTokens < 1) {
        throw new LocalLLMError('input_token_overflow', {
          taskType: 'localReasoning',
          estimatedInputTokens,
          cap: Math.max(1, numCtx - generationHeadroom),
          capReason: 'context_must_reserve_generation_headroom',
        });
      }
      enforceInputTokenCap(
        'localReasoning',
        [sys, task.prompt],
        Math.max(1, numCtx - Math.min(requestedNumPredict, availableOutputTokens) - generationHeadroom),
      );
      numPredict = Math.min(requestedNumPredict, availableOutputTokens);
    } else {
      // Preserve the pre-local-primary contract byte-for-byte when the caller
      // uses the legacy validated-local-chat/research path. This keeps the new
      // context-reservation policy from changing existing queue/fallback and
      // budget behavior while all local-primary flags are OFF.
      enforceInputTokenCap('localReasoning', [sys, task.prompt]);
      numCtx = Number.isFinite(task.numCtx) && (task.numCtx ?? 0) > 0
        ? Math.min(4096, Math.floor(task.numCtx!))
        : 4096;
      numPredict = Number.isFinite(task.numPredict) && (task.numPredict ?? 0) > 0
        ? Math.floor(task.numPredict!)
        : outputCapFor('localReasoning');
    }

    const request: OllamaChatRequest = {
      model: task.workloadRole === 'skill_inference'
        ? getActiveLocalModel().ollamaTag
        : task.modelOverride?.trim() || config.ollama.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: task.prompt },
      ],
      think: task.think ?? true,
      stream: false,
      keep_alive: task.keepAliveSeconds ?? -1,
      options: {
        num_ctx: numCtx,
        num_predict: numPredict,
        temperature: Number.isFinite(task.temperature) ? task.temperature : 0.2,
        top_p: 0.9,
        top_k: 20,
      },
    };
    if (task.outputSchema !== undefined) request.format = task.outputSchema;

    const result = await this.callOllamaForTask({
      taskType: 'localReasoning',
      workloadRole: task.workloadRole,
      category: 'local_reasoning',
      userId: task.userId,
      tenantId: task.tenantId,
      request,
      externalSignal: task.abortSignal,
      timeoutMsOverride: task.timeoutMs,
    });

    const text = stripThinkBlocks(result.response.message?.content);
    let parsed: unknown;
    if (task.outputSchema !== undefined) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LocalLLMError('invalid_json', { taskType: 'localReasoning', body: text.slice(0, 400) });
      }
      if (governedSkillInference) {
        const validation = validateStructuredOutputValue(parsed, task.outputSchema);
        if (!validation.valid) {
          throw new LocalLLMError('invalid_json', {
            taskType: 'localReasoning',
            reason: validation.reason ?? 'schema_value_invalid',
          });
        }
      }
    }
    const md = deriveMetrics(result.response);
    return {
      text,
      parsed,
      stopReason: result.response.done_reason ?? 'stop',
      providerMetadata: {
        providerUsed: 'ollama',
        modelUsed: request.model,
        modelDigest: result.modelDigest,
        fallbackUsed: false,
        totalDurationNs: md.totalDurationNs,
        evalCount: md.evalCount,
        promptEvalCount: md.promptEvalCount,
        generationTokensPerSec: md.generationTokensPerSec,
        firstTokenMs: md.firstTokenMs,
        inputTokens: md.promptEvalCount,
        outputTokens: md.evalCount,
        isColdLoad: md.isColdLoad,
      },
    };
  }

  // ── Low-level shared primitive used by script-generation.ts ──────
  //
  // Exposed so script-generation can issue structured-output calls without
  // bypassing the queue + rate-limit + usage-logging guarantees.

  async chatPrimitive(args: {
    taskType: OllamaTaskType;
    workloadRole: OllamaWorkloadRole;
    category: string;
    request: OllamaChatRequest;
    userId?: number;
    tenantId?: number;
    /** Optional caller-side cancellation (chained into the fetch abort). */
    externalSignal?: AbortSignal;
    /** Optional per-call timeout override (defaults to config.ollama.timeoutMs). */
    timeoutMsOverride?: number;
  }): Promise<{ response: OllamaChatResponse; modelDigest?: string }> {
    return this.callOllamaForTask(args);
  }

  // ── Health (for /health/detailed) ────────────────────────────────

  async getProviderHealth(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();
    const transportKind = localPrimaryInferenceConfig.gatewaySocketPath
      ? 'unix_socket_gateway' as const
      : 'direct_loopback' as const;
    const manifestLoad = tryGetLocalModelManifest({ fresh: true });
    if (!manifestLoad.ok) {
      return {
        name: 'ollama',
        healthy: false,
        latencyMs: Date.now() - startedAt,
        modelsLoaded: [],
        queueDepth: queueState.totalDepth,
        degraded: true,
        warning: manifestLoad.code,
        lastError: manifestLoad.code,
        transport: transportKind,
      };
    }
    const manifest = manifestLoad.manifest;
    const activeModel = manifest.models.find((model) => model.id === manifest.activeModelId)!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    timeout.unref?.();
    try {
      const transport = {
        baseUrl: config.ollama.baseUrl,
        socketPath: localPrimaryInferenceConfig.gatewaySocketPath,
      };
      const verResp = await ollamaTransportFetch(transport, '/api/version', {
        method: 'GET',
        signal: controller.signal,
      });
      const versionOk = verResp.ok;
      const psResp = await ollamaTransportFetch(transport, '/api/ps', {
        method: 'GET',
        signal: controller.signal,
      });
      const psJson = psResp.ok ? (await psResp.json()) as { models?: Array<{ name: string }> } : { models: [] };
      const modelsLoaded = (psJson.models || []).map(m => m.name);
      const tagsResp = await ollamaTransportFetch(transport, '/api/tags', {
        method: 'GET',
        signal: controller.signal,
      });
      const tagsJson = tagsResp.ok
        ? (await tagsResp.json()) as { models?: Array<{ name: string; digest: string }> }
        : { models: [] };
      const activeDigest = normalizeOllamaModelDigest((tagsJson.models || [])
        .find((model) => model.name === activeModel.ollamaTag)?.digest) ?? undefined;
      const activeModelLoaded = modelsLoaded.includes(activeModel.ollamaTag);
      const singleModelLoaded = modelsLoaded.length === 1;
      const activeModelIdentityValid = ollamaModelDigestsEqual(activeDigest, activeModel.digest);
      const latencyMs = Date.now() - startedAt;

      // The production contract reserves at least 6 GiB for Nexus and the OS.
      let memAvailableKb = 0;
      let memoryPressure = false;
      try {
        const fs = require('fs') as typeof import('fs');
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
        const m = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
        if (m) memAvailableKb = parseInt(m[1], 10);
        const minimumAvailableKb = (manifest.productionEnvelope.minimumHostAvailableBytes
          ?? 6 * 1024 ** 3) / 1024;
        memoryPressure = memAvailableKb > 0 && memAvailableKb < minimumAvailableKb;
      } catch { /* /proc/meminfo not always available (e.g., in tests) */ }
      const healthy = versionOk && psResp.ok && tagsResp.ok
        && activeModelLoaded && singleModelLoaded && activeModelIdentityValid;
      const degraded = !healthy || memoryPressure;
      const warning = !versionOk
        ? 'version_unavailable'
        : (!psResp.ok || !tagsResp.ok)
          ? 'model_state_unavailable'
          : !activeModelIdentityValid
            ? 'signed_model_digest_mismatch'
            : !activeModelLoaded
              ? 'active_model_not_loaded'
              : !singleModelLoaded
                ? 'multiple_models_loaded'
                : memoryPressure
                  ? 'memory_pressure'
                  : undefined;

      return {
        name: 'ollama',
        healthy,
        latencyMs,
        modelsLoaded,
        queueDepth: queueState.totalDepth,
        degraded,
        memAvailableKb: memAvailableKb || undefined,
        warning,
        activeModel: activeModel.ollamaTag,
        activeModelDigest: activeModel.digest ?? undefined,
        observedModelDigest: activeDigest,
        manifestVersion: manifest.manifestVersion,
        transport: transportKind,
      };
    } catch (err) {
      return {
        name: 'ollama',
        healthy: false,
        latencyMs: Date.now() - startedAt,
        modelsLoaded: [],
        queueDepth: queueState.totalDepth,
        degraded: true,
        lastError: (err as Error)?.message,
        activeModel: activeModel.ollamaTag,
        activeModelDigest: activeModel.digest ?? undefined,
        manifestVersion: manifest.manifestVersion,
        transport: transportKind,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Internal: queue + rate-limit + call + log ────────────────────

  private async callOllamaForTask(args: {
    taskType: OllamaTaskType;
    workloadRole: unknown;
    category: string;
    request: OllamaChatRequest;
    userId?: number;
    tenantId?: number;
    /**
     * When false, suppress api_usage write AND skip the rate-limit check.
     * Runtime shadow classification no longer uses this bypass: all model
     * calls must be gated and recorded. It remains only for explicitly
     * controlled offline/operator evaluations.
     */
    recordUsage?: boolean;
    /**
     * O3-A18: caller-side cancellation signal (chained into the fetch's
     * AbortController). Used by shadow-classify timeouts to actually
     * terminate in-flight Ollama HTTP requests instead of just resolving
     * the local promise.
     */
    externalSignal?: AbortSignal;
    /**
     * O3-A18 (optional): override default OLLAMA_TIMEOUT_MS for this
     * specific call. Shadow-classify uses a tighter ~5s timeout.
     */
    timeoutMsOverride?: number;
    /**
     * Keep budget/rate-limit admission and exactly-one accounting, but let
     * callDomain bind the usage category to post-response validation.
     */
    deferUsage?: boolean;
  }): Promise<{
    response: OllamaChatResponse;
    modelDigest?: string;
    deferredUsage?: DeferredOllamaUsage;
  }> {
    const {
      taskType,
      workloadRole,
      category,
      request,
      userId = 0,
      tenantId = 0,
      recordUsage = true,
      externalSignal,
      timeoutMsOverride,
      deferUsage = false,
    } = args;
    // This is the final shared boundary for every Ollama request, including
    // chatPrimitive and module-level helpers. Keep this check ahead of budget,
    // rate-limit, queue, digest, and network work so a missing/generic/complex
    // role cannot consume local capacity or reach the daemon.
    assertAllowedOllamaWorkloadRole(workloadRole, taskType);
    assertSmallOnlyOllamaModel(request.model, `ollama_request:${taskType}`);
    const governedSkillInference = workloadRole === 'skill_inference';
    // Entitlement/budget denial must happen before the local capacity meter.
    // Otherwise an ineligible request could consume a per-user/global Ollama
    // rate-limit unit even though it is forbidden from reaching the model.
    if (!governedSkillInference) {
      assertAiBudgetReservationForProvider({
        userId,
        category,
        provider: 'ollama',
        model: request.model,
        maxCostUsd: 0,
      });
    }

    // Explicit offline recordUsage=false calls bypass rate-limiting. Runtime
    // shadow calls are metered and therefore take the normal path.
    if (recordUsage && !governedSkillInference) {
      const scope = rateLimitScope(taskType);
      const rate = checkAndConsumeLocalLLMRateLimit({ userId, scope });
      if (!rate.allowed) {
        throw new LocalLLMError('capacity_exceeded', {
          taskType,
          reason: 'rate_limit',
          scope: rate.reasonScope,
        });
      }
    }

    const invokeOllama = async () => {
      // Queue wait can be non-trivial. Revalidate immediately before the HTTP
      // request so a provider call never relies only on a stale pre-queue
      // decision (the first check above still keeps ineligible work out early).
      if (!governedSkillInference) {
        assertAiBudgetReservationForProvider({
          userId,
          category,
          provider: 'ollama',
          model: request.model,
          maxCostUsd: 0,
        });
      }
      const manifest = getLocalModelManifest({ fresh: true });
      const activeModel = manifest.models.find((model) => model.id === manifest.activeModelId)!;
      // Bind the mutable tag, pinned digest, and selection status to this one
      // fresh manifest snapshot. A queued request may have been admitted under
      // an older manifest; it must not dispatch that old tag after activation
      // changes while separately validating a new winner's digest.
      assertSmallOnlyOllamaModel(
        request.model,
        `ollama_request:${taskType}:dispatch`,
        { expectedModel: activeModel.ollamaTag },
      );
      let modelDigest: string | undefined;
      if (manifest.selectionStatus === 'production_selected' || governedSkillInference) {
        // A production winner is security/release identity, not best-effort
        // telemetry. Governed evaluation traffic also pins the verified
        // control digest so a mutable tag change cannot contaminate bakeoff or
        // durable script checkpoints. Resolve and compare immediately before
        // any generation leaves the gateway.
        modelDigest = await getModelDigest(
          config.ollama.baseUrl,
          request.model,
          { allowCache: false },
        );
        if (!ollamaModelDigestsEqual(modelDigest, activeModel.digest)) {
          throw new LocalLLMError('model_missing', {
            taskType,
            model: request.model,
            reason: 'signed_manifest_digest_mismatch',
            expectedDigest: activeModel.digest,
            actualDigest: modelDigest ?? 'unresolved',
          });
        }
      }
      const t0 = Date.now();
      const effectiveTimeoutMs = timeoutMsOverride ?? config.ollama.timeoutMs;
      const response = await ollamaChat(request, effectiveTimeoutMs, externalSignal);
      const durationMs = Date.now() - t0;
      if (manifest.selectionStatus !== 'production_selected' && !governedSkillInference) {
        modelDigest = await getModelDigest(config.ollama.baseUrl, request.model);
      }

      const md = deriveMetrics(response);
      // Telemetry — never includes thinking content. Shadow calls are
      // marked so log readers can filter.
      logger.info(
        {
          taskType,
          workloadRole,
          category,
          provider: 'ollama',
          model: request.model,
          modelDigest,
          total_duration: md.totalDurationNs,
          load_duration: md.loadDurationNs,
          prompt_eval_count: md.promptEvalCount,
          eval_count: md.evalCount,
          prompt_tokens_per_sec: md.promptTokensPerSec,
          generation_tokens_per_sec: md.generationTokensPerSec,
          is_cold_load: md.isColdLoad,
          duration_ms: durationMs,
          stop_reason: response.done_reason,
          shadow: !recordUsage,
        },
        recordUsage ? 'OllamaProvider call complete' : 'OllamaProvider shadow call complete',
      );

      // Controlled offline calls may opt out; runtime paths keep this true.
      if (recordUsage && !deferUsage) {
        await logOllamaUsage(category, request.model, modelDigest, durationMs, md, userId, tenantId);
      }

      return {
        response,
        modelDigest,
        ...(recordUsage && deferUsage
          ? {
            deferredUsage: {
              model: request.model,
              modelDigest,
              durationMs,
              metrics: md,
              userId,
              tenantId,
            },
          }
          : {}),
      };
    };
    // SkillInferenceService already owns the one-active/four-waiting product
    // scheduler. Sending governed calls through the legacy provider queue as
    // well would create two independent deadlines and make weighted priority
    // unverifiable. The daemon's OLLAMA_MAX_QUEUE remains the final defense.
    return governedSkillInference ? invokeOllama() : withQueueSlot(taskType, invokeOllama);
  }
}

// ─── Module-level one-shot helper (local-LLM pilot, 2026-07-04) ─────
//
// Narrow public entry point for env-gated one-shot localReasoning
// completions (first consumer: channel-learner knowledge synthesis via
// LOCAL_LLM_CHANNEL_SYNTHESIS). Callers get the same guarantees as every
// other Ollama path — it does NOT bypass the serialized queue, per-user
// rate limits, per-task token caps, timeout handling, or the api_usage
// write (cost_usd=0, local_request_units=1) — because it delegates to
// OllamaProvider.chatPrimitive, which funnels into callOllamaForTask.
// This is deliberately additive: no existing routing path changes.

export interface LocalReasoningOneShotOptions {
  userId?: number;
  tenantId?: number;
  /** Output cap (maps to num_predict). Defaults to outputCapFor('localReasoning'). */
  maxTokens?: number;
  /** Defaults to 0.2 (matches localReason). */
  temperature?: number;
  /** Context window. Defaults to the signed active model's service limit. */
  numCtx?: number;
  /**
   * Thinking toggle. Defaults to FALSE for bounded synthesis latency.
   * Legacy localReason() keeps its think:true default — this helper is a
   * separate, additive entry point.
   */
  think?: boolean;
  /** Per-call timeout override. Defaults to config.ollama.timeoutMs. */
  timeoutMs?: number;
  /** Ollama model residency for keep_alive. Defaults to -1 (stay loaded). */
  keepAliveSeconds?: number;
  /** Optional caller abort signal composed into the Ollama fetch. */
  abortSignal?: AbortSignal;
}

export interface LocalReasoningOneShotResult {
  /** Response text with thinking traces stripped. May be empty — callers decide. */
  text: string;
  stopReason?: string;
  providerMetadata?: AICallResult['providerMetadata'];
}

// Lazy module-level provider instance. Queue state and rate limits are
// module-scoped (see queueState above), so this instance serializes with
// any registry-owned OllamaProvider in the same process.
let moduleOneShotProvider: OllamaProvider | null = null;

function getModuleOneShotProvider(): OllamaProvider {
  if (!moduleOneShotProvider) {
    moduleOneShotProvider = new OllamaProvider();
  }
  return moduleOneShotProvider;
}

/** Test-only: drop the lazy singleton so construct-time guards re-run. */
export function _resetLocalReasoningOneShotProviderForTests(): void {
  moduleOneShotProvider = null;
}

/**
 * One-shot local reasoning completion (system + user prompt → text).
 *
 * Throws LocalLLMError on every failure mode (not configured, queue
 * capacity, rate limit, timeout, daemon unhealthy, token overflow) so
 * callers can catch-and-fall-through to their existing cloud path.
 */
export async function completeLocalReasoningOneShot(
  systemPrompt: string,
  userPrompt: string,
  category: string,
  opts: LocalReasoningOneShotOptions = {},
): Promise<LocalReasoningOneShotResult> {
  if (!isOllamaConfigured()) {
    throw new LocalLLMError('provider_unhealthy', { reason: 'ollama_not_configured', category });
  }
  enforceInputTokenCap('localReasoning', [systemPrompt, userPrompt]);

  const numCtx = Number.isFinite(opts.numCtx) && (opts.numCtx ?? 0) > 0
    ? Math.min(4096, Math.floor(opts.numCtx!))
    : 4096;
  const numPredict = Number.isFinite(opts.maxTokens) && (opts.maxTokens ?? 0) > 0
    ? Math.floor(opts.maxTokens!)
    : outputCapFor('localReasoning');

  const request: OllamaChatRequest = {
    model: config.ollama.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    think: opts.think ?? false,
    stream: false,
    keep_alive: opts.keepAliveSeconds ?? -1,
    options: {
      num_ctx: numCtx,
      num_predict: numPredict,
      temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.2,
      top_p: 0.9,
      top_k: 20,
    },
  };

  const result = await getModuleOneShotProvider().chatPrimitive({
    taskType: 'localReasoning',
    workloadRole: 'offline_evaluation',
    category,
    request,
    userId: opts.userId,
    tenantId: opts.tenantId,
    externalSignal: opts.abortSignal,
    timeoutMsOverride: opts.timeoutMs,
  });

  const text = stripThinkBlocks(result.response.message?.content);
  const md = deriveMetrics(result.response);
  return {
    text,
    stopReason: result.response.done_reason ?? 'stop',
    providerMetadata: {
      providerUsed: 'ollama',
      modelUsed: request.model,
      modelDigest: result.modelDigest,
      fallbackUsed: false,
      totalDurationNs: md.totalDurationNs,
      promptEvalCount: md.promptEvalCount,
      evalCount: md.evalCount,
      generationTokensPerSec: md.generationTokensPerSec,
      isColdLoad: md.isColdLoad,
    },
  };
}
