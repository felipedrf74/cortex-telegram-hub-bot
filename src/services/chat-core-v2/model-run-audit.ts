// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import { getDb } from '../database';
import type {
  AuditRetentionPolicy,
  AuditSensitivity,
  ChatReplayBundle,
  ChatV2ModelRun,
  LLMProviderCapabilities,
} from './types';

export interface RecordChatV2ReplayBundleInput {
  replayBundleId: string;
  bundle: ChatReplayBundle;
  sensitivity: AuditSensitivity;
  retentionPolicy: AuditRetentionPolicy;
  encryptedFullBundle?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface ChatV2ReplayBundleRecord {
  id: number;
  replayBundleId: string;
  turnId: string;
  sensitivity: AuditSensitivity;
  retentionPolicy: AuditRetentionPolicy;
  bundle: ChatReplayBundle | null;
  encryptedFullBundle: string | null;
  createdAt: string;
  expiresAt: string | null;
}

export interface ChatV2ModelRunRecord extends ChatV2ModelRun {
  id: number;
  cachedInputTokenCount: number;
}

type ChatV2ModelRunStatus = ChatV2ModelRun['status'];

const MODEL_RUN_STATUSES: ReadonlySet<ChatV2ModelRunStatus> = new Set([
  'success',
  'schema_failed',
  'refused',
  'timeout',
  'error',
]);

const MODEL_RUN_PROVIDERS: ReadonlySet<LLMProviderCapabilities['provider']> = new Set([
  'openai',
  'anthropic',
  'google',
  'local',
  'other',
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

export function ensureChatCoreV2AuditTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_v2_model_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_run_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google', 'local', 'other')),
      model TEXT NOT NULL,
      model_version TEXT,
      model_settings_hash TEXT NOT NULL,
      prompt_template_version TEXT NOT NULL,
      tool_schema_set_version TEXT NOT NULL,
      context_builder_version TEXT NOT NULL,
      router_version TEXT NOT NULL,
      entity_resolver_version TEXT,
      reasoning_policy_version TEXT NOT NULL,
      input_token_count INTEGER NOT NULL DEFAULT 0,
      cached_input_token_count INTEGER NOT NULL DEFAULT 0,
      output_token_count INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL CHECK (status IN ('success', 'schema_failed', 'refused', 'timeout', 'error')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_v2_replay_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      replay_bundle_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      sensitivity TEXT NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'financial', 'health_adjacent', 'credential_adjacent')),
      retention_policy TEXT NOT NULL CHECK (retention_policy IN ('30d', '90d', '1y', 'legal_required')),
      redacted_bundle_json TEXT NOT NULL,
      encrypted_full_bundle TEXT,
      created_at TEXT NOT NULL,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_chat_v2_model_runs_turn
      ON chat_v2_model_runs(turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_model_runs_status
      ON chat_v2_model_runs(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_replay_bundles_turn
      ON chat_v2_replay_bundles(turn_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_chat_v2_replay_bundles_retention
      ON chat_v2_replay_bundles(retention_policy, expires_at);
  `);
}

export function recordChatV2ModelRun(
  run: ChatV2ModelRun,
  db: Database.Database = getDb(),
): ChatV2ModelRunRecord {
  ensureChatCoreV2AuditTables(db);
  validateModelRun(run);

  db.prepare(`
    INSERT INTO chat_v2_model_runs (
      model_run_id, turn_id, provider, model, model_version,
      model_settings_hash, prompt_template_version, tool_schema_set_version,
      context_builder_version, router_version, entity_resolver_version,
      reasoning_policy_version, input_token_count, cached_input_token_count,
      output_token_count, latency_ms, status, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(model_run_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      provider = excluded.provider,
      model = excluded.model,
      model_version = excluded.model_version,
      model_settings_hash = excluded.model_settings_hash,
      prompt_template_version = excluded.prompt_template_version,
      tool_schema_set_version = excluded.tool_schema_set_version,
      context_builder_version = excluded.context_builder_version,
      router_version = excluded.router_version,
      entity_resolver_version = excluded.entity_resolver_version,
      reasoning_policy_version = excluded.reasoning_policy_version,
      input_token_count = excluded.input_token_count,
      cached_input_token_count = excluded.cached_input_token_count,
      output_token_count = excluded.output_token_count,
      latency_ms = excluded.latency_ms,
      status = excluded.status,
      created_at = excluded.created_at
  `).run(
    run.modelRunId,
    run.turnId,
    run.provider,
    run.model,
    run.modelVersion ?? null,
    run.modelSettingsHash,
    run.promptTemplateVersion,
    run.toolSchemaSetVersion,
    run.contextBuilderVersion,
    run.routerVersion,
    run.entityResolverVersion ?? null,
    run.reasoningPolicyVersion,
    nonNegativeInteger(run.inputTokenCount, 'inputTokenCount'),
    nonNegativeInteger(run.cachedInputTokenCount ?? 0, 'cachedInputTokenCount'),
    nonNegativeInteger(run.outputTokenCount, 'outputTokenCount'),
    nonNegativeInteger(run.latencyMs, 'latencyMs'),
    run.status,
    run.createdAt,
  );

  return getChatV2ModelRunById(run.modelRunId, db)!;
}

export function getChatV2ModelRunById(
  modelRunId: string,
  db: Database.Database = getDb(),
): ChatV2ModelRunRecord | null {
  ensureChatCoreV2AuditTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_model_runs WHERE model_run_id = ?').get(modelRunId);
  return row ? mapModelRunRow(row) : null;
}

export function listChatV2ModelRunsForTurn(
  turnId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2ModelRunRecord[] {
  ensureChatCoreV2AuditTables(db);
  const limit = boundedLimit(options.limit);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_model_runs
    WHERE turn_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(turnId, limit);
  return rows.map(mapModelRunRow);
}

export function recordChatV2ReplayBundle(
  input: RecordChatV2ReplayBundleInput,
  db: Database.Database = getDb(),
): ChatV2ReplayBundleRecord {
  ensureChatCoreV2AuditTables(db);
  validateReplayBundleInput(input);
  const createdAt = input.createdAt ?? new Date().toISOString();

  db.prepare(`
    INSERT INTO chat_v2_replay_bundles (
      replay_bundle_id, turn_id, sensitivity, retention_policy,
      redacted_bundle_json, encrypted_full_bundle, created_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(replay_bundle_id) DO UPDATE SET
      turn_id = excluded.turn_id,
      sensitivity = excluded.sensitivity,
      retention_policy = excluded.retention_policy,
      redacted_bundle_json = excluded.redacted_bundle_json,
      encrypted_full_bundle = excluded.encrypted_full_bundle,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).run(
    input.replayBundleId,
    input.bundle.turnId,
    input.sensitivity,
    input.retentionPolicy,
    JSON.stringify(input.bundle),
    input.encryptedFullBundle ?? null,
    createdAt,
    input.expiresAt ?? null,
  );

  return getChatV2ReplayBundleById(input.replayBundleId, db)!;
}

export function getChatV2ReplayBundleById(
  replayBundleId: string,
  db: Database.Database = getDb(),
): ChatV2ReplayBundleRecord | null {
  ensureChatCoreV2AuditTables(db);
  const row = db.prepare('SELECT * FROM chat_v2_replay_bundles WHERE replay_bundle_id = ?').get(replayBundleId);
  return row ? mapReplayBundleRow(row) : null;
}

export function listChatV2ReplayBundlesForTurn(
  turnId: string,
  db: Database.Database = getDb(),
  options: { limit?: number } = {},
): ChatV2ReplayBundleRecord[] {
  ensureChatCoreV2AuditTables(db);
  const limit = boundedLimit(options.limit);
  const rows = db.prepare(`
    SELECT * FROM chat_v2_replay_bundles
    WHERE turn_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `).all(turnId, limit);
  return rows.map(mapReplayBundleRow);
}

function validateModelRun(run: ChatV2ModelRun): void {
  requireNonEmpty(run.modelRunId, 'modelRunId');
  requireNonEmpty(run.turnId, 'turnId');
  requireNonEmpty(run.model, 'model');
  requireNonEmpty(run.modelSettingsHash, 'modelSettingsHash');
  requireNonEmpty(run.promptTemplateVersion, 'promptTemplateVersion');
  requireNonEmpty(run.toolSchemaSetVersion, 'toolSchemaSetVersion');
  requireNonEmpty(run.contextBuilderVersion, 'contextBuilderVersion');
  requireNonEmpty(run.routerVersion, 'routerVersion');
  requireNonEmpty(run.reasoningPolicyVersion, 'reasoningPolicyVersion');
  requireNonEmpty(run.createdAt, 'createdAt');
  if (!MODEL_RUN_PROVIDERS.has(run.provider)) throw new Error(`Invalid Chat Core v2 provider: ${run.provider}`);
  if (!MODEL_RUN_STATUSES.has(run.status)) throw new Error(`Invalid Chat Core v2 model run status: ${run.status}`);
  nonNegativeInteger(run.inputTokenCount, 'inputTokenCount');
  nonNegativeInteger(run.cachedInputTokenCount ?? 0, 'cachedInputTokenCount');
  nonNegativeInteger(run.outputTokenCount, 'outputTokenCount');
  nonNegativeInteger(run.latencyMs, 'latencyMs');
}

function validateReplayBundleInput(input: RecordChatV2ReplayBundleInput): void {
  requireNonEmpty(input.replayBundleId, 'replayBundleId');
  requireNonEmpty(input.bundle.turnId, 'bundle.turnId');
  requireNonEmpty(input.bundle.toolSchemaSetVersion, 'bundle.toolSchemaSetVersion');
  if (!AUDIT_SENSITIVITIES.has(input.sensitivity)) throw new Error(`Invalid audit sensitivity: ${input.sensitivity}`);
  if (!AUDIT_RETENTION_POLICIES.has(input.retentionPolicy)) throw new Error(`Invalid audit retention policy: ${input.retentionPolicy}`);
  if (input.encryptedFullBundle !== undefined) requireNonEmpty(input.encryptedFullBundle, 'encryptedFullBundle');
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 25), 1), 250);
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }
  return Math.trunc(value);
}

function requireNonEmpty(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
}

function mapModelRunRow(raw: unknown): ChatV2ModelRunRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    modelRunId: String(row.model_run_id),
    turnId: String(row.turn_id),
    provider: row.provider as ChatV2ModelRun['provider'],
    model: String(row.model),
    modelVersion: stringOrUndefined(row.model_version),
    modelSettingsHash: String(row.model_settings_hash),
    promptTemplateVersion: String(row.prompt_template_version),
    toolSchemaSetVersion: String(row.tool_schema_set_version),
    contextBuilderVersion: String(row.context_builder_version),
    routerVersion: String(row.router_version),
    entityResolverVersion: stringOrUndefined(row.entity_resolver_version),
    reasoningPolicyVersion: String(row.reasoning_policy_version),
    inputTokenCount: Number(row.input_token_count),
    cachedInputTokenCount: Number(row.cached_input_token_count),
    outputTokenCount: Number(row.output_token_count),
    latencyMs: Number(row.latency_ms),
    status: row.status as ChatV2ModelRun['status'],
    createdAt: String(row.created_at),
  };
}

function mapReplayBundleRow(raw: unknown): ChatV2ReplayBundleRecord {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    replayBundleId: String(row.replay_bundle_id),
    turnId: String(row.turn_id),
    sensitivity: row.sensitivity as AuditSensitivity,
    retentionPolicy: row.retention_policy as AuditRetentionPolicy,
    bundle: parseReplayBundle(row.redacted_bundle_json),
    encryptedFullBundle: stringOrNull(row.encrypted_full_bundle),
    createdAt: String(row.created_at),
    expiresAt: stringOrNull(row.expires_at),
  };
}

function parseReplayBundle(value: unknown): ChatReplayBundle | null {
  try {
    const parsed = JSON.parse(String(value ?? 'null'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ChatReplayBundle;
  } catch {
    return null;
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
