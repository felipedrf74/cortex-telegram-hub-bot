// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Dependency-free process memo for readiness snapshots.
 *
 * Keeping the store outside readiness-scorer lets the canonical cache
 * coherence registry evict it without creating the cycle
 * registry -> scorer -> Garmin session store -> registry.
 */

export interface ReadinessMemoEntry<T = unknown> {
  at: number;
  result: T;
}

const readinessMemo = new Map<string, ReadinessMemoEntry<unknown>>();

function readinessMemoKey(tenantId: number, userId: number): string {
  return `${tenantId}:${userId}`;
}

export function getReadinessMemo<T>(
  tenantId: number,
  userId: number,
): ReadinessMemoEntry<T> | undefined {
  return readinessMemo.get(readinessMemoKey(tenantId, userId)) as ReadinessMemoEntry<T> | undefined;
}

export function setReadinessMemo<T>(
  tenantId: number,
  userId: number,
  result: T,
  at = Date.now(),
): void {
  readinessMemo.set(readinessMemoKey(tenantId, userId), { at, result });
}

export function invalidateReadinessMemoForUser(userId: number): void {
  const userSuffix = `:${userId}`;
  for (const memoKey of readinessMemo.keys()) {
    if (memoKey.endsWith(userSuffix)) readinessMemo.delete(memoKey);
  }
}

export function clearReadinessMemoForTests(): void {
  readinessMemo.clear();
}
