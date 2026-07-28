import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
} from '../../src/services/chat-live-evaluation-contract';

let db: Database.Database;
const prepareMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/services/database', async () => ({
  ...(await vi.importActual('../../src/services/database')),
  getDb: () => db,
  withDatabaseForTestAsync: vi.fn(),
}));
vi.mock('../../src/services/user-service', async () => ({
  ...(await vi.importActual('../../src/services/user-service')),
  getUserById: () => ({ id: 42, email: 'nexushubbot@gmail.com' }),
}));
vi.mock('../../src/api/secret-guards', async () => ({
  ...(await vi.importActual('../../src/api/secret-guards')),
  isLoopbackRequest: () => true,
}));
vi.mock('../../src/services/chat-live-evaluation-state', () => ({
  CHAT_LIVE_EVAL_SEED_PROFILE_VERSION: 'single-tenant-live-v2',
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

function request(phase: 'preflight' | 'reset' | 'evidence', body?: unknown) {
  const headers: Record<string, string> = {
    'x-nexus-chat-eval-contract': CHAT_LIVE_EVAL_CONTRACT_VERSION,
    'x-nexus-chat-eval-mode': 'local_engine',
    'x-nexus-chat-eval-run-id': 'chat-eval-route-test',
    'x-nexus-chat-eval-total-budget-usd': String(CHAT_LIVE_EVAL_LOCAL_BUDGET.totalCeilingUsd),
    'x-nexus-chat-eval-target-budget-usd': String(CHAT_LIVE_EVAL_LOCAL_BUDGET.targetCeilingUsd),
    'x-nexus-chat-eval-judge-budget-usd': String(CHAT_LIVE_EVAL_LOCAL_BUDGET.judgeCeilingUsd),
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
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE api_usage (
        user_id INTEGER, request_source TEXT, base_category TEXT, run_id TEXT,
        provider TEXT, cost_usd REAL, pricing_status TEXT
      );
      CREATE TABLE ai_provider_attempt_reservations (
        user_id INTEGER, request_source TEXT, base_category TEXT, run_id TEXT,
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
        seedProfileVersion: 'single-tenant-live-v2',
      },
    });
    expect(JSON.stringify(state.body)).not.toContain('API_KEY');
  });

  it('accepts only the header-bound scenario and never accepts client seed data', () => {
    prepareMock.mockReturnValue({
      scenarioId: 'morning_planning',
      seedProfileVersion: 'single-tenant-live-v2',
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
    db.prepare(`INSERT INTO api_usage VALUES (42, 'interactive', 'chat_live_eval_local', 'chat-eval-route-test', 'ollama', 0, 'zero-cost')`).run();
    db.prepare(`INSERT INTO ai_provider_attempt_reservations VALUES (42, 'interactive', 'chat_live_eval_local', 'chat-eval-route-test', 'ollama', 0)`).run();
    db.prepare(`INSERT INTO chat_live_eval_preparations VALUES (?, 'morning_planning', 'local_engine', 42, 42, 'single-tenant-live-v2', ?, '{"messages":1}')`)
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
