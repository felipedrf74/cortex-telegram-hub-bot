// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import { requireTenantIdParam } from './tenant-scope';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';
import { TRAINING_COACH_V2_CONTRACT_VERSION } from './training-coach-v2-proposals';

interface ReflowPreviewRow {
  preview_id: string;
  tenant_id: number;
  user_id: number;
  plan_id: number;
  week_id: number;
  expected_version: number;
  request_json: string;
  evidence_json: string;
  request_hash: string;
  created_at: string;
  expires_at: string;
}

export interface TrainingCoachV2ReflowPreviewResource {
  contractVersion: typeof TRAINING_COACH_V2_CONTRACT_VERSION;
  previewId: string;
  planId: number;
  weekId: number;
  expectedVersion: number;
  createdAt: string;
  expiresAt: string;
}

export interface TrainingCoachV2ReflowPreviewMaterial {
  preview: TrainingCoachV2ReflowPreviewResource;
  request: Record<string, unknown>;
  evidence: Record<string, unknown>;
  requestHash: string;
}

export class TrainingCoachV2ReflowPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

/**
 * Persists the exact reviewed reflow material. Proposal creation later reads
 * this immutable scoped snapshot instead of re-running a volatile classifier.
 */
export function createTrainingCoachV2ReflowPreview(input: {
  tenantId: number;
  userId: number;
  planId: number;
  weekId: number;
  expectedVersion: number;
  request: Record<string, unknown>;
  evidence: Record<string, unknown>;
  ttlMinutes?: number;
  db?: Database.Database;
}): TrainingCoachV2ReflowPreviewMaterial {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'createTrainingCoachV2ReflowPreview');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TrainingCoachV2ReflowPreviewError(
      'BAD_EXPECTED_VERSION',
      'expectedVersion must be a non-negative integer.',
      400,
    );
  }
  const ownership = db.prepare(`
    SELECT p.adaptation_revision AS adaptationRevision
      FROM fitness_training_plans p
      JOIN training_weeks w ON w.plan_id = p.id
     WHERE p.id = ? AND w.id = ? AND p.tenant_id = ? AND p.user_id = ?
  `).get(input.planId, input.weekId, tenantId, input.userId) as { adaptationRevision: number } | undefined;
  if (!ownership) {
    throw new TrainingCoachV2ReflowPreviewError(
      'WEEK_NOT_FOUND',
      'Training week not found.',
      404,
    );
  }
  if (Number(ownership.adaptationRevision ?? 0) !== input.expectedVersion) {
    throw new TrainingCoachV2ReflowPreviewError(
      'PREVIEW_VERSION_CHANGED',
      'The training plan changed before its reflow preview could be recorded.',
      412,
    );
  }

  const previewId = `tcrp_${randomUUID().replaceAll('-', '')}`;
  const createdAt = new Date().toISOString();
  const ttlMinutes = Math.min(60, Math.max(5, Math.floor(input.ttlMinutes ?? 15)));
  const expiresAt = new Date(Date.parse(createdAt) + ttlMinutes * 60_000).toISOString();
  const requestHash = stableTrainingRevisionHash({
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    operation: 'week_reflow_preview',
    tenantId,
    userId: input.userId,
    planId: input.planId,
    weekId: input.weekId,
    expectedVersion: input.expectedVersion,
    request: input.request,
    evidence: input.evidence,
  });
  db.prepare(`
    INSERT INTO training_coach_v2_reflow_previews (
      preview_id, tenant_id, user_id, plan_id, week_id, expected_version,
      request_json, evidence_json, request_hash, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    previewId,
    tenantId,
    input.userId,
    input.planId,
    input.weekId,
    input.expectedVersion,
    JSON.stringify(input.request),
    JSON.stringify(input.evidence),
    requestHash,
    createdAt,
    expiresAt,
  );
  return getTrainingCoachV2ReflowPreview({
    tenantId,
    userId: input.userId,
    planId: input.planId,
    weekId: input.weekId,
    previewId,
    db,
  });
}

export function getTrainingCoachV2ReflowPreview(input: {
  tenantId: number;
  userId: number;
  planId: number;
  weekId: number;
  previewId: string;
  allowExpired?: boolean;
  db?: Database.Database;
}): TrainingCoachV2ReflowPreviewMaterial {
  const db = input.db ?? getDb();
  const tenantId = requireTenantIdParam(input.tenantId, 'getTrainingCoachV2ReflowPreview');
  if (!/^tcrp_[a-f0-9]{32}$/.test(input.previewId)) {
    throw new TrainingCoachV2ReflowPreviewError('BAD_PREVIEW_ID', 'previewId is invalid.', 400);
  }
  const row = db.prepare(`
    SELECT * FROM training_coach_v2_reflow_previews
     WHERE tenant_id = ? AND user_id = ? AND plan_id = ? AND week_id = ?
       AND preview_id = ?
  `).get(
    tenantId,
    input.userId,
    input.planId,
    input.weekId,
    input.previewId,
  ) as ReflowPreviewRow | undefined;
  if (!row) {
    // Missing and foreign-scoped previews intentionally share one response.
    throw new TrainingCoachV2ReflowPreviewError(
      'REFLOW_PREVIEW_NOT_FOUND',
      'Reflow preview not found.',
      404,
    );
  }
  if (!input.allowExpired && Date.parse(row.expires_at) <= Date.now()) {
    throw new TrainingCoachV2ReflowPreviewError(
      'REFLOW_PREVIEW_EXPIRED',
      'Reflow preview expired. Create and review a new preview.',
      410,
    );
  }
  const request = parseStoredObject(row.request_json);
  const evidence = parseStoredObject(row.evidence_json);
  const expectedHash = stableTrainingRevisionHash({
    contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
    operation: 'week_reflow_preview',
    tenantId,
    userId: input.userId,
    planId: input.planId,
    weekId: input.weekId,
    expectedVersion: row.expected_version,
    request,
    evidence,
  });
  if (expectedHash !== row.request_hash) {
    throw new TrainingCoachV2ReflowPreviewError(
      'REFLOW_PREVIEW_INVALID',
      'Stored reflow preview verification failed.',
      409,
    );
  }
  return {
    preview: {
      contractVersion: TRAINING_COACH_V2_CONTRACT_VERSION,
      previewId: row.preview_id,
      planId: row.plan_id,
      weekId: row.week_id,
      expectedVersion: row.expected_version,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    },
    request,
    evidence,
    requestHash: row.request_hash,
  };
}

function parseStoredObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to a stable, privacy-safe contract error.
  }
  throw new TrainingCoachV2ReflowPreviewError(
    'REFLOW_PREVIEW_INVALID',
    'Stored reflow preview verification failed.',
    409,
  );
}
