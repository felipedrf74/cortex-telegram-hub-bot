import { clearCacheByPrefix } from './cache-store';

function notificationRouteCacheKey(...parts: Array<string | number | boolean | null | undefined>): string {
  return parts.map((part) => part == null ? '' : String(part)).join(':');
}

export function invalidateNotificationInboxCaches(userId: number, tenantId: number): void {
  clearCacheByPrefix([
    notificationRouteCacheKey('unified-inbox', userId, 'tenant', tenantId),
    notificationRouteCacheKey('unified-inbox-unread', userId, 'tenant', tenantId),
  ]);
}
