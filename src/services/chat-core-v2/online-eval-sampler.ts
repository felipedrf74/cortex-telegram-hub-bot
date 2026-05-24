// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { getDb } from '../database';
import type {
  ActionRisk,
  AuditSensitivity,
  ChatCoreV2Domain,
  ChatCoreV2EvidenceSignal,
  ChatCoreV2RouteMethod,
  FallbackReason,
} from './types';

export const CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION = 'chat_core_v2_online_eval_sampler@1.0.0';

export type ChatV2OnlineEvalSampleReason =
  | 'baseline_random'
  | 'schema_failure'
  | 'model_refusal'
  | 'model_timeout'
  | 'fallback'
  | 'verification_failure'
  | 'policy_rejection'
  | 'prompt_injection_signal'
  | 'high_risk'
  | 'restricted_risk'
  | 'finance_sensitive'
  | 'unsupported_or_blocked'
  | 'not_sampled'
  | 'privacy_suppressed';

export type ChatV2OnlineEvalSampleStatus = 'sampled' | 'not_sampled' | 'privacy_suppressed';

export interface DecideChatV2OnlineEvalSamplingInput {
  turnId: string;
  tenantId: string;
  userId: string;
  routeMethod: ChatCoreV2RouteMethod;
  risk: ActionRisk;
  sensitivity: AuditSensitivity;
  domain?: ChatCoreV2Domain;
  replayBundleId?: string;
  fallbackReason?: FallbackReason;
  modelRunStatuses?: Array<'success' | 'schema_failed' | 'refused' | 'timeout' | 'error'>;
  commandStatuses?: string[];
  evidenceSignalCodes?: ChatCoreV2EvidenceSignal[];
  metadata?: Record<string, unknown>;
}

export interface ChatV2OnlineEvalSamplingOptions {
  baselineRate?: number;
  financeRate?: number;
  allowCredentialAdjacent?: boolean;
  seed?: string;
}

export interface ChatV2OnlineEvalSamplingDecision {
  sample: boolean;
  status: ChatV2OnlineEvalSampleStatus;
  reason: ChatV2OnlineEvalSampleReason;
  sampleRate: number;
  samplerVersion: string;
}

export interface ChatV2OnlineEvalSampleRecord extends ChatV2OnlineEvalSamplingDecision {
  id: number;
  sampleId: string;
  turnId: string;
  tenantId: string;
  userId: string;
  replayBundleId?: string;
  routeMethod: ChatCoreV2RouteMethod;
  domain?: ChatCoreV2Domain;
  risk: ActionRisk;
  sensitivity: AuditSensitivity;
  metadata: Record<string, unknown>;
  createdAt: string;
}

const ROUTE_METHODS: ReadonlySet<ChatCoreV2RouteMethod> = new Set([
  'deterministic_read',
  'llm_synthesis',
  'llm_command_translation',
  'planner',
  'background_planner',
  'needs_clarification',
  'unsupported',
  'blocked',
]);

const RISKS: ReadonlySet<ActionRisk> = new Set(['low', 'medium', 'high', 'restricted']);

const SENSITIVITIES: ReadonlySet<AuditSensitivity> = new Set([
  'normal',
  'personal',
  'financial',
  'health_adjacent',
  'credential_adjacent',
]);

const DOMAINS: ReadonlySet<ChatCoreV2Domain> = new Set([
  'secretary',
  'tasks',
  'training',
  'content',
  'cooking',
  'finance',
  'connections',
  'notifications',
  'decision_center',
]);

