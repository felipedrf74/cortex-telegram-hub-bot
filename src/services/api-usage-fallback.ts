// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { resolveApiUsageAttribution, type AiRequestSource } from './api-usage-attribution';

export type ApiUsagePricingStatus = 'resolved' | 'unresolved' | 'legacy' | 'zero-cost';

export interface ApiUsagePersistenceFailure {
  provider: string;
  category: string;
  occurredAt: string;
}

/**
 * A provider response without a durable api_usage row makes quota enforcement
 * unsafe. The first such failure trips a process-wide, restart-cleared latch;
 * all subsequent model calls fail through the shared SERVICE_DEGRADED gate.
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
    };
  }
  return new ApiUsagePersistenceError(provider, category);
}

export function getApiUsagePersistenceFailure(): ApiUsagePersistenceFailure | null {
  return apiUsagePersistenceFailure ? { ...apiUsagePersistenceFailure } : null;
}

/** Test-only: production intentionally clears the latch only on restart. */
export function _resetApiUsagePersistenceFailureForTests(): void {
  apiUsagePersistenceFailure = null;
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
