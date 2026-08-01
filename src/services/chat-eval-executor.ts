// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// ChatTurnExecutor abstraction for the chat evaluation harness and the
// day-to-day simulation. The same scenario banks can replay through:
//   - FixtureExecutor: deterministic synthetic envelopes (bit-identical to
//     the historical inline fixture path — it simply echoes the fixture
//     result the runner already built);
//   - HttpExecutor: the real `POST /api/v1/chat/message` pipeline via an
//     injectable request function (supertest wrapper in tests, fetch against
//     a base URL for live staging/local-engine runs). Unit tests must never
//     hit the network: they inject the request function.

import {
  CHAT_LIVE_EVAL_CONTRACT_VERSION,
  CHAT_LIVE_EVAL_LOCAL_BUDGET,
  CHAT_LIVE_EVAL_REAL_BUDGET,
  CHAT_LIVE_EVAL_SCENARIO_IDS,
  type ChatLiveEvalBudget,
  type ChatLiveEvalRunEvidence,
  type ChatLiveEvalScenarioId,
} from './chat-live-evaluation-contract';
import { CHAT_LIVE_EVAL_SEED_PROFILE_VERSION } from './chat-live-evaluation-context';

export type ChatEvalExecutorMode = 'fixture' | 'local_engine' | 'real_provider';

export interface ChatEvalTurnRequest {
  text: string;
  /**
   * Logical conversation identity for multi-turn scenarios. The backend keeps
   * conversation state server-side per user/tenant; executors use this id to
   * derive stable per-turn client message ids so retries dedupe correctly.
   */
  conversationId: string;
  userId: number;
  tenantId: number;
  locale?: string;
  timezone?: string;
  clientMessageId?: string;
  idempotencyKey?: string;
  /** Scenario day offset for longitudinal turns (fixture bookkeeping only). */
  dayOffset?: number;
  /**
   * Fixture mode only: the pre-built deterministic result the FixtureExecutor
   * echoes back unchanged. Non-fixture executors ignore this field.
   */
  fixtureResult?: ChatEvalTurnResult;
}

export interface ChatEvalTurnResult {
  ok: boolean;
  statusCode: number;
  text: string;
  domain?: string;
  routeMethod?: string;
  metadata?: Record<string, unknown> | null;
  /** Raw parsed response envelope (or fixture envelope) for evidence. */
  envelope: unknown;
  latencyMs: number;
  providerTrace?: Record<string, unknown> | null;
  /** Populated when ok=false so runners can render a scenario-blocked shape. */
  blockedReason?: string;
}

export type ChatEvalSideEffectKind = 'tasks_list' | 'calendar_list';

export interface ChatTurnExecutor {
  readonly mode: ChatEvalExecutorMode;
  executeTurn(req: ChatEvalTurnRequest): Promise<ChatEvalTurnResult>;
  /** Token-zero REST read-back used to verify side effects after a turn. */
  readSideEffect?(kind: ChatEvalSideEffectKind, params: Record<string, unknown>): Promise<unknown>;
}

export class FixtureExecutor implements ChatTurnExecutor {
  readonly mode = 'fixture' as const;

  async executeTurn(req: ChatEvalTurnRequest): Promise<ChatEvalTurnResult> {
    if (req.fixtureResult) return req.fixtureResult;
    return {
      ok: true,
      statusCode: 200,
      text: '',
      envelope: null,
      latencyMs: 0,
    };
  }
}

export interface ChatEvalHttpResponse {
  statusCode: number;
  body: unknown;
}

export type ChatEvalRequestFn = (input: {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}) => Promise<ChatEvalHttpResponse>;

export interface HttpExecutorOptions {
  mode: 'local_engine' | 'real_provider';
  /** Base URL for the default fetch-based requester (live runs only). */
  baseUrl?: string;
  /** Injectable request function; required when no baseUrl (unit tests). */
  request?: ChatEvalRequestFn;
  /** Provides the Bearer token for every request. */
  authToken: string | (() => string | Promise<string>);
  /**
   * Physical identity of the dedicated eval principal. Logical persona ids
   * on ChatEvalTurnRequest are scenario metadata and must never become auth
   * scope. When omitted, the verified Bearer token establishes the canonical
   * tenant and no active-tenant override header is sent.
   */
  evalTenantId?: number;
  evalUserId?: number;
  /** Defaults to the real chat pipeline path. */
  messagePath?: string;
  sideEffectPaths?: Partial<Record<ChatEvalSideEffectKind, string>>;
  locale?: string;
  timezone?: string;
  /**
   * Per-run nonce mixed into fallback clientMessageIds so repeated live runs
   * do not collide with server idempotency. Explicit clientMessageIds from
   * the caller are used verbatim (the suite mixes its own nonce into them).
   */
  runNonce?: string;
  /** Required for every fetch-backed live run; binds all calls to one budget. */
  runContract?: ChatEvalRunContract;
}

