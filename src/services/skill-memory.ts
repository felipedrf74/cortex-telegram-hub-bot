// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { isValidTenantUserId } from './tenant-scope-observability';

export type SkillMemoryType =
  | 'user_preference'
  | 'tenant_preference'
  | 'skill_specific_memory'
  | 'cross_skill_signal'
  | 'action_history'
  | 'unresolved_commitment'
  | 'content_creative_preference'
  | 'schedule_preference'
  | 'training_preference'
  | 'cooking_preference'
  | 'finance_preference'
  | 'source_reference_preference'
  | 'voice_brand_preference'
  | 'correction_override'
  | 'stale_uncertain_memory';

export type SkillMemoryScope = 'user_private' | 'tenant_shared' | 'platform_internal';
export type SkillMemoryFreshness = 'fresh' | 'uncertain' | 'stale' | 'expired' | 'corrected';
export type SkillMemoryStatus = 'active' | 'superseded' | 'stale' | 'deleted';

export interface SkillMemoryInput {
  tenantId: number;
  userId?: number | null;
  skillId: string;
  memoryType: SkillMemoryType;
  scope: SkillMemoryScope;
  memoryKey: string;
  memoryValue: string;
  source: string;
  confidence?: number;
  freshnessStatus?: SkillMemoryFreshness;
  expiresAt?: string | null;
  stalenessPolicy?: string | null;
  schemaVersion?: string;
  relatedSkillVersion?: string | null;
  auditMetadata?: Record<string, unknown>;
}

export interface SkillMemoryRecord {
  id: number;
  memoryId: string;
  tenantId: number;
  userId: number;
  skillId: string;
  memoryType: SkillMemoryType;
  scope: SkillMemoryScope;
  memoryKey: string;
  memoryValue: string;
  source: string;
  confidence: number;
  freshnessStatus: SkillMemoryFreshness;
  status: SkillMemoryStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  stalenessPolicy: string | null;
  schemaVersion: string;
  relatedSkillVersion: string | null;
  supersededByMemoryId: string | null;
  correctionParentMemoryId: string | null;
  correctionHistory: Array<Record<string, unknown>>;
  auditMetadata: Record<string, unknown>;
  lastUsedAt: string | null;
  useCount: number;
}

export interface SkillMemoryQuery {
  tenantId: number;
  userId?: number | null;
  skillId: string;
  memoryTypes?: SkillMemoryType[];
  includeCrossSkillSignals?: boolean;
  includeStale?: boolean;
  includePlatformInternal?: boolean;
  now?: Date;
}

export interface SkillMemoryCorrectionInput {
  tenantId: number;
  userId?: number | null;
  skillId: string;
  memoryType: SkillMemoryType;
  scope: SkillMemoryScope;
  memoryKey: string;
  correctedValue: string;
  source: string;
  confidence?: number;
  schemaVersion?: string;
  relatedSkillVersion?: string | null;
  auditMetadata?: Record<string, unknown>;
}

export interface StaleMemoryInvalidationInput {
  tenantId?: number;
  skillId: string;
  schemaVersion?: string;
  relatedSkillVersion?: string;
  reason: string;
}

export type MemoryReferenceResolution =
  | { status: 'resolved'; memory: SkillMemoryRecord }
  | { status: 'needs_clarification'; reason: string; candidates: SkillMemoryRecord[] };

interface SkillMemoryRow {
  id: number;
  memory_id: string;
  tenant_id: number;
  user_id: number;
  skill_id: string;
  memory_type: SkillMemoryType;
  scope: SkillMemoryScope;
  memory_key: string;
  memory_value: string;
  source: string;
  confidence: number;
  freshness_status: SkillMemoryFreshness;
  status: SkillMemoryStatus;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  staleness_policy: string | null;
  schema_version: string;
  related_skill_version: string | null;
  superseded_by_memory_id: string | null;
  correction_parent_memory_id: string | null;
  correction_history_json: string;
  audit_metadata_json: string;
  last_used_at: string | null;
  use_count: number;
}

