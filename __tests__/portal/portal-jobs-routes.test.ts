import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigratedTestDatabase } from '../../src/testing/migrated-test-database';

interface FakeJob {
  name: string;
  label: string;
  cronExpression: string;
  domain: string;
  lastRunAt: string | null;
  lastResult: 'success' | 'failed' | 'running' | 'never';
  lastDurationMs: number | null;
  lastError: string | null;
  wrappedFn?: () => Promise<void>;
}

const hoisted = vi.hoisted(() => ({
  db: null as null | InstanceType<typeof import('better-sqlite3')>,
  jobMap: new Map<string, FakeJob>(),
  disabled: new Set<string>(),
  manifestJobs: [] as Record<string, unknown>[],
  pausedAgents: new Set<string>(),
  cooldowns: new Map<string, number>(),
  logPortalAdminMutation: vi.fn(),
  sendPortalInternalError: vi.fn(),
}));

vi.mock('../../src/services/database', () => ({ getDb: () => hoisted.db }));
vi.mock('../../src/config', () => ({ config: { app: { timezone: 'UTC' } } }));
vi.mock('../../src/api/secret-guards', () => ({
  requirePortalAdminToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../src/portal/admin-audit', () => ({ logPortalAdminMutation: hoisted.logPortalAdminMutation }));
vi.mock('../../src/portal/http', () => ({ sendPortalInternalError: hoisted.sendPortalInternalError }));
vi.mock('../../src/utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/portal/telemetry', () => ({
  getJobMap: () => hoisted.jobMap,
  getJobStatuses: () => [...hoisted.jobMap.values()].map(({ wrappedFn: _fn, ...rest }) => rest),
  isJobEnabled: (name: string) => !hoisted.disabled.has(name),
}));
vi.mock('../../src/services/agent-job-manifest', () => ({
  loadAgentJobManifest: () => ({ jobs: hoisted.manifestJobs }),
}));
vi.mock('../../src/services/content-agent-lifecycle', () => ({
  isPausedContentAgent: (id: string) => hoisted.pausedAgents.has(id),
}));
vi.mock('../../src/portal/actions', () => ({
  PORTAL_ACTION_COOLDOWN_MS: 30_000,
  isPortalActionRateLimited: (action: string) => Date.now() - (hoisted.cooldowns.get(action) ?? 0) < 30_000,
  recordPortalAction: (action: string) => { hoisted.cooldowns.set(action, Date.now()); },
}));

import { registerPortalJobsRoutes, resolveManualRunPolicy } from '../../src/portal/jobs-routes';

type Handler = (req: any, res: any) => void;

function makeApp() {
  const routes = new Map<string, Handler[]>();
  const app = {
    get: vi.fn((p: string, ...h: Handler[]) => { routes.set(`GET ${p}`, h); }),
    post: vi.fn((p: string, ...h: Handler[]) => { routes.set(`POST ${p}`, h); }),
  };
  registerPortalJobsRoutes(app as any);
  return { app, routes };
}

function call(routes: Map<string, Handler[]>, key: string, req: any = {}) {
  const handlers = routes.get(key);
  if (!handlers) throw new Error(`route ${key} not registered`);
  const payload: { statusCode: number; body?: any; headers: Record<string, string> } = { statusCode: 200, headers: {} };
  const res: any = {
    status: (c: number) => { payload.statusCode = c; return res; },
    json: (b: unknown) => { payload.body = b; return res; },
    setHeader: (k: string, v: string) => { payload.headers[k.toLowerCase()] = v; },
  };
  handlers[handlers.length - 1]({ query: {}, params: {}, body: {}, ...req }, res);
  return payload;
}

function job(name: string, overrides: Partial<FakeJob> = {}): FakeJob {
  return {
    name,
    label: name.replace(/_/g, ' '),
    cronExpression: '0 3 * * *',
    domain: 'system',
    lastRunAt: null,
    lastResult: 'never',
    lastDurationMs: null,
    lastError: null,
    wrappedFn: vi.fn(async () => {}),
    ...overrides,
  };
}

function manifest(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: id.replace(/_/g, ' '),
    schedule: '0 3 * * *',
    domain: 'system',
    lifecycle: 'active',
    policyOwner: 'platform',
    jobVersion: '1.0.0',
    providerUsage: 'none',
    costPolicy: 'no-model-provider-cost',
    overlapPolicy: 'durable-database-lease',
    retryPolicy: 'next-scheduled-run',
    notificationPolicy: 'job-specific',
    ...overrides,
  };
}

beforeEach(() => {
  hoisted.db = createMigratedTestDatabase();
  hoisted.jobMap.clear();
  hoisted.disabled.clear();
  hoisted.pausedAgents.clear();
  hoisted.cooldowns.clear();
  hoisted.manifestJobs = [];
  hoisted.logPortalAdminMutation.mockClear();
  hoisted.sendPortalInternalError.mockClear();
});

afterEach(() => {
  (hoisted.db as Database.Database | null)?.close();
});

describe('resolveManualRunPolicy', () => {
  it('denies paused and disabled jobs, asks confirmation for provider-capable jobs, allows the rest', () => {
    const governed = manifest('x', { providerUsage: 'governed-provider-capable' }) as any;
    expect(resolveManualRunPolicy({ lifecycle: 'paused', enabled: true, manifest: governed }).policy).toBe('deny');
    expect(resolveManualRunPolicy({ lifecycle: 'active', enabled: false, manifest: governed })).toEqual({ policy: 'deny', reason: 'owning sub-skill disabled' });
    expect(resolveManualRunPolicy({ lifecycle: 'active', enabled: true, manifest: governed }).policy).toBe('confirm');
    expect(resolveManualRunPolicy({ lifecycle: 'active', enabled: true, manifest: null })).toEqual({ policy: 'allow', reason: null });
  });
});

describe('GET /api/jobs', () => {
  it('merges telemetry, manifest governance, next run, 24h stats and the manual policy', () => {
    hoisted.jobMap.set('nightly_cleanup', job('nightly_cleanup', { lastResult: 'success', lastRunAt: '2026-09-04T03:00:00.000Z', lastDurationMs: 1200 }));
    hoisted.jobMap.set('content_digest', job('content_digest', { domain: 'content', cronExpression: '*/15 * * * *' }));
    hoisted.jobMap.set('paused_agent', job('paused_agent', { domain: 'content' }));
    hoisted.jobMap.set('orphan_job', job('orphan_job', { wrappedFn: undefined }));
    hoisted.manifestJobs = [
      manifest('nightly_cleanup'),
      manifest('content_digest', { domain: 'content', providerUsage: 'governed-provider-capable', policyOwner: 'content' }),
      manifest('paused_agent', { domain: 'content', lifecycle: 'paused' }),
    ];
    hoisted.disabled.add('orphan_job');
    const insert = hoisted.db!.prepare("INSERT INTO job_history (job_name, result, duration_ms, ts) VALUES (?, ?, ?, datetime('now', ?))");
    insert.run('nightly_cleanup', 'success', 1000, '-1 hours');
    insert.run('nightly_cleanup', 'success', 3000, '-2 hours');
    insert.run('nightly_cleanup', 'failed', 500, '-3 hours');
    insert.run('nightly_cleanup', 'success', 9000, '-3 days');

    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/jobs');
    expect(payload.statusCode).toBe(200);
    expect(payload.headers['cache-control']).toBe('no-store');
    expect(payload.body.timezone).toBe('UTC');
    expect(payload.body.cooldownMs).toBe(30_000);

    const byName = new Map<string, any>(payload.body.jobs.map((j: any) => [j.name, j]));
    expect([...byName.keys()]).toEqual(['content_digest', 'paused_agent', 'nightly_cleanup', 'orphan_job']);

    const cleanup = byName.get('nightly_cleanup');
    expect(cleanup.lifecycle).toBe('active');
    expect(cleanup.manual).toEqual({ policy: 'allow', reason: null });
    expect(cleanup.governance).toMatchObject({ policyOwner: 'platform', providerUsage: 'none', jobVersion: '1.0.0' });
    expect(cleanup.stats24h).toEqual({ runs: 3, failed: 1, avgDurationMs: 1500 });
    expect(cleanup.nextRunAt).toMatch(/T03:00:00\.000Z$/);
    expect(cleanup.runnerAvailable).toBe(true);
    expect(cleanup.cooldownRemainingMs).toBe(0);

    expect(byName.get('content_digest').manual).toEqual({ policy: 'confirm', reason: 'may call governed AI providers' });
    expect(byName.get('paused_agent')).toMatchObject({ lifecycle: 'paused', nextRunAt: null, manual: { policy: 'deny' } });
    expect(byName.get('orphan_job')).toMatchObject({ enabled: false, governance: null, runnerAvailable: false, manual: { policy: 'deny', reason: 'owning sub-skill disabled' } });
  });

  it('treats content-agent lifecycle pauses as paused even without a manifest entry', () => {
    hoisted.jobMap.set('legacy_agent', job('legacy_agent'));
    hoisted.pausedAgents.add('legacy_agent');
    const { routes } = makeApp();
    expect(call(routes, 'GET /api/jobs').body.jobs[0]).toMatchObject({ lifecycle: 'paused', manual: { policy: 'deny' } });
  });
});

describe('GET /api/jobs/:name/history', () => {
  it('returns recent rows newest first and 404s unknown jobs', () => {
    hoisted.jobMap.set('nightly_cleanup', job('nightly_cleanup'));
    const insert = hoisted.db!.prepare("INSERT INTO job_history (job_name, result, duration_ms, error_message, ts) VALUES (?, ?, ?, ?, datetime('now', ?))");
    insert.run('nightly_cleanup', 'failed', 10, 'disk full', '-2 hours');
    insert.run('nightly_cleanup', 'success', 20, null, '-1 hours');
    insert.run('other_job', 'success', 30, null, '-1 hours');

    const { routes } = makeApp();
    const payload = call(routes, 'GET /api/jobs/:name/history', { params: { name: 'nightly_cleanup' } });
    expect(payload.statusCode).toBe(200);
    expect(payload.body.history.map((row: any) => row.result)).toEqual(['success', 'failed']);
    expect(payload.body.history[1]).toMatchObject({ durationMs: 10, errorMessage: 'disk full' });

    expect(call(routes, 'GET /api/jobs/:name/history', { params: { name: 'nightly_cleanup' }, query: { limit: '1' } }).body.history).toHaveLength(1);
    expect(call(routes, 'GET /api/jobs/:name/history', { params: { name: 'ghost' } }).statusCode).toBe(404);
    expect(call(routes, 'GET /api/jobs/:name/history', { params: { name: 'bad name!' } }).statusCode).toBe(404);
  });
});

describe('POST /api/jobs/:name/run', () => {
  it('requires the admin guard', () => {
    const { routes } = makeApp();
    expect(routes.get('POST /api/jobs/:name/run')).toHaveLength(2);
  });

  it('starts an allowed job once, audits it, and enforces the cooldown', async () => {
    const run = vi.fn(async () => {});
    hoisted.jobMap.set('nightly_cleanup', job('nightly_cleanup', { wrappedFn: run }));
    hoisted.manifestJobs = [manifest('nightly_cleanup')];
    const { routes } = makeApp();

    const first = call(routes, 'POST /api/jobs/:name/run', { params: { name: 'nightly_cleanup' } });
    expect(first.statusCode).toBe(202);
    expect(first.body).toEqual({ ok: true, started: true, job: 'nightly_cleanup', policy: 'allow' });
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 0, 'job.run', { job: 'nightly_cleanup', policy: 'allow', confirmed: false });

    const second = call(routes, 'POST /api/jobs/:name/run', { params: { name: 'nightly_cleanup' } });
    expect(second.statusCode).toBe(429);
    expect(run).toHaveBeenCalledTimes(1);
    expect(call(routes, 'GET /api/jobs').body.jobs[0].cooldownRemainingMs).toBe(30_000);
  });

  it('requires explicit confirmation for provider-capable jobs', async () => {
    const run = vi.fn(async () => {});
    hoisted.jobMap.set('content_digest', job('content_digest', { wrappedFn: run }));
    hoisted.manifestJobs = [manifest('content_digest', { providerUsage: 'governed-provider-capable' })];
    const { routes } = makeApp();

    const unconfirmed = call(routes, 'POST /api/jobs/:name/run', { params: { name: 'content_digest' } });
    expect(unconfirmed.statusCode).toBe(400);
    expect(unconfirmed.body.policy.policy).toBe('confirm');
    expect(run).not.toHaveBeenCalled();

    const confirmed = call(routes, 'POST /api/jobs/:name/run', { params: { name: 'content_digest' }, body: { confirm: true } });
    expect(confirmed.statusCode).toBe(202);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);
    expect(hoisted.logPortalAdminMutation).toHaveBeenCalledWith(expect.anything(), 0, 'job.run', { job: 'content_digest', policy: 'confirm', confirmed: true });
  });

  it('denies paused and disabled jobs, and refuses running or runner-less jobs', () => {
    hoisted.jobMap.set('paused_agent', job('paused_agent'));
    hoisted.jobMap.set('disabled_job', job('disabled_job'));
    hoisted.jobMap.set('busy_job', job('busy_job', { lastResult: 'running' }));
    hoisted.jobMap.set('no_runner', job('no_runner', { wrappedFn: undefined }));
    hoisted.manifestJobs = [manifest('paused_agent', { lifecycle: 'paused' })];
    hoisted.disabled.add('disabled_job');
    const { routes } = makeApp();

    expect(call(routes, 'POST /api/jobs/:name/run', { params: { name: 'paused_agent' } }).statusCode).toBe(403);
    expect(call(routes, 'POST /api/jobs/:name/run', { params: { name: 'disabled_job' } }).statusCode).toBe(403);
    expect(call(routes, 'POST /api/jobs/:name/run', { params: { name: 'busy_job' } }).statusCode).toBe(409);
    expect(call(routes, 'POST /api/jobs/:name/run', { params: { name: 'no_runner' } }).statusCode).toBe(409);
    expect(call(routes, 'POST /api/jobs/:name/run', { params: { name: 'ghost' } }).statusCode).toBe(404);
    expect(hoisted.logPortalAdminMutation).not.toHaveBeenCalled();
  });

  it('logs runner rejections instead of surfacing them to the client', async () => {
    const run = vi.fn(async () => { throw new Error('runner exploded'); });
    hoisted.jobMap.set('flaky', job('flaky', { wrappedFn: run }));
    const { routes } = makeApp();
    const payload = call(routes, 'POST /api/jobs/:name/run', { params: { name: 'flaky' } });
    expect(payload.statusCode).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hoisted.sendPortalInternalError).not.toHaveBeenCalled();
  });
});