export interface ChatEvalRunContract {
  version: typeof CHAT_LIVE_EVAL_CONTRACT_VERSION;
  runId: string;
  budget: ChatLiveEvalBudget;
}

// Real route: `router.post('/message', ...)` in chat-message-routes.ts,
// mounted at `/chat` inside createApiRouter() which the portal mounts at
// `/api/v1`. Auth is `Authorization: Bearer <iOS JWT>` (authMiddleware),
// active tenant via `x-nexus-active-tenant-id`, language via `x-language`.
export const CHAT_EVAL_DEFAULT_MESSAGE_PATH = '/api/v1/chat/message';
export const CHAT_EVAL_DEFAULT_PREFLIGHT_PATH = '/api/v1/chat/eval/preflight';
export const CHAT_EVAL_DEFAULT_RESET_PATH = '/api/v1/chat/eval/scenario/reset';
export const CHAT_EVAL_DEFAULT_EVIDENCE_PATH = '/api/v1/chat/eval/evidence';

export const CHAT_EVAL_DEFAULT_SIDE_EFFECT_PATHS: Record<ChatEvalSideEffectKind, string> = {
  tasks_list: '/api/v1/tasks/snapshot',
  calendar_list: '/api/v1/calendar/events',
};

export class HttpExecutor implements ChatTurnExecutor {
  readonly mode: 'local_engine' | 'real_provider';
  private readonly request: ChatEvalRequestFn;
  private readonly options: HttpExecutorOptions;
  private readonly turnCounters = new Map<string, number>();
  private readonly preparationPromises = new Map<ChatLiveEvalScenarioId, Promise<void>>();

  constructor(options: HttpExecutorOptions) {
    if (!options.request && !options.baseUrl) {
      throw new Error('HttpExecutor requires either an injectable request function or a baseUrl');
    }
    if (options.evalTenantId !== undefined
      && (!Number.isSafeInteger(options.evalTenantId) || options.evalTenantId <= 0)) {
      throw new Error('HttpExecutor evalTenantId must be a positive safe integer');
    }
    if (options.baseUrl && !options.runContract) {
      throw new Error('HttpExecutor live baseUrl requires a governed runContract');
    }
    if (options.runContract) validateRunContract(options.mode, options.runContract);
    this.mode = options.mode;
    this.options = options;
    this.request = options.request ?? buildFetchRequestFn(options.baseUrl as string);
  }

