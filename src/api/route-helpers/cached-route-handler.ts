// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type { Response } from 'express';
import { getCachedSWR, setCacheSWR } from '../../services/cache-store';
import { recordSWRRefreshFailure, recordSWRRefreshSuccess } from '../../services/swr-refresh-observability';
import { ensureValidTenantRouteScope } from '../tenant-route-scope';

interface CachedRouteRefreshContext {
  source: string;
  operation: string;
  userId?: number;
}

interface CachedRouteHit<T> {
  value: T;
  fresh: boolean;
}

export interface CachedRouteHandlerOptions<T> {
  cacheKey: string;
  ttlSeconds: number;
  staleSeconds?: number;
  refreshContext: CachedRouteRefreshContext;
  fetchFresh: () => Promise<T>;
  send: (payload: T, meta: { cached: boolean; fresh: boolean }) => void;
  shouldServeCached?: (hit: CachedRouteHit<T>) => boolean;
  onCachedBypass?: (hit: CachedRouteHit<T>) => void;
}

const swrInFlight = new Set<string>();

export function ensureCachedRouteTenantScope(
  res: Response,
  userId: number | undefined,
  operation: string,
  details?: Record<string, unknown>,
): userId is number {
  return ensureValidTenantRouteScope(res, userId, operation, details);
}

export function routeCacheKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => part == null ? '' : String(part)).join(':');
}

export async function handleCachedRoute<T>(options: CachedRouteHandlerOptions<T>): Promise<{ source: 'cache' | 'fresh' }> {
  const cached = getCachedSWR<T>(options.cacheKey);
  if (cached && (options.shouldServeCached?.(cached) ?? true)) {
    options.send(cached.value, { cached: true, fresh: cached.fresh });
    if (!cached.fresh) {
      refreshCachedRoute(options.cacheKey, async () => {
        const refreshed = await options.fetchFresh();
        setCacheSWR(options.cacheKey, refreshed, options.ttlSeconds, options.staleSeconds);
      }, options.refreshContext);
    }
    return { source: 'cache' };
  }

  if (cached) {
    options.onCachedBypass?.(cached);
  }

  const fresh = await options.fetchFresh();
  setCacheSWR(options.cacheKey, fresh, options.ttlSeconds, options.staleSeconds);
  options.send(fresh, { cached: false, fresh: true });
  return { source: 'fresh' };
}

export function refreshCachedRoute(
  cacheKey: string,
  refresh: () => Promise<void>,
  context: CachedRouteRefreshContext,
): void {
  if (swrInFlight.has(cacheKey)) return;
  swrInFlight.add(cacheKey);
  refresh()
    .then(() => recordSWRRefreshSuccess(cacheKey))
    .catch((err) => recordSWRRefreshFailure(cacheKey, err, context))
    .finally(() => swrInFlight.delete(cacheKey));
}

export function _resetCachedRouteHandlerForTests(): void {
  swrInFlight.clear();
}
