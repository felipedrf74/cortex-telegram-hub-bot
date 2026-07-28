import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  CHAT_LIVE_EVAL_REAL_BUDGET,
  ChatLiveEvalContractError,
  readChatLiveEvalRunEvidence,
  resolveChatLiveEvalRequest,
} from '../../src/services/chat-live-evaluation-contract';

function headers(values: Record<string, string>): (name: string) => string | undefined {
  const normalized = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return (name) => normalized[name.toLowerCase()];
}

function contractHeaders(
  mode: 'local_engine' | 'real_provider',
  phase: 'preflight' | 'turn' | 'evidence' = 'turn',
): Record<string, string> {
  const budget = mode === 'local_engine' ? CHAT_LIVE_EVAL_LOCAL_BUDGET : CHAT_LIVE_EVAL_REAL_BUDGET;
  return {
    'x-nexus-chat-eval-contract': CHAT_LIVE_EVAL_CONTRACT_VERSION,
    'x-nexus-chat-eval-mode': mode,
    'x-nexus-chat-eval-run-id': 'chat-eval-2026-07-22T10-00-00-000Z',
    'x-nexus-chat-eval-total-budget-usd': String(budget.totalCeilingUsd),
    'x-nexus-chat-eval-target-budget-usd': String(budget.targetCeilingUsd),
    'x-nexus-chat-eval-judge-budget-usd': String(budget.judgeCeilingUsd),
    ...(phase === 'turn' ? { 'x-nexus-chat-eval-scenario-id': 'morning_planning' } : {}),
  };
}

function localEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'development',
    NEXUS_LOCAL_ALLOW_MODEL_CALLS: '1',
    OLLAMA_ENABLED: 'true',
    AI_CLASSIFY_PRIMARY: 'ollama',
    AI_CLASSIFY_FALLBACK: 'none',
    AI_CHAT_PRIMARY: 'ollama',
    AI_CHAT_FALLBACK: 'none',
    AI_TOOL_USE_PRIMARY: 'ollama',
    AI_TOOL_USE_FALLBACK: 'none',
    NEXUS_LOCAL_IOS_EMAIL: 'nexushubbot@gmail.com',
    ...overrides,
  };
}

function realEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'staging',
    STAGING: 'true',
    CHAT_EVAL_DEDICATED_TENANT_ID: '42',
    GEMINI_API_KEY: 'configured-but-never-returned',
    AI_CLASSIFY_PRIMARY: 'gemini',
    AI_CLASSIFY_FALLBACK: 'openai',
    AI_CHAT_PRIMARY: 'openai',
    AI_CHAT_FALLBACK: 'gemini',
    AI_TOOL_USE_PRIMARY: 'gemini',
    AI_TOOL_USE_FALLBACK: 'openai',
    ...overrides,
  };
}

function resolve(input: {
  mode: 'local_engine' | 'real_provider';
  phase?: 'preflight' | 'turn' | 'evidence';
  env?: NodeJS.ProcessEnv;
  userId?: number;
  tenantId?: number;
  email?: string | null;
  isLoopback?: boolean;
  isLocalDockerGateway?: boolean;
  headerOverrides?: Record<string, string>;
}) {
  const phase = input.phase ?? 'turn';
  return resolveChatLiveEvalRequest({
    readHeader: headers({ ...contractHeaders(input.mode, phase), ...input.headerOverrides }),
    phase,
    userId: input.userId ?? 42,
    tenantId: input.tenantId ?? 42,
    principalEmail: input.email === undefined
      ? (input.mode === 'local_engine' ? 'nexushubbot@gmail.com' : 'chat-eval@staging.invalid')
      : input.email,
    isLoopback: input.isLoopback ?? input.mode === 'local_engine',
    isLocalDockerGateway: input.isLocalDockerGateway ?? false,
    env: input.env ?? (input.mode === 'local_engine' ? localEnv() : realEnv()),
  });
}

function evidenceDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      request_source TEXT NOT NULL,
      base_category TEXT,
      run_id TEXT,
      provider TEXT,
      model TEXT,
      cost_usd REAL,
      pricing_status TEXT
    );
    CREATE TABLE ai_provider_attempt_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      request_source TEXT NOT NULL,
      base_category TEXT NOT NULL,
      job_name TEXT,
      run_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_category TEXT NOT NULL,
      reserved_cost_usd REAL NOT NULL
    );
    CREATE TABLE chat_live_eval_preparations (
      run_id TEXT NOT NULL,
      scenario_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      tenant_id INTEGER NOT NULL,
      seed_profile_version TEXT NOT NULL,
      seed_profile_hash TEXT NOT NULL,
      reset_counts_json TEXT NOT NULL
    );
  `);
  return db;
}

function recordPreparation(db: Database.Database, context: NonNullable<ReturnType<typeof resolve>>): void {
  db.prepare(`
    INSERT INTO chat_live_eval_preparations (
      run_id, scenario_id, mode, user_id, tenant_id,
      seed_profile_version, seed_profile_hash, reset_counts_json
    ) VALUES (?, 'morning_planning', ?, ?, ?, 'single-tenant-live-v2', ?, ?)
  `).run(context.runId, context.mode, context.userId, context.tenantId, 'a'.repeat(64), '{"messages":2}');
}

describe('chat live-evaluation contract', () => {
  it('returns null when no eval headers are present and rejects a partial contract', () => {
    expect(resolveChatLiveEvalRequest({
      readHeader: () => undefined,
      phase: 'turn',
      userId: 42,
      tenantId: 42,
      principalEmail: 'nexushubbot@gmail.com',
      isLoopback: true,
      env: localEnv(),
    })).toBeNull();

    expect(() => resolveChatLiveEvalRequest({
      readHeader: headers({ 'x-nexus-chat-eval-mode': 'local_engine' }),
      phase: 'turn',
      userId: 42,
      tenantId: 42,
      principalEmail: 'nexushubbot@gmail.com',
      isLoopback: true,
      env: localEnv(),
    })).toThrowError(ChatLiveEvalContractError);
  });

  it('accepts only the exact local epsilon split on loopback with Ollama-only routing and no cloud credentials', () => {
    const context = resolve({ mode: 'local_engine' });
    expect(context).toMatchObject({
      mode: 'local_engine',
      runId: 'chat-eval-2026-07-22T10-00-00-000Z',
      scenarioId: 'morning_planning',
      budget: CHAT_LIVE_EVAL_LOCAL_BUDGET,
      targetBaseCategory: 'chat_live_eval_local',
      providerPolicy: 'ollama_only_zero_cloud',
      productionDataUsed: false,
    });

    expect(() => resolve({ mode: 'local_engine', isLoopback: false })).toThrow(/loopback/i);
    expect(() => resolve({
      mode: 'local_engine',
      isLoopback: false,
      isLocalDockerGateway: true,
    })).toThrow(/loopback/i);
    expect(resolve({
      mode: 'local_engine',
      isLoopback: false,
      isLocalDockerGateway: true,
      env: localEnv({ NEXUS_CHAT_EVAL_ALLOW_DOCKER_GATEWAY: '1' }),
    })).toMatchObject({ mode: 'local_engine', providerPolicy: 'ollama_only_zero_cloud' });
    expect(() => resolve({
      mode: 'local_engine',
      env: localEnv({ OPENAI_API_KEY: 'configured' }),
    })).toThrow(/Ollama-only/i);
    expect(() => resolve({
      mode: 'local_engine',
      env: localEnv({ AI_CHAT_FALLBACK: 'gemini' }),
    })).toThrow(/Ollama-only/i);
    expect(() => resolve({
      mode: 'local_engine',
      headerOverrides: { 'x-nexus-chat-eval-target-budget-usd': '0.45' },
    })).toThrow(/budget/i);
  });

  it('requires the authenticated local debug principal, not a logical scenario identity', () => {
    expect(() => resolve({ mode: 'local_engine', userId: 42, tenantId: 41 })).toThrow(/authenticated/i);
    expect(() => resolve({ mode: 'local_engine', email: 'felipe@example.com' })).toThrow(/dedicated/i);
  });

  it('accepts the exact $0.50 staging split only for the configured dedicated .invalid tenant', () => {
    const context = resolve({ mode: 'real_provider', isLoopback: false });
    expect(context).toMatchObject({
      mode: 'real_provider',
      budget: CHAT_LIVE_EVAL_REAL_BUDGET,
      targetBaseCategory: 'chat_live_eval_real',
      providerPolicy: 'metered_cloud_only',
      productionDataUsed: false,
    });

    expect(() => resolve({ mode: 'real_provider', env: realEnv({ NODE_ENV: 'production' }) })).toThrow(/production/i);
    expect(() => resolve({ mode: 'real_provider', env: realEnv({ CHAT_EVAL_DEDICATED_TENANT_ID: '' }) })).toThrow(/dedicated/i);
    expect(() => resolve({ mode: 'real_provider', userId: 43, tenantId: 43 })).toThrow(/dedicated/i);
    expect(() => resolve({ mode: 'real_provider', email: 'felipe@example.com' })).toThrow(/dedicated/i);
    expect(() => resolve({
      mode: 'real_provider',
      headerOverrides: { 'x-nexus-chat-eval-judge-budget-usd': '0.50' },
    })).toThrow(/budget/i);
  });

  it('requires scenario identity only for turn requests', () => {
    expect(resolve({ mode: 'local_engine', phase: 'preflight' })?.scenarioId).toBeNull();
    expect(resolve({ mode: 'local_engine', phase: 'evidence' })?.scenarioId).toBeNull();
    expect(() => resolve({
      mode: 'local_engine',
      phase: 'turn',
      headerOverrides: { 'x-nexus-chat-eval-scenario-id': '' },
    })).toThrow(/scenario/i);
  });

  it('attests local evidence only when every observed provider is Ollama and all spend is zero', () => {
    const db = evidenceDb();
    try {
      const context = resolve({ mode: 'local_engine', phase: 'evidence' })!;
      recordPreparation(db, context);
      db.prepare(`
        INSERT INTO api_usage (user_id, request_source, base_category, run_id, provider, model, cost_usd, pricing_status)
        VALUES (42, 'interactive', 'chat_live_eval_local', ?, 'ollama', 'qwen-test', 0, 'local_zero')
      `).run(context.runId);
      db.prepare(`
        INSERT INTO ai_provider_attempt_reservations (
          user_id, request_source, base_category, job_name, run_id,
          provider, model, provider_category, reserved_cost_usd
        ) VALUES (42, 'interactive', 'chat_live_eval_local', 'chat_live_eval:morning', ?, 'ollama', 'qwen-test', 'chat', 0)
      `).run(context.runId);

      expect(readChatLiveEvalRunEvidence(db, context)).toEqual(expect.objectContaining({
        attested: true,
        reasons: [],
        target: expect.objectContaining({
          ceilingUsd: CHAT_LIVE_EVAL_LOCAL_BUDGET.targetCeilingUsd,
          actualSpendUsd: 0,
          reservedAttemptCeilingUsd: 0,
          usageCallCount: 1,
          providerAttemptCount: 1,
          providers: ['ollama'],
        }),
        preparation: expect.objectContaining({
          scenarioCount: 1,
          scenarioIds: ['morning_planning'],
          aggregateResetCounts: { messages: 2 },
        }),
      }));

      db.prepare(`
        INSERT INTO api_usage (user_id, request_source, base_category, run_id, provider, model, cost_usd, pricing_status)
        VALUES (42, 'interactive', 'chat_live_eval_local', ?, 'gemini', 'gemini-test', 0.000001, 'resolved')
      `).run(context.runId);
      const rejected = readChatLiveEvalRunEvidence(db, context);
      expect(rejected.attested).toBe(false);
      expect(rejected.reasons).toContain('local_non_ollama_provider_observed');
      expect(rejected.reasons).toContain('local_nonzero_spend_observed');
    } finally {
      db.close();
    }
  });

  it('persists truthful real-provider actual, reservation, and attempt evidence without confusing the ceiling for spend', () => {
    const db = evidenceDb();
    try {
      const context = resolve({ mode: 'real_provider', phase: 'evidence', isLoopback: false })!;
      recordPreparation(db, context);
      db.prepare(`
        INSERT INTO api_usage (user_id, request_source, base_category, run_id, provider, model, cost_usd, pricing_status)
        VALUES
          (42, 'interactive', 'chat_live_eval_real', ?, 'openai', 'gpt-test', 0.012, 'resolved'),
          (999, 'interactive', 'chat_live_eval_real', ?, 'openai', 'gpt-test', 99, 'resolved')
      `).run(context.runId, context.runId);
      db.prepare(`
        INSERT INTO ai_provider_attempt_reservations (
          user_id, request_source, base_category, job_name, run_id,
          provider, model, provider_category, reserved_cost_usd
        ) VALUES (42, 'interactive', 'chat_live_eval_real', 'chat_live_eval:morning', ?, 'openai', 'gpt-test', 'chat', 0.03)
      `).run(context.runId);

      const evidence = readChatLiveEvalRunEvidence(db, context);
      expect(evidence).toEqual(expect.objectContaining({
        attested: true,
        productionDataUsed: false,
        target: expect.objectContaining({
          ceilingUsd: 0.45,
          actualSpendUsd: 0.012,
          reservedAttemptCeilingUsd: 0.03,
          committedCeilingUsd: 0.042,
          usageCallCount: 1,
          providerAttemptCount: 1,
          providers: ['openai'],
        }),
      }));
      expect(evidence.totalCeilingUsd).toBe(0.5);
      expect(evidence.judgeCeilingUsd).toBe(0.05);
    } finally {
      db.close();
    }
  });

  it('fails evidence closed when no provider call occurred, pricing is unresolved, or committed target cost exceeds the split', () => {
    const db = evidenceDb();
    try {
      const context = resolve({ mode: 'real_provider', phase: 'evidence', isLoopback: false })!;
      recordPreparation(db, context);
      expect(readChatLiveEvalRunEvidence(db, context).reasons).toContain('no_target_provider_usage');

      db.prepare(`
        INSERT INTO api_usage (user_id, request_source, base_category, run_id, provider, model, cost_usd, pricing_status)
        VALUES (42, 'interactive', 'chat_live_eval_real', ?, 'gemini', 'unknown-model', 0.40, 'unresolved')
      `).run(context.runId);
      db.prepare(`
        INSERT INTO ai_provider_attempt_reservations (
          user_id, request_source, base_category, job_name, run_id,
          provider, model, provider_category, reserved_cost_usd
        ) VALUES (42, 'interactive', 'chat_live_eval_real', 'chat_live_eval:morning', ?, 'gemini', 'unknown-model', 'chat', 0.06)
      `).run(context.runId);

      const evidence = readChatLiveEvalRunEvidence(db, context);
      expect(evidence.attested).toBe(false);
      expect(evidence.reasons).toContain('unresolved_provider_pricing');
      expect(evidence.reasons).toContain('target_cost_ceiling_exceeded');
    } finally {
      db.close();
    }
  });
});