const SAFE_MEMORY_KEY_RE = /^[a-zA-Z0-9_.:-]{1,128}$/;
const MAX_MEMORY_VALUE_CHARS = 1600;
const MAX_ACTIVE_USER_PRIVATE_MEMORIES_PER_SKILL = 100;
const MAX_ACTIVE_TENANT_SHARED_MEMORIES_PER_SKILL = 500;
const DEFAULT_SCHEMA_VERSION = 'skill-memory-v1';
const UNSAFE_MEMORY_PATTERNS = [
  /\b(api[_-]?key|secret[_-]?key|client[_-]?secret|password|passcode|bearer\s+[a-z0-9._-]+)\b/i,
  /\b(access[_-]?token|refresh[_-]?token|oauth[_-]?token|id[_-]?token|session[_-]?token)\b/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9/+]{40}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:sk_live_|pk_live_)[A-Za-z0-9_]+\b/,
  /\b(?:ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/,
  /\bxox[baprs]-[A-Za-z0-9-]+\b/,
  /\bpostgres:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bmongodb(?:\+srv)?:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bmysql:\/\/[^:\s]+:[^@\s]+@[^\s]+/i,
  /\bFQoGZXIvYXdzE[A-Za-z0-9/+=]+/i,
  /\bDefaultEndpointsProtocol=.*?AccountKey=[^;\s]+/i,
  /\b(?:\d[ -]*?){13,19}\b/,
];

const UNSAFE_MEMORY_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /passcode/i,
  /token/i,
  /credential/i,
  /connection[_-]?string/i,
  /private[_-]?key/i,
];

const MEMORY_BOUNDARIES: Record<string, Set<SkillMemoryType>> = {
  chat: new Set([
    'user_preference',
    'tenant_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'unresolved_commitment',
    'correction_override',
    'stale_uncertain_memory',
  ]),
  secretary: new Set([
    'user_preference',
    'tenant_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'unresolved_commitment',
    'schedule_preference',
    'correction_override',
    'stale_uncertain_memory',
  ]),
  training: new Set([
    'user_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'training_preference',
    'correction_override',
    'stale_uncertain_memory',
  ]),
  finance: new Set([
    'user_preference',
    'tenant_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'unresolved_commitment',
    'finance_preference',
    'correction_override',
    'stale_uncertain_memory',
  ]),
  cooking: new Set([
    'user_preference',
    'tenant_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'cooking_preference',
    'correction_override',
    'stale_uncertain_memory',
  ]),
  content: new Set([
    'user_preference',
    'tenant_preference',
    'skill_specific_memory',
    'cross_skill_signal',
    'action_history',
    'content_creative_preference',
    'source_reference_preference',
    'voice_brand_preference',
    'correction_override',
    'stale_uncertain_memory',
  ]),
};

function normalizeSkillId(skillId: string): string {
  const normalized = skillId.trim().toLowerCase();
  if (normalized === 'triathlon') return 'training';
  return normalized;
}

function assertBoundary(skillId: string, memoryType: SkillMemoryType): void {
  const allowed = MEMORY_BOUNDARIES[normalizeSkillId(skillId)];
  if (!allowed || !allowed.has(memoryType)) {
    throw new Error(`SKILL_MEMORY_BOUNDARY: ${memoryType} is not allowed for ${normalizeSkillId(skillId)}`);
  }
}

function containsUnsafeMemoryFragment(value: unknown, depth = 0): boolean {
  if (depth > 8) return true;
  if (typeof value === 'string') {
    return UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsUnsafeMemoryFragment(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => (
      UNSAFE_MEMORY_KEY_PATTERNS.some((pattern) => pattern.test(key))
      || containsUnsafeMemoryFragment(nested, depth + 1)
    ));
  }
  return false;
}

function assertSkillSpecificMemorySchema(value: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('SKILL_MEMORY_UNSAFE: skill_specific_memory must be a JSON object with typed metadata');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SKILL_MEMORY_UNSAFE: skill_specific_memory must be a JSON object with typed metadata');
  }
  if (containsUnsafeMemoryFragment(parsed)) {
    throw new Error('SKILL_MEMORY_UNSAFE: refusing to store secrets, tokens, cards, or credential-like values');
  }
}

