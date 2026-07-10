// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { AsyncLocalStorage } from 'async_hooks';

export type AiRequestSource = 'interactive' | 'automation' | 'system';

export interface ApiUsageAttribution {
  requestSource: AiRequestSource;
  jobName: string | null;
  baseCategory: string;
  runId: string | null;
}

const apiUsageContext = new AsyncLocalStorage<Partial<ApiUsageAttribution>>();

function clean(value: string | null | undefined, maxLength = 160): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '_');
  return normalized ? normalized.slice(0, maxLength) : null;
}

/** Collapse provider fallback suffixes without changing the legacy category. */
export function normalizeBaseCategory(category: string): string {
  return String(category || 'uncategorized')
    .replace(/_(?:gemini_model|openai|anthropic)_fallback$/i, '')
    .replace(/_fallback$/i, '')
    .slice(0, 160);
}

export function runWithApiUsageAttribution<T>(
  attribution: Partial<ApiUsageAttribution>,
  fn: () => T,
): T {
  const current = apiUsageContext.getStore() ?? {};
  return apiUsageContext.run({ ...current, ...attribution }, fn);
}

/**
 * Explicit-release companion for long route handlers that discover model work
 * lazily after token-zero branches have already run. Prefer
 * runWithApiUsageAttribution/withAiBudgetReservation for bounded callbacks.
 */
export function enterApiUsageAttribution(
  attribution: Partial<ApiUsageAttribution>,
): () => void {
  const previous = apiUsageContext.getStore();
  apiUsageContext.enterWith({ ...(previous ?? {}), ...attribution });
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    apiUsageContext.enterWith(previous ?? {});
  };
}

export function resolveApiUsageAttribution(
  category: string,
  userId: number,
  explicit?: Partial<ApiUsageAttribution>,
): ApiUsageAttribution {
  const definedExplicit = Object.fromEntries(
    Object.entries(explicit ?? {}).filter(([, value]) => value !== undefined),
  ) as Partial<ApiUsageAttribution>;
  const current = { ...(apiUsageContext.getStore() ?? {}), ...definedExplicit };
  const requestSource = current.requestSource
    ?? (Number.isFinite(userId) && userId > 0 ? 'interactive' : 'system');
  return {
    requestSource,
    jobName: clean(current.jobName),
    baseCategory: clean(current.baseCategory) ?? normalizeBaseCategory(category),
    runId: clean(current.runId),
  };
}

export function getCurrentApiUsageAttribution(): Partial<ApiUsageAttribution> | undefined {
  return apiUsageContext.getStore();
}
