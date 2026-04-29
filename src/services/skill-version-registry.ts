// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { DEFAULT_SKILLS, type SkillDefinition } from '../skills/skill-config';

export type SkillReleaseType = 'major' | 'minor' | 'patch' | 'hotfix' | 'experimental';
export type SkillVersionStatus = 'draft' | 'candidate' | 'active' | 'deprecated' | 'rolled_back';
export type SkillRolloutScope = 'global' | 'tenant' | 'user' | 'canary';

export interface SkillVersionInput {
  skillId: string;
  skillName: string;
  version: string;
  releaseType: SkillReleaseType;
  releaseTitle: string;
  releaseSummary: string;
  capabilitiesAdded?: string[];
  logicImprovements?: string[];
  bugFixes?: string[];
  securityFixes?: string[];
  tenantScopeChanges?: string[];
  memoryContextChanges?: string[];
  modelRoutingChanges?: string[];
  dataSchemaChanges?: string[];
  iosPortalContractChanges?: string[];
  testsAdded?: string[];
  smokeTestsPassed?: string[];
  evaluationResults?: Record<string, unknown>;
  openRisks?: string[];
  knownLimitations?: string[];
  rollbackNotes?: string | null;
  internalNotes?: string | null;
  createdBy?: string | null;
  status?: SkillVersionStatus;
  rolloutScope?: SkillRolloutScope;
  compatibleApiVersion?: string | null;
  memorySchemaVersion?: string | null;
  qualityGateStatus?: string | null;
}

export interface SkillVersionRecord {
  id: number;
  skillId: string;
  skillName: string;
  version: string;
  releaseType: SkillReleaseType;
  releaseTitle: string;
  releaseSummary: string;
  capabilitiesAdded: string[];
  logicImprovements: string[];
  bugFixes: string[];
  securityFixes: string[];
  tenantScopeChanges: string[];
  memoryContextChanges: string[];
  modelRoutingChanges: string[];
  dataSchemaChanges: string[];
  iosPortalContractChanges: string[];
  testsAdded: string[];
  smokeTestsPassed: string[];
  evaluationResults: Record<string, unknown>;
  openRisks: string[];
  knownLimitations: string[];
  rollbackNotes: string | null;
  internalNotes?: string | null;
  createdBy: string | null;
  createdAt: string;
  activatedAt: string | null;
  deprecatedAt: string | null;
  status: SkillVersionStatus;
  rolloutScope: SkillRolloutScope;
  compatibleApiVersion: string | null;
  memorySchemaVersion: string | null;
  qualityGateStatus: string | null;
}

export interface PublicSkillVersionRecord extends Omit<SkillVersionRecord, 'internalNotes'> {}

export interface SkillVersionScope {
  tenantId?: number | null;
  userId?: number | null;
  canaryKey?: string | null;
}

export interface SkillMetadata {
  skillId: string;
  skillName: string;
  currentVersion: string;
  status: SkillVersionStatus;
  releaseType: SkillReleaseType;
  releaseTitle: string;
  releaseSummary: string;
  capabilities: string[];
  releaseNotes: string[];
  knownLimitations: string[];
  openRisks: string[];
  lastUpdated: string | null;
  compatibleApiVersion: string | null;
  memorySchemaVersion: string | null;
  qualityGateStatus: string | null;
  rolloutScope: SkillRolloutScope;
  rollbackNotes: string | null;
}

interface SkillVersionRow {
  id: number;
  skill_id: string;
  skill_name: string;
  version: string;
  release_type: SkillReleaseType;
  release_title: string;
  release_summary: string;
  capabilities_added_json: string;
  logic_improvements_json: string;
  bug_fixes_json: string;
  security_fixes_json: string;
  tenant_scope_changes_json: string;
  memory_context_changes_json: string;
  model_routing_changes_json: string;
  data_schema_changes_json: string;
  ios_portal_contract_changes_json: string;
  tests_added_json: string;
  smoke_tests_passed_json: string;
  evaluation_results_json: string;
  open_risks_json: string;
  known_limitations_json: string;
  rollback_notes: string | null;
  internal_notes: string | null;
  created_by: string | null;
  created_at: string;
  activated_at: string | null;
  deprecated_at: string | null;
  status: SkillVersionStatus;
  rollout_scope: SkillRolloutScope;
  compatible_api_version: string | null;
  memory_schema_version: string | null;
  quality_gate_status: string | null;
}

