// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import {
  getTrainingPlanRevisionV1Mode,
  isTrainingPlanRevisionV1ExplicitlyEnrolled,
  isDecisionFlowV1EnforceEnabled,
  type RuntimeFlagScope,
} from './runtime-flags';
import {
  buildTrainingPlanRevisionCandidate,
  stableTrainingRevisionHash,
  type BuiltTrainingPlanRevisionCandidate,
  type TrainingPlanCandidateRequest,
  type TrainingPlanCausalFactor,
  type TrainingPlanRevisionDocument,
} from './training-plan-revision-candidate-builder';
import {
  decryptTrainingProfileSnapshot,
  encryptTrainingProfileSnapshot,
} from './training-profile-snapshot-encryption';
import { TrainingPlanRevisionError } from './training-plan-revision-errors';
export { TrainingPlanRevisionError } from './training-plan-revision-errors';

export const TRAINING_PLAN_REVISION_API_SCHEMA = 'training_plan_revision_api.v1' as const;

export type TrainingPlanRevisionLifecycleState =
  | 'CANDIDATE'
  | 'PENDING_REVIEW'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'EXPIRED'
  | 'LEGACY_ACTIVE';

export type TrainingPlanRevisionApprovalState =
  | 'UNREVIEWED'
  | 'PENDING'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED';

export interface TrainingPlanRevisionScope {
  userId: number;
  tenantId: number;
}

export interface TrainingPlanRevisionResource {
  revisionId: string;
  familyId: string;
  revisionSequence: number;
  parentRevisionId: string | null;
  profileSnapshotId: string;
  origin: 'GENERATED' | 'LEGACY_BACKFILL';
  lifecycleState: TrainingPlanRevisionLifecycleState;
  approvalState: TrainingPlanRevisionApprovalState;
  decisionId: string | null;
  creationContextVersion: string;
  contentHash: string;
  policyVersion: string;
  catalog: {
    version: string;
    sourceHash: string;
  };
  capabilityRegistryVersion: string;
  documentSchemaVersion: string;
  document: TrainingPlanRevisionDocument | Record<string, unknown>;
  qualityReport: {
    status: 'PASS' | 'LEGACY_COMPATIBILITY';
    checks: Array<{ code: string; status: 'PASS' | 'WARNING'; evidence: string }>;
    warnings?: string[];
  };
  causalFactors: TrainingPlanCausalFactor[];
  createdAt: string;
  reviewRequestedAt: string | null;
  activatedAt: string | null;
}

export interface TrainingPlanCandidateSetResource {
  candidateSetId: string;
  profileSnapshotId: string;
  candidates: TrainingPlanRevisionResource[];
  comparison: {
    kind: 'SINGLE_CANDIDATE';
    causalFactors: TrainingPlanCausalFactor[];
  };
}

export interface TrainingPlanRevisionDifference {
  path: string;
  before: unknown;
  after: unknown;
}

export interface TrainingPlanEditPreviewResource {
  currentRevision: TrainingPlanRevisionResource;
  proposedRevision: TrainingPlanRevisionResource;
  differences: TrainingPlanRevisionDifference[];
  rationale: string;
  approvalRequired: true;
}

export interface TrainingActivePlanReferenceResource {
  familyId: string;
  activeRevisionId: string;
  projectionPlanId: number | null;
  pointerVersion: number;
  updatedAt: string;
}

export interface TrainingProfileSnapshotResource {
  snapshotId: string;
  contentHash: string;
  keyVersion: string;
  body: ReturnType<typeof decryptTrainingProfileSnapshot>;
}

interface RevisionRow {
  revision_id: string;
  family_id: string;
  revision_sequence: number;
  parent_revision_id: string | null;
  profile_snapshot_id: string;
  origin: 'GENERATED' | 'LEGACY_BACKFILL';
  lifecycle_state: TrainingPlanRevisionLifecycleState;
  approval_state: TrainingPlanRevisionApprovalState;
  decision_id: string | null;
  creation_context_version: string;
  content_hash: string;
  policy_version: string;
  catalog_version: string;
  catalog_source_hash: string;
  capability_registry_version: string;
  document_schema_version: string;
  revision_document_json: string;
  quality_report_json: string;
  created_at: string;
  review_requested_at: string | null;
  activated_at: string | null;
}

export interface TrainingRevisionAuthoritativeContextVersions {
  schemaVersion: 'training-revision-authoritative-context.v1';
  profileSourceVersion: string;
  calendarSourceVersion: string;
  conflictSourceVersion: string;
}

type AuthoritativeBuiltCandidate = BuiltTrainingPlanRevisionCandidate & {
  baseCreationContextVersion: string;
  authoritativeContext: TrainingRevisionAuthoritativeContextVersions;
};

