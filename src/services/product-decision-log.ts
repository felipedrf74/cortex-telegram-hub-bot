// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Generic product decision log.
 *
 * This complements specialized logs (for example notification decisions) with
 * a small, privacy-bounded reason ledger for projections and orchestrators.
 */

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { isValidTenantUserId, recordTenantScopeAnomaly } from './tenant-scope-observability';
import { getCurrentContext } from '../utils/request-context';
import { sanitizePrivacyObject } from '../utils/privacy-sanitizer';

export interface ProductDecisionLogInput {
  decisionId?: string;
  tenantId: number;
  userId?: number | null;
  sourceSkill: string;
  entityType: string;
  entityId: string | number;
  decisionType: string;
  inputsSummary?: Record<string, unknown>;
  constraints?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  explanationCode: string;
  confidence?: number | null;
  warnings?: unknown[];
  correlationId?: string | null;
  eventId?: string | null;
}

export interface ProductDecisionLogRecord {
  decisionId: string;
  tenantId: number;
  userId: number | null;
  sourceSkill: string;
  entityType: string;
  entityId: string;
  decisionType: string;
  inputsSummary: Record<string, unknown>;
  constraints: Record<string, unknown>;
  decision: Record<string, unknown>;
  explanationCode: string;
  confidence: number | null;
  warnings: unknown[];
  correlationId: string | null;
  eventId: string | null;
  createdAt: string;
}

export function ensureProductDecisionLogTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_decision_logs (
      decision_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER,
      source_skill TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      inputs_summary_json TEXT NOT NULL DEFAULT '{}',
      constraints_json TEXT NOT NULL DEFAULT '{}',
      decision_json TEXT NOT NULL DEFAULT '{}',
      explanation_code TEXT NOT NULL,
      confidence REAL,
      warnings_json TEXT NOT NULL DEFAULT '[]',
      correlation_id TEXT,
      event_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_product_decision_logs_scope_created
      ON product_decision_logs(tenant_id, user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_product_decision_logs_entity
      ON product_decision_logs(source_skill, entity_type, entity_id);
  `);
}

export function recordProductDecision(input: ProductDecisionLogInput, db: Database.Database = getDb()): ProductDecisionLogRecord {
  assertDecisionScope(input);
  ensureProductDecisionLogTables(db);
  const decisionId = input.decisionId ?? randomUUID();
  const correlationId = input.correlationId ?? getCurrentContext()?.requestId ?? null;
  db.prepare(`
    INSERT INTO product_decision_logs (
      decision_id, tenant_id, user_id, source_skill, entity_type, entity_id,
      decision_type, inputs_summary_json, constraints_json, decision_json,
      explanation_code, confidence, warnings_json, correlation_id, event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    decisionId,
    input.tenantId,
    input.userId ?? null,
    input.sourceSkill,
    input.entityType,
    String(input.entityId),
    input.decisionType,
    JSON.stringify(sanitize(input.inputsSummary ?? {})),
    JSON.stringify(sanitize(input.constraints ?? {})),
    JSON.stringify(sanitize(input.decision ?? {})),
    input.explanationCode,
    typeof input.confidence === 'number' ? input.confidence : null,
    JSON.stringify(input.warnings ?? []),
    correlationId,
    input.eventId ?? null,
  );
  return mapDecision(db.prepare('SELECT * FROM product_decision_logs WHERE decision_id = ?').get(decisionId) as any);
}

function assertDecisionScope(input: ProductDecisionLogInput): void {
  if (!isValidTenantUserId(input.tenantId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'product_decision_log',
      reason: 'invalid_user_scope',
      userId: typeof input.tenantId === 'number' ? input.tenantId : null,
      details: { sourceSkill: input.sourceSkill, decisionType: input.decisionType },
    });
    throw new Error('tenantId required: must be a positive integer');
  }
  if (input.userId != null && !isValidTenantUserId(input.userId)) {
    recordTenantScopeAnomaly({
      layer: 'orchestration',
      operation: 'product_decision_log',
      reason: 'invalid_user_scope',
      userId: typeof input.userId === 'number' ? input.userId : null,
      details: { sourceSkill: input.sourceSkill, decisionType: input.decisionType },
    });
    throw new Error('userId required: must be a positive integer when provided');
  }
}

function sanitize(value: Record<string, unknown>): Record<string, unknown> {
  return sanitizePrivacyObject(value, { maxDepth: 4, maxStringLength: 500 });
}

function mapDecision(row: any): ProductDecisionLogRecord {
  return {
    decisionId: row.decision_id,
    tenantId: Number(row.tenant_id),
    userId: row.user_id == null ? null : Number(row.user_id),
    sourceSkill: row.source_skill,
    entityType: row.entity_type,
    entityId: row.entity_id,
    decisionType: row.decision_type,
    inputsSummary: parseObject(row.inputs_summary_json),
    constraints: parseObject(row.constraints_json),
    decision: parseObject(row.decision_json),
    explanationCode: row.explanation_code,
    confidence: row.confidence == null ? null : Number(row.confidence),
    warnings: parseArray(row.warnings_json),
    correlationId: row.correlation_id ?? null,
    eventId: row.event_id ?? null,
    createdAt: row.created_at,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
