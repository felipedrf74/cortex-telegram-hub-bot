// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { resolveApiUsageAttribution, type AiRequestSource } from './api-usage-attribution';

export type ApiUsagePricingStatus = 'resolved' | 'unresolved' | 'legacy' | 'zero-cost' | 'timeout-estimate';

export interface ApiUsagePersistenceFailure {
  provider: string;
  category: string;
  occurredAt: string;
  retryAt: string;
}

/**
 * A provider response without a durable api_usage row makes quota enforcement
 * unsafe. The first such failure trips a process-wide latch; all subsequent
 * model calls fail through SERVICE_DEGRADED until the honest 60-second retry
 * window opens and a durable zero-cost probe succeeds.
 */
export class ApiUsagePersistenceError extends Error {
  readonly code = 'AI_USAGE_PERSISTENCE_FAILED';
  readonly provider: string;
  readonly category: string;

  constructor(provider: string, category: string) {
    super('AI usage could not be persisted; provider access is degraded');
    this.name = 'ApiUsagePersistenceError';
    this.provider = provider;
    this.category = category;
  }
}

/** Errors that must never be retried through another paid provider. */
export function isAiUsageFailClosedError(error: unknown): boolean {
  const candidate = error as { name?: string; code?: string } | null;
  return error instanceof ApiUsagePersistenceError
    || candidate?.name === 'ApiUsagePersistenceError'
    || candidate?.code === 'AI_USAGE_PERSISTENCE_FAILED'
    || candidate?.name === 'AiBudgetError';
}

export function rethrowAiUsageFailClosedError(error: unknown): void {
  if (isAiUsageFailClosedError(error)) throw error;
}

const API_USAGE_RECOVERY_RETRY_MS = 60_000;
let apiUsagePersistenceFailure: ApiUsagePersistenceFailure | null = null;

export function tripApiUsagePersistenceFailure(
  provider: string,
  category: string,
): ApiUsagePersistenceError {
  if (!apiUsagePersistenceFailure) {
    apiUsagePersistenceFailure = {
      provider,
      category,
      occurredAt: new Date().toISOString(),
      retryAt: new Date(Date.now() + API_USAGE_RECOVERY_RETRY_MS).toISOString(),
    };
  }
  return new ApiUsagePersistenceError(provider, category);
}

export function getApiUsagePersistenceFailure(): ApiUsagePersistenceFailure | null {
  return apiUsagePersistenceFailure ? { ...apiUsagePersistenceFailure } : null;
}

/** Test-only latch reset. Production recovery uses the durable probe above. */
export function _resetApiUsagePersistenceFailureForTests(): void {
  apiUsagePersistenceFailure = null;
}

/**
 * Probe the exact durable api_usage write path once the advertised retry
 * window opens. A successful zero-cost marker clears the process latch; a
 * failed probe advances the retry window by another honest 60 seconds.
 */
export function tryRecoverApiUsagePersistenceFailure(db: Database.Database): boolean {
  const failure = apiUsagePersistenceFailure;
  if (!failure) return true;
  const retryAtMs = Date.parse(failure.retryAt);
  if (Number.isFinite(retryAtMs) && Date.now() < retryAtMs) return false;

  try {
    insertApiUsageFallback(db, {
      category: 'api_usage_recovery_probe',
      model: 'metering-probe',
      provider: 'system',
      tenantId: 0,
      userId: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      pricingStatus: 'zero-cost',
      requestSource: 'system',
      baseCategory: 'api_usage_recovery_probe',
    });
    apiUsagePersistenceFailure = null;
    return true;
  } catch {
    apiUsagePersistenceFailure = {
      ...failure,
      retryAt: new Date(Date.now() + API_USAGE_RECOVERY_RETRY_MS).toISOString(),
    };
    return false;
  }
}

export interface ApiUsageFallbackInsertInput {
  category: string;
  model: string;
  provider: string;
  tenantId?: number | null;
  userId?: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  costUsd: number;
  durationMs?: number | null;
  pricingStatus?: ApiUsagePricingStatus;
  pricingModelKey?: string | null;
  // v2.6 (angry-QA-found): local LLM call metering. The Ollama provider's
  // primary INSERT path sets `local_request_units=1` directly in its SQL
  // text. Without this field on the fallback path, fallback rows landed
  // with the default 0 and the local-llm-rate-limiter under-counted —
  // a single user could exceed daily/hourly caps by repeatedly tripping
  // the primary INSERT's catch handler.
  localRequestUnits?: number | null;
  requestSource?: AiRequestSource;
  jobName?: string | null;
  baseCategory?: string | null;
  runId?: string | null;
  providerToolCostUsd?: number | null;
  webSearchRequests?: number | null;
  groundedSearchPrompts?: number | null;
}