function assertSafeMemory(input: SkillMemoryInput | SkillMemoryCorrectionInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    throw new Error('SKILL_MEMORY_SCOPE: tenantId is required');
  }
  if (input.scope === 'user_private' && !isValidTenantUserId(input.userId)) {
    throw new Error('SKILL_MEMORY_SCOPE: user-private memory requires userId');
  }
  if (input.scope === 'platform_internal') {
    throw new Error('SKILL_MEMORY_SCOPE: platform_internal memory is not writable through normal skill memory APIs');
  }
  if (!SAFE_MEMORY_KEY_RE.test(input.memoryKey)) {
    throw new Error('SKILL_MEMORY_UNSAFE: memory key must be short, stable, and identifier-like');
  }
  const value = 'memoryValue' in input ? input.memoryValue : input.correctedValue;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('SKILL_MEMORY_UNSAFE: memory value is required');
  }
  if (value.length > MAX_MEMORY_VALUE_CHARS) {
    throw new Error('SKILL_MEMORY_UNSAFE: memory value is too large for durable skill memory');
  }
  if (UNSAFE_MEMORY_PATTERNS.some((pattern) => pattern.test(value)) || containsUnsafeMemoryFragment(value)) {
    throw new Error('SKILL_MEMORY_UNSAFE: refusing to store secrets, tokens, cards, or credential-like values');
  }
  if (input.memoryType === 'skill_specific_memory') {
    assertSkillSpecificMemorySchema(value);
  }
  assertBoundary(input.skillId, input.memoryType);
}

function clampConfidence(confidence: number | undefined): number {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return 0.5;
  return Math.max(0, Math.min(1, confidence));
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string | null | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
      : [];
  } catch {
    return [];
  }
}

function makeMemoryId(skillId: string): string {
  return `mem_${normalizeSkillId(skillId)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function userIdForScope(scope: SkillMemoryScope, userId?: number | null): number {
  return scope === 'user_private' ? Number(userId) : 0;
}

function canReadTenantSharedMemory(userId: number | null | undefined, tenantId: number): boolean {
  // Nexus does not yet have a durable tenant-membership table. Until it does,
  // tenant-shared memory may only be read by the canonical owner workspace
  // user. This fails closed for same-user tenant switching instead of relying
  // on frontend filtering or model behavior.
  return isValidTenantUserId(userId) && userId === tenantId;
}

function rowToRecord(row: SkillMemoryRow): SkillMemoryRecord {
  return {
    id: row.id,
    memoryId: row.memory_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    skillId: row.skill_id,
    memoryType: row.memory_type,
    scope: row.scope,
    memoryKey: row.memory_key,
    memoryValue: row.memory_value,
    source: row.source,
    confidence: row.confidence,
    freshnessStatus: row.freshness_status,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    stalenessPolicy: row.staleness_policy,
    schemaVersion: row.schema_version,
    relatedSkillVersion: row.related_skill_version,
    supersededByMemoryId: row.superseded_by_memory_id,
    correctionParentMemoryId: row.correction_parent_memory_id,
    correctionHistory: parseJsonArray(row.correction_history_json),
    auditMetadata: parseJsonObject(row.audit_metadata_json),
    lastUsedAt: row.last_used_at,
    useCount: row.use_count,
  };
}

function downgradeExpiredMemories(now: Date): void {
  getDb().prepare(`
    UPDATE skill_memories
    SET status = 'stale',
        freshness_status = 'expired',
        updated_at = datetime('now')
    WHERE status = 'active'
      AND expires_at IS NOT NULL
      AND expires_at < ?
  `).run(now.toISOString());
}

function findActiveMemory(input: SkillMemoryInput | SkillMemoryCorrectionInput): SkillMemoryRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM skill_memories
    WHERE tenant_id = ?
      AND user_id = ?
      AND skill_id = ?
      AND scope = ?
      AND memory_type = ?
      AND memory_key = ?
      AND status = 'active'
    LIMIT 1
  `).get(
    input.tenantId,
    userIdForScope(input.scope, input.userId),
    normalizeSkillId(input.skillId),
    input.scope,
    input.memoryType,
    input.memoryKey,
  ) as SkillMemoryRow | undefined;
  return row ? rowToRecord(row) : null;
}

