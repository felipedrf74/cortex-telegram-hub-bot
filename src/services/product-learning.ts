// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';

export type LearningCaseLifecycle = 'observed' | 'candidate' | 'reviewed' | 'golden' | 'retired';
export type LearningPrivacyClass = 'public' | 'redacted-product' | 'sensitive-no-export';

export interface LearningCase {
  id: string;
  tenantId: number;
  userId: number;
  owner: string;
  lifecycle: LearningCaseLifecycle;
  privacyClass: LearningPrivacyClass;
  redactedInput: Record<string, unknown>;
  expectedContract: Record<string, unknown>;
  evidenceReferences: string[];
  producerVersion: string;
  confidence: number;
  observedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewApprovalReference?: string;
  expiresAt: string;
}

export interface LearningReviewProof {
  approvalReference: string;
}

export interface LearningReviewApprovalReceipt {
  approvalReference: string;
  tenantId: number;
  userId: number;
  caseId: string;
  actionExecutionId: string;
  decisionId: string;
  actionId: 'approve_product_learning_case';
  reviewedBy: string;
  reviewedAt: string;
  createdAt: string;
}

export interface LearningReviewApprovalInput {
  tenantId: number;
  userId: number;
  caseId: string;
  actionExecutionId: string;
}

export const TRAINING_LEARNING_KIND_VALUES = [
  'plan_correction',
  'adaptation_accepted',
  'adaptation_rejected',
  'capacity_conflict_accuracy',
  'media_fallback',
  'media_missing_mapping',
  'compatibility_regression',
  'physical_device_observation',
] as const;

export type TrainingLearningKind = typeof TRAINING_LEARNING_KIND_VALUES[number];

export interface TrainingLearningObservation {
  id: string;
  tenantId: number;
  userId: number;
  kind: TrainingLearningKind;
  outcomeCode: string;
  expectedContractId: string;
  evidenceReferences: string[];
  producerVersion: string;
  confidence: number;
  observedAt?: string;
  expiresAt?: string;
  subjectFingerprint?: string;
}

const TRAINING_LEARNING_TAXONOMY: Record<
  TrainingLearningKind,
  Readonly<Record<string, string>>
> = {
  plan_correction: { user_corrected: 'training.plan_correction.v1' },
  adaptation_accepted: { user_approved: 'training.adaptation.activation.v1' },
  adaptation_rejected: { user_rejected: 'training.adaptation.rejection.v1' },
  capacity_conflict_accuracy: {
    confirmed: 'training.capacity_conflict.v1',
    corrected: 'training.capacity_conflict.v1',
  },
  media_fallback: {
    fallback_used: 'training.media_fallback.v1',
    fallback_failed: 'training.media_fallback.v1',
  },
  media_missing_mapping: {
    mapping_missing: 'training.media_mapping.v1',
    mapping_added: 'training.media_mapping.v1',
  },
  compatibility_regression: {
    detected: 'training.compatibility_regression.v1',
    resolved: 'training.compatibility_regression.v1',
  },
  physical_device_observation: {
    passed: 'training.physical_device.v1',
    failed: 'training.physical_device.v1',
  },
};
const TRAINING_LEARNING_KIND_SET = new Set<string>(TRAINING_LEARNING_KIND_VALUES);
const TRAINING_INPUT_KEYS = new Set(['kind', 'outcomeCode', 'subjectFingerprint']);
const TRAINING_CONTRACT_KEYS = new Set(['contractId']);
const DEFAULT_LEARNING_EXPIRY_DAYS = 180;
const PRODUCT_LEARNING_REVIEW_ACTION_ID = 'approve_product_learning_case' as const;

export function trainingLearningExpectedContract(
  kind: TrainingLearningKind,
  outcomeCode: string,
): string | null {
  return TRAINING_LEARNING_TAXONOMY[kind]?.[outcomeCode] ?? null;
}

const LIFECYCLE_TRANSITIONS: Record<LearningCaseLifecycle, readonly LearningCaseLifecycle[]> = {
  observed: ['candidate', 'retired'],
  candidate: ['reviewed', 'retired'],
  reviewed: ['golden', 'retired'],
  golden: ['retired'],
  retired: [],
};

