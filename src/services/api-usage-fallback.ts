// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';

export type ApiUsagePricingStatus = 'resolved' | 'unresolved' | 'legacy';

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
): number | null {
  const columns = getApiUsageColumns(db);
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

  if (insertColumns.length === 0) return null;

  const result = db.prepare(`
    INSERT INTO api_usage (${insertColumns.join(', ')})
    VALUES (${insertColumns.map(() => '?').join(', ')})
  `).run(...values);
  return Number((result as { lastInsertRowid?: number | bigint } | undefined)?.lastInsertRowid ?? 0) || null;
}
