import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  CHAT_LIVE_EVAL_REAL_BUDGET,
} from '../../src/services/chat-live-evaluation-contract';

let db: Database.Database;
const prepareMock = vi.hoisted(() => vi.fn());
const routeMocks = vi.hoisted(() => ({
  principalEmail: 'nexushubbot@gmail.com',
  getEffectiveEntitlement: vi.fn(),
  checkSkillAccess: vi.fn(),
}));

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: () => db,
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual('../../src/services/user-service')),
  getUserById: () => ({ id: 42, email: routeMocks.principalEmail }),
}));
vi.mock('../../src/services/entitlement', async () => ({
  ...(await vi.importActual('../../src/services/entitlement')),
  getEffectiveEntitlement: (...args: unknown[]) => routeMocks.getEffectiveEntitlement(...args),
}));
vi.mock('../../src/services/skill-tiers', async () => ({
  ...(await vi.importActual('../../src/services/skill-tiers')),
  checkSkillAccess: (...args: unknown[]) => routeMocks.checkSkillAccess(...args),
}));
vi.mock('../../src/api/secret-guards', async () => ({
  ...(await vi.importActual('../../src/api/secret-guards')),
  isLoopbackRequest: () => true,
}));
vi.mock('../../src/services/chat-live-evaluation-state', () => ({
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION: 'single-tenant-live-v3',
  prepareChatLiveEvalScenario: (...args: unknown[]) => prepareMock(...args),
}));

import {
  isPrivateDockerGatewayRequest,
  registerChatEvalRoutes,
} from '../../src/api/routes/chat-eval-routes';

type Handler = (req: any, res: any) => unknown;

function routes() {
  const handlers = new Map<string, Handler>();
  const router = {
    get: vi.fn((path: string, handler: Handler) => handlers.set(`GET ${path}`, handler)),
    post: vi.fn((path: string, handler: Handler) => handlers.set(`POST ${path}`, handler)),
  };
  registerChatEvalRoutes(router as any, (() => true) as any);
  return handlers;
}

function request(
  phase: 'preflight' | 'reset' | 'evidence',
  body?: unknown,
  mode: 'local_engine' | 'real_provider' = 'local_engine',
) {
  const budget = mode === 'local_engine' ? CHAT_LIVE_EVAL_LOCAL_BUDGET : CHAT_LIVE_EVAL_REAL_BUDGET;
  const headers: Record<string, string> = {
    'x-nexus-chat-eval-contract': CHAT_LIVE_EVAL_CONTRACT_VERSION,
    'x-nexus-chat-eval-mode': mode,
    'x-nexus-chat-eval-run-id': 'chat-eval-route-test',
    'x-nexus-chat-eval-total-budget-usd': String(budget.totalCeilingUsd),
    'x-nexus-chat-eval-target-budget-usd': String(budget.targetCeilingUsd),
    'x-nexus-chat-eval-judge-budget-usd': String(budget.judgeCeilingUsd),
    ...(phase === 'reset' ? { 'x-nexus-chat-eval-scenario-id': 'morning_planning' } : {}),
  };
  return {
    userId: 42,
    tenantId: 42,
    body,
    header: (name: string) => headers[name.toLowerCase()],
  };
}

function response() {
  const state = { status: 200, body: null as unknown, headers: {} as Record<string, string> };
  const res: any = {
    setHeader: (key: string, value: string) => { state.headers[key] = value; },
    status: (status: number) => { state.status = status; return res; },
    json: (body: unknown) => { state.body = body; return res; },
  };
  return { state, res };
}

const DEPLOYED_SHA = 'c'.repeat(40);
const DEPLOYED_DIGEST = 'd'.repeat(64);

/** Mirrors what the release transaction exports into the serving process. */
function stubDeployedStagingRelease(overrides: Record<string, string | undefined> = {}): void {
  const values: Record<string, string | undefined> = {
    NEXUS_RELEASE_SHA: DEPLOYED_SHA,
    NEXUS_RELEASE_ARTIFACT_SHA256: DEPLOYED_DIGEST,
    NEXUS_RELEASE_ROLE: 'staging',
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) {
    vi.stubEnv(name, value as string);
  }
}