const FORBIDDEN_KEYS = /(?:email|phone|calendar|token|secret|password|raw[_-]?(?:content|text)|access[_-]?key|oauth|address)/i;
const PRIVATE_STRING = /(?:\bBearer\s+[A-Za-z0-9._~-]+|-----BEGIN [A-Z ]+PRIVATE KEY-----|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|\b(?:\+?\d[\s().-]*){9,}\d\b)/i;
const SAFE_CODE = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const SAFE_CASE_ID = /^[a-z0-9][a-z0-9_.:-]{0,159}$/;
const SAFE_EVIDENCE_REFERENCE = /^(?:ci|metric|outcome|approval|release|testflight|external|event):\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#=%-]{0,399}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? 'null';
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function immutableEvidenceMatches(existing: LearningCase, candidate: LearningCase): boolean {
  return existing.tenantId === candidate.tenantId
    && existing.userId === candidate.userId
    && existing.owner === candidate.owner
    && existing.privacyClass === candidate.privacyClass
    && stableStringify(existing.redactedInput) === stableStringify(candidate.redactedInput)
    && stableStringify(existing.expectedContract) === stableStringify(candidate.expectedContract)
    && stableStringify(existing.evidenceReferences) === stableStringify(candidate.evidenceReferences)
    && existing.producerVersion === candidate.producerVersion
    && existing.confidence === candidate.confidence
    && existing.observedAt === candidate.observedAt
    && existing.expiresAt === candidate.expiresAt;
}

function containsPrivateMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsPrivateMaterial);
  if (typeof value === 'string') return value.length > 2_000 || PRIVATE_STRING.test(value);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => FORBIDDEN_KEYS.test(key) || containsPrivateMaterial(nested));
}

function isIsoTimestamp(value: string | undefined): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function mapLearningCase(row: Record<string, unknown>): LearningCase {
  return {
    id: String(row.case_id),
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    owner: String(row.owner),
    lifecycle: String(row.lifecycle) as LearningCaseLifecycle,
    privacyClass: String(row.privacy_class) as LearningPrivacyClass,
    redactedInput: JSON.parse(String(row.redacted_input_json)),
    expectedContract: JSON.parse(String(row.expected_contract_json)),
    evidenceReferences: JSON.parse(String(row.evidence_references_json)),
    producerVersion: String(row.producer_version),
    confidence: Number(row.confidence),
    observedAt: String(row.observed_at),
    ...(row.reviewed_at ? { reviewedAt: String(row.reviewed_at) } : {}),
    ...(row.reviewed_by ? { reviewedBy: String(row.reviewed_by) } : {}),
    ...(row.review_approval_reference ? { reviewApprovalReference: String(row.review_approval_reference) } : {}),
    expiresAt: String(row.expires_at),
  };
}

function mapLearningReviewApproval(row: Record<string, unknown>): LearningReviewApprovalReceipt {
  return {
    approvalReference: String(row.approval_reference),
    tenantId: Number(row.tenant_id),
    userId: Number(row.user_id),
    caseId: String(row.case_id),
    actionExecutionId: String(row.action_execution_id),
    decisionId: String(row.decision_id),
    actionId: PRODUCT_LEARNING_REVIEW_ACTION_ID,
    reviewedBy: String(row.reviewed_by),
    reviewedAt: String(row.reviewed_at),
    createdAt: String(row.created_at),
  };
}

function canonicalSqliteUtcTimestamp(value: string): string {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`;
  const parsed = Date.parse(zoned);
  if (!Number.isFinite(parsed)) throw new Error('Decision Center review execution has an invalid completion timestamp');
  return new Date(parsed).toISOString();
}

export function learningReviewApprovalReferenceForExecution(actionExecutionId: string): string {
  const digest = createHash('sha256').update(actionExecutionId).digest('hex');
  return `approval://product-learning/${digest}`;
}

