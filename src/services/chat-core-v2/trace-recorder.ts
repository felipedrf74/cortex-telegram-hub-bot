// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { getDb } from '../database';
import { recordChatV2ReplayBundle, type ChatV2ReplayBundleRecord } from './model-run-audit';
import type {
  AuditRetentionPolicy,
  AuditSensitivity,
  ChatReplayBundle,
  ChatV2CommandEvent,
  ChatV2ModelRun,
  ChatV2TraceSpan,
  ChatV2TraceSpanKind,
  ChatV2TraceSpanStatus,
  AICommandEnvelope,
} from './types';

export const CHAT_CORE_V2_TRACE_RECORDER_VERSION = 'chat_core_v2_trace_recorder@1.0.0';

export interface ChatV2TraceSpanRecord extends ChatV2TraceSpan {
  id: number;
  attributes: Record<string, unknown>;
  durationMs: number;
  // WP-08: retention-window expiry. NULL (=> undefined here) for
  // `legal_required` spans, which are never auto-deleted.
  expiresAt?: string;
}

export interface BuildChatV2ReplayBundleInput {
  turnId: string;
  routeDecision: unknown;
  contextPack: unknown;
  modelRuns?: ChatV2ModelRun[];
  toolSchemaSetVersion: string;
  commandProposals?: AICommandEnvelope[];
  commandEvents?: ChatV2CommandEvent[];
  traceSpans?: ChatV2TraceSpan[];
  response: unknown;
}

export interface RecordChatV2TraceReplayInput extends BuildChatV2ReplayBundleInput {
  replayBundleId: string;
  sensitivity: AuditSensitivity;
  retentionPolicy: AuditRetentionPolicy;
  encryptedFullBundle?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ChatV2TraceReplayRecord {
  replayBundle: ChatV2ReplayBundleRecord;
  traceSpans: ChatV2TraceSpanRecord[];
}

const TRACE_SPAN_KINDS: ReadonlySet<ChatV2TraceSpanKind> = new Set([
  'router',
  'budget',
  'capability',
  'context',
  'entity_resolution',
  'tool_selection',
  'model',
  'policy',
  'command',
  'workflow',
  'response',
  'fallback',
  'guardrail',
  'custom',
]);

const TRACE_SPAN_STATUSES: ReadonlySet<ChatV2TraceSpanStatus> = new Set([
  'success',
  'skipped',
  'blocked',
  'failed',
]);

const AUDIT_SENSITIVITIES: ReadonlySet<AuditSensitivity> = new Set([
  'normal',
  'personal',
  'financial',
  'health_adjacent',
  'credential_adjacent',
]);

const AUDIT_RETENTION_POLICIES: ReadonlySet<AuditRetentionPolicy> = new Set([
  '30d',
  '90d',
  '1y',
  'legal_required',
]);

const REDACTED = '[redacted]';
const REDACTED_TRUNCATED = '[truncated]';
const MAX_SUMMARY_CHARS = 1000;
const MAX_STRING_CHARS = 2000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_REDACTION_DEPTH = 8;

export function ensureChatCoreV2TraceTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_trace_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_span_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      parent_span_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN (
        'router', 'budget', 'capability', 'context', 'entity_resolution',
        'tool_selection', 'model', 'policy', 'command', 'workflow',
        'response', 'fallback', 'guardrail', 'custom'
      )),
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success', 'skipped', 'blocked', 'failed')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
      retention_policy TEXT NOT NULL CHECK (retention_policy IN ('30d', '90d', '1y', 'legal_required')),
      redacted_summary TEXT NOT NULL,
      attributes_json TEXT NOT NULL DEFAULT '{}',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_turn
      ON chat_v2_trace_spans(turn_id, started_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_scope
      ON chat_v2_trace_spans(tenant_id, user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_kind_status
      ON chat_v2_trace_spans(kind, status, started_at DESC);
  `);

  // WP-08 retention column. The base CREATE above keeps the original 161-era
  // schema verbatim (so a fresh :memory: test DB matches production-after-161);
  // `expires_at` is added here as an idempotent ALTER that mirrors migration
  // 172. The PRAGMA guard makes it a no-op once the column exists, whether it
  // was added by this guard on a fresh DB or by migration 172 in production.
  // This is the seam that lets the data-retention cron's
  // `chat_v2_trace_spans` stanza be meaningful on any DB this module touches.
  ensureTraceSpanExpiresAtColumn(db);
}

function ensureTraceSpanExpiresAtColumn(db: Database.Database): void {
  try {
    const columns = db.prepare('PRAGMA table_info(chat_v2_trace_spans)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'expires_at')) {
      db.exec('ALTER TABLE chat_v2_trace_spans ADD COLUMN expires_at TEXT');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_chat_v2_trace_spans_retention
        ON chat_v2_trace_spans(retention_policy, expires_at);
    `);
  } catch {
    // A concurrent migration may have raced the ALTER ("duplicate column") or
    // the table may be mid-creation; either way the column ends up present.
    // The retention stanza tolerates a missing column via its own try/catch.
  }
}

