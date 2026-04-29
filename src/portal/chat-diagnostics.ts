// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

type PreparedStatement = {
  get: (...args: any[]) => unknown;
  all: (...args: any[]) => unknown[];
};

export type PortalChatDiagnosticsDb = {
  prepare(sql: string): PreparedStatement;
};

export interface PortalChatDiagnosticsOptions {
  windowDays?: number;
  limit?: number;
  tenantId?: number;
}

export interface PortalChatDiagnosticsWindow {
  activeUsers: number;
  activeTenants: number;
  messages: number;
  assistantMessages: number;
  failedMessages: number;
  streamingMessages: number;
  pendingConfirmations: number;
  clarificationPrompts: number;
}

export interface PortalChatDiagnosticBucket {
  key: string;
  messages: number;
  failedMessages?: number;
  avgConfidence?: number | null;
}

export interface PortalChatTenantDiagnostic {
  tenantId: number;
  activeUsers: number;
  messages: number;
  failedMessages: number;
  pendingConfirmations: number;
  lastMessageAt: string | null;
}

export interface PortalChatProviderDiagnostic {
  provider: string;
  model: string;
  category: string;
  calls: number;
  costUsd: number;
  tokens: number;
  avgLatencyMs: number | null;
}

export interface PortalChatMessageDiagnostic {
  id: string;
  tenantId: number;
  userId: number;
  role: 'user' | 'assistant' | string;
  domain: string | null;
  routeMethod: string | null;
  lifecycleState: string;
  errorCode: string | null;
  textLength: number;
  hasButtons: boolean;
  hasMetadata: boolean;
  metadataType: string | null;
  sourceSkills: string[];
  toolCallCount: number;
  hasActionConfirmation: boolean;
  hasClarificationPrompt: boolean;
  createdAt: string;
}

export interface PortalChatDiagnostics {
  ok: true;
  privacyMode: 'metadata_only';
  windowDays: number;
  totals: PortalChatDiagnosticsWindow;
  byTenant: PortalChatTenantDiagnostic[];
  byLifecycle: PortalChatDiagnosticBucket[];
  byDomain: PortalChatDiagnosticBucket[];
  byRouteMethod: PortalChatDiagnosticBucket[];
  providerUsage: PortalChatProviderDiagnostic[];
}

export interface PortalUserChatDiagnostics extends Omit<PortalChatDiagnostics, 'byTenant'> {
  userId: number;
  byTenant: PortalChatTenantDiagnostic[];
  recentMessages: PortalChatMessageDiagnostic[];
}

type RawMessageRow = {
  message_uuid?: string;
  tenant_id?: number;
  user_id?: number;
  role?: string;
  domain?: string | null;
  route_method?: string | null;
  lifecycle_state?: string | null;
  error_code?: string | null;
  text?: string | null;
  buttons_json?: string | null;
  metadata_json?: string | null;
  created_at?: string;
};

const CHAT_USAGE_CATEGORIES = [
  'chat',
  'content_chat_refine',
  'coach_analysis',
  'classifier',
  'tool_use',
  'toolUse',
];

function clampPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function sinceArg(windowDays: number): string {
  return `-${windowDays} days`;
}

function asNumber(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function asNullableNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeAll<T>(db: PortalChatDiagnosticsDb, sql: string, args: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...args) as T[];
  } catch {
    return [];
  }
}

