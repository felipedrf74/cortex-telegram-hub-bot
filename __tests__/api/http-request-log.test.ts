import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetHttpRequestLogForTests,
  attachHttpRequestLogDb,
  classifySurface,
  flushHttpRequestLog,
  getLatencyFromLog,
  hashClientIp,
  normalizeRoute,
  pruneHttpRequestLog,
  queryHttpRequests,
  recordHttpRequest,
  shouldStoreRequest,
  type HttpRequestLogEntry,
} from '../../src/api/http-request-log';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

let db: Database.Database;

beforeEach(() => {
  _resetHttpRequestLogForTests();
  db = createMigratedTestDatabase();
  attachHttpRequestLogDb(() => db);
});

afterEach(() => {
  _resetHttpRequestLogForTests();
  db.close();
});

function entry(overrides: Partial<HttpRequestLogEntry> = {}): HttpRequestLogEntry {
  return {
    ts: new Date().toISOString(),
    reqId: 'req-1',
    surface: 'ios',
    method: 'GET',
    path: '/api/v1/tasks/123',
    route: '/api/v1/tasks/:id',
    status: 200,
    durationMs: 12,
    userId: 4,
    ipHash: 'abc',
    userAgent: 'NexusHub/1.0',
    bytesOut: 120,
    sampled: false,
    ...overrides,
  };
}

describe('http request log', () => {
  it('normalises dynamic path segments and classifies surfaces', () => {
    expect(normalizeRoute('/api/v1/tasks/123/items/8f14e45f-ceea-467a-9575-6d3f0a4c0d2b')).toBe('/api/v1/tasks/:id/items/:id');
    expect(normalizeRoute('/api/ops/requests/req_0123456789abcdef0123456789')).toBe('/api/ops/requests/:id');
    expect(normalizeRoute('/health?x=1')).toBe('/health');
    expect(classifySurface('/api/v1/dashboard')).toBe('ios');
    expect(classifySurface('/api/snapshot')).toBe('portal');
    expect(classifySurface('/webhooks/todoist')).toBe('webhook');
    expect(classifySurface('/health/detailed')).toBe('health');
    expect(classifySurface('/oauth/google/callback')).toBe('oauth');
    expect(classifySurface('/waitlist')).toBe('public');
    expect(classifySurface('/admin')).toBe('static');
  });

  it('always stores failures, slow requests and portal mutations; samples the rest', () => {
    const never = () => 0.99;
    const always = () => 0;
    expect(shouldStoreRequest({ path: '/api/v1/x', surface: 'ios', method: 'GET', status: 500, durationMs: 1 }, { random: never })).toEqual({ store: true, sampled: false });
    expect(shouldStoreRequest({ path: '/api/v1/x', surface: 'ios', method: 'GET', status: 200, durationMs: 900 }, { random: never })).toEqual({ store: true, sampled: false });
    expect(shouldStoreRequest({ path: '/api/settings', surface: 'portal', method: 'PUT', status: 200, durationMs: 5 }, { random: never })).toEqual({ store: true, sampled: false });
    expect(shouldStoreRequest({ path: '/api/v1/x', surface: 'ios', method: 'GET', status: 200, durationMs: 5 }, { random: never, sampleRate: 0.1 })).toEqual({ store: false, sampled: true });
    expect(shouldStoreRequest({ path: '/api/v1/x', surface: 'ios', method: 'GET', status: 200, durationMs: 5 }, { random: always, sampleRate: 0.1 })).toEqual({ store: true, sampled: true });
    expect(shouldStoreRequest({ path: '/health', surface: 'health', method: 'GET', status: 503, durationMs: 5 }, { random: () => 0.5 })).toEqual({ store: false, sampled: true });
  });

  it('hashes client IPs with a salt and never stores the raw address', () => {
    const a = hashClientIp('203.0.113.9', { HTTP_LOG_IP_SALT: 's1' });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hashClientIp('203.0.113.9', { HTTP_LOG_IP_SALT: 's1' })).toBe(a);
    expect(hashClientIp('203.0.113.9', { HTTP_LOG_IP_SALT: 's2' })).not.toBe(a);
    expect(hashClientIp(undefined)).toBeNull();
  });

  it('batches rows, queries by request id/user/status/path and pages', () => {
    recordHttpRequest(entry({ reqId: 'r1' }));
    recordHttpRequest(entry({ reqId: 'r2', status: 404, userId: 9, path: '/api/v1/other' }));
    recordHttpRequest(entry({ reqId: 'r3', status: 502, surface: 'portal', method: 'POST', path: '/api/settings', route: '/api/settings', durationMs: 640 }));
    flushHttpRequestLog();

    expect(queryHttpRequests(db, { reqId: 'r2' })[0]).toMatchObject({ reqId: 'r2', status: 404, userId: 9 });
    expect(queryHttpRequests(db, { statusClass: 5 }).map((r) => r.reqId)).toEqual(['r3']);
    expect(queryHttpRequests(db, { path: '/api/v1/' })).toHaveLength(2);
    expect(queryHttpRequests(db, { minDurationMs: 500 })).toHaveLength(1);
    expect(queryHttpRequests(db, { surface: 'portal' })[0].method).toBe('POST');
    const first = queryHttpRequests(db, { limit: 1 });
    expect(queryHttpRequests(db, { beforeId: first[0].id, limit: 1 })[0].reqId).toBe('r2');
  });

  it('computes per-route latency percentiles and error rates', () => {
    for (let i = 1; i <= 20; i += 1) {
      recordHttpRequest(entry({ reqId: `r${i}`, durationMs: i * 10, status: i === 20 ? 500 : 200 }));
    }
    recordHttpRequest(entry({ reqId: 'x', route: '/api/v1/chat', path: '/api/v1/chat', method: 'POST', durationMs: 300 }));
    flushHttpRequestLog();

    const latency = getLatencyFromLog(db, 60);
    const tasks = latency.find((r) => r.route === '/api/v1/tasks/:id')!;
    expect(latency[0].route).toBe('/api/v1/tasks/:id');
    expect(tasks).toMatchObject({ count: 20, errorCount: 1, errorRate: 0.05, p50Ms: 100, p95Ms: 190, p99Ms: 200, maxMs: 200 });
    expect(latency.find((r) => r.route === '/api/v1/chat')).toMatchObject({ method: 'POST', count: 1, p50Ms: 300 });
  });

  it('prunes by age and row cap', () => {
    for (let i = 0; i < 5; i += 1) recordHttpRequest(entry({ reqId: `old${i}`, ts: new Date(Date.now() - 10 * 86_400_000).toISOString() }));
    for (let i = 0; i < 5; i += 1) recordHttpRequest(entry({ reqId: `new${i}` }));
    flushHttpRequestLog();
    expect(pruneHttpRequestLog(db, { maxAgeDays: 7, maxRows: 2 })).toEqual({ byAge: 5, byCount: 3 });
    expect(queryHttpRequests(db)).toHaveLength(2);
  });
});