  async executeTurn(req: ChatEvalTurnRequest): Promise<ChatEvalTurnResult> {
    const path = this.options.messagePath ?? CHAT_EVAL_DEFAULT_MESSAGE_PATH;
    const clientMessageId = req.clientMessageId ?? this.nextClientMessageId(req.conversationId);
    const startedAt = Date.now();
    let response: ChatEvalHttpResponse;
    try {
      const scenarioId = this.options.runContract
        ? this.resolveScenarioId(req.conversationId)
        : null;
      if (scenarioId) await this.ensureScenarioPrepared(scenarioId);
      response = await this.request({
        method: 'POST',
        path,
        headers: await this.buildHeaders(req, true, scenarioId ? 'turn' : undefined, scenarioId),
        body: {
          text: req.text,
          clientMessageId,
          ...(req.idempotencyKey ? { idempotencyKey: req.idempotencyKey } : {}),
        },
      });
    } catch (err) {
      return {
        ok: false,
        statusCode: 0,
        text: '',
        envelope: null,
        latencyMs: Date.now() - startedAt,
        blockedReason: `transport_error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const latencyMs = Date.now() - startedAt;
    const body = response.body && typeof response.body === 'object'
      ? response.body as Record<string, unknown>
      : null;

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errorEnvelope = body?.error && typeof body.error === 'object'
        ? body.error as Record<string, unknown>
        : null;
      const message = typeof errorEnvelope?.message === 'string' ? errorEnvelope.message : '';
      return {
        ok: false,
        statusCode: response.statusCode,
        text: message,
        envelope: response.body,
        latencyMs,
        blockedReason: `http_${response.statusCode}${typeof errorEnvelope?.code === 'string' ? `:${errorEnvelope.code}` : ''}`,
      };
    }

    const metadata = body?.metadata && typeof body.metadata === 'object'
      ? body.metadata as Record<string, unknown>
      : null;
    return {
      ok: true,
      statusCode: response.statusCode,
      text: typeof body?.text === 'string' ? body.text : '',
      domain: typeof body?.domain === 'string' ? body.domain : undefined,
      routeMethod: typeof body?.routeMethod === 'string' ? body.routeMethod : undefined,
      metadata,
      envelope: response.body,
      latencyMs,
      providerTrace: metadata?.providerTrace && typeof metadata.providerTrace === 'object'
        ? metadata.providerTrace as Record<string, unknown>
        : null,
    };
  }

  async readSideEffect(kind: ChatEvalSideEffectKind, params: Record<string, unknown>): Promise<unknown> {
    const basePath = this.options.sideEffectPaths?.[kind] ?? CHAT_EVAL_DEFAULT_SIDE_EFFECT_PATHS[kind];
    const query = buildQueryString(params);
    const response = await this.request({
      method: 'GET',
      path: query ? `${basePath}?${query}` : basePath,
      headers: await this.buildHeaders(null, false),
    });
    return { statusCode: response.statusCode, body: response.body };
  }

  async preflight(): Promise<Record<string, unknown>> {
    const contract = this.requireRunContract();
    const response = await this.request({
      method: 'GET',
      path: CHAT_EVAL_DEFAULT_PREFLIGHT_PATH,
      headers: await this.buildHeaders(null, false, 'preflight'),
    });
    const data = responseData(response, 'preflight');
    if (
      data.contractVersion !== contract.version
      || data.mode !== this.mode
      || data.runId !== contract.runId
      || JSON.stringify(data.budget) !== JSON.stringify(contract.budget)
      || (this.mode === 'local_engine' && data.providerPolicy !== 'ollama_only_zero_cloud')
      || (this.mode === 'real_provider' && data.providerPolicy !== 'metered_cloud_only')
      || data.seedProfileVersion !== CHAT_LIVE_EVAL_SEED_PROFILE_VERSION
      || !Array.isArray(data.supportedScenarioIds)
    ) {
      throw new Error('Chat eval preflight did not attest the governed run contract');
    }
    // Paid evidence must name the artifact that served it. Only the deployed
    // process can attest that, so refuse a real-provider run whose server did
    // not report a verified staging release identity.
    if (this.mode === 'real_provider' && !isAttestedStagingRelease(data.deployedRelease)) {
      throw new Error('Chat eval preflight did not attest a deployed staging release identity');
    }
    return data;
  }

  async readRunEvidence(): Promise<ChatLiveEvalRunEvidence> {
    this.requireRunContract();
    const response = await this.request({
      method: 'GET',
      path: CHAT_EVAL_DEFAULT_EVIDENCE_PATH,
      headers: await this.buildHeaders(null, false, 'evidence'),
    });
    return responseData(response, 'evidence') as unknown as ChatLiveEvalRunEvidence;
  }

  private nextClientMessageId(conversationId: string): string {
    const next = (this.turnCounters.get(conversationId) ?? 0) + 1;
    this.turnCounters.set(conversationId, next);
    const base = `${conversationId}-turn-${next}`;
    return this.options.runNonce ? `${base}-${this.options.runNonce}` : base;
  }

  private requireRunContract(): ChatEvalRunContract {
    if (!this.options.runContract) throw new Error('HttpExecutor operation requires a governed runContract');
    return this.options.runContract;
  }

  private resolveScenarioId(conversationId: string): ChatLiveEvalScenarioId {
    const candidate = conversationId.replace(/^d2d-/, '');
    if (!CHAT_LIVE_EVAL_SCENARIO_IDS.includes(candidate as ChatLiveEvalScenarioId)) {
      throw new Error(`Chat eval conversation does not map to an allowlisted scenario: ${conversationId}`);
    }
    return candidate as ChatLiveEvalScenarioId;
  }

  private ensureScenarioPrepared(scenarioId: ChatLiveEvalScenarioId): Promise<void> {
    const existing = this.preparationPromises.get(scenarioId);
    if (existing) return existing;
    const preparation = (async () => {
      const response = await this.request({
        method: 'POST',
        path: CHAT_EVAL_DEFAULT_RESET_PATH,
        headers: await this.buildHeaders(null, true, 'reset', scenarioId),
        body: { scenarioId },
      });
      const data = responseData(response, 'scenario reset');
      if (data.scenarioId !== scenarioId || data.seedProfileVersion !== CHAT_LIVE_EVAL_SEED_PROFILE_VERSION) {
        throw new Error('Chat eval scenario reset did not attest the requested seed profile');
      }
    })();
    this.preparationPromises.set(scenarioId, preparation);
    return preparation.catch((error) => {
      this.preparationPromises.delete(scenarioId);
      throw error;
    });
  }

  private async buildHeaders(
    req: ChatEvalTurnRequest | null,
    withBody: boolean,
    phase?: 'preflight' | 'reset' | 'turn' | 'evidence',
    scenarioId?: ChatLiveEvalScenarioId | null,
  ): Promise<Record<string, string>> {
    const token = typeof this.options.authToken === 'function'
      ? await this.options.authToken()
      : this.options.authToken;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (withBody) headers['content-type'] = 'application/json';
    if (this.options.evalTenantId !== undefined) {
      headers['x-nexus-active-tenant-id'] = String(this.options.evalTenantId);
    }
    const locale = req?.locale ?? this.options.locale;
    if (locale) headers['x-language'] = locale;
    if (phase) {
      const contract = this.requireRunContract();
      headers['x-nexus-chat-eval-contract'] = contract.version;
      headers['x-nexus-chat-eval-mode'] = this.mode;
      headers['x-nexus-chat-eval-run-id'] = contract.runId;
      headers['x-nexus-chat-eval-total-budget-usd'] = String(contract.budget.totalCeilingUsd);
      headers['x-nexus-chat-eval-target-budget-usd'] = String(contract.budget.targetCeilingUsd);
      headers['x-nexus-chat-eval-judge-budget-usd'] = String(contract.budget.judgeCeilingUsd);
      if (scenarioId) headers['x-nexus-chat-eval-scenario-id'] = scenarioId;
    }
    return headers;
  }
}

function sameBudget(left: ChatLiveEvalBudget, right: ChatLiveEvalBudget): boolean {
  return left.totalCeilingUsd === right.totalCeilingUsd
    && left.targetCeilingUsd === right.targetCeilingUsd
    && left.judgeCeilingUsd === right.judgeCeilingUsd;
}

function validateRunContract(mode: HttpExecutorOptions['mode'], contract: ChatEvalRunContract): void {
  const expected = mode === 'local_engine' ? CHAT_LIVE_EVAL_LOCAL_BUDGET : CHAT_LIVE_EVAL_REAL_BUDGET;
  if (
    contract.version !== CHAT_LIVE_EVAL_CONTRACT_VERSION
    || !/^chat-eval-[a-zA-Z0-9._:-]{8,120}$/.test(contract.runId)
    || !sameBudget(contract.budget, expected)
  ) {
    throw new Error('HttpExecutor runContract version, run id, or budget is invalid');
  }
}

function responseData(response: ChatEvalHttpResponse, operation: string): Record<string, unknown> {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Chat eval ${operation} failed with HTTP ${response.statusCode}`);
  }
  const body = response.body && typeof response.body === 'object'
    ? response.body as Record<string, unknown>
    : null;
  const data = body?.data && typeof body.data === 'object'
    ? body.data as Record<string, unknown>
    : null;
  if (body?.ok !== true || !data) throw new Error(`Chat eval ${operation} returned an invalid evidence envelope`);
  return data;
}

function buildQueryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return query.toString();
}

/** A preflight identity is usable evidence only if it is complete and staging. */
function isAttestedStagingRelease(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return typeof identity.runtimeSha === 'string'
    && /^[a-f0-9]{40}$/.test(identity.runtimeSha)
    && typeof identity.artifactDigest === 'string'
    && /^[a-f0-9]{64}$/.test(identity.artifactDigest)
    && identity.role === 'staging';
}

function buildFetchRequestFn(baseUrl: string): ChatEvalRequestFn {
  return async ({ method, path, headers, body }) => {
    const response = await fetch(new URL(path, baseUrl).toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = null;
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
    return { statusCode: response.status, body: parsed };
  };
}
