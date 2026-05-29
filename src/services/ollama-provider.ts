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
  normalizeCallDomainOptions,
} from './ai-provider';
import { DomainName, DomainMessage, ClassificationResult } from '../domains/types';
import { getClassifierSystemPrompt, getDomainSystemPrompt, getOllamaClassifierSystemPromptCompact } from './anthropic';
import { LocalLLMError, type LocalLLMErrorKind } from './local-llm-error';
import { estimateTokens, estimateTokensTotal } from './token-estimator';
import { insertApiUsageFallback } from './api-usage-fallback';
import {
  checkAndConsumeLocalLLMRateLimit,
  type LocalLLMRateLimitScope,
} from './local-llm-rate-limiter';

// ─── Public types for the new task dispatch paths ──────────────────

/** Task type identifiers spoken by the routing layer. */
export type OllamaTaskType =
  | 'classify'
  | 'chat'             // callDomain (non-tool domains)
  | 'tool-use'         // callDomain / continueWithToolResults — UNSUPPORTED in v1
  | 'scriptGeneration'
  | 'localReasoning';

export interface ScriptGenTask {
  description: string;
  targetPath?: string;          // hint where artifacts will live (relative)
  domainContext?: string;       // additional context to inject into the system prompt
  userId?: number;
  tenantId?: number;
  /** Run id used for sandbox directory naming. Caller may pass a UUID. */
  runId?: string;
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
  /** Optional caller abort signal composed into the Ollama fetch. */
  abortSignal?: AbortSignal;
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

function phaseKDomainSystemPromptSuffix(domain: DomainName): string {
  if (domain === 'cooking' || domain === 'content') return PHASE_K_ANSWER_ONLY_GUARD;
  if (domain === 'finance') return PHASE_K_FINANCE_GUARD;
  return '';
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
  return m;
}

// ─── Model digest cache (proves what actually ran) ─────────────────

interface ModelDigestEntry { digest: string; ts: number }
const modelDigestCache = new Map<string, ModelDigestEntry>();
const DIGEST_CACHE_MS = 5 * 60 * 1000;

async function getModelDigest(baseUrl: string, model: string): Promise<string | undefined> {
  const cached = modelDigestCache.get(model);
  if (cached && (Date.now() - cached.ts) < DIGEST_CACHE_MS) return cached.digest;
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { method: 'GET' });
    if (!resp.ok) return cached?.digest;
    const json = await resp.json() as { models?: Array<{ name: string; digest: string }> };
    for (const m of json.models || []) {
      modelDigestCache.set(m.name, { digest: m.digest, ts: Date.now() });
    }
    return modelDigestCache.get(model)?.digest;
  } catch {
    return cached?.digest;
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

const queueState: QueueState = {
  classifyDepth: 0,
  scriptGenDepth: 0,
  localReasoningDepth: 0,
  chatDepth: 0,
  totalDepth: 0,
  chain: Promise.resolve(),
};

function depthFor(taskType: OllamaTaskType): { depth: number; cap: number; key: keyof QueueState } {
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

  (queueState[key] as number)++;
  queueState.totalDepth++;

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
    (queueState[key] as number)--;
    queueState.totalDepth--;
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
      ctrl.abort();
    } else {
      externalAbortListener = () => ctrl.abort();
      externalSignal.addEventListener('abort', externalAbortListener, { once: true });
    }
  }
  try {
    const resp = await fetch(`${config.ollama.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      // 404 from Ollama means model not loaded / not in library; 503 means
      // queue full at the daemon side; 5xx is generic server error.
      const text = await resp.text().catch(() => '');
      if (resp.status === 404 || /model.*not.*found/i.test(text)) {
        throw new LocalLLMError('model_missing', { model: req.model, status: resp.status, body: text.slice(0, 400) });
      }
      if (resp.status === 503) {
        throw new LocalLLMError('capacity_exceeded', { reason: 'daemon_queue_full', status: 503 });
      }
      throw new LocalLLMError('provider_unhealthy', { status: resp.status, body: text.slice(0, 400) });
    }
    return await resp.json() as OllamaChatResponse;
  } catch (err) {
    if (err instanceof LocalLLMError) throw err;
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
    db.prepare(`
      INSERT INTO api_usage (
        category, model, tenant_id, user_id,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        cost_usd, duration_ms, provider, pricing_status, pricing_model_key,
        local_request_units
      )
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 'ollama', 'zero-cost', ?, 1)
    `).run(
      category,
      model,
      tenantId,
      userId,
      metrics.promptEvalCount ?? 0,
      metrics.evalCount ?? 0,
      durationMs,
      modelDigest ?? model,
    );
    pushEvent({
      ts: new Date().toISOString(),
      type: 'api_call',
      summary: `Ollama ${model}: ${metrics.promptEvalCount ?? 0}+${metrics.evalCount ?? 0} tokens (local, $0)`,
      durationMs,
    });
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
      logger.warn({ err: fallbackErr }, 'Failed to log Ollama usage');
    }
  }
}

// ─── Per-task token-cap enforcement ─────────────────────────────────

function enforceInputTokenCap(taskType: OllamaTaskType, parts: ReadonlyArray<string | null | undefined>): void {
  const caps = config.ollama.tokenCaps;
  let cap: number | undefined;
  switch (taskType) {
    case 'classify':         cap = caps.classifyMaxInput; break;
    case 'scriptGeneration': cap = caps.scriptGenMaxInput; break;
    case 'localReasoning':   cap = caps.localReasoningMaxInput; break;
    case 'chat':             cap = caps.localReasoningMaxInput; break; // chat reuses the larger cap
    default:                 cap = caps.classifyMaxInput; break;
  }
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

function isValidClassificationPayload(o: unknown): o is ClassificationResult {
  if (!o || typeof o !== 'object') return false;
  const obj = o as Record<string, unknown>;
  if (typeof obj.confidence !== 'number') return false;
  if (typeof obj.domain !== 'string') return false;
  return (VALID_DOMAINS as readonly string[]).includes(obj.domain);
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

    // O3-A14: prefer the compact (<400-token) classifier prompt when set.
    // Falls back to the long Gemini prompt+hardening suffix when the
    // compact prompt is not provided (back-compat for tests / non-classifier
    // model use). The compact prompt is the path that lets a small
    // dedicated classifier model run sub-3s on this CPU.
    const compact = getOllamaClassifierSystemPromptCompact();
    const sys = compact
      ? compact
      : `${getClassifierSystemPrompt()}\n\n${CLASSIFY_HARDENING_SUFFIX}`;
    enforceInputTokenCap('classify', [sys, message]);

    // O3-A14: classifier-specific request body knobs. Defaults sized for
    // qwen2.5:3b on this CPU: num_ctx=2048 (compact prompt + short user
    // message fits comfortably), num_predict=32 (JSON output is ~20
    // tokens). Both env-overridable for future tuning.
    const classifierNumCtx = readPositiveInt('OLLAMA_CLASSIFIER_NUM_CTX', 2048);
    const classifierNumPredict = readPositiveInt('OLLAMA_CLASSIFIER_NUM_PREDICT', 32);

    const baseRequest = {
      model: config.ollama.classifierModel,
      think: false,
      format: CLASSIFICATION_JSON_SCHEMA,
      stream: false as const,
      keep_alive: -1,
      options: {
        num_ctx: classifierNumCtx,
        num_predict: classifierNumPredict,
        temperature: 0,
      },
    };

    // O3-A12 OPTION 1 + O3-A19: shadow path suppresses api_usage and
    // bypasses local LLM rate-limiting; live path is unchanged.
    const recordUsage = options?.recordUsage !== false && options?.source !== 'shadow';

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
            { role: 'user', content:
              `Your previous reply did not match the schema. The "domain" value MUST be EXACTLY one of: ` +
              `${VALID_DOMAINS.join(', ')}. The "confidence" field is REQUIRED. ` +
              `Return ONLY JSON of shape: {"domain":"<one of the 5>","confidence":<0..1>}.`,
            },
          ];

      const result = await this.callOllamaForTask({
        taskType: 'classify',
        category: options?.source === 'shadow' ? 'classify_shadow' : 'classify_message',
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
      if (isValidClassificationPayload(parsed)) return parsed;

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
    const baseSys = getDomainSystemPrompt(domain, stateContext);
    const sys = phaseKDomainSystemPromptSuffix(domain) ? baseSys + phaseKDomainSystemPromptSuffix(domain) : baseSys;

    const messages: OllamaChatRequest['messages'] = [{ role: 'system', content: sys }];
    for (const h of history) {
      messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) });
    }
    messages.push({ role: 'user', content: currentMessage });

    enforceInputTokenCap('chat', [sys, currentMessage, stateContext, ...history.map(h => typeof h.content === 'string' ? h.content : '')]);

    const model = options.modelOverride ?? config.ollama.model;
    const maxOutput = options.maxTokensOverride ?? outputCapFor('chat');

    // Phase K: build request options once so providerMetadata reflects
    // exactly what went over the wire. Future per-domain temperature
    // overrides (Phase 3) plug in here.
    const requestOptions = {
      num_ctx: 8192,
      num_predict: maxOutput,
      temperature: 0.3,
    };

    const result = await this.callOllamaForTask({
      taskType: 'chat',
      category: `chat_${domain}`,
      userId: options.userId,
      tenantId: options.tenantId,
      request: {
        model,
        messages,
        think: false,
        stream: false,
        keep_alive: -1,
        options: requestOptions,
      },
    });

    const text = stripThinkBlocks(result.response.message?.content);
    const md = deriveMetrics(result.response);
    return {
      text,
      toolCalls: [],
      stopReason: result.response.done_reason ?? 'stop',
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
    // Delayed require to avoid a circular import at module load.
    const { runScriptGenerationPipeline } = require('./script-generation') as
      typeof import('./script-generation');
    return runScriptGenerationPipeline(task, this);
  }

  // ── Optional: localReason (single-shot, think:true) ──────────────

  async localReason(task: LocalReasoningTask): Promise<LocalReasoningResult> {
    const sys = task.systemContext ?? 'You are an expert reasoning assistant.';
    enforceInputTokenCap('localReasoning', [sys, task.prompt]);
    const numCtx = Number.isFinite(task.numCtx) && (task.numCtx ?? 0) > 0
      ? Math.floor(task.numCtx!)
      : 8192;
    const numPredict = Number.isFinite(task.numPredict) && (task.numPredict ?? 0) > 0
      ? Math.floor(task.numPredict!)
      : outputCapFor('localReasoning');

    const request: OllamaChatRequest = {
      model: task.modelOverride?.trim() || config.ollama.model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: task.prompt },
      ],
      think: task.think ?? true,
      stream: false,
      keep_alive: -1,
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
    category: string;
    request: OllamaChatRequest;
    userId?: number;
    tenantId?: number;
  }): Promise<{ response: OllamaChatResponse; modelDigest?: string }> {
    return this.callOllamaForTask(args);
  }

  // ── Health (for /health/detailed) ────────────────────────────────

  async getProviderHealth(): Promise<ProviderHealthSnapshot> {
    const startedAt = Date.now();
    try {
      const verResp = await fetch(`${config.ollama.baseUrl}/api/version`, { method: 'GET' });
      const versionOk = verResp.ok;
      const psResp = await fetch(`${config.ollama.baseUrl}/api/ps`, { method: 'GET' });
      const psJson = psResp.ok ? (await psResp.json()) as { models?: Array<{ name: string }> } : { models: [] };
      const modelsLoaded = (psJson.models || []).map(m => m.name);
      const latencyMs = Date.now() - startedAt;

      // Memory pressure (A7): degraded if MemAvailable < 1.5 GB.
      let memAvailableKb = 0;
      let degraded = false;
      let warning: string | undefined;
      try {
        const fs = require('fs') as typeof import('fs');
        const meminfo = fs.readFileSync('/proc/meminfo', 'utf-8');
        const m = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
        if (m) memAvailableKb = parseInt(m[1], 10);
        if (memAvailableKb > 0 && memAvailableKb < 1.5 * 1024 * 1024) {
          degraded = true;
          warning = 'memory_pressure';
        }
      } catch { /* /proc/meminfo not always available (e.g., in tests) */ }

      return {
        name: 'ollama',
        healthy: versionOk,
        latencyMs,
        modelsLoaded,
        queueDepth: queueState.totalDepth,
        degraded,
        memAvailableKb: memAvailableKb || undefined,
        warning,
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
      };
    }
  }

  // ── Internal: queue + rate-limit + call + log ────────────────────

  private async callOllamaForTask(args: {
    taskType: OllamaTaskType;
    category: string;
    request: OllamaChatRequest;
    userId?: number;
    tenantId?: number;
    /**
     * O3-A12 OPTION 1: when false, suppress api_usage write AND skip the
     * rate-limit check. Used by shadow-classify so:
     *   - shadow calls don't burn per-user local LLM quota
     *   - cost/usage dashboards stay clean (no api_usage rows to filter)
     * Telemetry still flows via classify_shadow_runs.
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
  }): Promise<{ response: OllamaChatResponse; modelDigest?: string }> {
    const {
      taskType,
      category,
      request,
      userId = 0,
      tenantId = 0,
      recordUsage = true,
      externalSignal,
      timeoutMsOverride,
    } = args;
    // O3-A12 OPTION 1: shadow calls bypass rate-limiting (no quota burn).
    if (recordUsage) {
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

    return withQueueSlot(taskType, async () => {
      const t0 = Date.now();
      const effectiveTimeoutMs = timeoutMsOverride ?? config.ollama.timeoutMs;
      const response = await ollamaChat(request, effectiveTimeoutMs, externalSignal);
      const durationMs = Date.now() - t0;

      const md = deriveMetrics(response);
      const modelDigest = await getModelDigest(config.ollama.baseUrl, request.model);

      // Telemetry — never includes thinking content. Shadow calls are
      // marked so log readers can filter.
      logger.info(
        {
          taskType,
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

      // O3-A12 OPTION 1: only write api_usage when recordUsage=true.
      if (recordUsage) {
        await logOllamaUsage(category, request.model, modelDigest, durationMs, md, userId, tenantId);
      }

      return { response, modelDigest };
    });
  }
}