function assertMemoryQuota(input: SkillMemoryInput, scopedUserId: number, skillId: string, replacingExisting: boolean): void {
  const limit = input.scope === 'tenant_shared'
    ? MAX_ACTIVE_TENANT_SHARED_MEMORIES_PER_SKILL
    : MAX_ACTIVE_USER_PRIVATE_MEMORIES_PER_SKILL;
  const row = getDb().prepare(`
    SELECT COUNT(*) as count
    FROM skill_memories
    WHERE tenant_id = ?
      AND user_id = ?
      AND skill_id = ?
      AND scope = ?
      AND status = 'active'
  `).get(
    input.tenantId,
    scopedUserId,
    skillId,
    input.scope,
  ) as { count: number } | undefined;
  const activeCount = Number(row?.count ?? 0);
  if (!replacingExisting && activeCount >= limit) {
    throw new Error(`SKILL_MEMORY_QUOTA: ${input.scope} memory quota exceeded for ${skillId}`);
  }
}

export function setSkillMemory(input: SkillMemoryInput): SkillMemoryRecord {
  assertSafeMemory(input);
  const db = getDb();
  const skillId = normalizeSkillId(input.skillId);
  const scopedUserId = userIdForScope(input.scope, input.userId);
  const existing = findActiveMemory(input);
  assertMemoryQuota(input, scopedUserId, skillId, Boolean(existing));
  const memoryId = makeMemoryId(skillId);
  const correctionHistory = existing
    ? [
        ...existing.correctionHistory,
        {
          supersededMemoryId: existing.memoryId,
          previousValue: existing.memoryValue,
          previousConfidence: existing.confidence,
          correctedAt: new Date().toISOString(),
          source: input.source,
        },
      ]
    : [];

  const tx = db.transaction(() => {
    if (existing) {
      db.prepare(`
        UPDATE skill_memories
        SET status = 'superseded',
            freshness_status = 'stale',
            superseded_by_memory_id = ?,
            updated_at = datetime('now')
        WHERE memory_id = ?
      `).run(memoryId, existing.memoryId);
    }

    db.prepare(`
      INSERT INTO skill_memories (
        memory_id,
        tenant_id,
        user_id,
        skill_id,
        memory_type,
        scope,
        memory_key,
        memory_value,
        source,
        confidence,
        freshness_status,
        expires_at,
        staleness_policy,
        schema_version,
        related_skill_version,
        correction_parent_memory_id,
        correction_history_json,
        audit_metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      memoryId,
      input.tenantId,
      scopedUserId,
      skillId,
      input.memoryType,
      input.scope,
      input.memoryKey,
      input.memoryValue.trim(),
      input.source,
      clampConfidence(input.confidence),
      input.freshnessStatus ?? (existing ? 'corrected' : 'fresh'),
      input.expiresAt ?? null,
      input.stalenessPolicy ?? null,
      input.schemaVersion ?? DEFAULT_SCHEMA_VERSION,
      input.relatedSkillVersion ?? null,
      existing?.memoryId ?? null,
      JSON.stringify(correctionHistory),
      json(input.auditMetadata),
    );
  });
  tx();

  const row = db.prepare('SELECT * FROM skill_memories WHERE memory_id = ?').get(memoryId) as SkillMemoryRow;
  return rowToRecord(row);
}

export function applySkillMemoryCorrection(input: SkillMemoryCorrectionInput): SkillMemoryRecord {
  return setSkillMemory({
    tenantId: input.tenantId,
    userId: input.userId,
    skillId: input.skillId,
    memoryType: input.memoryType,
    scope: input.scope,
    memoryKey: input.memoryKey,
    memoryValue: input.correctedValue,
    source: input.source,
    confidence: input.confidence ?? 0.95,
    freshnessStatus: 'corrected',
    schemaVersion: input.schemaVersion,
    relatedSkillVersion: input.relatedSkillVersion,
    auditMetadata: {
      ...(input.auditMetadata ?? {}),
      correction: true,
    },
  });
}

export function getSkillMemories(query: SkillMemoryQuery): SkillMemoryRecord[] {
  if (!isValidTenantUserId(query.tenantId)) return [];
  if (!isValidTenantUserId(query.userId) && !query.includePlatformInternal) {
    return [];
  }

  const skillId = normalizeSkillId(query.skillId);
  const params: unknown[] = [
    query.tenantId,
    query.userId ?? 0,
    skillId,
  ];
  const memoryTypeFilter = query.memoryTypes?.length
    ? `AND memory_type IN (${query.memoryTypes.map(() => '?').join(', ')})`
    : '';
  if (query.memoryTypes?.length) params.push(...query.memoryTypes);

  const allowTenantShared = canReadTenantSharedMemory(query.userId, query.tenantId);
  const tenantSharedClause = allowTenantShared ? "OR scope = 'tenant_shared'" : '';
  const platformClause = query.includePlatformInternal
    ? "OR scope = 'platform_internal'"
    : '';
  const staleClause = query.includeStale
    ? ''
    : "AND freshness_status NOT IN ('stale', 'expired')";
  const statusClause = query.includeStale
    ? "status IN ('active', 'stale')"
    : "status = 'active'";
  const skillClause = query.includeCrossSkillSignals
    ? "(skill_id = ? OR memory_type = 'cross_skill_signal')"
    : 'skill_id = ?';

  const db = getDb();
  const readAndTouch = () => {
    downgradeExpiredMemories(query.now ?? new Date());

    const rows = db.prepare(`
      SELECT * FROM skill_memories
      WHERE tenant_id = ?
        AND (
          (scope = 'user_private' AND user_id = ?)
          ${tenantSharedClause}
          ${platformClause}
        )
        AND ${skillClause}
        AND ${statusClause}
        ${staleClause}
        ${memoryTypeFilter}
      ORDER BY
        CASE freshness_status WHEN 'corrected' THEN 0 WHEN 'fresh' THEN 1 WHEN 'uncertain' THEN 2 ELSE 9 END,
        confidence DESC,
        updated_at DESC
    `).all(...params) as SkillMemoryRow[];

    if (rows.length > 0) {
      const ids = rows.map((row) => row.memory_id);
      db.prepare(`
        UPDATE skill_memories
        SET last_used_at = datetime('now'),
            use_count = use_count + 1
        WHERE memory_id IN (${ids.map(() => '?').join(', ')})
      `).run(...ids);
    }

    return rows.map(rowToRecord);
  };

  if (typeof db.transaction === 'function') {
    return db.transaction(readAndTouch)();
  }
  return readAndTouch();
}

export function markSkillMemoriesStaleForVersion(input: StaleMemoryInvalidationInput): number {
  const skillId = normalizeSkillId(input.skillId);
  const clauses = ['skill_id = ?', "status = 'active'"];
  const params: unknown[] = [skillId];
  if (isValidTenantUserId(input.tenantId)) {
    clauses.push('tenant_id = ?');
    params.push(input.tenantId);
  }
  if (input.schemaVersion) {
    clauses.push('schema_version <> ?');
    params.push(input.schemaVersion);
  }
  if (input.relatedSkillVersion) {
    clauses.push('(related_skill_version IS NULL OR related_skill_version <> ?)');
    params.push(input.relatedSkillVersion);
  }

  const result = getDb().prepare(`
    UPDATE skill_memories
    SET status = 'stale',
        freshness_status = 'stale',
        updated_at = datetime('now'),
        audit_metadata_json = json_set(
          COALESCE(NULLIF(audit_metadata_json, ''), '{}'),
          '$.staleReason',
          ?
        )
    WHERE ${clauses.join(' AND ')}
  `).run(input.reason, ...params);

  return result.changes;
}

export function resolveSkillMemoryReference(query: SkillMemoryQuery & { memoryKey?: string }): MemoryReferenceResolution {
  const candidates = getSkillMemories(query)
    .filter((memory) => !query.memoryKey || memory.memoryKey === query.memoryKey);
  if (candidates.length === 1) {
    return { status: 'resolved', memory: candidates[0] };
  }
  return {
    status: 'needs_clarification',
    reason: candidates.length === 0
      ? 'missing_or_unauthorized_context'
      : 'ambiguous_memory_reference',
    candidates,
  };
}

export function buildSkillMemorySummary(query: SkillMemoryQuery): string {
  const memories = getSkillMemories(query);
  if (memories.length === 0) return '';
  const lines = memories.map((memory) =>
    `- ${memory.memoryKey}: ${memory.memoryValue} (source=${memory.source}, confidence=${memory.confidence.toFixed(2)}, freshness=${memory.freshnessStatus})`,
  );
  return `Skill memory for ${normalizeSkillId(query.skillId)}:\n${lines.join('\n')}`;
}

export function getSkillMemoryBoundaries(): Record<string, SkillMemoryType[]> {
  return Object.fromEntries(
    Object.entries(MEMORY_BOUNDARIES).map(([skillId, types]) => [skillId, [...types]]),
  );
}