export function createTrainingPlanCandidateRevision(input: {
  scope: TrainingPlanRevisionScope;
  idempotencyKey: string;
  request: TrainingPlanCandidateRequest;
  env?: NodeJS.ProcessEnv;
}): TrainingPlanCandidateSetResource {
  requireActiveMode(input.scope, input.env);
  requireIdempotencyKey(input.idempotencyKey);
  const requestHash = stableTrainingRevisionHash({ operation: 'CREATE_CANDIDATE', request: input.request });
  const db = getDb();
  requireRevisionSchema(db);
  const operation = findOperation(db, input.scope, 'CREATE_CANDIDATE', input.idempotencyKey);
  if (operation) return replayOperation<TrainingPlanCandidateSetResource>(operation, requestHash);
  requireNoActivePlanForCandidate(db, input.scope);
  const built = bindCandidateToAuthoritativeContext(
    db,
    input.scope,
    buildTrainingPlanRevisionCandidate(input.request, { env: input.env, scope: input.scope }),
  );

  return db.transaction(() => {
    const operationId = `trpop_${randomUUID()}`;
    insertOperation(db, {
      operationId,
      scope: input.scope,
      operationType: 'CREATE_CANDIDATE',
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    const persisted = persistBuiltCandidate(db, {
      scope: input.scope,
      request: input.request,
      built,
      operationId,
      parentRevisionId: null,
      existingFamilyId: null,
      env: input.env,
    });
    const response: TrainingPlanCandidateSetResource = {
      candidateSetId: operationId,
      profileSnapshotId: persisted.profileSnapshotId,
      candidates: [persisted.revision],
      comparison: { kind: 'SINGLE_CANDIDATE', causalFactors: built.causalFactors },
    };
    completeOperation(db, operationId, persisted.revision, response);
    return response;
  })();
}

export function computeTrainingPlanRevisionShadow(
  request: TrainingPlanCandidateRequest,
  options: { env?: NodeJS.ProcessEnv; scope?: RuntimeFlagScope } = {},
): BuiltTrainingPlanRevisionCandidate {
  return buildTrainingPlanRevisionCandidate(request, options);
}

export function computeTrainingRevisionAuthoritativeContext(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
): TrainingRevisionAuthoritativeContextVersions {
  const profileRows = tableExists(db, 'user_profiles')
    ? db.prepare(`
        SELECT profile_type, data, created_at, updated_at
          FROM user_profiles WHERE user_id = ?
         ORDER BY profile_type, id
      `).all(scope.userId)
    : [];
  const agendaRows = tableExists(db, 'secretary_agenda_items')
    ? db.prepare(`
        SELECT agenda_item_id, source_skill, source_entity_id, source_entity_type,
               lifecycle_state, provider_sync_state, provider_event_id,
               provider_source, version, start_at, end_at, duration_minutes,
               source_shape_hash, scheduled_segments_json, updated_at
          FROM secretary_agenda_items
         WHERE owner_user_id = ? AND tenant_id = ?
           AND lifecycle_state NOT IN ('canceled', 'superseded', 'completed')
         ORDER BY agenda_item_id, version
      `).all(scope.userId, String(scope.tenantId))
    : [];
  const ownershipRows = tableExists(db, 'training_agenda_event_ownership')
    ? db.prepare(`
        SELECT plan_id, plan_version, session_id, calendar_event_id,
               calendar_source, calendar_id, status, last_verified_at,
               sync_version
          FROM training_agenda_event_ownership
         WHERE user_id = ? AND tenant_id = ?
         ORDER BY plan_id, plan_version, id
      `).all(scope.userId, scope.tenantId)
    : [];
  const conflictRows = tableExists(db, 'notification_center_items')
      && tableExists(db, 'notification_intents')
    ? db.prepare(`
        SELECT items.item_id, items.decision_state, items.expires_at,
               intents.source_skill, intents.related_entity_id,
               intents.related_entity_type, intents.normalized_action_json
          FROM notification_center_items items
          JOIN notification_intents intents ON intents.intent_id = items.intent_id
         WHERE items.user_id = ? AND items.tenant_id = ?
           AND items.status IN ('unread', 'read', 'failed', 'snoozed')
           AND (items.expires_at IS NULL OR datetime(items.expires_at) > datetime('now'))
           AND NOT (
             intents.source_skill = 'training'
             AND intents.related_entity_type = 'training_plan_revision'
           )
         ORDER BY items.item_id
      `).all(scope.userId, scope.tenantId)
    : [];
  return {
    schemaVersion: 'training-revision-authoritative-context.v1',
    profileSourceVersion: `profile_${stableTrainingRevisionHash(profileRows)}`,
    calendarSourceVersion: `calendar_${stableTrainingRevisionHash({ agendaRows, ownershipRows })}`,
    conflictSourceVersion: `conflict_${stableTrainingRevisionHash(conflictRows)}`,
  };
}

export function deriveTrainingRevisionCreationContextVersion(
  baseCreationContextVersion: string,
  authoritativeContext: TrainingRevisionAuthoritativeContextVersions,
): string {
  return `ctx_${stableTrainingRevisionHash({
    baseCreationContextVersion,
    authoritativeContext,
  }).slice(0, 32)}`;
}

function bindCandidateToAuthoritativeContext(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  built: BuiltTrainingPlanRevisionCandidate,
): AuthoritativeBuiltCandidate {
  const authoritativeContext = computeTrainingRevisionAuthoritativeContext(db, scope);
  return {
    ...built,
    baseCreationContextVersion: built.creationContextVersion,
    authoritativeContext,
    creationContextVersion: deriveTrainingRevisionCreationContextVersion(
      built.creationContextVersion,
      authoritativeContext,
    ),
  };
}

export function getScopedTrainingPlanRevision(
  scope: TrainingPlanRevisionScope,
  revisionId: string,
  db: Database.Database = getDb(),
): TrainingPlanRevisionResource | null {
  const row = db.prepare(`
    SELECT * FROM training_plan_revisions
     WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
  `).get(revisionId, scope.userId, scope.tenantId) as RevisionRow | undefined;
  return row ? mapRevisionRow(row) : null;
}

export function getActiveTrainingPlanReference(
  scope: TrainingPlanRevisionScope,
  familyId?: string | null,
  db: Database.Database = getDb(),
): TrainingActivePlanReferenceResource | null {
  const row = familyId
    ? db.prepare(`
        SELECT family_id, active_revision_id, projection_plan_id, pointer_version, updated_at
          FROM training_active_plan_references
         WHERE tenant_id = ? AND user_id = ? AND family_id = ?
      `).get(scope.tenantId, scope.userId, familyId)
    : db.prepare(`
        SELECT family_id, active_revision_id, projection_plan_id, pointer_version, updated_at
          FROM training_active_plan_references
         WHERE tenant_id = ? AND user_id = ?
         ORDER BY updated_at DESC, family_id ASC LIMIT 1
      `).get(scope.tenantId, scope.userId);
  if (!row) return null;
  const typed = row as {
    family_id: string;
    active_revision_id: string;
    projection_plan_id: number | null;
    pointer_version: number;
    updated_at: string;
  };
  return {
    familyId: typed.family_id,
    activeRevisionId: typed.active_revision_id,
    projectionPlanId: typed.projection_plan_id,
    pointerVersion: typed.pointer_version,
    updatedAt: typed.updated_at,
  };
}

export function getScopedTrainingProfileSnapshot(
  scope: TrainingPlanRevisionScope,
  snapshotId: string,
  env?: NodeJS.ProcessEnv,
  db: Database.Database = getDb(),
): TrainingProfileSnapshotResource | null {
  const row = db.prepare(`
    SELECT snapshot_id, content_hash, encrypted_snapshot_body, snapshot_body_key_version
      FROM training_profile_snapshots
     WHERE snapshot_id = ? AND tenant_id = ? AND user_id = ?
  `).get(snapshotId, scope.tenantId, scope.userId) as {
    snapshot_id: string;
    content_hash: string;
    encrypted_snapshot_body: string;
    snapshot_body_key_version: string;
  } | undefined;
  if (!row) return null;
  const body = decryptTrainingProfileSnapshot({
    encryptedBody: row.encrypted_snapshot_body,
    keyVersion: row.snapshot_body_key_version,
    userId: scope.userId,
    env,
  });
  const currentHash = stableTrainingRevisionHash({
    request: body.request,
    catalogVersion: body.catalogVersion,
    catalogSourceHash: body.catalogSourceHash,
    policyVersion: body.policyVersion,
    authoritativeContext: body.authoritativeSourceVersions,
  });
  if (body.profileKind === 'generated' && currentHash !== row.content_hash) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PROFILE_SNAPSHOT_HASH_MISMATCH',
      'The training profile snapshot failed integrity validation.',
      409,
    );
  }
  return {
    snapshotId: row.snapshot_id,
    contentHash: row.content_hash,
    keyVersion: row.snapshot_body_key_version,
    body,
  };
}