export function ensureChatCoreV2OnlineEvalTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_online_eval_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sample_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      replay_bundle_id TEXT,
      route_method TEXT NOT NULL,
      domain TEXT,
      risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'restricted')),
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
      reason TEXT NOT NULL,
      sample_rate REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('sampled', 'not_sampled', 'privacy_suppressed')),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_turn
      ON chat_v2_online_eval_samples(turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_scope
      ON chat_v2_online_eval_samples(tenant_id, user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_online_eval_samples_status_reason
      ON chat_v2_online_eval_samples(status, reason, created_at DESC);
  `);
}

export function decideChatV2OnlineEvalSampling(
  input: DecideChatV2OnlineEvalSamplingInput,
  options: ChatV2OnlineEvalSamplingOptions = {},
): ChatV2OnlineEvalSamplingDecision {
  validateSamplingInput(input);

  if (input.sensitivity === 'credential_adjacent' && options.allowCredentialAdjacent !== true) {
    return decision(false, 'privacy_suppressed', 'privacy_suppressed', 0);
  }

  const reason = selectSampleReason(input);
  const forced = reason !== 'baseline_random' && reason !== 'not_sampled';
  const sampleRate = forced ? 1 : normalizeRate(options.baselineRate ?? 0.01);
  const sampled = forced || deterministicRoll(`${options.seed ?? 'chat-v2-online-eval'}:${input.turnId}:${reason}`) < sampleRate;

  return decision(sampled, sampled ? 'sampled' : 'not_sampled', sampled ? reason : 'not_sampled', sampleRate);
}

export function recordChatV2OnlineEvalSample(
  input: DecideChatV2OnlineEvalSamplingInput & {
    sampleId: string;
    decision?: ChatV2OnlineEvalSamplingDecision;
    createdAt?: string;
  },
  db: Database.Database = getDb(),
): ChatV2OnlineEvalSampleRecord {
  ensureChatCoreV2OnlineEvalTables(db);
  requireNonEmpty(input.sampleId, 'sampleId');
  const samplingDecision = input.decision ?? decideChatV2OnlineEvalSampling(input);
  const createdAt = input.createdAt ?? new Date().toISOString();

  db.prepare(`
    INSERT INTO chat_v2_online_eval_samples (
      sample_id, turn_id, tenant_id, user_id, replay_bundle_id, route_method,
      domain, risk, sensitivity, reason, sample_rate, status, metadata_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sample_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      tenant_id = excluded.tenant_id,
      user_id = excluded.user_id,
      replay_bundle_id = excluded.replay_bundle_id,
      route_method = excluded.route_method,
      domain = excluded.domain,
      risk = excluded.risk,
      sensitivity = excluded.sensitivity,
      reason = excluded.reason,
      sample_rate = excluded.sample_rate,
      status = excluded.status,
      metadata_json = excluded.metadata_json,
      created_at = excluded.created_at
  `).run(
    input.sampleId,
    input.turnId,
    input.tenantId,
    input.userId,
    input.replayBundleId ?? null,
    input.routeMethod,
    input.domain ?? null,
    input.risk,
    input.sensitivity,
    samplingDecision.reason,
    samplingDecision.sampleRate,
    samplingDecision.status,
    JSON.stringify(sanitizeMetadata(input.metadata ?? {})),
    createdAt,
  );

  return getChatV2OnlineEvalSampleById(input.sampleId, db)!;
}

export function getChatV2OnlineEvalSampleById(
  sampleId: string,
  db: Database.Database = getDb(),
): ChatV2OnlineEvalSampleRecord | null {
  ensureChatCoreV2OnlineEvalTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_online_eval_samples WHERE sample_id = ?').get(sampleId);
  return row ? mapEvalSampleRow(row) : null;
}

export function listChatV2OnlineEvalSamplesForTurn(
  turnId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2OnlineEvalSampleRecord[] {
  ensureChatCoreV2OnlineEvalTables(db);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_online_eval_samples
    WHERE turn_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(turnId, boundedLimit(options.limit));
  return rows.map(mapEvalSampleRow);
}

function selectSampleReason(input: DecideChatV2OnlineEvalSamplingInput): ChatV2OnlineEvalSampleReason {
  const modelStatuses = new Set(input.modelRunStatuses ?? []);
  const commandStatuses = new Set(input.commandStatuses ?? []);
  const signals = new Set(input.evidenceSignalCodes ?? []);

  if (modelStatuses.has('schema_failed')) return 'schema_failure';
  if (modelStatuses.has('refused')) return 'model_refusal';
  if (modelStatuses.has('timeout') || modelStatuses.has('error')) return 'model_timeout';
  if (input.fallbackReason) return 'fallback';
  if (commandStatuses.has('verification_failed')) return 'verification_failure';
  if (commandStatuses.has('rejected_by_policy') || commandStatuses.has('approval_denied')) return 'policy_rejection';
  if (
    signals.has('prompt_injection_phrase')
    || signals.has('delimiter_breakout')
    || signals.has('access_control_request')
    || signals.has('bulk_destructive_request')
  ) return 'prompt_injection_signal';
  if (input.risk === 'restricted') return 'restricted_risk';
  if (input.risk === 'high') return 'high_risk';
  if (input.domain === 'finance' || input.sensitivity === 'financial') return 'finance_sensitive';
  if (input.routeMethod === 'unsupported' || input.routeMethod === 'blocked') return 'unsupported_or_blocked';
  return 'baseline_random';
}

function decision(
  sample: boolean,
  status: ChatV2OnlineEvalSampleStatus,
  reason: ChatV2OnlineEvalSampleReason,
  sampleRate: number,
): ChatV2OnlineEvalSamplingDecision {
  return {
    sample,
    status,
    reason,
    sampleRate,
    samplerVersion: CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION,
  };
}

function deterministicRoll(seed: string): number {
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return Number.parseInt(hash, 16) / 0xffffffffffff;
}

function validateSamplingInput(input: DecideChatV2OnlineEvalSamplingInput): void {
  requireNonEmpty(input.turnId, 'turnId');
  requireNonEmpty(input.tenantId, 'tenantId');
  requireNonEmpty(input.userId, 'userId');
  if (input.replayBundleId !== undefined) requireNonEmpty(input.replayBundleId, 'replayBundleId');
  if (!ROUTE_METHODS.has(input.routeMethod)) throw new Error(`Invalid Chat Core v2 route method: ${input.routeMethod}`);
  if (!RISKS.has(input.risk)) throw new Error(`Invalid Chat Core v2 risk: ${input.risk}`);
  if (!SENSITIVITIES.has(input.sensitivity)) throw new Error(`Invalid audit sensitivity: ${input.sensitivity}`);
  if (input.domain !== undefined && !DOMAINS.has(input.domain)) throw new Error(`Invalid Chat Core v2 domain: ${input.domain}`);
}

function sanitizeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(metadata).sort()) {
    if (isSensitiveKey(key)) {
      output[key] = '[redacted]';
      continue;
    }
    const value = metadata[key];
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') continue;
    output[key] = value;
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /(?:^|_)(?:token|jwt)(?:$|_)/i.test(key)
    || /api(?:[\s_-]?key|Key)/i.test(key)
    || /(?:client|webhook|session)(?:[\s_-]?secret|Secret)/i.test(key)
    || /password/i.test(key)
    || /prompt|providerPayload|providerRequest|providerResponse/i.test(key);
}

function normalizeRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  return Math.min(Math.max(rate, 0), 1);
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 50), 1), 250);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function mapEvalSampleRow(raw: unknown): ChatV2OnlineEvalSampleRecord {
  const row = raw as Record<string, unknown>;
  const status = row.status as ChatV2OnlineEvalSampleStatus;
  return {
    id: Number(row.id),
    sampleId: String(row.sample_id),
    turnId: String(row.turn_id),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    replayBundleId: stringOrUndefined(row.replay_bundle_id),
    routeMethod: row.route_method as ChatCoreV2RouteMethod,
    domain: stringOrUndefined(row.domain) as ChatCoreV2Domain | undefined,
    risk: row.risk as ActionRisk,
    sensitivity: row.sensitivity as AuditSensitivity,
    sample: status === 'sampled',
    status,
    reason: row.reason as ChatV2OnlineEvalSampleReason,
    sampleRate: Number(row.sample_rate),
    samplerVersion: CHAT_CORE_V2_ONLINE_EVAL_SAMPLER_VERSION,
    metadata: parseMetadata(row.metadata_json),
    createdAt: String(row.created_at),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
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