export interface ApiUsageTimeoutEstimateInput {
  category: string;
  model: string;
  provider: string;
  tenantId?: number | null;
  userId?: number | null;
  maxCostUsd: number;
  timeoutMs: number;
  providerToolCostUsd?: number | null;
  webSearchRequests?: number | null;
  groundedSearchPrompts?: number | null;
}

/**
 * Persist the provider-enforced upper cost bound when an SDK request outlives
 * the caller timeout. The orphan may still be billed, but no reliable token
 * metadata is available at the abandonment boundary. A distinct pricing
 * status keeps this conservative row visible to owner/admin reconciliation.
 */
export function recordApiUsageTimeoutEstimate(
  input: ApiUsageTimeoutEstimateInput,
  db: Database.Database = getDbForTimeoutEstimate(),
): number {
  try {
    return insertApiUsageFallback(db, {
      category: input.category,
      model: input.model,
      provider: input.provider,
      tenantId: input.tenantId ?? input.userId ?? 0,
      userId: input.userId ?? 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: Math.max(0, input.maxCostUsd),
      durationMs: Math.max(0, Math.floor(input.timeoutMs)),
      pricingStatus: 'timeout-estimate',
      providerToolCostUsd: input.providerToolCostUsd ?? 0,
      webSearchRequests: input.webSearchRequests ?? 0,
      groundedSearchPrompts: input.groundedSearchPrompts ?? 0,
    });
  } catch (err) {
    if (err instanceof ApiUsagePersistenceError) throw err;
    throw tripApiUsagePersistenceFailure(input.provider, input.category);
  }
}

// Lazy load avoids a database -> migration -> provider import cycle during
// application bootstrap while keeping the timeout callback synchronous.
function getDbForTimeoutEstimate(): Database.Database {
  return (require('./database') as typeof import('./database')).getDb();
}

const columnCache = new WeakMap<Database.Database, Set<string>>();

export function getApiUsageColumns(db: Database.Database): Set<string> {
  const cached = columnCache.get(db);
  if (cached) return cached;
  const rows = db.prepare('PRAGMA table_info(api_usage)').all() as Array<{ name: string }>;
  const columns = new Set(rows.map((row) => row.name));
  columnCache.set(db, columns);
  return columns;
}

export function insertApiUsageFallback(
  db: Database.Database,
  input: ApiUsageFallbackInsertInput,
): number {
  const columns = getApiUsageColumns(db);
  const attribution = resolveApiUsageAttribution(input.category, input.userId ?? 0, {
    requestSource: input.requestSource,
    jobName: input.jobName,
    baseCategory: input.baseCategory ?? undefined,
    runId: input.runId,
  });
  const insertColumns: string[] = [];
  const values: unknown[] = [];

  const add = (column: string, value: unknown): void => {
    if (!columns.has(column)) return;
    insertColumns.push(column);
    values.push(value);
  };

  add('category', input.category);
  add('model', input.model);
  add('tenant_id', input.tenantId ?? input.userId ?? 0);
  add('user_id', input.userId ?? 0);
  add('input_tokens', input.inputTokens);
  add('output_tokens', input.outputTokens);
  add('cache_read_tokens', input.cacheReadTokens ?? 0);
  add('cache_write_tokens', input.cacheWriteTokens ?? 0);
  add('cost_usd', input.costUsd);
  add('duration_ms', input.durationMs ?? 0);
  add('provider', input.provider);
  add('pricing_status', input.pricingStatus ?? 'legacy');
  add('pricing_model_key', input.pricingModelKey ?? null);
  add('local_request_units', input.localRequestUnits ?? 0);
  add('request_source', attribution.requestSource);
  add('job_name', attribution.jobName);
  add('base_category', attribution.baseCategory);
  add('run_id', attribution.runId);
  add('provider_tool_cost_usd', input.providerToolCostUsd ?? 0);
  add('web_search_requests', input.webSearchRequests ?? 0);
  add('grounded_search_prompts', input.groundedSearchPrompts ?? 0);

  if (insertColumns.length === 0) throw tripApiUsagePersistenceFailure(input.provider, input.category);

  const result = db.prepare(`
    INSERT INTO api_usage (${insertColumns.join(', ')})
    VALUES (${insertColumns.map(() => '?').join(', ')})
  `).run(...values);
  const insertedId = Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0);
  if (!Number.isFinite(insertedId) || insertedId <= 0) {
    throw tripApiUsagePersistenceFailure(input.provider, input.category);
  }
  return insertedId;
}