function safeGet<T>(db: PortalChatDiagnosticsDb, sql: string, args: unknown[] = []): T | null {
  try {
    return (db.prepare(sql).get(...args) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

function normalizeOptions(options: PortalChatDiagnosticsOptions = {}): { windowDays: number; limit: number } {
  return {
    windowDays: clampPositiveInt(options.windowDays, 7, 90),
    limit: clampPositiveInt(options.limit, 20, 100),
  };
}

function buildTotals(
  db: PortalChatDiagnosticsDb,
  windowDays: number,
  userId?: number,
  tenantId?: number,
): PortalChatDiagnosticsWindow {
  const userClause = userId ? 'AND user_id = ?' : '';
  const tenantClause = tenantId ? 'AND tenant_id = ?' : '';
  const args = [
    sinceArg(windowDays),
    ...(userId ? [userId] : []),
    ...(tenantId ? [tenantId] : []),
  ];
  const row = safeGet<Record<string, unknown>>(db, `
    SELECT
      COUNT(*) as messages,
      COUNT(DISTINCT user_id) as activeUsers,
      COUNT(DISTINCT tenant_id) as activeTenants,
      SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as assistantMessages,
      SUM(CASE WHEN COALESCE(lifecycle_state, 'completed') = 'failed' OR error_code IS NOT NULL THEN 1 ELSE 0 END) as failedMessages,
      SUM(CASE WHEN COALESCE(lifecycle_state, '') IN ('streaming', 'sent') THEN 1 ELSE 0 END) as streamingMessages,
      SUM(CASE WHEN metadata_json LIKE '%actionConfirmation%' OR metadata_json LIKE '%action_confirmation%' THEN 1 ELSE 0 END) as pendingConfirmations,
      SUM(CASE WHEN metadata_json LIKE '%clarification%' THEN 1 ELSE 0 END) as clarificationPrompts
    FROM messages
    WHERE created_at >= datetime('now', ?)
      AND COALESCE(scope_status, 'active') = 'active'
      ${userClause}
      ${tenantClause}
  `, args) ?? {};

  return {
    activeUsers: asNumber(row.activeUsers),
    activeTenants: asNumber(row.activeTenants),
    messages: asNumber(row.messages),
    assistantMessages: asNumber(row.assistantMessages),
    failedMessages: asNumber(row.failedMessages),
    streamingMessages: asNumber(row.streamingMessages),
    pendingConfirmations: asNumber(row.pendingConfirmations),
    clarificationPrompts: asNumber(row.clarificationPrompts),
  };
}

function buildTenantBuckets(
  db: PortalChatDiagnosticsDb,
  windowDays: number,
  limit: number,
  userId?: number,
  tenantId?: number,
): PortalChatTenantDiagnostic[] {
  const userClause = userId ? 'AND user_id = ?' : '';
  const tenantClause = tenantId ? 'AND tenant_id = ?' : '';
  const args = [
    sinceArg(windowDays),
    ...(userId ? [userId] : []),
    ...(tenantId ? [tenantId] : []),
    limit,
  ];
  const rows = safeAll<Record<string, unknown>>(db, `
    SELECT
      tenant_id as tenantId,
      COUNT(DISTINCT user_id) as activeUsers,
      COUNT(*) as messages,
      SUM(CASE WHEN COALESCE(lifecycle_state, 'completed') = 'failed' OR error_code IS NOT NULL THEN 1 ELSE 0 END) as failedMessages,
      SUM(CASE WHEN metadata_json LIKE '%actionConfirmation%' OR metadata_json LIKE '%action_confirmation%' THEN 1 ELSE 0 END) as pendingConfirmations,
      MAX(created_at) as lastMessageAt
    FROM messages
    WHERE created_at >= datetime('now', ?)
      AND COALESCE(scope_status, 'active') = 'active'
      ${userClause}
      ${tenantClause}
    GROUP BY tenant_id
    ORDER BY messages DESC
    LIMIT ?
  `, args);

  return rows.map((row) => ({
    tenantId: asNumber(row.tenantId),
    activeUsers: asNumber(row.activeUsers),
    messages: asNumber(row.messages),
    failedMessages: asNumber(row.failedMessages),
    pendingConfirmations: asNumber(row.pendingConfirmations),
    lastMessageAt: typeof row.lastMessageAt === 'string' ? row.lastMessageAt : null,
  }));
}

function buildSimpleBuckets(
  db: PortalChatDiagnosticsDb,
  input: {
    windowDays: number;
    columnSql: string;
    fallback: string;
    limit: number;
    userId?: number;
    tenantId?: number;
    includeConfidence?: boolean;
  },
): PortalChatDiagnosticBucket[] {
  const userClause = input.userId ? 'AND user_id = ?' : '';
  const tenantClause = input.tenantId ? 'AND tenant_id = ?' : '';
  const args = [
    sinceArg(input.windowDays),
    ...(input.userId ? [input.userId] : []),
    ...(input.tenantId ? [input.tenantId] : []),
    input.limit,
  ];
  const confidenceSql = input.includeConfidence
    ? ', AVG(confidence) as avgConfidence'
    : '';
  const rows = safeAll<Record<string, unknown>>(db, `
    SELECT
      COALESCE(${input.columnSql}, ?) as key,
      COUNT(*) as messages,
      SUM(CASE WHEN COALESCE(lifecycle_state, 'completed') = 'failed' OR error_code IS NOT NULL THEN 1 ELSE 0 END) as failedMessages
      ${confidenceSql}
    FROM messages
    WHERE created_at >= datetime('now', ?)
      AND COALESCE(scope_status, 'active') = 'active'
      ${userClause}
      ${tenantClause}
    GROUP BY key
    ORDER BY messages DESC
    LIMIT ?
  `, [input.fallback, ...args]);

  return rows.map((row) => ({
    key: asString(row.key, input.fallback),
    messages: asNumber(row.messages),
    failedMessages: asNumber(row.failedMessages),
    avgConfidence: input.includeConfidence ? asNullableNumber(row.avgConfidence) : undefined,
  }));
}

function buildProviderUsage(
  db: PortalChatDiagnosticsDb,
  windowDays: number,
  limit: number,
  userId?: number,
  tenantId?: number,
): PortalChatProviderDiagnostic[] {
  const userClause = userId ? 'AND user_id = ?' : '';
  const tenantClause = tenantId ? 'AND tenant_id = ?' : '';
  const args = [
    sinceArg(windowDays),
    ...(userId ? [userId] : []),
    ...(tenantId ? [tenantId] : []),
    ...CHAT_USAGE_CATEGORIES,
    limit,
  ];
  const placeholders = CHAT_USAGE_CATEGORIES.map(() => '?').join(', ');
  const rows = safeAll<Record<string, unknown>>(db, `
    SELECT
      COALESCE(provider, 'unknown') as provider,
      COALESCE(model, 'unknown') as model,
      COALESCE(category, 'unknown') as category,
      COUNT(*) as calls,
      COALESCE(SUM(cost_usd), 0) as costUsd,
      COALESCE(SUM(input_tokens + output_tokens), 0) as tokens,
      AVG(duration_ms) as avgLatencyMs
    FROM api_usage
    WHERE ts >= datetime('now', ?)
      ${userClause}
      ${tenantClause}
      AND (
        category IN (${placeholders})
        OR category LIKE '%chat%'
        OR category LIKE '%tool%'
      )
    GROUP BY provider, model, category
    ORDER BY calls DESC
    LIMIT ?
  `, args);

  return rows.map((row) => ({
    provider: asString(row.provider, 'unknown'),
    model: asString(row.model, 'unknown'),
    category: asString(row.category, 'unknown'),
    calls: asNumber(row.calls),
    costUsd: asNumber(row.costUsd),
    tokens: asNumber(row.tokens),
    avgLatencyMs: asNullableNumber(row.avgLatencyMs),
  }));
}

function parseMetadata(metadataJson: string | null | undefined): Record<string, unknown> | null {
  if (!metadataJson) return null;
  try {
    const parsed = JSON.parse(metadataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function metadataStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        return typeof record.id === 'string'
          ? record.id
          : typeof record.name === 'string'
            ? record.name
            : null;
      }
      return null;
    })
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, 8);
}

function mapRecentMessage(row: RawMessageRow): PortalChatMessageDiagnostic {
  const metadata = parseMetadata(row.metadata_json);
  const toolCalls = Array.isArray(metadata?.toolCalls)
    ? metadata.toolCalls
    : Array.isArray(metadata?.tool_calls)
      ? metadata.tool_calls
      : [];

  return {
    id: asString(row.message_uuid),
    tenantId: asNumber(row.tenant_id),
    userId: asNumber(row.user_id),
    role: asString(row.role, 'assistant'),
    domain: row.domain ?? null,
    routeMethod: row.route_method ?? null,
    lifecycleState: row.lifecycle_state ?? (row.role === 'user' ? 'sent' : 'completed'),
    errorCode: row.error_code ?? null,
    textLength: typeof row.text === 'string' ? row.text.length : 0,
    hasButtons: Boolean(row.buttons_json),
    hasMetadata: Boolean(row.metadata_json),
    metadataType: typeof metadata?.type === 'string' ? metadata.type : null,
    sourceSkills: metadataStringArray(metadata?.sourceSkills ?? metadata?.source_skills),
    toolCallCount: toolCalls.length,
    hasActionConfirmation: Boolean(metadata?.actionConfirmation ?? metadata?.action_confirmation),
    hasClarificationPrompt: Boolean(metadata?.clarification),
    createdAt: asString(row.created_at),
  };
}

function buildRecentMessages(
  db: PortalChatDiagnosticsDb,
  userId: number,
  tenantId: number,
  windowDays: number,
  limit: number,
): PortalChatMessageDiagnostic[] {
  const rows = safeAll<RawMessageRow>(db, `
    SELECT
      message_uuid,
      tenant_id,
      user_id,
      role,
      domain,
      route_method,
      lifecycle_state,
      error_code,
      text,
      buttons_json,
      metadata_json,
      created_at
    FROM messages
    WHERE tenant_id = ?
      AND user_id = ?
      AND created_at >= datetime('now', ?)
      AND COALESCE(scope_status, 'active') = 'active'
      AND COALESCE(lifecycle_state, 'completed') != 'deleted'
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `, [tenantId, userId, sinceArg(windowDays), limit]);

  return rows.map(mapRecentMessage);
}

export function buildPortalChatDiagnostics(
  db: PortalChatDiagnosticsDb,
  options: PortalChatDiagnosticsOptions = {},
): PortalChatDiagnostics {
  const normalized = normalizeOptions(options);
  return {
    ok: true,
    privacyMode: 'metadata_only',
    windowDays: normalized.windowDays,
    totals: buildTotals(db, normalized.windowDays),
    byTenant: buildTenantBuckets(db, normalized.windowDays, normalized.limit),
    byLifecycle: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: "COALESCE(lifecycle_state, CASE WHEN role = 'user' THEN 'sent' ELSE 'completed' END)",
      fallback: 'unknown',
      limit: normalized.limit,
    }),
    byDomain: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: 'domain',
      fallback: 'unknown',
      limit: normalized.limit,
      includeConfidence: true,
    }),
    byRouteMethod: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: 'route_method',
      fallback: 'unknown',
      limit: normalized.limit,
    }),
    providerUsage: buildProviderUsage(db, normalized.windowDays, normalized.limit),
  };
}