/**
 * Resolves the retention-window expiry for a trace span from its
 * `retention_policy`. `legal_required` is the compliance sentinel — it returns
 * `null` so the row is NEVER assigned an `expires_at` and the data-retention
 * cron can never delete it. Backfill (migration 172) and live writes
 * (`recordChatV2TraceSpan`) must agree on this mapping.
 */
export function resolveTraceSpanExpiresAt(
  startedAt: string,
  retentionPolicy: AuditRetentionPolicy,
): string | null {
  if (retentionPolicy === 'legal_required') return null;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return null;
  const days = retentionPolicy === '1y' ? 365 : retentionPolicy === '90d' ? 90 : 30;
  return new Date(started + days * 24 * 60 * 60 * 1000).toISOString();
}

export function recordChatV2TraceSpan(
  span: ChatV2TraceSpan,
  db: Database.Database = getDb(),
): ChatV2TraceSpanRecord {
  ensureChatCoreV2TraceTables(db);
  validateTraceSpan(span);
  const durationMs = normalizeDurationMs(span);
  // WP-08: persist the retention-window expiry so the midnight cron can age the
  // row out by policy. `legal_required` resolves to NULL (compliance sentinel),
  // and a NULL expires_at is NEVER deleted by the retention sweep.
  const expiresAt = resolveTraceSpanExpiresAt(span.startedAt, span.retentionPolicy);

  db.prepare(`
    INSERT INTO chat_v2_trace_spans (
      trace_span_id, turn_id, tenant_id, user_id, parent_span_id, kind, name,
      status, sensitivity, retention_policy, redacted_summary, attributes_json,
      started_at, ended_at, duration_ms, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(trace_span_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      tenant_id = excluded.tenant_id,
      user_id = excluded.user_id,
      parent_span_id = excluded.parent_span_id,
      kind = excluded.kind,
      name = excluded.name,
      status = excluded.status,
      sensitivity = excluded.sensitivity,
      retention_policy = excluded.retention_policy,
      redacted_summary = excluded.redacted_summary,
      attributes_json = excluded.attributes_json,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      duration_ms = excluded.duration_ms,
      expires_at = excluded.expires_at
  `).run(
    span.traceSpanId,
    span.turnId,
    span.tenantId,
    span.userId,
    span.parentSpanId ?? null,
    span.kind,
    span.name,
    span.status,
    span.sensitivity,
    span.retentionPolicy,
    truncateString(span.redactedSummary, MAX_SUMMARY_CHARS),
    JSON.stringify(redactChatV2TraceValue(span.attributes ?? {})),
    span.startedAt,
    span.endedAt ?? null,
    durationMs,
    expiresAt,
  );

  return getChatV2TraceSpanById(span.traceSpanId, db)!;
}