export function editTrainingPlanRevisionPreview(input: {
  scope: TrainingPlanRevisionScope;
  revisionId: string;
  expectedContentHash: string;
  idempotencyKey: string;
  edits: Partial<TrainingPlanCandidateRequest['profile']> & { horizonWeeks?: number };
  rationale: string;
  env?: NodeJS.ProcessEnv;
}): TrainingPlanEditPreviewResource {
  requireActiveMode(input.scope, input.env);
  requireIdempotencyKey(input.idempotencyKey);
  if (!input.expectedContentHash?.trim()) {
    throw new TrainingPlanRevisionError(
      'TRAINING_EXPECTED_CONTENT_HASH_REQUIRED',
      'An expected content hash is required.',
      428,
    );
  }
  const db = getDb();
  requireRevisionSchema(db);
  const current = getScopedTrainingPlanRevision(input.scope, input.revisionId, db);
  if (!current) throw new TrainingPlanRevisionError('TRAINING_REVISION_NOT_FOUND', 'Training plan revision not found.', 404);
  if (current.contentHash !== input.expectedContentHash) {
    throw new TrainingPlanRevisionError('TRAINING_REVISION_CONTENT_CONFLICT', 'The revision changed; refresh before editing.', 409);
  }
  const requestHash = stableTrainingRevisionHash({
    operation: 'EDIT_PREVIEW',
    revisionId: input.revisionId,
    expectedContentHash: input.expectedContentHash,
    edits: input.edits,
    rationale: input.rationale,
  });
  const operation = findOperation(db, input.scope, 'EDIT_PREVIEW', input.idempotencyKey);
  // Replay is evaluated before lifecycle validation because a successful edit
  // intentionally supersedes its parent. The immutable scoped parent and
  // expected content hash were still verified above.
  if (operation) return replayOperation<TrainingPlanEditPreviewResource>(operation, requestHash);
  if (current.origin !== 'GENERATED' || current.documentSchemaVersion !== 'training-plan-revision.v1') {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_REVISION_EDIT_NOT_IN_M1', 'Legacy active revisions are read-only in Milestone 1.', 409);
  }
  if (!['CANDIDATE', 'PENDING_REVIEW'].includes(current.lifecycleState)
      || !['UNREVIEWED', 'PENDING'].includes(current.approvalState)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_EDIT_STATE_INVALID',
      'Only the current unapproved candidate can be edited.',
      409,
    );
  }
  const snapshot = db.prepare(`
    SELECT encrypted_snapshot_body, snapshot_body_key_version
      FROM training_profile_snapshots
     WHERE snapshot_id = ? AND tenant_id = ? AND user_id = ?
  `).get(current.profileSnapshotId, input.scope.tenantId, input.scope.userId) as {
    encrypted_snapshot_body: string;
    snapshot_body_key_version: string;
  } | undefined;
  if (!snapshot) throw new TrainingPlanRevisionError('TRAINING_PROFILE_SNAPSHOT_NOT_FOUND', 'Profile snapshot not found.', 409);
  const stored = decryptTrainingProfileSnapshot({
    encryptedBody: snapshot.encrypted_snapshot_body,
    keyVersion: snapshot.snapshot_body_key_version,
    userId: input.scope.userId,
    env: input.env,
  });
  if (stored.profileKind !== 'generated' || !stored.request) {
    throw new TrainingPlanRevisionError('TRAINING_PROFILE_SNAPSHOT_INVALID', 'Profile snapshot is invalid.', 409);
  }
  const nextRequest: TrainingPlanCandidateRequest = {
    ...stored.request,
    horizonWeeks: input.edits.horizonWeeks ?? stored.request.horizonWeeks,
    profile: {
      ...stored.request.profile,
      ...withoutUndefined(input.edits),
    },
  };
  delete (nextRequest.profile as Record<string, unknown>).horizonWeeks;
  const built = bindCandidateToAuthoritativeContext(
    db,
    input.scope,
    buildTrainingPlanRevisionCandidate(nextRequest, { env: input.env, scope: input.scope }),
  );

  return db.transaction(() => {
    const operationId = `trpop_${randomUUID()}`;
    insertOperation(db, {
      operationId,
      scope: input.scope,
      operationType: 'EDIT_PREVIEW',
      idempotencyKey: input.idempotencyKey,
      requestHash,
    });
    const persisted = persistBuiltCandidate(db, {
      scope: input.scope,
      request: nextRequest,
      built,
      operationId,
      parentRevisionId: current.revisionId,
      existingFamilyId: current.familyId,
      env: input.env,
    });
    const response: TrainingPlanEditPreviewResource = {
      currentRevision: current,
      proposedRevision: persisted.revision,
      differences: diffRevisionDocuments(
        current.document as TrainingPlanRevisionDocument,
        persisted.revision.document as TrainingPlanRevisionDocument,
      ),
      rationale: input.rationale.trim() || 'Profile inputs were edited.',
      approvalRequired: true,
    };
    completeOperation(db, operationId, persisted.revision, response);
    return response;
  })();
}

