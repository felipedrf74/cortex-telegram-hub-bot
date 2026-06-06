import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

let testDb: Database.Database;

vi.mock('../../src/services/database', () => ({
  getDb: () => testDb,
}));

vi.mock('../../src/services/operator-alerts', () => ({
  recordOperatorAlert: vi.fn(),
}));

vi.mock('../../src/utils/logger', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

import { assertTenantScope, requireMutationScope, requireTenantIdParam, TenantScopeError } from '../../src/services/tenant-scope';
import { clearTenantScopeAnomaliesForTests, getTenantScopeAnomalies } from '../../src/services/tenant-scope-observability';

describe('tenant-scope helper', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync('migrations/033_audit_trail.sql', 'utf8'));
    testDb.exec(`
      ALTER TABLE audit_trail ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_audit_trail_tenant_user_ts
        ON audit_trail(tenant_id, user_id, ts);
    `);
    clearTenantScopeAnomaliesForTests();
  });

  it('returns the authenticated user and tenant without falling back to user id', () => {
    expect(assertTenantScope({ userId: 7, tenantId: 70 }, 'test_scope')).toEqual({
      userId: 7,
      tenantId: 70,
    });
  });

  it('rejects missing tenant scope and records an anomaly', () => {
    expect(() => assertTenantScope({ userId: 7 }, 'test_scope_missing_tenant')).toThrow(/tenant scope/i);

    expect(getTenantScopeAnomalies(1)[0]).toMatchObject({
      layer: 'delivery',
      operation: 'test_scope_missing_tenant',
      reason: 'missing_tenant_scope',
      userId: 7,
    });
  });

  it('audits mutation scope checks before writes run', () => {
    const scope = requireMutationScope({
      userId: 7,
      tenantId: 70,
      originalUrl: '/api/v1/decisions/nc_1/actions',
    }, 'notification_center_items', 'decisions_route_action');

    expect(scope).toEqual({ userId: 7, tenantId: 70 });
    const row = testDb.prepare(`
      SELECT tenant_id, user_id, actor_id, action, resource, details
      FROM audit_trail
    `).get() as any;
    expect(row).toMatchObject({
      tenant_id: 70,
      user_id: 7,
      actor_id: 7,
      action: 'mutation_scope',
      resource: 'notification_center_items',
    });
    expect(JSON.parse(row.details)).toMatchObject({
      operation: 'decisions_route_action',
      path: '/api/v1/decisions/nc_1/actions',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
// QA regression pins (skill-hardening 2026-05-18 follow-up, P3-4):
// `requireTenantIdParam` is the service-layer guard used to refuse
// missing/invalid tenantId at the function boundary. Previous QA
// observed it was exercised indirectly via the four service tests but
// had no direct hostile-input test locking the contract. These pins
// fix that.
// ─────────────────────────────────────────────────────────────────────
describe('requireTenantIdParam hostile inputs (P3-4)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.exec(readFileSync('migrations/033_audit_trail.sql', 'utf8'));
    testDb.exec(`
      ALTER TABLE audit_trail ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 0;
    `);
    clearTenantScopeAnomaliesForTests();
  });

  it('returns the value unchanged when given a positive safe integer', () => {
    expect(requireTenantIdParam(42, 'unit_test')).toBe(42);
    expect(requireTenantIdParam(1, 'unit_test')).toBe(1);
    expect(requireTenantIdParam(Number.MAX_SAFE_INTEGER, 'unit_test')).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('throws TenantScopeError on undefined', () => {
    expect(() => requireTenantIdParam(undefined, 'unit_test_undefined')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(undefined, 'unit_test_undefined')).toThrow(/TENANT_SCOPE_REQUIRED|validated tenantId/);
  });

  it('throws TenantScopeError on null', () => {
    expect(() => requireTenantIdParam(null, 'unit_test_null')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on zero', () => {
    expect(() => requireTenantIdParam(0, 'unit_test_zero')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on negative integer', () => {
    expect(() => requireTenantIdParam(-1, 'unit_test_negative')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(-999, 'unit_test_negative')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on NaN', () => {
    expect(() => requireTenantIdParam(NaN, 'unit_test_nan')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on Infinity', () => {
    expect(() => requireTenantIdParam(Infinity, 'unit_test_infinity')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(-Infinity, 'unit_test_infinity')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on non-safe-integer floats', () => {
    expect(() => requireTenantIdParam(1.5, 'unit_test_float')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(0.001, 'unit_test_float')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(Number.MAX_SAFE_INTEGER + 1, 'unit_test_float')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on string inputs (no implicit coercion)', () => {
    expect(() => requireTenantIdParam('42' as any, 'unit_test_string')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam('' as any, 'unit_test_string')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam('abc' as any, 'unit_test_string')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on boolean inputs', () => {
    expect(() => requireTenantIdParam(true as any, 'unit_test_bool')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam(false as any, 'unit_test_bool')).toThrow(TenantScopeError);
  });

  it('throws TenantScopeError on objects and arrays', () => {
    expect(() => requireTenantIdParam({ tenantId: 42 } as any, 'unit_test_obj')).toThrow(TenantScopeError);
    expect(() => requireTenantIdParam([42] as any, 'unit_test_arr')).toThrow(TenantScopeError);
  });

  it('error carries code TENANT_SCOPE_REQUIRED + status 400', () => {
    try {
      requireTenantIdParam(undefined, 'unit_test_shape');
      throw new Error('expected throw did not fire');
    } catch (err: any) {
      expect(err).toBeInstanceOf(TenantScopeError);
      expect(err.code).toBe('TENANT_SCOPE_REQUIRED');
      expect(err.status).toBe(400);
      expect(err.name).toBe('TenantScopeError');
    }
  });

  it('records a service-layer anomaly with the context name', () => {
    try { requireTenantIdParam(undefined, 'my_service_function'); } catch { /* expected */ }

    const anomaly = getTenantScopeAnomalies(1)[0];
    expect(anomaly).toMatchObject({
      layer: 'service',
      operation: 'my_service_function',
      reason: 'missing_tenant_scope',
    });
  });
});