export function getChatV2TraceSpanById(
  traceSpanId: string,
  db: Database.Database = getDb(),
): ChatV2TraceSpanRecord | null {
  ensureChatCoreV2TraceTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_trace_spans WHERE trace_span_id = ?').get(traceSpanId);
  return row ? mapTraceSpanRow(row) : null;
}

export function listChatV2TraceSpansForTurn(
  turnId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2TraceSpanRecord[] {
  ensureChatCoreV2TraceTables(db);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_trace_spans
    WHERE turn_id = ?
    ORDER BY started_at ASC, id ASC
    LIMIT ?
  `).all(turnId, boundedLimit(options.limit));
  return rows.map(mapTraceSpanRow);
}

export function buildChatV2ReplayBundle(input: BuildChatV2ReplayBundleInput): ChatReplayBundle {
  requireNonEmpty(input.turnId, 'turnId');
  requireNonEmpty(input.toolSchemaSetVersion, 'toolSchemaSetVersion');

  return {
    turnId: input.turnId,
    routeDecision: redactChatV2TraceValue(input.routeDecision),
    contextPack: redactChatV2TraceValue(input.contextPack),
    modelRuns: [...(input.modelRuns ?? [])],
    toolSchemaSetVersion: input.toolSchemaSetVersion,
    commandProposals: redactChatV2TraceValue(input.commandProposals ?? []) as AICommandEnvelope[],
    commandEvents: (input.commandEvents ?? []).map((event) => ({
      ...event,
      metadata: redactChatV2TraceValue(event.metadata ?? {}) as Record<string, unknown>,
    })),
    traceSpans: (input.traceSpans ?? []).map(redactTraceSpanForReplay),
    response: redactChatV2TraceValue(input.response),
  };
}

export function recordChatV2TraceReplay(
  input: RecordChatV2TraceReplayInput,
  db: Database.Database = getDb(),
): ChatV2TraceReplayRecord {
  requireNonEmpty(input.replayBundleId, 'replayBundleId');
  validateAuditEnvelope(input.sensitivity, input.retentionPolicy);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const bundle = buildChatV2ReplayBundle(input);
  const traceSpans = (input.traceSpans ?? []).map((span) => recordChatV2TraceSpan(span, db));

  const replayBundle = recordChatV2ReplayBundle({
    replayBundleId: input.replayBundleId,
    bundle,
    sensitivity: input.sensitivity,
    retentionPolicy: input.retentionPolicy,
    encryptedFullBundle: input.encryptedFullBundle,
    createdAt,
    expiresAt: input.expiresAt,
  }, db);

  return { replayBundle, traceSpans };
}

export function redactChatV2TraceValue(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function validateTraceSpan(span: ChatV2TraceSpan): void {
  requireNonEmpty(span.traceSpanId, 'traceSpanId');
  requireNonEmpty(span.turnId, 'turnId');
  requireNonEmpty(span.tenantId, 'tenantId');
  requireNonEmpty(span.userId, 'userId');
  requireNonEmpty(span.name, 'name');
  requireNonEmpty(span.redactedSummary, 'redactedSummary');
  requireNonEmpty(span.startedAt, 'startedAt');
  if (span.parentSpanId !== undefined) requireNonEmpty(span.parentSpanId, 'parentSpanId');
  if (span.endedAt !== undefined) requireNonEmpty(span.endedAt, 'endedAt');
  if (!TRACE_SPAN_KINDS.has(span.kind)) throw new Error(`Invalid Chat Core v2 trace span kind: ${span.kind}`);
  if (!TRACE_SPAN_STATUSES.has(span.status)) throw new Error(`Invalid Chat Core v2 trace span status: ${span.status}`);
  validateAuditEnvelope(span.sensitivity, span.retentionPolicy);
  if (span.attributes !== undefined) JSON.stringify(redactChatV2TraceValue(span.attributes));
  if (span.durationMs !== undefined) nonNegativeInteger(span.durationMs, 'durationMs');
}

function validateAuditEnvelope(sensitivity: AuditSensitivity, retentionPolicy: AuditRetentionPolicy): void {
  if (!AUDIT_SENSITIVITIES.has(sensitivity)) throw new Error(`Invalid audit sensitivity: ${sensitivity}`);
  if (!AUDIT_RETENTION_POLICIES.has(retentionPolicy)) throw new Error(`Invalid audit retention policy: ${retentionPolicy}`);
}

function redactTraceSpanForReplay(span: ChatV2TraceSpan): ChatV2TraceSpan {
  return {
    ...span,
    redactedSummary: truncateString(span.redactedSummary, MAX_SUMMARY_CHARS),
    attributes: redactChatV2TraceValue(span.attributes ?? {}) as Record<string, unknown>,
    durationMs: normalizeDurationMs(span),
  };
}

function normalizeDurationMs(span: ChatV2TraceSpan): number {
  if (span.durationMs !== undefined) return nonNegativeInteger(span.durationMs, 'durationMs');
  if (!span.endedAt) return 0;
  const started = Date.parse(span.startedAt);
  const ended = Date.parse(span.endedAt);
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return 0;
  return Math.trunc(ended - started);
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return redactSensitiveString(truncateString(value, MAX_STRING_CHARS));
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (depth >= MAX_REDACTION_DEPTH) return '[redacted-depth-limit]';

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactValue(item, depth + 1, seen))
      .filter((item) => item !== undefined)
      .concat(value.length > MAX_ARRAY_ITEMS ? [REDACTED_TRUNCATED] : []);
  }

  if (seen.has(value as object)) return '[redacted-circular]';
  seen.add(value as object);
  const object = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort().slice(0, MAX_OBJECT_KEYS)) {
    if (isSensitiveTraceKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    const redacted = redactValue(object[key], depth + 1, seen);
    if (redacted !== undefined) output[key] = redacted;
  }
  if (Object.keys(object).length > MAX_OBJECT_KEYS) output.__truncatedKeys = true;
  seen.delete(value as object);
  return output;
}

function isSensitiveTraceKey(key: string): boolean {
  return /(?:^|_)(?:token|jwt)(?:$|_)/i.test(key)
    || /(?:access|refresh|confirmation|auth|bearer).*token/i.test(key)
    || /token(?:$|[A-Z_])/i.test(key)
    || /api(?:[\s_-]?key|Key)/i.test(key)
    || /(?:client|webhook|session)(?:[\s_-]?secret|Secret)/i.test(key)
    || /(?:^|[\s_-])secret(?:$|[\s_-])|secret(?:$|[A-Z_])/i.test(key)
    || /session(?:[\s_-]?id|Id)/i.test(key)
    || /password/i.test(key)
    || /^(?:raw_?prompt|prompt|system_prompt|developer_prompt|user_prompt|messages)$/i.test(key)
    || /provider(?:Payload|_payload|Request|_request|Response|_response)/i.test(key);
}

function redactSensitiveString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, 'Bearer [redacted]')
    .replace(/\b(?:sk|pk|rk|ghp|pat)_[A-Za-z0-9_]{12,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, REDACTED);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 100), 1), 500);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return Math.trunc(value);
}

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars);
}

function mapTraceSpanRow(raw: unknown): ChatV2TraceSpanRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    traceSpanId: String(row.trace_span_id),
    turnId: String(row.turn_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    parentSpanId: stringOrUndefined(row.parent_span_id),
    kind: row.kind as ChatV2TraceSpanKind,
    name: String(row.name),
    status: row.status as ChatV2TraceSpanStatus,
    sensitivity: row.sensitivity as AuditSensitivity,
    retentionPolicy: row.retention_policy as AuditRetentionPolicy,
    redactedSummary: String(row.redacted_summary),
    attributes: parseAttributes(row.attributes_json),
    startedAt: String(row.started_at),
    endedAt: stringOrUndefined(row.ended_at),
    durationMs: Number(row.duration_ms),
    expiresAt: stringOrUndefined(row.expires_at),
  };
}

function parseAttributes(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