export function supersedeTrainingPlanRevisionForBoundChild(input: {
  scope: TrainingPlanRevisionScope;
  parentRevisionId: string;
  childRevisionId: string;
  expectedParentContentHash: string;
  db?: Database.Database;
}): void {
  const db = input.db ?? getDb();
  const child = getScopedTrainingPlanRevision(input.scope, input.childRevisionId, db);
  const parent = getScopedTrainingPlanRevision(input.scope, input.parentRevisionId, db);
  if (!child || !parent
      || child.parentRevisionId !== parent.revisionId
      || child.familyId !== parent.familyId
      || child.lifecycleState !== 'PENDING_REVIEW'
      || child.approvalState !== 'PENDING'
      || !child.decisionId) {
    throw new TrainingPlanRevisionError(
      'TRAINING_EDIT_CHILD_REVIEW_BINDING_INVALID',
      'The edited child revision is not safely bound for review.',
      409,
    );
  }
  if (parent.contentHash !== input.expectedParentContentHash) {
    throw new TrainingPlanRevisionError(
      'TRAINING_REVISION_CONTENT_CONFLICT',
      'The parent revision changed before the edit could replace its review.',
      409,
    );
  }
  if (parent.lifecycleState === 'SUPERSEDED' && parent.approvalState === 'EXPIRED') return;
  const updated = db.prepare(`
    UPDATE training_plan_revisions
       SET lifecycle_state = 'SUPERSEDED', approval_state = 'EXPIRED',
           superseded_at = datetime('now')
     WHERE revision_id = ? AND user_id = ? AND tenant_id = ?
       AND content_hash = ?
       AND lifecycle_state IN ('CANDIDATE', 'PENDING_REVIEW')
       AND approval_state IN ('UNREVIEWED', 'PENDING')
  `).run(
    parent.revisionId,
    input.scope.userId,
    input.scope.tenantId,
    input.expectedParentContentHash,
  );
  if (updated.changes !== 1) {
    throw new TrainingPlanRevisionError(
      'TRAINING_EDIT_PARENT_SUPERSESSION_CONFLICT',
      'The parent revision review state changed before supersession.',
      409,
    );
  }
}