export function buildPortalUserChatDiagnostics(
  db: PortalChatDiagnosticsDb,
  userId: number,
  options: PortalChatDiagnosticsOptions = {},
): PortalUserChatDiagnostics {
  const normalized = normalizeOptions(options);
  const tenantId = Number.isInteger(options.tenantId) && Number(options.tenantId) > 0
    ? Number(options.tenantId)
    : userId;
  return {
    ok: true,
    privacyMode: 'metadata_only',
    userId,
    windowDays: normalized.windowDays,
    totals: buildTotals(db, normalized.windowDays, userId, tenantId),
    byTenant: buildTenantBuckets(db, normalized.windowDays, normalized.limit, userId, tenantId),
    byLifecycle: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: "COALESCE(lifecycle_state, CASE WHEN role = 'user' THEN 'sent' ELSE 'completed' END)",
      fallback: 'unknown',
      limit: normalized.limit,
      userId,
      tenantId,
    }),
    byDomain: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: 'domain',
      fallback: 'unknown',
      limit: normalized.limit,
      userId,
      tenantId,
      includeConfidence: true,
    }),
    byRouteMethod: buildSimpleBuckets(db, {
      windowDays: normalized.windowDays,
      columnSql: 'route_method',
      fallback: 'unknown',
      limit: normalized.limit,
      userId,
      tenantId,
    }),
    providerUsage: buildProviderUsage(db, normalized.windowDays, normalized.limit, userId, tenantId),
    recentMessages: buildRecentMessages(db, userId, tenantId, normalized.windowDays, normalized.limit),
  };
}
