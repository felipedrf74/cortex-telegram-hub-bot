// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

export const PORTAL_SNAPSHOT_CACHE_TTL_MS = 3_000;

type SnapshotCacheEntry<T> = {
  data: T;
  at: number;
};

let cachedSnapshot: SnapshotCacheEntry<unknown> | null = null;

export function getCachedPortalSnapshot<T>(
  now = Date.now(),
  ttlMs = PORTAL_SNAPSHOT_CACHE_TTL_MS,
): T | null {
  if (!cachedSnapshot) return null;
  if (now - cachedSnapshot.at >= ttlMs) return null;
  return cachedSnapshot.data as T;
}

export function setCachedPortalSnapshot<T>(data: T, now = Date.now()): void {
  cachedSnapshot = { data, at: now };
}

export function clearPortalSnapshotCache(): void {
  cachedSnapshot = null;
}