function persistBuiltCandidate(db: Database.Database, input: {
  scope: TrainingPlanRevisionScope;
  request: TrainingPlanCandidateRequest;
  built: AuthoritativeBuiltCandidate;
  operationId: string;
  parentRevisionId: string | null;
  existingFamilyId: string | null;
  env?: NodeJS.ProcessEnv;
}): { profileSnapshotId: string; revision: TrainingPlanRevisionResource } {
  const familyId = input.existingFamilyId ?? findOrCreatePlanFamily(db, input.scope, input.request);
  const existing = db.prepare(`
    SELECT * FROM training_plan_revisions
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
       AND content_hash = ? AND creation_context_version = ?
     ORDER BY revision_sequence DESC
     LIMIT 1
  `).get(
    input.scope.tenantId,
    input.scope.userId,
    familyId,
    input.built.contentHash,
    input.built.creationContextVersion,
  ) as RevisionRow | undefined;
  if (existing) {
    const existingResource = mapRevisionRow(existing);
    if (existingResource.lifecycleState === 'SUPERSEDED'
        || existingResource.approvalState === 'REJECTED'
        || (existingResource.lifecycleState === 'EXPIRED'
          && existingResource.approvalState !== 'EXPIRED')) {
      throw new TrainingPlanRevisionError(
        'TRAINING_UNCHANGED_CANDIDATE_SUPPRESSED',
        'This unchanged candidate was already rejected or superseded; change the profile inputs before regenerating.',
        409,
      );
    }
    if (existingResource.lifecycleState !== 'EXPIRED') {
      setCurrentPlanContext(db, input.scope, existingResource, input.built);
      return { profileSnapshotId: existing.profile_snapshot_id, revision: existingResource };
    }
  }
  const profileSnapshotId = findOrCreateProfileSnapshot(db, input.scope, input.request, input.built, input.env);

  const revisionId = `trpr_${randomUUID()}`;
  const sequence = ((db.prepare(`
    SELECT COALESCE(MAX(revision_sequence), 0) AS sequence
      FROM training_plan_revisions
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
  `).get(input.scope.tenantId, input.scope.userId, familyId) as { sequence: number }).sequence ?? 0) + 1;
  const qualityPayload = {
    qualityReport: input.built.qualityReport,
    causalFactors: input.built.causalFactors,
  };
  db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      parent_revision_id, profile_snapshot_id, origin, lifecycle_state,
      approval_state, creation_context_version, policy_version, catalog_version,
      catalog_source_hash, capability_registry_version, document_schema_version,
      revision_document_json, content_hash, quality_report_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GENERATED', 'CANDIDATE', 'UNREVIEWED', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    revisionId,
    input.scope.tenantId,
    input.scope.userId,
    familyId,
    sequence,
    input.parentRevisionId,
    profileSnapshotId,
    input.built.creationContextVersion,
    input.built.policyVersion,
    input.built.catalogVersion,
    input.built.catalogSourceHash,
    input.built.capabilityRegistryVersion,
    input.built.document.schemaVersion,
    JSON.stringify(input.built.document),
    input.built.contentHash,
    JSON.stringify(qualityPayload),
  );
  const persisted = {
    profileSnapshotId,
    revision: getScopedTrainingPlanRevision(input.scope, revisionId, db)!,
  };
  setCurrentPlanContext(db, input.scope, persisted.revision, input.built);
  return persisted;
}

