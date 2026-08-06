// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'crypto';
import { getDb } from './database';
import { buildNormalizedActionHash } from './chat-action-run-store';
import type { ChatActionName, ChatActionSkill } from './chat/registry';

export type ChatActionRiskClass = 'R0' | 'R1' | 'R2' | 'R3' | 'R4';

export interface ChatSlotProvenance {
  slot: string;
  value: unknown;
  rawText: string | null;
  turnId: string;
  spanStart: number | null;
  spanEnd: number | null;
  sourceType:
    | 'user_message'
    | 'planner'
    | 'classifier'
    | 'reviewer'
    | 'safe_default'
    | 'provider_read_back'
    | 'visible_card'
    | 'pending_action';
  normalizer: string;
  confidence: number;
  validation: 'passed' | 'missing' | 'failed';
}

export interface RecentEntityGraphNode {
  entityId: string;
  entityType: 'task' | 'calendar_event' | 'training_plan' | 'content_package' | 'finance_item' | 'cooking_item';
  provider: string;
  surface: 'chat' | 'tasks' | 'calendar' | 'training' | 'content' | 'finance' | 'cooking';
  userVisibleLabel: string;
  createdOrViewedAt: string;
  lastVerifiedAt: string;
  allowedFollowupActions: string[];
  confidence: number;
  expiresAt: string;
  sourceTurnId: string;
  metadata?: Record<string, unknown>;
}

export interface PendingChatAction {
  id: string;
  schemaVersion: 1;
  userId: number;
  tenantId: number;
  accountId: string | null;
  conversationId: string;
  skill: ChatActionSkill;
  action: ChatActionName;
  status: string;
  collectedSlots: Record<string, unknown>;
  missingSlots: string[];
  riskClass: ChatActionRiskClass;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  accountScope: string | null;
  locale: string;
  timezone: string;
  originatingSurface: string;
  idempotencyKey: string;
  validationState: 'needs_input' | 'valid' | 'invalid';
  confirmationState: 'not_required' | 'required' | 'confirmed';
  cancellationState: 'active' | 'cancelled' | 'expired';
}

export interface ChatActionTelemetry {
  routeTier: 'tier0_deterministic' | 'tier1_classifier' | 'tier2_structured_planner' | 'tier3_reviewer';
  candidates: Array<{ skill: ChatActionSkill; action: ChatActionName; score: number }>;
  calibratedScore: number;
  threshold: number;
  modelProvider?: 'gemini' | 'anthropic' | 'openai';
  model?: string;
  estimatedTokenCostUsd?: number;
  verifierStatus?: 'not_required' | 'pending' | 'verified' | 'mismatch' | 'failed';
  latencyMs?: number;
  outcome?: string;
  failureReason?: string;
  predictedActionHash?: string;
  slotProvenanceSummary?: Record<string, unknown>;
}

export interface ChatActionTelemetryRecordInput {
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  planner: string;
  status: string;
  skill?: ChatActionSkill | null;
  action?: ChatActionName | null;
  telemetry?: ChatActionTelemetry;
  nowIso?: string;
}

export interface ChatActionTelemetryRecord {
  id: string;
  userId: number;
  tenantId: number;
  conversationId: string;
  messageId: string;
  planner: string;
  routeTier: ChatActionTelemetry['routeTier'];
  skill: ChatActionSkill | null;
  action: ChatActionName | null;
  status: string;
  calibratedScore: number | null;
  threshold: number | null;
  modelProvider: ChatActionTelemetry['modelProvider'] | null;
  model: string | null;
  estimatedTokenCostUsd: number | null;
  verifierStatus: ChatActionTelemetry['verifierStatus'] | null;
  latencyMs: number | null;
  outcome: string | null;
  failureReason: string | null;
  predictedActionHash: string | null;
  slotProvenanceSummary: Record<string, unknown> | null;
  createdAt: string;
}