function trustedReviewApprovalRow(
  tenantId: number,
  userId: number,
  caseId: string,
  approvalReference: string,
  db: Database.Database,
): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT approval.*
      FROM product_learning_case_review_approvals approval
      JOIN decision_action_executions execution
        ON execution.action_execution_id = approval.action_execution_id
       AND execution.decision_id = approval.decision_id
       AND execution.user_id = approval.user_id
       AND execution.tenant_id = approval.tenant_id
      JOIN notification_center_items item
        ON item.item_id = execution.decision_id
       AND item.user_id = execution.user_id
       AND item.tenant_id = execution.tenant_id
      JOIN notification_intents intent
        ON intent.intent_id = item.intent_id
       AND intent.user_id = item.user_id
       AND intent.tenant_id = item.tenant_id
     WHERE approval.tenant_id = ?
       AND approval.user_id = ?
       AND approval.case_id = ?
       AND approval.approval_reference = ?
       AND execution.action_id = ?
       AND execution.executor_skill = 'training'
       AND execution.status = 'succeeded'
       AND execution.completed_at IS NOT NULL
       AND datetime(execution.completed_at) <= datetime('now')
       AND datetime(execution.completed_at) = datetime(approval.reviewed_at)
       AND json_extract(execution.result_json, '$.productLearningCaseId') = approval.case_id
       AND json_extract(execution.result_json, '$.approved') = 1
       AND item.source_skill = 'training'
       AND item.status = 'actioned'
       AND item.decision_state = 'completed'
       AND intent.source_skill = 'training'
       AND intent.related_entity_type = 'product_learning_case'
       AND intent.related_entity_id = approval.case_id
     LIMIT 1
  `).get(
    tenantId,
    userId,
    caseId,
    approvalReference,
    PRODUCT_LEARNING_REVIEW_ACTION_ID,
  ) as Record<string, unknown> | undefined;
}

function requireTrustedReviewApproval(
  candidate: LearningCase,
  approvalReference: string | undefined,
  db: Database.Database | undefined,
): LearningReviewApprovalReceipt {
  if (!db) throw new Error('trusted learning review approval database is required');
  if (typeof approvalReference !== 'string'
      || !approvalReference.startsWith('approval://product-learning/')) {
    throw new Error('trusted learning review approval receipt is required');
  }
  const row = trustedReviewApprovalRow(
    candidate.tenantId,
    candidate.userId,
    candidate.id,
    approvalReference,
    db,
  );
  if (!row) throw new Error('trusted learning review approval receipt is missing or outside tenant scope');
  const receipt = mapLearningReviewApproval(row);
  if (receipt.reviewedBy !== `user:${candidate.userId}`
      || Date.parse(receipt.reviewedAt) > Date.now()) {
    throw new Error('trusted learning review approval receipt has invalid server authority');
  }
  return receipt;
}

export function recordLearningCaseReviewApproval(
  input: LearningReviewApprovalInput,
  db: Database.Database = getDb(),
): LearningReviewApprovalReceipt {
  if (!Number.isInteger(input.tenantId) || input.tenantId <= 0
      || !Number.isInteger(input.userId) || input.userId <= 0
      || !SAFE_CASE_ID.test(input.caseId)
      || !SAFE_CASE_ID.test(input.actionExecutionId)) {
    throw new Error('learning review approval scope and execution id are required');
  }
  const learningCase = getLearningCase(input.tenantId, input.userId, input.caseId, db);
  if (!learningCase) {
    throw new Error('learning review approval requires a case in the exact tenant scope');
  }
  const existing = db.prepare(`
    SELECT * FROM product_learning_case_review_approvals
     WHERE tenant_id = ? AND user_id = ? AND case_id = ?
     LIMIT 1
  `).get(input.tenantId, input.userId, input.caseId) as Record<string, unknown> | undefined;
  if (existing) {
    const receipt = mapLearningReviewApproval(existing);
    if (receipt.actionExecutionId !== input.actionExecutionId) {
      throw new Error('learning review approval conflicts with an existing immutable receipt');
    }
    return requireTrustedReviewApproval(learningCase, receipt.approvalReference, db);
  }
  if (learningCase.lifecycle !== 'candidate') {
    throw new Error('learning review approval requires a candidate in the exact tenant scope');
  }
  if (Date.parse(learningCase.expiresAt) <= Date.now()) {
    throw new Error('expired learning case cannot receive review approval');
  }
  const execution = db.prepare(`
    SELECT execution.action_execution_id AS actionExecutionId,
           execution.decision_id AS decisionId,
           execution.completed_at AS completedAt
      FROM decision_action_executions execution
      JOIN notification_center_items item
        ON item.item_id = execution.decision_id
       AND item.user_id = execution.user_id
       AND item.tenant_id = execution.tenant_id
      JOIN notification_intents intent
        ON intent.intent_id = item.intent_id
       AND intent.user_id = item.user_id
       AND intent.tenant_id = item.tenant_id
     WHERE execution.action_execution_id = ?
       AND execution.user_id = ?
       AND execution.tenant_id = ?
       AND execution.action_id = ?
       AND execution.executor_skill = 'training'
       AND execution.status = 'succeeded'
       AND execution.completed_at IS NOT NULL
       AND datetime(execution.completed_at) <= datetime('now')
       AND json_extract(execution.result_json, '$.productLearningCaseId') = ?
       AND json_extract(execution.result_json, '$.approved') = 1
       AND item.source_skill = 'training'
       AND item.status = 'actioned'
       AND item.decision_state = 'completed'
       AND intent.source_skill = 'training'
       AND intent.related_entity_type = 'product_learning_case'
       AND intent.related_entity_id = ?
     LIMIT 1
  `).get(
    input.actionExecutionId,
    input.userId,
    input.tenantId,
    PRODUCT_LEARNING_REVIEW_ACTION_ID,
    input.caseId,
    input.caseId,
  ) as { actionExecutionId: string; decisionId: string; completedAt: string } | undefined;
  if (!execution) {
    throw new Error('learning review approval requires a completed scoped Decision Center execution');
  }
  const reviewedAt = canonicalSqliteUtcTimestamp(execution.completedAt);
  if (Date.parse(reviewedAt) > Date.now()) {
    throw new Error('learning review approval cannot use a future completion timestamp');
  }
  const approvalReference = learningReviewApprovalReferenceForExecution(execution.actionExecutionId);
  const inserted = db.prepare(`
    INSERT INTO product_learning_case_review_approvals (
      approval_reference, tenant_id, user_id, case_id, action_execution_id,
      decision_id, action_id, reviewed_by, reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT DO NOTHING
  `).run(
    approvalReference,
    input.tenantId,
    input.userId,
    input.caseId,
    execution.actionExecutionId,
    execution.decisionId,
    PRODUCT_LEARNING_REVIEW_ACTION_ID,
    `user:${input.userId}`,
    reviewedAt,
  );
  if (inserted.changes === 0) {
    const concurrent = db.prepare(`
      SELECT * FROM product_learning_case_review_approvals
       WHERE tenant_id = ? AND user_id = ? AND case_id = ?
       LIMIT 1
    `).get(input.tenantId, input.userId, input.caseId) as Record<string, unknown> | undefined;
    if (!concurrent) {
      throw new Error('learning review approval conflicts with another immutable receipt');
    }
    const receipt = mapLearningReviewApproval(concurrent);
    if (receipt.actionExecutionId !== execution.actionExecutionId
        || receipt.approvalReference !== approvalReference) {
      throw new Error('learning review approval conflicts with another immutable receipt');
    }
  }
  return requireTrustedReviewApproval(learningCase, approvalReference, db);
}

function exactKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function validTrainingPayload(candidate: LearningCase): boolean {
  if (candidate.owner !== 'training'
      || !isRecord(candidate.redactedInput)
      || !isRecord(candidate.expectedContract)
      || !exactKeys(candidate.redactedInput, TRAINING_INPUT_KEYS)
      || !exactKeys(candidate.expectedContract, TRAINING_CONTRACT_KEYS)) return false;
  const kind = candidate.redactedInput.kind;
  const outcomeCode = candidate.redactedInput.outcomeCode;
  const contractId = candidate.expectedContract.contractId;
  if (typeof kind !== 'string' || !TRAINING_LEARNING_KIND_SET.has(kind)
      || typeof outcomeCode !== 'string' || typeof contractId !== 'string') return false;
  const expectedContract = trainingLearningExpectedContract(kind as TrainingLearningKind, outcomeCode);
  if (expectedContract !== contractId) return false;
  const fingerprint = candidate.redactedInput.subjectFingerprint;
  return fingerprint === undefined || (typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint));
}

export function validateLearningCase(candidate: LearningCase): string[] {
  const errors: string[] = [];
  if (!SAFE_CASE_ID.test(candidate.id)) errors.push('id_required');
  if (!Number.isInteger(candidate.tenantId) || candidate.tenantId <= 0) errors.push('tenant_scope_required');
  if (!Number.isInteger(candidate.userId) || candidate.userId <= 0) {
    errors.push('user_scope_required');
  }
  if (!candidate.owner.trim() || candidate.owner.length > 80) errors.push('owner_required');
  if (!isRecord(candidate.redactedInput) || !isRecord(candidate.expectedContract)
      || containsPrivateMaterial(candidate.redactedInput) || containsPrivateMaterial(candidate.expectedContract)) {
    errors.push('redaction_failed');
  }
  if (!validTrainingPayload(candidate)) errors.push('training_taxonomy_invalid');
  if (!Array.isArray(candidate.evidenceReferences)
      || candidate.evidenceReferences.some((reference) => typeof reference !== 'string'
        || !SAFE_EVIDENCE_REFERENCE.test(reference) || PRIVATE_STRING.test(reference))) {
    errors.push('evidence_reference_invalid');
  }
  if (!SAFE_CODE.test(candidate.producerVersion)) errors.push('producer_version_required');
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1) {
    errors.push('confidence_invalid');
  }
  if (!isIsoTimestamp(candidate.observedAt)) errors.push('observed_at_invalid');
  if (candidate.reviewedAt && !isIsoTimestamp(candidate.reviewedAt)) errors.push('reviewed_at_invalid');
  if (candidate.reviewedAt && isIsoTimestamp(candidate.reviewedAt)
      && Date.parse(candidate.reviewedAt) > Date.now()) {
    errors.push('reviewed_at_future');
  }
  if (candidate.reviewedAt && isIsoTimestamp(candidate.observedAt) && isIsoTimestamp(candidate.expiresAt)
      && (Date.parse(candidate.reviewedAt) <= Date.parse(candidate.observedAt)
        || Date.parse(candidate.reviewedAt) > Date.parse(candidate.expiresAt))) {
    errors.push('reviewed_at_order_invalid');
  }
  if (!isIsoTimestamp(candidate.expiresAt)
      || (isIsoTimestamp(candidate.observedAt) && Date.parse(candidate.expiresAt) <= Date.parse(candidate.observedAt))) {
    errors.push('expires_at_invalid');
  }
  const hasAnyReviewProof = !!(candidate.reviewedAt || candidate.reviewedBy || candidate.reviewApprovalReference);
  const hasCompleteReviewProof = !!(candidate.reviewedAt && candidate.reviewedBy && candidate.reviewApprovalReference);
  if (['reviewed', 'golden'].includes(candidate.lifecycle)) {
    if (!candidate.reviewedAt || !candidate.reviewedBy || !candidate.reviewApprovalReference) {
      errors.push('review_proof_required');
    } else if (!SAFE_CODE.test(candidate.reviewedBy)
        || !candidate.reviewApprovalReference.startsWith('approval://product-learning/')
        || !SAFE_EVIDENCE_REFERENCE.test(candidate.reviewApprovalReference)
        || PRIVATE_STRING.test(candidate.reviewApprovalReference)) {
      errors.push('review_proof_invalid');
    }
  } else if (candidate.lifecycle === 'retired' && hasAnyReviewProof) {
    if (!hasCompleteReviewProof || !SAFE_CODE.test(candidate.reviewedBy!)
        || !candidate.reviewApprovalReference!.startsWith('approval://product-learning/')
        || !SAFE_EVIDENCE_REFERENCE.test(candidate.reviewApprovalReference!)) {
      errors.push('review_proof_invalid');
    }
  } else if (hasAnyReviewProof) {
    errors.push('review_proof_lifecycle_invalid');
  }
  if (candidate.lifecycle === 'golden') {
    if (!candidate.reviewedAt) errors.push('golden_requires_review');
    if (candidate.evidenceReferences.length === 0) errors.push('golden_requires_evidence');
    if (candidate.privacyClass === 'sensitive-no-export') errors.push('sensitive_case_cannot_be_golden');
  }
  return [...new Set(errors)];
}

function assertValidLearningCase(candidate: LearningCase): void {
  const errors = validateLearningCase(candidate);
  if (errors.length) throw new Error(`invalid learning case: ${errors.join(', ')}`);
}

export function promoteLearningCase(
  candidate: LearningCase,
  lifecycle: Exclude<LearningCaseLifecycle, 'observed'>,
  reviewProof?: LearningReviewProof,
  db?: Database.Database,
): LearningCase {
  if (!LIFECYCLE_TRANSITIONS[candidate.lifecycle].includes(lifecycle)) {
    throw new Error(`invalid learning case transition: ${candidate.lifecycle}->${lifecycle}`);
  }
  if (reviewProof && Object.keys(reviewProof).some((key) => key !== 'approvalReference')) {
    throw new Error('learning review timestamp and reviewer must be server-authoritative');
  }
  const trustedReceipt = lifecycle === 'reviewed'
    ? requireTrustedReviewApproval(candidate, reviewProof?.approvalReference, db)
    : lifecycle === 'golden'
      ? requireTrustedReviewApproval(candidate, candidate.reviewApprovalReference, db)
      : null;
  const promoted: LearningCase = {
    ...candidate,
    lifecycle,
    ...(lifecycle === 'reviewed' && trustedReceipt ? {
      reviewedAt: trustedReceipt.reviewedAt,
      reviewedBy: trustedReceipt.reviewedBy,
      reviewApprovalReference: trustedReceipt.approvalReference,
    } : {}),
  };
  assertValidLearningCase(promoted);
  return promoted;
}

export function storeLearningCase(candidate: LearningCase, db: Database.Database = getDb()): LearningCase {
  assertValidLearningCase(candidate);
  if (candidate.lifecycle !== 'observed' || candidate.reviewedAt
      || candidate.reviewedBy || candidate.reviewApprovalReference) {
    throw new Error('new learning cases must enter through the observed lifecycle');
  }
  const existing = getLearningCase(candidate.tenantId, candidate.userId, candidate.id, db);
  if (existing) {
    if (!immutableEvidenceMatches(existing, candidate)) {
      throw new Error('learning case idempotency key conflicts with different immutable evidence');
    }
    return existing;
  }
  const insert = db.prepare(`
    INSERT INTO product_learning_cases (
      case_id, tenant_id, user_id, owner, lifecycle, privacy_class,
      redacted_input_json, expected_contract_json, evidence_references_json,
      producer_version, confidence, observed_at, reviewed_at, reviewed_by,
      review_approval_reference, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, case_id) DO NOTHING
  `).run(
    candidate.id,
    candidate.tenantId,
    candidate.userId,
    candidate.owner,
    candidate.lifecycle,
    candidate.privacyClass,
    JSON.stringify(candidate.redactedInput),
    JSON.stringify(candidate.expectedContract),
    JSON.stringify(candidate.evidenceReferences),
    candidate.producerVersion,
    candidate.confidence,
    candidate.observedAt,
    candidate.reviewedAt ?? null,
    candidate.reviewedBy ?? null,
    candidate.reviewApprovalReference ?? null,
    candidate.expiresAt,
  );
  if (insert.changes === 0) {
    const concurrent = getLearningCase(candidate.tenantId, candidate.userId, candidate.id, db);
    if (!concurrent || !immutableEvidenceMatches(concurrent, candidate)) {
      throw new Error('learning case idempotency key conflicts with different immutable evidence');
    }
    return concurrent;
  }
  return candidate;
}

export function getLearningCase(
  tenantId: number,
  userId: number,
  id: string,
  db: Database.Database = getDb(),
): LearningCase | null {
  const row = db.prepare(`
    SELECT * FROM product_learning_cases
     WHERE case_id = ? AND tenant_id = ? AND user_id = ?
     LIMIT 1
  `).get(id, tenantId, userId) as Record<string, unknown> | undefined;
  return row ? mapLearningCase(row) : null;
}

export function listLearningCases(
  tenantId: number,
  userId: number,
  lifecycle?: LearningCaseLifecycle,
): LearningCase[] {
  const rows = lifecycle
    ? getDb().prepare(`
        SELECT * FROM product_learning_cases
         WHERE tenant_id = ? AND user_id = ? AND lifecycle = ?
         ORDER BY observed_at DESC, case_id
      `).all(tenantId, userId, lifecycle)
    : getDb().prepare(`
        SELECT * FROM product_learning_cases
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY observed_at DESC, case_id
      `).all(tenantId, userId);
  return (rows as Array<Record<string, unknown>>).map(mapLearningCase);
}

export function transitionStoredLearningCase(
  tenantId: number,
  userId: number,
  id: string,
  lifecycle: Exclude<LearningCaseLifecycle, 'observed'>,
  reviewProof?: LearningReviewProof,
  db: Database.Database = getDb(),
): LearningCase {
  const existing = getLearningCase(tenantId, userId, id, db);
  if (!existing) throw new Error('learning case not found in tenant scope');
  if (lifecycle !== 'retired' && Date.parse(existing.expiresAt) <= Date.now()) {
    throw new Error('expired learning case can only be retired');
  }
  const promoted = promoteLearningCase(existing, lifecycle, reviewProof, db);
  const result = db.prepare(`
    UPDATE product_learning_cases
       SET lifecycle = ?, reviewed_at = ?, reviewed_by = ?,
           review_approval_reference = ?, updated_at = datetime('now')
     WHERE case_id = ? AND tenant_id = ? AND user_id = ? AND lifecycle = ?
  `).run(
    promoted.lifecycle,
    promoted.reviewedAt ?? existing.reviewedAt ?? null,
    promoted.reviewedBy ?? existing.reviewedBy ?? null,
    promoted.reviewApprovalReference ?? existing.reviewApprovalReference ?? null,
    id,
    tenantId,
    userId,
    existing.lifecycle,
  );
  if (result.changes !== 1) throw new Error('learning case lifecycle update lost its compare-and-swap');
  return promoted;
}

export function createTrainingLearningCase(observation: TrainingLearningObservation): LearningCase {
  const expectedContract = trainingLearningExpectedContract(observation.kind, observation.outcomeCode);
  if (!TRAINING_LEARNING_KIND_SET.has(observation.kind)
      || !SAFE_CODE.test(observation.outcomeCode)
      || expectedContract !== observation.expectedContractId) {
    throw new Error('training learning observation must use closed taxonomy codes');
  }
  if (observation.subjectFingerprint && !/^[a-f0-9]{64}$/.test(observation.subjectFingerprint)) {
    throw new Error('training learning observation fingerprint must be sha256');
  }
  const observedAt = observation.observedAt ?? new Date().toISOString();
  const expiresAt = observation.expiresAt
    ?? new Date(Date.parse(observedAt) + DEFAULT_LEARNING_EXPIRY_DAYS * 24 * 60 * 60 * 1_000).toISOString();
  const candidate: LearningCase = {
    id: observation.id,
    tenantId: observation.tenantId,
    userId: observation.userId,
    owner: 'training',
    lifecycle: 'observed',
    privacyClass: 'redacted-product',
    redactedInput: {
      kind: observation.kind,
      outcomeCode: observation.outcomeCode,
      ...(observation.subjectFingerprint ? { subjectFingerprint: observation.subjectFingerprint } : {}),
    },
    expectedContract: { contractId: observation.expectedContractId },
    evidenceReferences: [...observation.evidenceReferences],
    producerVersion: observation.producerVersion,
    confidence: observation.confidence,
    observedAt,
    expiresAt,
  };
  assertValidLearningCase(candidate);
  return candidate;
}

export function recordTrainingLearningObservation(
  observation: TrainingLearningObservation,
  db: Database.Database = getDb(),
): LearningCase {
  return storeLearningCase(createTrainingLearningCase(observation), db);
}