function setCurrentPlanContext(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  revision: TrainingPlanRevisionResource,
  built: AuthoritativeBuiltCandidate,
): void {
  db.prepare(`
    INSERT INTO training_plan_current_contexts (
      tenant_id, user_id, family_id, current_revision_id,
      current_profile_snapshot_id, current_context_version,
      base_context_version, profile_source_version, calendar_source_version,
      conflict_source_version, pointer_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    ON CONFLICT(tenant_id, user_id, family_id) DO UPDATE SET
      current_revision_id = excluded.current_revision_id,
      current_profile_snapshot_id = excluded.current_profile_snapshot_id,
      current_context_version = excluded.current_context_version,
      base_context_version = excluded.base_context_version,
      profile_source_version = excluded.profile_source_version,
      calendar_source_version = excluded.calendar_source_version,
      conflict_source_version = excluded.conflict_source_version,
      pointer_version = training_plan_current_contexts.pointer_version + 1,
      updated_at = datetime('now')
    WHERE training_plan_current_contexts.current_revision_id IS NOT excluded.current_revision_id
       OR training_plan_current_contexts.current_profile_snapshot_id IS NOT excluded.current_profile_snapshot_id
       OR training_plan_current_contexts.current_context_version IS NOT excluded.current_context_version
  `).run(
    scope.tenantId,
    scope.userId,
    revision.familyId,
    revision.revisionId,
    revision.profileSnapshotId,
    revision.creationContextVersion,
    built.baseCreationContextVersion,
    built.authoritativeContext.profileSourceVersion,
    built.authoritativeContext.calendarSourceVersion,
    built.authoritativeContext.conflictSourceVersion,
  );
}

