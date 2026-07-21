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
  /** Eval identity fallbacks when the turn request omits them. */
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
}

// Real route: `router.post('/message', ...)` in chat-message-routes.ts,
// mounted at `/chat` inside createApiRouter() which the portal mounts at
// `/api/v1`. Auth is `Authorization: Bearer <iOS JWT>` (authMiddleware),
// active tenant via `x-nexus-active-tenant-id`, language via `x-language`.
export const CHAT_EVAL_DEFAULT_MESSAGE_PATH = '/api/v1/chat/message';

export const CHAT_EVAL_DEFAULT_SIDE_EFFECT_PATHS: Record<ChatEvalSideEffectKind, string> = {
  tasks_list: '/api/v1/tasks/snapshot',
  calendar_list: '/api/v1/calendar/events',
};

export class HttpExecutor implements ChatTurnExecutor {
  readonly mode: 'local_engine' | 'real_provider';
  private readonly request: ChatEvalRequestFn;
  private readonly options: HttpExecutorOptions;
  private readonly turnCounters = new Map<string, number>();

  constructor(options: HttpExecutorOptions) {
    if (!options.request && !options.baseUrl) {
      throw new Error('HttpExecutor requires either an injectable request function or a baseUrl');
    }
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
      response = await this.request({
        method: 'POST',
        path,
        headers: await this.buildHeaders(req, true),
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

  private nextClientMessageId(conversationId: string): string {
    const next = (this.turnCounters.get(conversationId) ?? 0) + 1;
    this.turnCounters.set(conversationId, next);
    const base = `${conversationId}-turn-${next}`;
    return this.options.runNonce ? `${base}-${this.options.runNonce}` : base;
  }

  private async buildHeaders(req: ChatEvalTurnRequest | null, withBody: boolean): Promise<Record<string, string>> {
    const token = typeof this.options.authToken === 'function'
      ? await this.options.authToken()
      : this.options.authToken;
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
    };
    if (withBody) headers['content-type'] = 'application/json';
    const tenantId = req?.tenantId ?? this.options.evalTenantId;
    if (typeof tenantId === 'number' && Number.isFinite(tenantId)) {
      headers['x-nexus-active-tenant-id'] = String(tenantId);
    }
    const locale = req?.locale ?? this.options.locale;
    if (locale) headers['x-language'] = locale;
    return headers;
  }
}

function buildQueryString(params: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    query.set(key, String(value));
  }
  return query.toString();
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