const PUBLIC_SKILL_IDS = ['chat', 'secretary', 'training', 'finance', 'cooking', 'content'] as const;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const ALLOWED_STATUS_TRANSITIONS: Record<SkillVersionStatus, ReadonlySet<SkillVersionStatus>> = {
  draft: new Set(['candidate', 'deprecated', 'rolled_back']),
  candidate: new Set(['active', 'deprecated', 'rolled_back']),
  active: new Set(['deprecated', 'rolled_back']),
  deprecated: new Set(['rolled_back']),
  rolled_back: new Set([]),
};

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
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

function jsonArray(value: string[] | undefined): string {
  return JSON.stringify(value ?? []);
}

function jsonObject(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value ?? {});
}

function normalizeSkillId(skillId: string): string {
  const normalized = skillId.trim().toLowerCase();
  if (normalized === 'triathlon') return 'training';
  return normalized;
}

function validateVersionInput(input: SkillVersionInput): void {
  const skillId = normalizeSkillId(input.skillId);
  if (!skillId) throw new Error('skillId is required');
  if (!input.skillName.trim()) throw new Error('skillName is required');
  if (!VERSION_RE.test(input.version)) {
    throw new Error('version must be a non-empty semantic or release identifier');
  }
  if (!input.releaseTitle.trim()) throw new Error('releaseTitle is required');
  if (!input.releaseSummary.trim()) throw new Error('releaseSummary is required');
}

function rowToRecord(row: SkillVersionRow): SkillVersionRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    version: row.version,
    releaseType: row.release_type,
    releaseTitle: row.release_title,
    releaseSummary: row.release_summary,
    capabilitiesAdded: parseJsonArray(row.capabilities_added_json),
    logicImprovements: parseJsonArray(row.logic_improvements_json),
    bugFixes: parseJsonArray(row.bug_fixes_json),
    securityFixes: parseJsonArray(row.security_fixes_json),
    tenantScopeChanges: parseJsonArray(row.tenant_scope_changes_json),
    memoryContextChanges: parseJsonArray(row.memory_context_changes_json),
    modelRoutingChanges: parseJsonArray(row.model_routing_changes_json),
    dataSchemaChanges: parseJsonArray(row.data_schema_changes_json),
    iosPortalContractChanges: parseJsonArray(row.ios_portal_contract_changes_json),
    testsAdded: parseJsonArray(row.tests_added_json),
    smokeTestsPassed: parseJsonArray(row.smoke_tests_passed_json),
    evaluationResults: parseJsonObject(row.evaluation_results_json),
    openRisks: parseJsonArray(row.open_risks_json),
    knownLimitations: parseJsonArray(row.known_limitations_json),
    rollbackNotes: row.rollback_notes,
    internalNotes: row.internal_notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    deprecatedAt: row.deprecated_at,
    status: row.status,
    rolloutScope: row.rollout_scope,
    compatibleApiVersion: row.compatible_api_version,
    memorySchemaVersion: row.memory_schema_version,
    qualityGateStatus: row.quality_gate_status,
  };
}

export function toPublicSkillVersion(record: SkillVersionRecord): PublicSkillVersionRecord {
  const { internalNotes: _internalNotes, ...publicRecord } = record;
  return publicRecord;
}

function getVersionById(id: number): SkillVersionRecord | null {
  const row = getDb().prepare('SELECT * FROM skill_versions WHERE id = ?').get(id) as SkillVersionRow | undefined;
  return row ? rowToRecord(row) : null;
}

function tableExists(table: string): boolean {
  const row = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { name: string } | undefined;
  return Boolean(row);
}

function assertAllowedStatusTransition(from: SkillVersionStatus, to: SkillVersionStatus): void {
  if (from === to) return;
  if (!ALLOWED_STATUS_TRANSITIONS[from]?.has(to)) {
    throw new Error(`SKILL_VERSION_TRANSITION_DENIED: cannot transition ${from} to ${to}`);
  }
}