function findOrCreateProfileSnapshot(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  request: TrainingPlanCandidateRequest,
  built: AuthoritativeBuiltCandidate,
  env?: NodeJS.ProcessEnv,
): string {
  const content = {
    request,
    catalogVersion: built.catalogVersion,
    catalogSourceHash: built.catalogSourceHash,
    policyVersion: built.policyVersion,
    authoritativeContext: built.authoritativeContext,
  };
  const contentHash = stableTrainingRevisionHash(content);
  const existing = db.prepare(`
    SELECT snapshot_id FROM training_profile_snapshots
     WHERE tenant_id = ? AND user_id = ? AND content_hash = ?
  `).get(scope.tenantId, scope.userId, contentHash) as { snapshot_id: string } | undefined;
  if (existing) return existing.snapshot_id;
  const sequence = ((db.prepare(`
    SELECT COALESCE(MAX(snapshot_sequence), 0) AS sequence
      FROM training_profile_snapshots WHERE tenant_id = ? AND user_id = ?
  `).get(scope.tenantId, scope.userId) as { sequence: number }).sequence ?? 0) + 1;
  const snapshotId = `trps_${randomUUID()}`;
  const now = new Date().toISOString();
  const encrypted = encryptTrainingProfileSnapshot({
    body: {
      profileKind: 'generated',
      request,
      catalogVersion: built.catalogVersion,
      catalogSourceHash: built.catalogSourceHash,
      policyVersion: built.policyVersion,
      authoritativeSourceVersions: built.authoritativeContext,
      consentContext: { optionalPermissionsUsed: [] },
      missingInputs: built.document.missingInputs,
    },
    userId: scope.userId,
    env,
  });
  const displayFactorIndex = built.causalFactors.map((factor) => ({
    inputKey: factor.inputKey,
    state: factor.inputValue == null || (Array.isArray(factor.inputValue) && factor.inputValue.length === 0)
      ? 'missing'
      : 'provided',
    materialEffects: factor.materialEffects,
  }));
  db.prepare(`
    INSERT INTO training_profile_snapshots (
      snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
      content_hash, encrypted_snapshot_body, snapshot_body_key_version,
      display_factor_index_json, normalized_goals_json, normalized_constraints_json,
      factor_evidence_json, source_versions_json, consent_context_json,
      missing_inputs_json, observed_at, captured_at
    ) VALUES (?, ?, ?, ?, 'training-profile-snapshot.v1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshotId,
    scope.tenantId,
    scope.userId,
    sequence,
    contentHash,
    encrypted.encryptedBody,
    encrypted.keyVersion,
    JSON.stringify(displayFactorIndex),
    JSON.stringify({ goal: request.goal, planMode: request.planMode, discipline: request.discipline }),
    JSON.stringify({
      experienceState: 'provided',
      scheduleState: 'provided',
      availabilityState: request.profile.availableDays.length > 0 ? 'provided' : 'missing',
      equipmentState: request.profile.equipmentIds.length > 0 ? 'provided' : 'none',
      locationState: 'provided',
      preferenceState: (request.profile.preferences?.length ?? 0) > 0 ? 'provided' : 'none',
      exclusionState: (request.profile.exclusions?.length ?? 0) > 0 ? 'provided' : 'none',
    }),
    JSON.stringify(displayFactorIndex),
    JSON.stringify({
      catalogVersion: built.catalogVersion,
      catalogSourceHash: built.catalogSourceHash,
      policyVersion: built.policyVersion,
      authoritativeContext: built.authoritativeContext,
    }),
    JSON.stringify({ optionalPermissionsUsed: [] }),
    JSON.stringify(built.document.missingInputs),
    now,
    now,
  );
  return snapshotId;
}

function findOrCreatePlanFamily(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  request: TrainingPlanCandidateRequest,
): string {
  const familyKey = `${request.planMode}:${request.goal}`;
  const existing = db.prepare(`
    SELECT family_id FROM training_plan_families
     WHERE tenant_id = ? AND user_id = ? AND family_key = ?
  `).get(scope.tenantId, scope.userId, familyKey) as { family_id: string } | undefined;
  if (existing) return existing.family_id;
  const familyId = `trpf_${randomUUID()}`;
  db.prepare(`
    INSERT INTO training_plan_families (
      family_id, tenant_id, user_id, family_key, plan_mode, discipline, origin
    ) VALUES (?, ?, ?, ?, ?, ?, 'GENERATED')
  `).run(familyId, scope.tenantId, scope.userId, familyKey, request.planMode, request.discipline);
  return familyId;
}

function mapRevisionRow(row: RevisionRow): TrainingPlanRevisionResource {
  const qualityPayload = parseJson<{
    qualityReport: TrainingPlanRevisionResource['qualityReport'];
    causalFactors: TrainingPlanCausalFactor[];
  }>(row.quality_report_json, {
    qualityReport: { status: 'PASS', checks: [] },
    causalFactors: [],
  });
  return {
    revisionId: row.revision_id,
    familyId: row.family_id,
    revisionSequence: row.revision_sequence,
    parentRevisionId: row.parent_revision_id,
    profileSnapshotId: row.profile_snapshot_id,
    origin: row.origin,
    lifecycleState: row.lifecycle_state,
    approvalState: row.approval_state,
    decisionId: row.decision_id,
    creationContextVersion: row.creation_context_version,
    contentHash: row.content_hash,
    policyVersion: row.policy_version,
    catalog: { version: row.catalog_version, sourceHash: row.catalog_source_hash },
    capabilityRegistryVersion: row.capability_registry_version,
    documentSchemaVersion: row.document_schema_version,
    document: parseJson<TrainingPlanRevisionDocument | Record<string, unknown>>(row.revision_document_json, {}),
    qualityReport: qualityPayload.qualityReport,
    causalFactors: qualityPayload.causalFactors,
    createdAt: row.created_at,
    reviewRequestedAt: row.review_requested_at,
    activatedAt: row.activated_at,
  };
}

function requireActiveMode(scope: RuntimeFlagScope, env: NodeJS.ProcessEnv | undefined): void {
  const mode = getTrainingPlanRevisionV1Mode(env ?? process.env, scope);
  if (mode !== 'active') {
    throw new TrainingPlanRevisionError(
      'TRAINING_PLAN_REVISION_V1_NOT_ACTIVE',
      'Training plan revision writes are unavailable.',
      404,
    );
  }
  if (!isTrainingPlanRevisionV1ExplicitlyEnrolled(env ?? process.env, scope)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PLAN_REVISION_V1_NOT_ENROLLED',
      'Training plan revisions are unavailable for this account.',
      404,
    );
  }
  if (!isDecisionFlowV1EnforceEnabled(env ?? process.env, scope)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PLAN_REVISION_DECISION_FLOW_REQUIRED',
      'Training plan revisions require Decision Flow v1 enforcement.',
      409,
    );
  }
  requirePersonalTrainingRevisionScope(scope);
}

export function requirePersonalTrainingRevisionScope(scope: RuntimeFlagScope): void {
  if (scope.userId !== scope.tenantId) {
    throw new TrainingPlanRevisionError(
      'TRAINING_PLAN_REVISION_PERSONAL_SCOPE_REQUIRED',
      'Training plan revisions are limited to personal accounts in Milestone 1.',
      404,
    );
  }
}

function requireIdempotencyKey(value: string): void {
  if (!value?.trim() || value.length > 200) {
    throw new TrainingPlanRevisionError('TRAINING_IDEMPOTENCY_KEY_REQUIRED', 'A valid Idempotency-Key is required.', 428);
  }
}

function requireRevisionSchema(db: Database.Database): void {
  const row = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'training_plan_revisions'
  `).get();
  if (!row) throw new TrainingPlanRevisionError('TRAINING_PLAN_REVISION_SCHEMA_UNAVAILABLE', 'Training plan revision schema is unavailable.', 503);
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name);
}

