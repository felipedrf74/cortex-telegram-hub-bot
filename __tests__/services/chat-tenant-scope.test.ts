/**
 * Mirror test for chat-tenant-scope (M6 reliability backfill).
 * Pins tenant resolution rules and cross-tenant/invalid-scope denial with
 * anomaly observability.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
  LOGGER_REDACTION_PATHS: [],
}));

vi.mock('../../src/services/operator-alerts', async () => ({
  ...(await vi.importActual('../../src/services/operator-alerts')),
  recordOperatorAlert: vi.fn(),
}));

import {
  DEFAULT_CHAT_VISIBILITY_SCOPE,
  isActiveChatScopeStatus,
  isValidChatTenantId,
  resolveChatTenantId,
  resolveChatTenantScope,
} from '../../src/services/chat-tenant-scope';
import {
  clearTenantScopeAnomaliesForTests,
  getTenantScopeAnomalies,
} from '../../src/services/tenant-scope-observability';

describe('chat-tenant-scope', () => {
  beforeEach(() => {
    clearTenantScopeAnomaliesForTests();
  });

  describe('isValidChatTenantId / resolveChatTenantId', () => {
    it('accepts only positive safe integers', () => {
      expect(isValidChatTenantId(1)).toBe(true);
      expect(isValidChatTenantId(4242)).toBe(true);
      expect(isValidChatTenantId(0)).toBe(false);
      expect(isValidChatTenantId(-5)).toBe(false);
      expect(isValidChatTenantId(1.5)).toBe(false);
      expect(isValidChatTenantId(Number.NaN)).toBe(false);
      expect(isValidChatTenantId(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
      expect(isValidChatTenantId(null)).toBe(false);
      expect(isValidChatTenantId(undefined)).toBe(false);
    });

    it('uses the explicit tenant when valid and falls back to userId otherwise', () => {
      expect(resolveChatTenantId(42, 7)).toBe(7);
      expect(resolveChatTenantId(42)).toBe(42);
      expect(resolveChatTenantId(42, null)).toBe(42);
      expect(resolveChatTenantId(42, 0)).toBe(42);
      expect(resolveChatTenantId(42, -1)).toBe(42);
    });
  });

  describe('resolveChatTenantScope', () => {
    it('resolves a valid scope with defaults', () => {
      const scope = resolveChatTenantScope({
        userId: 42,
        tenantId: 7,
        operation: 'chat_route_message',
      });

      expect(scope).toEqual({
        tenantId: 7,
        userId: 42,
        visibilityScope: DEFAULT_CHAT_VISIBILITY_SCOPE,
        scopeStatus: 'active',
        createdBy: 42,
      });
      expect(getTenantScopeAnomalies()).toHaveLength(0);
    });

    it('falls back to user-private/tenant=userId when no tenant is provided', () => {
      const scope = resolveChatTenantScope({ userId: 42, operation: 'chat_route_message' });

      expect(scope?.tenantId).toBe(42);
      expect(scope?.visibilityScope).toBe('user_private');
    });

    it('honors an explicit visibility scope', () => {
      const scope = resolveChatTenantScope({
        userId: 42,
        visibilityScope: 'tenant_shared',
        operation: 'chat_route_message',
      });

      expect(scope?.visibilityScope).toBe('tenant_shared');
    });

    it('denies a missing user scope and records a missing_user_scope anomaly', () => {
      const scope = resolveChatTenantScope({
        userId: null,
        tenantId: 7,
        operation: 'chat_route_message',
        details: { source: 'test' },
      });

      expect(scope).toBeNull();
      const anomalies = getTenantScopeAnomalies();
      expect(anomalies).toHaveLength(1);
      expect(anomalies[0]).toMatchObject({
        layer: 'delivery',
        operation: 'chat_route_message',
        reason: 'missing_user_scope',
        userId: null,
        details: { source: 'test' },
      });
    });

    it('denies an invalid user scope and records an invalid_user_scope anomaly', () => {
      for (const userId of [0, -1, 1.5, Number.NaN]) {
        clearTenantScopeAnomaliesForTests();
        expect(resolveChatTenantScope({ userId, operation: 'chat_route_message' })).toBeNull();
        expect(getTenantScopeAnomalies()[0]).toMatchObject({
          reason: 'invalid_user_scope',
          operation: 'chat_route_message',
        });
      }
    });

    it('ignores an invalid tenant hint instead of denying a valid user', () => {
      // Cross-tenant safety: an invalid tenant id can never select another
      // scope; it degrades to the caller's own user-backed tenant.
      const scope = resolveChatTenantScope({
        userId: 42,
        tenantId: -99,
        operation: 'chat_route_message',
      });

      expect(scope?.tenantId).toBe(42);
      expect(getTenantScopeAnomalies()).toHaveLength(0);
    });

    it('records the anomaly under the caller-provided layer', () => {
      resolveChatTenantScope({
        userId: undefined,
        operation: 'chat_history_read',
        layer: 'service',
      });

      expect(getTenantScopeAnomalies()[0]).toMatchObject({
        layer: 'service',
        reason: 'missing_user_scope',
      });
    });
  });

  describe('isActiveChatScopeStatus', () => {
    it('treats active and absent statuses as active, quarantined as inactive', () => {
      expect(isActiveChatScopeStatus('active')).toBe(true);
      expect(isActiveChatScopeStatus(null)).toBe(true);
      expect(isActiveChatScopeStatus(undefined)).toBe(true);
      expect(isActiveChatScopeStatus('')).toBe(true);
      expect(isActiveChatScopeStatus('quarantined')).toBe(false);
      expect(isActiveChatScopeStatus('anything_else')).toBe(false);
    });
  });
});