interface PendingRow {
  id: string;
  user_id: number;
  tenant_id: number;
  account_id: string | null;
  conversation_id: string;
  action_hash: string;
  skill: ChatActionSkill;
  action: ChatActionName;
  status: string;
  risk_class: ChatActionRiskClass;
  collected_slots_json: string;
  missing_slots_json: string;
  locale: string;
  timezone: string;
  originating_surface: string | null;
  validation_state: PendingChatAction['validationState'];
  confirmation_state: PendingChatAction['confirmationState'];
  cancellation_state: PendingChatAction['cancellationState'];
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const recentEntities = new Map<string, RecentEntityGraphNode[]>();

export function makeSlotProvenance(input: {
  slot: string;
  value: unknown;
  rawText?: string | null;
  turnId: string;
  spanStart?: number | null;
  spanEnd?: number | null;
  sourceType?: ChatSlotProvenance['sourceType'];
  normalizer: string;
  confidence: number;
  validation?: ChatSlotProvenance['validation'];
}): ChatSlotProvenance {
  return {
    slot: input.slot,
    value: input.value,
    rawText: input.rawText ?? null,
    turnId: input.turnId,
    spanStart: input.spanStart ?? null,
    spanEnd: input.spanEnd ?? null,
    sourceType: input.sourceType ?? 'user_message',
    normalizer: input.normalizer,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    validation: input.validation ?? 'passed',
  };
}

export function upsertPendingChatAction(input: {
  userId: number;
  tenantId: number;
  accountId?: string | null;
  conversationId: string;
  skill: ChatActionSkill;
  action: ChatActionName;
  collectedSlots: Record<string, unknown>;
  missingSlots: string[];
  riskClass: ChatActionRiskClass;
  locale: string;
  timezone: string;
  originatingSurface: string;
  nowIso?: string;
  expiresAt?: string;
}): PendingChatAction {
  const db = getDb();
  const now = input.nowIso ?? new Date().toISOString();
  const expiresAtCandidate = input.expiresAt
    ?? new Date(Date.parse(now) + ttlMsForRisk(input.riskClass)).toISOString();
  const expiresAtMs = Date.parse(expiresAtCandidate);
  if (!Number.isFinite(expiresAtMs)) throw new Error('chat_pending_action_invalid_expiry');
  // Persist one sortable representation because expiry sweeps use an indexed
  // SQLite TEXT comparison rather than a provider/database datetime type.
  const expiresAt = new Date(expiresAtMs).toISOString();
  // Pending-action rows are de-duplicated by conversation + active draft slots, not by
  // provider write idempotency. Keep this namespace separate from per-step run hashes:
  // the UPSERT guard is conversation+skill+action+active status, so equivalent datetime
  // strings in collectedSlots do not need the planner's cross-zone hash normalization.
  const actionHash = buildNormalizedActionHash({
    skill: input.skill,
    action: input.action,
    conversationId: input.conversationId,
    collectedSlots: input.collectedSlots,
  });
  const id = `chat-pending-${randomUUID()}`;
  const collected = JSON.stringify(input.collectedSlots ?? {});
  const missing = JSON.stringify(input.missingSlots ?? []);

  db.prepare(`
    INSERT INTO chat_pending_actions (
      id, user_id, tenant_id, account_id, conversation_id, action_hash,
      skill, action, status, risk_class, collected_slots_json, missing_slots_json,
      locale, timezone, originating_surface, validation_state, confirmation_state,
      cancellation_state, expires_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(user_id, tenant_id, conversation_id, skill, action)
    WHERE status IN ('needs_input', 'needs_confirmation', 'executable')
    DO UPDATE SET
      action_hash = excluded.action_hash,
      status = excluded.status,
      risk_class = excluded.risk_class,
      collected_slots_json = excluded.collected_slots_json,
      missing_slots_json = excluded.missing_slots_json,
      locale = excluded.locale,
      timezone = excluded.timezone,
      originating_surface = excluded.originating_surface,
      validation_state = excluded.validation_state,
      confirmation_state = excluded.confirmation_state,
      cancellation_state = 'active',
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
  `).run(
    id,
    input.userId,
    input.tenantId,
    input.accountId ?? null,
    input.conversationId,
    actionHash,
    input.skill,
    input.action,
    input.missingSlots.length > 0 ? 'needs_input' : 'executable',
    input.riskClass,
    collected,
    missing,
    input.locale,
    input.timezone,
    input.originatingSurface,
    input.missingSlots.length > 0 ? 'needs_input' : 'valid',
    input.riskClass === 'R2' || input.riskClass === 'R3' ? 'required' : 'not_required',
    expiresAt,
    now,
    now,
  );

  const row = getActivePendingChatAction({
    userId: input.userId,
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    skill: input.skill,
    nowIso: now,
  });
  if (!row || row.action !== input.action) throw new Error('chat_pending_action_upsert_failed');
  return row;
}

export function getActivePendingChatAction(input: {
  userId: number;
  tenantId: number;
  conversationId: string;
  skill?: ChatActionSkill;
  nowIso?: string;
}): PendingChatAction | null {
  expireStalePendingChatActions(input.nowIso);
  const params: Array<number | string> = [input.userId, input.tenantId, input.conversationId];
  const skillClause = input.skill ? 'AND skill = ?' : '';
  if (input.skill) params.push(input.skill);
  const row = getDb().prepare(`
    SELECT * FROM chat_pending_actions
    WHERE user_id = ? AND tenant_id = ? AND conversation_id = ?
      ${skillClause}
      AND status IN ('needs_input', 'needs_confirmation', 'executable')
      AND cancellation_state = 'active'
    ORDER BY updated_at DESC, created_at DESC
    LIMIT 1
  `).get(...params) as PendingRow | undefined;
  return row ? rowToPending(row) : null;
}

export function getPendingChatActionById(input: {
  userId: number;
  tenantId: number;
  pendingActionId: string;
  nowIso?: string;
}): PendingChatAction | null {
  expireStalePendingChatActions(input.nowIso);
  const row = getDb().prepare(`
    SELECT * FROM chat_pending_actions
    WHERE id = ?
      AND user_id = ?
      AND tenant_id = ?
      AND status IN ('needs_input', 'needs_confirmation', 'executable', 'needs_user_followup')
      AND cancellation_state = 'active'
    LIMIT 1
  `).get(input.pendingActionId, input.userId, input.tenantId) as PendingRow | undefined;
  return row ? rowToPending(row) : null;
}

export function cancelPendingChatActions(input: {
  userId: number;
  tenantId: number;
  conversationId?: string | null;
  skill?: ChatActionSkill;
  nowIso?: string;
}): number {
  const params: Array<number | string> = [input.nowIso ?? new Date().toISOString(), input.userId, input.tenantId];
  const conversationClause = input.conversationId ? 'AND conversation_id = ?' : '';
  if (input.conversationId) params.push(input.conversationId);
  const skillClause = input.skill ? 'AND skill = ?' : '';
  if (input.skill) params.push(input.skill);
  const result = getDb().prepare(`
    UPDATE chat_pending_actions
    SET status = 'cancelled',
        cancellation_state = 'cancelled',
        updated_at = ?
    WHERE user_id = ? AND tenant_id = ?
      ${conversationClause}
      ${skillClause}
      AND status IN ('needs_input', 'needs_confirmation', 'executable', 'needs_user_followup')
  `).run(...params);
  return Number(result.changes ?? 0);
}

export function cancelPendingChatActionsForAccountSwitch(input: {
  userId: number;
  tenantId?: number | null;
  nowIso?: string;
}): number {
  const now = input.nowIso ?? new Date().toISOString();
  const params: Array<number | string> = [now, input.userId];
  const tenantClause = input.tenantId != null ? 'AND tenant_id = ?' : '';
  if (input.tenantId != null) params.push(input.tenantId);
  const result = getDb().prepare(`
    UPDATE chat_pending_actions
    SET status = 'cancelled',
        cancellation_state = 'cancelled',
        updated_at = ?
    WHERE user_id = ?
      ${tenantClause}
      AND status IN ('needs_input', 'needs_confirmation', 'executable', 'needs_user_followup')
  `).run(...params);
  clearRecentChatEntitiesForUser(input.userId, input.tenantId ?? undefined);
  return Number(result.changes ?? 0);
}

export function markPendingChatActionNeedsUserFollowup(input: {
  userId: number;
  tenantId: number;
  conversationId: string;
  skill: ChatActionSkill;
  action: ChatActionName;
  nowIso?: string;
}): number {
  const now = input.nowIso ?? new Date().toISOString();
  const result = getDb().prepare(`
    UPDATE chat_pending_actions
    SET status = 'needs_user_followup',
        validation_state = 'invalid',
        updated_at = ?
    WHERE user_id = ?
      AND tenant_id = ?
      AND conversation_id = ?
      AND skill = ?
      AND action = ?
      AND status IN ('needs_input', 'needs_confirmation', 'executable')
  `).run(now, input.userId, input.tenantId, input.conversationId, input.skill, input.action);
  return Number(result.changes ?? 0);
}

export function expireStalePendingChatActionsForJob(nowIso = new Date().toISOString()): number {
  return expireStalePendingChatActions(nowIso);
}

export function rememberRecentChatEntity(input: {
  userId: number;
  tenantId: number;
  conversationId: string;
  node: RecentEntityGraphNode;
}): void {
  const key = recentKey(input.userId, input.tenantId, input.conversationId);
  const nowMs = Date.now();
  const fresh = (recentEntities.get(key) ?? [])
    .filter((node) => Date.parse(node.expiresAt) > nowMs)
    .filter((node) => !(node.entityType === input.node.entityType && node.entityId === input.node.entityId));
  fresh.unshift(input.node);
  recentEntities.set(key, fresh.slice(0, 20));
}

export function resolveRecentChatEntity(input: {
  userId: number;
  tenantId: number;
  conversationId: string;
  entityType: RecentEntityGraphNode['entityType'];
  action: string;
  nowIso?: string;
}): { status: 'none' | 'single' | 'ambiguous'; candidates: RecentEntityGraphNode[] } {
  const nowMs = Date.parse(input.nowIso ?? new Date().toISOString());
  const candidates = (recentEntities.get(recentKey(input.userId, input.tenantId, input.conversationId)) ?? [])
    .filter((node) => node.entityType === input.entityType)
    .filter((node) => node.allowedFollowupActions.includes(input.action))
    .filter((node) => Date.parse(node.expiresAt) > nowMs)
    .sort((a, b) => Date.parse(b.lastVerifiedAt) - Date.parse(a.lastVerifiedAt));
  if (candidates.length === 0) return { status: 'none', candidates: [] };
  if (candidates.length === 1) return { status: 'single', candidates };
  const top = candidates[0];
  const second = candidates[1];
  if (top && second && top.confidence >= 0.92 && top.confidence - second.confidence >= 0.2) {
    return { status: 'single', candidates: [top] };
  }
  return { status: 'ambiguous', candidates: candidates.slice(0, 4) };
}

export function resetChatActionStateForTests(): void {
  recentEntities.clear();
}

export function clearRecentChatEntitiesForUser(userId: number, tenantId?: number): void {
  const prefix = tenantId == null ? `${userId}:` : `${userId}:${tenantId}:`;
  for (const key of [...recentEntities.keys()]) {
    if (key.startsWith(prefix)) recentEntities.delete(key);
  }
}

export function recordChatActionTelemetry(input: ChatActionTelemetryRecordInput): void {
  const telemetry = input.telemetry;
  const now = input.nowIso ?? new Date().toISOString();
  getDb().prepare(`
    INSERT INTO chat_action_telemetry (
      id, user_id, tenant_id, conversation_id, message_id, planner, route_tier,
      skill, action, status, calibrated_score, threshold, model_provider, model,
      estimated_token_cost_usd, verifier_status, latency_ms, outcome, failure_reason,
      predicted_action_hash, slot_provenance_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `chat-telemetry-${randomUUID()}`,
    input.userId,
    input.tenantId,
    input.conversationId,
    input.messageId,
    input.planner,
    telemetry?.routeTier ?? 'tier0_deterministic',
    input.skill ?? telemetry?.candidates?.[0]?.skill ?? null,
    input.action ?? telemetry?.candidates?.[0]?.action ?? null,
    input.status,
    telemetry?.calibratedScore ?? null,
    telemetry?.threshold ?? null,
    telemetry?.modelProvider ?? null,
    telemetry?.model ?? null,
    telemetry?.estimatedTokenCostUsd ?? null,
    telemetry?.verifierStatus ?? null,
    telemetry?.latencyMs ?? null,
    telemetry?.outcome ?? null,
    telemetry?.failureReason ?? null,
    telemetry?.predictedActionHash ?? null,
    telemetry?.slotProvenanceSummary ? JSON.stringify(telemetry.slotProvenanceSummary) : null,
    now,
  );
}

export function listChatActionTelemetryForScope(input: {
  userId: number;
  tenantId: number;
  conversationId?: string | null;
  messageId?: string | null;
  limit?: number;
}): ChatActionTelemetryRecord[] {
  const clauses = ['user_id = ?', 'tenant_id = ?'];
  const params: Array<number | string> = [input.userId, input.tenantId];
  if (input.conversationId) {
    clauses.push('conversation_id = ?');
    params.push(input.conversationId);
  }
  if (input.messageId) {
    clauses.push('message_id = ?');
    params.push(input.messageId);
  }
  params.push(Math.max(1, Math.min(500, input.limit ?? 100)));
  const rows = getDb().prepare(`
    SELECT *
    FROM chat_action_telemetry
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToTelemetry);
}

function rowToPending(row: PendingRow): PendingChatAction {
  return {
    id: row.id,
    schemaVersion: 1,
    userId: row.user_id,
    tenantId: row.tenant_id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    skill: row.skill,
    action: row.action,
    status: row.status,
    collectedSlots: parseJsonRecord(row.collected_slots_json),
    missingSlots: parseJsonArray(row.missing_slots_json),
    riskClass: row.risk_class,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    accountScope: row.account_id,
    locale: row.locale,
    timezone: row.timezone,
    originatingSurface: row.originating_surface ?? 'chat',
    idempotencyKey: row.action_hash,
    validationState: row.validation_state,
    confirmationState: row.confirmation_state,
    cancellationState: row.cancellation_state,
  };
}

function rowToTelemetry(row: Record<string, unknown>): ChatActionTelemetryRecord {
  return {
    id: String(row.id),
    userId: Number(row.user_id),
    tenantId: Number(row.tenant_id),
    conversationId: String(row.conversation_id),
    messageId: String(row.message_id),
    planner: String(row.planner),
    routeTier: String(row.route_tier) as ChatActionTelemetry['routeTier'],
    skill: typeof row.skill === 'string' ? row.skill as ChatActionSkill : null,
    action: typeof row.action === 'string' ? row.action as ChatActionName : null,
    status: String(row.status),
    calibratedScore: row.calibrated_score == null ? null : Number(row.calibrated_score),
    threshold: row.threshold == null ? null : Number(row.threshold),
    modelProvider: typeof row.model_provider === 'string' ? row.model_provider as ChatActionTelemetry['modelProvider'] : null,
    model: typeof row.model === 'string' ? row.model : null,
    estimatedTokenCostUsd: row.estimated_token_cost_usd == null ? null : Number(row.estimated_token_cost_usd),
    verifierStatus: typeof row.verifier_status === 'string' ? row.verifier_status as ChatActionTelemetry['verifierStatus'] : null,
    latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
    outcome: typeof row.outcome === 'string' ? row.outcome : null,
    failureReason: typeof row.failure_reason === 'string' ? row.failure_reason : null,
    predictedActionHash: typeof row.predicted_action_hash === 'string' ? row.predicted_action_hash : null,
    slotProvenanceSummary: typeof row.slot_provenance_json === 'string' ? parseJsonRecord(row.slot_provenance_json) : null,
    createdAt: String(row.created_at),
  };
}

function expireStalePendingChatActions(nowIso?: string): number {
  const candidate = nowIso ?? new Date().toISOString();
  const nowMs = Date.parse(candidate);
  // SQLite compares these ISO timestamps as TEXT. Canonicalize offsets to UTC
  // before the comparison so equivalent instants do not expire early. An
  // invalid operator/job timestamp fails closed without mutating durable work.
  if (!Number.isFinite(nowMs)) return 0;
  const now = new Date(nowMs).toISOString();
  let total = 0;
  try {
    const statement = getDb().prepare(`
      UPDATE chat_pending_actions
      SET status = 'cancelled',
          cancellation_state = 'expired',
          updated_at = ?
      WHERE id IN (
        SELECT id
        FROM chat_pending_actions
        WHERE status IN ('needs_input', 'needs_confirmation', 'executable')
          AND expires_at <= ?
        ORDER BY expires_at ASC
        LIMIT 500
      )
    `);
    if (typeof statement.run !== 'function') return 0;
    for (;;) {
      const result = statement.run(now, now);
      const changes = Number(result.changes ?? 0);
      total += changes;
      if (changes < 500) break;
    }
    return total;
  } catch {
    return 0;
  }
}

function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function ttlMsForRisk(riskClass: ChatActionRiskClass): number {
  if (riskClass === 'R3') return 10 * 60 * 1000;
  if (riskClass === 'R2') return 20 * 60 * 1000;
  return 60 * 60 * 1000;
}

function recentKey(userId: number, tenantId: number, conversationId: string): string {
  return `${userId}:${tenantId}:${conversationId}`;
}