function requireNoActivePlanForCandidate(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
): void {
  const row = db.prepare(`
    SELECT id FROM fitness_training_plans
     WHERE user_id = ? AND tenant_id = ? AND status = 'active'
     LIMIT 1
  `).get(scope.userId, scope.tenantId);
  if (row) {
    throw new TrainingPlanRevisionError(
      'TRAINING_ACTIVE_PLAN_REPLACEMENT_NOT_IN_M1',
      'Milestone 1 cannot generate a replacement while an active plan exists.',
      409,
    );
  }
}

function findOperation(
  db: Database.Database,
  scope: TrainingPlanRevisionScope,
  operationType: string,
  idempotencyKey: string,
): { request_hash: string; response_json: string | null; status: string } | undefined {
  return db.prepare(`
    SELECT request_hash, response_json, status
      FROM training_plan_revision_operations
     WHERE tenant_id = ? AND user_id = ? AND operation_type = ? AND idempotency_key = ?
  `).get(scope.tenantId, scope.userId, operationType, idempotencyKey) as any;
}

function replayOperation<T>(
  operation: { request_hash: string; response_json: string | null; status: string },
  requestHash: string,
): T {
  if (operation.request_hash !== requestHash) {
    throw new TrainingPlanRevisionError('TRAINING_IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used for different content.', 409);
  }
  if (operation.status !== 'SUCCEEDED' || !operation.response_json) {
    throw new TrainingPlanRevisionError('TRAINING_OPERATION_IN_PROGRESS', 'The prior operation has not completed; retry shortly.', 409);
  }
  return parseJson<T | null>(operation.response_json, null)!;
}

function insertOperation(db: Database.Database, input: {
  operationId: string;
  scope: TrainingPlanRevisionScope;
  operationType: string;
  idempotencyKey: string;
  requestHash: string;
}): void {
  db.prepare(`
    INSERT INTO training_plan_revision_operations (
      operation_id, tenant_id, user_id, operation_type, idempotency_key,
      request_hash, status, lease_owner, lease_expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'IN_PROGRESS', ?, datetime('now', '+2 minutes'))
  `).run(
    input.operationId,
    input.scope.tenantId,
    input.scope.userId,
    input.operationType,
    input.idempotencyKey,
    input.requestHash,
    input.operationId,
  );
}

function completeOperation(
  db: Database.Database,
  operationId: string,
  revision: TrainingPlanRevisionResource,
  response: unknown,
): void {
  db.prepare(`
    UPDATE training_plan_revision_operations
       SET status = 'SUCCEEDED', result_family_id = ?, result_revision_id = ?,
           response_json = ?, lease_owner = NULL, lease_expires_at = NULL,
           updated_at = datetime('now'), completed_at = datetime('now')
     WHERE operation_id = ?
  `).run(revision.familyId, revision.revisionId, JSON.stringify(response), operationId);
}

function diffRevisionDocuments(
  before: TrainingPlanRevisionDocument,
  after: TrainingPlanRevisionDocument,
): TrainingPlanRevisionDifference[] {
  const differences: TrainingPlanRevisionDifference[] = [];
  compare('weeklyStructure.targetSessionsPerWeek', before.weeklyStructure.targetSessionsPerWeek, after.weeklyStructure.targetSessionsPerWeek, differences);
  compare('weeklyStructure.sessionDurationMinutes', before.weeklyStructure.sessionDurationMinutes, after.weeklyStructure.sessionDurationMinutes, differences);
  compare('weeklyStructure.availableDays', before.weeklyStructure.availableDays, after.weeklyStructure.availableDays, differences);
  compare('weeklyStructure.targetWorkoutTypeDistribution', before.weeklyStructure.targetWorkoutTypeDistribution, after.weeklyStructure.targetWorkoutTypeDistribution, differences);
  compare('progression', before.progression, after.progression, differences);
  compare('recovery', before.recovery, after.recovery, differences);
  compare('phases', before.phases, after.phases, differences);
  compare('weeks', before.weeks, after.weeks, differences);
  return differences;
}

function compare(path: string, before: unknown, after: unknown, output: TrainingPlanRevisionDifference[]): void {
  if (stableTrainingRevisionHash(before) !== stableTrainingRevisionHash(after)) output.push({ path, before, after });
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function withoutUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