function incompatibleMemoryCount(skillId: string, memorySchemaVersion: string | null, scope: SkillVersionScope = {}): number {
  if (!memorySchemaVersion || !tableExists('skill_memories')) return 0;
  const clauses = [
    'skill_id = ?',
    "status = 'active'",
    'schema_version <> ?',
  ];
  const params: unknown[] = [normalizeSkillId(skillId), memorySchemaVersion];
  if (typeof scope.tenantId === 'number' && Number.isFinite(scope.tenantId) && scope.tenantId > 0) {
    clauses.push('tenant_id = ?');
    params.push(scope.tenantId);
  }
  if (typeof scope.userId === 'number' && Number.isFinite(scope.userId) && scope.userId > 0) {
    clauses.push('(user_id = ? OR user_id = 0)');
    params.push(scope.userId);
  }
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM skill_memories
    WHERE ${clauses.join(' AND ')}
  `).get(...params) as { count: number } | undefined;
  return row?.count ?? 0;
}

function assertMemorySchemaCompatibleForActivation(version: SkillVersionRecord, scope: SkillVersionScope = {}): void {
  const incompatible = incompatibleMemoryCount(version.skillId, version.memorySchemaVersion, scope);
  if (incompatible > 0) {
    throw new Error(`SKILL_VERSION_MEMORY_SCHEMA_INCOMPATIBLE: ${version.skillId}@${version.version} requires ${version.memorySchemaVersion}`);
  }
}

export function createSkillVersion(input: SkillVersionInput): SkillVersionRecord {
  validateVersionInput(input);
  const skillId = normalizeSkillId(input.skillId);
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO skill_versions (
      skill_id,
      skill_name,
      version,
      release_type,
      release_title,
      release_summary,
      capabilities_added_json,
      logic_improvements_json,
      bug_fixes_json,
      security_fixes_json,
      tenant_scope_changes_json,
      memory_context_changes_json,
      model_routing_changes_json,
      data_schema_changes_json,
      ios_portal_contract_changes_json,
      tests_added_json,
      smoke_tests_passed_json,
      evaluation_results_json,
      open_risks_json,
      known_limitations_json,
      rollback_notes,
      internal_notes,
      created_by,
      status,
      rollout_scope,
      compatible_api_version,
      memory_schema_version,
      quality_gate_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    skillId,
    input.skillName.trim(),
    input.version,
    input.releaseType,
    input.releaseTitle.trim(),
    input.releaseSummary.trim(),
    jsonArray(input.capabilitiesAdded),
    jsonArray(input.logicImprovements),
    jsonArray(input.bugFixes),
    jsonArray(input.securityFixes),
    jsonArray(input.tenantScopeChanges),
    jsonArray(input.memoryContextChanges),
    jsonArray(input.modelRoutingChanges),
    jsonArray(input.dataSchemaChanges),
    jsonArray(input.iosPortalContractChanges),
    jsonArray(input.testsAdded),
    jsonArray(input.smokeTestsPassed),
    jsonObject(input.evaluationResults),
    jsonArray(input.openRisks),
    jsonArray(input.knownLimitations),
    input.rollbackNotes ?? null,
    input.internalNotes ?? null,
    input.createdBy ?? null,
    input.status ?? 'draft',
    input.rolloutScope ?? 'global',
    input.compatibleApiVersion ?? null,
    input.memorySchemaVersion ?? null,
    input.qualityGateStatus ?? null,
  );

  return getVersionById(Number(result.lastInsertRowid))!;
}

export function listSkillVersions(skillId?: string): SkillVersionRecord[] {
  const db = getDb();
  const rows = skillId
    ? db.prepare(`
        SELECT * FROM skill_versions
        WHERE skill_id = ?
        ORDER BY COALESCE(activated_at, created_at) DESC, id DESC
      `).all(normalizeSkillId(skillId)) as SkillVersionRow[]
    : db.prepare(`
        SELECT * FROM skill_versions
        ORDER BY skill_id ASC, COALESCE(activated_at, created_at) DESC, id DESC
      `).all() as SkillVersionRow[];
  return rows.map(rowToRecord);
}

export function getSkillVersion(skillId: string, version: string): SkillVersionRecord | null {
  const row = getDb().prepare(`
    SELECT * FROM skill_versions
    WHERE skill_id = ? AND version = ?
  `).get(normalizeSkillId(skillId), version) as SkillVersionRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function setSkillVersionStatus(
  skillId: string,
  version: string,
  status: SkillVersionStatus,
  options?: { actor?: string | null; deprecatedAt?: string | null },
): SkillVersionRecord {
  const existing = getSkillVersion(skillId, version);
  if (!existing) throw new Error(`Skill version not found: ${normalizeSkillId(skillId)}@${version}`);
  assertAllowedStatusTransition(existing.status, status);
  if (status === 'active') {
    assertMemorySchemaCompatibleForActivation(existing);
  }

  const nowExpr = status === 'active' ? "activated_at = COALESCE(activated_at, datetime('now'))," : '';
  const deprecatedExpr = status === 'deprecated' || status === 'rolled_back'
    ? "deprecated_at = COALESCE(?, datetime('now')),"
    : "deprecated_at = deprecated_at,";
  const deprecatedValue = status === 'deprecated' || status === 'rolled_back'
    ? options?.deprecatedAt ?? null
    : undefined;

  if (status === 'active' && existing.rolloutScope === 'global') {
    getDb().prepare(`
      UPDATE skill_versions
      SET status = 'deprecated',
          deprecated_at = COALESCE(deprecated_at, datetime('now'))
      WHERE skill_id = ? AND status = 'active' AND rollout_scope = 'global' AND id <> ?
    `).run(existing.skillId, existing.id);
  }

  const sql = `
    UPDATE skill_versions
    SET status = ?,
        ${nowExpr}
        ${deprecatedExpr}
        created_by = COALESCE(created_by, ?)
    WHERE id = ?
  `;
  const params = deprecatedValue === undefined
    ? [status, options?.actor ?? null, existing.id]
    : [status, deprecatedValue, options?.actor ?? null, existing.id];
  getDb().prepare(sql).run(...params);
  return getVersionById(existing.id)!;
}

export function activateSkillVersion(
  skillId: string,
  version: string,
  options?: {
    scopeType?: SkillRolloutScope;
    tenantId?: number | null;
    userId?: number | null;
    canaryKey?: string | null;
    actor?: string | null;
    notes?: string | null;
  },
): SkillVersionRecord {
  const existing = getSkillVersion(skillId, version);
  if (!existing) throw new Error(`Skill version not found: ${normalizeSkillId(skillId)}@${version}`);
  const scopeType = options?.scopeType ?? 'global';
  assertAllowedStatusTransition(existing.status, 'active');
  assertMemorySchemaCompatibleForActivation(existing, {
    tenantId: options?.tenantId ?? null,
    userId: options?.userId ?? null,
    canaryKey: options?.canaryKey ?? null,
  });

  if (scopeType === 'global') {
    setSkillVersionStatus(existing.skillId, existing.version, 'active', { actor: options?.actor ?? null });
  } else {
    getDb().prepare(`
      UPDATE skill_versions
      SET status = 'active',
          rollout_scope = ?,
          activated_at = COALESCE(activated_at, datetime('now')),
          created_by = COALESCE(created_by, ?)
      WHERE id = ?
    `).run(scopeType, options?.actor ?? null, existing.id);
  }

  getDb().prepare(`
    INSERT INTO skill_version_rollouts (
      skill_version_id,
      scope_type,
      tenant_id,
      user_id,
      canary_key,
      status,
      created_by,
      activated_at,
      rollout_notes
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'), ?)
  `).run(
    existing.id,
    scopeType,
    options?.tenantId ?? null,
    options?.userId ?? null,
    options?.canaryKey ?? null,
    options?.actor ?? null,
    options?.notes ?? null,
  );

  return getVersionById(existing.id)!;
}

export function getActiveSkillVersion(skillId: string, scope: SkillVersionScope = {}): SkillVersionRecord | null {
  const normalized = normalizeSkillId(skillId);
  const db = getDb();
  const candidates: SkillVersionRow[] = db.prepare(`
    SELECT v.*
    FROM skill_versions v
    JOIN skill_version_rollouts r ON r.skill_version_id = v.id
    WHERE v.skill_id = ?
      AND r.status = 'active'
      AND (
        (r.scope_type = 'user' AND r.user_id = ?)
        OR (r.scope_type = 'tenant' AND r.tenant_id = ?)
        OR (r.scope_type = 'canary' AND r.canary_key = ?)
        OR r.scope_type = 'global'
      )
    ORDER BY
      CASE
        WHEN r.scope_type = 'user' AND r.user_id = ? THEN 0
        WHEN r.scope_type = 'tenant' AND r.tenant_id = ? THEN 1
        WHEN r.scope_type = 'canary' AND r.canary_key = ? THEN 2
        WHEN r.scope_type = 'global' THEN 3
        ELSE 9
      END,
      COALESCE(r.activated_at, v.activated_at, v.created_at) DESC,
      v.id DESC
  `).all(
    normalized,
    scope.userId ?? null,
    scope.tenantId ?? null,
    scope.canaryKey ?? null,
    scope.userId ?? null,
    scope.tenantId ?? null,
    scope.canaryKey ?? null,
  ) as SkillVersionRow[];

  const row = candidates[0] ?? db.prepare(`
    SELECT * FROM skill_versions
    WHERE skill_id = ? AND status = 'active' AND rollout_scope = 'global'
    ORDER BY COALESCE(activated_at, created_at) DESC, id DESC
    LIMIT 1
  `).get(normalized) as SkillVersionRow | undefined;

  return row ? rowToRecord(row) : null;
}

function definitionForSkill(skillId: string): SkillDefinition | null {
  const normalized = normalizeSkillId(skillId);
  if (normalized === 'training') return DEFAULT_SKILLS.triathlon;
  if (normalized in DEFAULT_SKILLS) return DEFAULT_SKILLS[normalized as keyof typeof DEFAULT_SKILLS];
  return null;
}

function fallbackMetadata(skillId: string): SkillMetadata {
  const normalized = normalizeSkillId(skillId);
  const def = definitionForSkill(normalized);
  const skillName = normalized === 'chat'
    ? 'Chat'
    : normalized === 'training'
      ? 'Training'
      : def?.description.split(' — ')[0] ?? normalized;
  const version = def?.version ?? '0.0.0';
  const capabilities = def
    ? def.subSkills.map((sub) => sub.name)
    : normalized === 'chat'
      ? ['conversation', 'skill routing', 'live model routing']
      : [];

  return {
    skillId: normalized,
    skillName,
    currentVersion: version,
    status: 'active',
    releaseType: 'minor',
    releaseTitle: `${skillName} compiled baseline`,
    releaseSummary: 'Compiled skill metadata fallback. No explicit skill version registry row was found.',
    capabilities,
    releaseNotes: capabilities,
    knownLimitations: ['No explicit skill version registry row has been recorded yet.'],
    openRisks: [],
    lastUpdated: null,
    compatibleApiVersion: null,
    memorySchemaVersion: null,
    qualityGateStatus: 'fallback',
    rolloutScope: 'global',
    rollbackNotes: null,
  };
}

export function getSkillMetadata(skillId: string, scope: SkillVersionScope = {}): SkillMetadata {
  const active = getActiveSkillVersion(skillId, scope);
  if (!active) return fallbackMetadata(skillId);

  return {
    skillId: active.skillId,
    skillName: active.skillName,
    currentVersion: active.version,
    status: active.status,
    releaseType: active.releaseType,
    releaseTitle: active.releaseTitle,
    releaseSummary: active.releaseSummary,
    capabilities: active.capabilitiesAdded,
    releaseNotes: [
      ...active.capabilitiesAdded,
      ...active.logicImprovements,
      ...active.bugFixes,
      ...active.securityFixes,
    ],
    knownLimitations: active.knownLimitations,
    openRisks: active.openRisks,
    lastUpdated: active.activatedAt ?? active.createdAt,
    compatibleApiVersion: active.compatibleApiVersion,
    memorySchemaVersion: active.memorySchemaVersion,
    qualityGateStatus: active.qualityGateStatus,
    rolloutScope: active.rolloutScope,
    rollbackNotes: active.rollbackNotes,
  };
}

export function getAllSkillMetadata(scope: SkillVersionScope = {}): SkillMetadata[] {
  return PUBLIC_SKILL_IDS.map((skillId) => getSkillMetadata(skillId, scope));
}