describe('authenticated chat live-eval routes', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('NEXUS_LOCAL_ALLOW_MODEL_CALLS', '1');
    vi.stubEnv('OLLAMA_ENABLED', 'true');
    vi.stubEnv('AI_CLASSIFY_PRIMARY', 'ollama');
    vi.stubEnv('AI_CLASSIFY_FALLBACK', 'none');
    vi.stubEnv('AI_CHAT_PRIMARY', 'ollama');
    vi.stubEnv('AI_CHAT_FALLBACK', 'none');
    vi.stubEnv('AI_TOOL_USE_PRIMARY', 'ollama');
    vi.stubEnv('AI_TOOL_USE_FALLBACK', 'none');
    vi.stubEnv('NEXUS_LOCAL_IOS_EMAIL', 'nexushubbot@gmail.com');
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) vi.stubEnv(key, '');
    prepareMock.mockReset();
    routeMocks.principalEmail = 'nexushubbot@gmail.com';
    routeMocks.getEffectiveEntitlement.mockReset();
    routeMocks.getEffectiveEntitlement.mockReturnValue({ plan: 'max', aiAccessAllowed: true });
    routeMocks.checkSkillAccess.mockReset();
    routeMocks.checkSkillAccess.mockReturnValue({ allowed: true });
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_usage (
        user_id INTEGER, tenant_id INTEGER, request_source TEXT, base_category TEXT, job_name TEXT, run_id TEXT,
        provider TEXT, category TEXT, cost_usd REAL, pricing_status TEXT
      );
      CREATE TABLE ai_provider_attempt_reservations (
        user_id INTEGER, request_source TEXT, base_category TEXT, job_name TEXT, run_id TEXT,
        provider TEXT, reserved_cost_usd REAL
      );
      CREATE TABLE chat_live_eval_preparations (
        run_id TEXT, scenario_id TEXT, mode TEXT, user_id INTEGER, tenant_id INTEGER,
        seed_profile_version TEXT, seed_profile_hash TEXT, reset_counts_json TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
  });

  it('recognizes only a private bridge gateway from the direct socket address', () => {
    const requestFrom = (remoteAddress: string, forwardedFor?: string) => ({
      ip: forwardedFor ?? remoteAddress,
      socket: { remoteAddress },
    });

    expect(isPrivateDockerGatewayRequest(requestFrom('172.18.0.1') as any)).toBe(true);
    expect(isPrivateDockerGatewayRequest(requestFrom('10.42.0.1') as any)).toBe(true);
    expect(isPrivateDockerGatewayRequest(requestFrom('192.168.65.1') as any)).toBe(true);
    expect(isPrivateDockerGatewayRequest(requestFrom('172.18.0.2') as any)).toBe(false);
    expect(isPrivateDockerGatewayRequest(requestFrom('203.0.113.1') as any)).toBe(false);
    expect(isPrivateDockerGatewayRequest(requestFrom('203.0.113.1', '127.0.0.1') as any)).toBe(false);
  });

  it('returns a sanitized authenticated preflight contract with no credentials', () => {
    const handler = routes().get('GET /eval/preflight')!;
    const { state, res } = response();
    handler(request('preflight'), res);

    expect(state.status).toBe(200);
    expect(state.headers['Cache-Control']).toContain('no-store');
    expect(state.body).toMatchObject({
      ok: true,
      data: {
        contractVersion: CHAT_LIVE_EVAL_CONTRACT_VERSION,
        runId: 'chat-eval-route-test',
        providerPolicy: 'ollama_only_zero_cloud',
        productionDataUsed: false,
        seedProfileVersion: 'single-tenant-live-v3',
      },
    });
    expect(JSON.stringify(state.body)).not.toContain('API_KEY');
  });

  it('rejects real-provider preflight before spend when scenario skill access is incomplete', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    stubDeployedStagingRelease();
    vi.stubEnv('AI_CLASSIFY_PRIMARY', 'gemini');
    vi.stubEnv('AI_CLASSIFY_FALLBACK', 'none');
    vi.stubEnv('AI_CHAT_PRIMARY', 'gemini');
    vi.stubEnv('AI_CHAT_FALLBACK', 'none');
    vi.stubEnv('AI_TOOL_USE_PRIMARY', 'gemini');
    vi.stubEnv('AI_TOOL_USE_FALLBACK', 'none');
    vi.stubEnv('GEMINI_API_KEY', 'test-only-gemini-key');
    vi.stubEnv('PAID_AI_COST_CONTROLS_ENFORCEMENT_ENABLED', 'false');
    routeMocks.principalEmail = 'chat-eval@nexus.invalid';
    routeMocks.getEffectiveEntitlement.mockReturnValue({ plan: 'free', aiAccessAllowed: false });
    routeMocks.checkSkillAccess.mockImplementation((_user: unknown, skillId: string) => ({
      allowed: skillId !== 'content',
    }));

    const handler = routes().get('GET /eval/preflight')!;
    const { state, res } = response();
    handler(request('preflight', undefined, 'real_provider'), res);

    expect(state.status).toBe(403);
    expect(state.body).toEqual({
      error: {
        code: 'CHAT_LIVE_EVAL_DISABLED',
        message: 'Real-provider chat evaluation requires complete dedicated-tenant scenario access.',
      },
    });
  });

  it('rejects beta access even when runtime AI enforcement is observe-only', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    stubDeployedStagingRelease();
    vi.stubEnv('AI_CLASSIFY_PRIMARY', 'gemini');
    vi.stubEnv('AI_CLASSIFY_FALLBACK', 'none');
    vi.stubEnv('AI_CHAT_PRIMARY', 'gemini');
    vi.stubEnv('AI_CHAT_FALLBACK', 'none');
    vi.stubEnv('AI_TOOL_USE_PRIMARY', 'gemini');
    vi.stubEnv('AI_TOOL_USE_FALLBACK', 'none');
    vi.stubEnv('GEMINI_API_KEY', 'test-only-gemini-key');
    routeMocks.principalEmail = 'chat-eval@nexus.invalid';
    routeMocks.getEffectiveEntitlement.mockReturnValue({
      plan: 'beta',
      source: 'beta',
      aiAccessAllowed: false,
      allowedSkills: new Set(['secretary', 'triathlon', 'content', 'cooking', 'finance']),
    });
    const handler = routes().get('GET /eval/preflight')!;
    const { state, res } = response();
    handler(request('preflight', undefined, 'real_provider'), res);

    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({
      error: { code: 'CHAT_LIVE_EVAL_DISABLED' },
    });
  });

  it('admits a dedicated real-provider tenant only after every scenario access check passes', () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    stubDeployedStagingRelease();
    vi.stubEnv('AI_CLASSIFY_PRIMARY', 'gemini');
    vi.stubEnv('AI_CLASSIFY_FALLBACK', 'none');
    vi.stubEnv('AI_CHAT_PRIMARY', 'gemini');
    vi.stubEnv('AI_CHAT_FALLBACK', 'none');
    vi.stubEnv('AI_TOOL_USE_PRIMARY', 'gemini');
    vi.stubEnv('AI_TOOL_USE_FALLBACK', 'none');
    vi.stubEnv('GEMINI_API_KEY', 'test-only-gemini-key');
    routeMocks.principalEmail = 'chat-eval@nexus.invalid';
    routeMocks.getEffectiveEntitlement.mockReturnValue({
      userId: 42,
      plan: 'max',
      source: 'founder',
      aiAccessAllowed: true,
      allowedSkills: new Set(['secretary', 'triathlon', 'content', 'cooking', 'finance']),
    });

    const handler = routes().get('GET /eval/preflight')!;
    const { state, res } = response();
    handler(request('preflight', undefined, 'real_provider'), res);

    expect(state.status).toBe(200);
    expect(state.body).toMatchObject({
      ok: true,
      data: {
        providerPolicy: 'metered_cloud_only',
        productionDataUsed: false,
        // The runner binds its evidence to this server-attested identity
        // instead of to the operator's local checkout.
        deployedRelease: {
          runtimeSha: DEPLOYED_SHA,
          artifactDigest: DEPLOYED_DIGEST,
          role: 'staging',
        },
      },
    });
    expect(routeMocks.checkSkillAccess.mock.calls.map((call) => call[1])).toEqual([
      'secretary.calendar',
      'secretary.tasks',
      'triathlon',
      'content',
      'cooking',
      'finance',
    ]);
  });

  it.each([
    ['an unattested process', { NEXUS_RELEASE_SHA: undefined, NEXUS_RELEASE_ARTIFACT_SHA256: undefined, NEXUS_RELEASE_ROLE: undefined }],
    ['the ecosystem placeholder identity', { NEXUS_RELEASE_SHA: 'unknown', NEXUS_RELEASE_ARTIFACT_SHA256: 'unknown' }],
    ['a production release', { NEXUS_RELEASE_ROLE: 'production' }],
  ])('refuses real-provider preflight from %s before any spend', (_label, overrides) => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('STAGING', 'true');
    vi.stubEnv('CHAT_EVAL_DEDICATED_TENANT_ID', '42');
    stubDeployedStagingRelease(overrides);
    vi.stubEnv('GEMINI_API_KEY', 'test-only-gemini-key');
    routeMocks.principalEmail = 'chat-eval@nexus.invalid';
    routeMocks.getEffectiveEntitlement.mockReturnValue({
      userId: 42,
      plan: 'max',
      source: 'founder',
      aiAccessAllowed: true,
      allowedSkills: new Set(['secretary', 'triathlon', 'content', 'cooking', 'finance']),
    });

    const handler = routes().get('GET /eval/preflight')!;
    const { state, res } = response();
    handler(request('preflight', undefined, 'real_provider'), res);

    expect(state.status).toBe(403);
    expect(state.body).toMatchObject({ error: { code: 'CHAT_LIVE_EVAL_DISABLED' } });
    expect(routeMocks.getEffectiveEntitlement).not.toHaveBeenCalled();
  });

  it('accepts only the header-bound scenario and never accepts client seed data', () => {
    prepareMock.mockReturnValue({
      scenarioId: 'morning_planning',
      seedProfileVersion: 'single-tenant-live-v3',
      seedProfileHash: 'a'.repeat(64),
      resetCounts: {},
    });
    const handler = routes().get('POST /eval/scenario/reset')!;
    const rejected = response();
    handler(request('reset', { scenarioId: 'morning_planning', contextSeeds: ['private'] }), rejected.res);
    expect(rejected.state.status).toBe(400);
    expect(prepareMock).not.toHaveBeenCalled();

    const accepted = response();
    handler(request('reset', { scenarioId: 'morning_planning' }), accepted.res);
    expect(accepted.state.status).toBe(200);
    expect(prepareMock).toHaveBeenCalledWith(db, expect.objectContaining({
      scenarioId: 'morning_planning',
      userId: 42,
      tenantId: 42,
    }));
  });

  it('returns aggregate provider and reset evidence without raw prompts or messages', () => {
    db.prepare(`
      INSERT INTO api_usage (
        user_id, tenant_id, request_source, base_category, job_name, run_id,
        provider, category, cost_usd, pricing_status
      ) VALUES (
        42, 42, 'interactive', 'chat_live_eval_local', 'chat_live_eval:content_creator_day',
        'chat-eval-route-test', 'ollama', 'chat_content_model_authored_short', 0, 'zero-cost'
      )
    `).run();
    db.prepare(`INSERT INTO ai_provider_attempt_reservations VALUES (42, 'interactive', 'chat_live_eval_local', 'chat_live_eval:content_creator_day', 'chat-eval-route-test', 'ollama', 0)`).run();
    db.prepare(`INSERT INTO chat_live_eval_preparations VALUES (?, 'morning_planning', 'local_engine', 42, 42, 'single-tenant-live-v3', ?, '{"messages":1}')`)
      .run('chat-eval-route-test', 'a'.repeat(64));
    const handler = routes().get('GET /eval/evidence')!;
    const { state, res } = response();
    handler(request('evidence'), res);

    expect(state.body).toMatchObject({
      ok: true,
      data: {
        attested: true,
        target: { actualSpendUsd: 0, providerAttemptCount: 1, providers: ['ollama'] },
        preparation: { scenarioIds: ['morning_planning'], aggregateResetCounts: { messages: 1 } },
      },
    });
    expect(JSON.stringify(state.body)).not.toContain('private');
  });
});
