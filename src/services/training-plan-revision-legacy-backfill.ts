// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { stableTrainingRevisionHash } from './training-plan-revision-candidate-builder';
import { encryptTrainingProfileSnapshot } from './training-profile-snapshot-encryption';
import { TrainingPlanRevisionError, type TrainingPlanRevisionScope } from './training-plan-revisions';
import { incrementTrainingGenerationCounter } from './training-generation-observability';

export type LegacyActivePlanBackfillMode = 'dry_run' | 'apply';

export interface LegacyActivePlanBackfillPlanResult {
  planId: number;
  familyId: string;
  profileSnapshotId: string;
  revisionId: string;
  sourceHash: string;
  contentHash: string;
  status: 'WOULD_APPLY' | 'APPLIED' | 'ALREADY_APPLIED';
}

export interface LegacyActivePlanBackfillResult {
  mode: LegacyActivePlanBackfillMode;
  digest: string;
  total: number;
  wouldApply: number;
  applied: number;
  alreadyApplied: number;
  plans: LegacyActivePlanBackfillPlanResult[];
}

export function runLegacyActivePlanBackfill(input: {
  mode: LegacyActivePlanBackfillMode;
  scope?: TrainingPlanRevisionScope;
  planId?: number;
  db?: Database.Database;
  env?: NodeJS.ProcessEnv;
  expectedDigest?: string;
}): LegacyActivePlanBackfillResult {
  const db = input.db ?? getDb();
  const plans = loadLegacyActivePlans(db, input.scope, input.planId);
  const prepared = plans
    .map((plan) => prepareLegacyPlan(db, plan))
    .map((entry) => canonicalizeExistingBackfill(db, entry));
  if (input.mode === 'dry_run') {
    const results = prepared.map((entry) => ({
      ...entry.identities,
      status: existingBackfillStatus(db, entry) ? 'ALREADY_APPLIED' as const : 'WOULD_APPLY' as const,
    }));
    return summarize('dry_run', results);
  }
  if (input.mode !== 'apply') {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_MODE_INVALID', 'Legacy backfill mode is invalid.', 400);
  }
  const preparedDigest = backfillDigest(prepared.map((entry) => entry.identities));
  if (!input.expectedDigest || !/^[a-f0-9]{64}$/.test(input.expectedDigest)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_BACKFILL_EXPECTED_DIGEST_REQUIRED',
      'Apply requires the exact 64-character digest from a prior dry run.',
      428,
    );
  }
  if (input.expectedDigest !== preparedDigest) {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_BACKFILL_DRY_RUN_DRIFT',
      'Legacy source changed after the dry-run rehearsal.',
      409,
    );
  }
  const results = db.transaction(() => {
    const activeCountBefore = countActivePlans(db, input.scope);
    const applied = prepared.map((entry) => applyPreparedLegacyPlan(db, entry, input.env));
    const activeCountAfter = countActivePlans(db, input.scope);
    if (activeCountAfter !== activeCountBefore) {
      throw new TrainingPlanRevisionError(
        'TRAINING_LEGACY_BACKFILL_ACTIVE_COUNT_CHANGED',
        'Legacy backfill changed the active plan count.',
        500,
      );
    }
    return applied;
  })();
  const appliedCount = results.filter((entry) => entry.status === 'APPLIED').length;
  if (appliedCount > 0) incrementTrainingGenerationCounter('revision_legacy_backfill_applied_total', appliedCount);
  return summarize('apply', results);
}

function loadLegacyActivePlans(
  db: Database.Database,
  scope?: TrainingPlanRevisionScope,
  planId?: number,
): Array<Record<string, any>> {
  const clauses = [
    "status = 'active'",
    "(source_revision_id IS NULL OR source_revision_id LIKE 'trpr_legacy_%')",
  ];
  const params: Array<string | number> = [];
  if (scope) {
    clauses.push('user_id = ?', 'tenant_id = ?');
    params.push(scope.userId, scope.tenantId);
  }
  if (planId != null) {
    if (!Number.isSafeInteger(planId) || planId <= 0) {
      throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_PLAN_ID_INVALID', 'Plan ID is invalid.', 400);
    }
    clauses.push('id = ?');
    params.push(planId);
  }
  return db.prepare(`
    SELECT * FROM fitness_training_plans
     WHERE ${clauses.join(' AND ')}
     ORDER BY tenant_id, user_id, id
  `).all(...params) as Array<Record<string, any>>;
}

function prepareLegacyPlan(db: Database.Database, plan: Record<string, any>) {
  const scope = { userId: Number(plan.user_id), tenantId: Number(plan.tenant_id) };
  if (!Number.isSafeInteger(scope.userId) || scope.userId <= 0
      || !Number.isSafeInteger(scope.tenantId) || scope.tenantId <= 0) {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_SCOPE_INVALID', 'Legacy plan scope is invalid.', 409);
  }
  const weeks = db.prepare('SELECT * FROM training_weeks WHERE plan_id = ? ORDER BY week_number, id')
    .all(plan.id) as Array<Record<string, any>>;
  const sessions = db.prepare('SELECT * FROM training_sessions WHERE plan_id = ? ORDER BY week_id, id')
    .all(plan.id) as Array<Record<string, any>>;
  const completions = db.prepare('SELECT * FROM training_completions WHERE plan_id = ? ORDER BY completed_at, id')
    .all(plan.id) as Array<Record<string, any>>;
  const calendarOwnership = db.prepare(`
    SELECT * FROM training_agenda_event_ownership
     WHERE plan_id = ?
     ORDER BY plan_version, id
  `).all(plan.id) as Array<Record<string, any>>;
  const adaptations = db.prepare('SELECT * FROM training_plan_adaptations WHERE plan_id = ? ORDER BY id')
    .all(plan.id) as Array<Record<string, any>>;
  assertLegacyRelationships(plan, weeks, sessions, completions, calendarOwnership, adaptations);
  const source = {
    plan: stripLegacyRevisionMetadata(plan),
    weeks: weeks.map(stripLegacyRevisionMetadata),
    sessions: sessions.map(stripLegacyRevisionMetadata),
    completions,
    calendarOwnership,
    adaptations,
  };
  const sourceHash = stableTrainingRevisionHash(source);
  const identitySeed = {
    tenantId: scope.tenantId,
    userId: scope.userId,
    planId: plan.id,
    planVersion: Number(plan.plan_version ?? 1),
  };
  const identityHash = stableTrainingRevisionHash(identitySeed).slice(0, 32);
  const document = {
    schemaVersion: 'legacy-training-plan-revision.v1',
    sourcePlanId: plan.id,
    sourceHash,
    compatibilityTreatment: 'LEGACY_ACTIVE_READ_ONLY',
    plan: source.plan,
    weeks: source.weeks.map((week) => ({
      ...week,
      sessions: source.sessions.filter((session) => session.week_id === week.id),
    })),
    completionSummary: {
      count: completions.length,
      sourceHash: stableTrainingRevisionHash(completions),
    },
    calendarOwnershipSummary: {
      count: calendarOwnership.length,
      statusCounts: countByString(calendarOwnership, 'status'),
      sourceHash: stableTrainingRevisionHash(calendarOwnership),
    },
    adaptationSummary: {
      count: adaptations.length,
      maxAdaptationRevision: adaptations.reduce((max, row) => Math.max(max, Number(row.adaptation_revision ?? 0)), 0),
      sourceHash: stableTrainingRevisionHash(adaptations),
    },
  };
  const contentHash = stableTrainingRevisionHash(document);
  return {
    scope,
    source,
    completions,
    calendarOwnership,
    adaptations,
    plan,
    document,
    identities: {
      planId: Number(plan.id),
      familyId: `trpf_legacy_${identityHash}`,
      profileSnapshotId: `trps_legacy_${identityHash}`,
      revisionId: `trpr_legacy_${identityHash}`,
      sourceHash,
      contentHash,
    },
  };
}

function existingBackfillStatus(db: Database.Database, entry: ReturnType<typeof prepareLegacyPlan>): boolean {
  return !!db.prepare(`
    SELECT 1 FROM training_plan_revisions
     WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
       AND origin = 'LEGACY_BACKFILL'
  `).get(entry.identities.revisionId, entry.scope.tenantId, entry.scope.userId);
}

function canonicalizeExistingBackfill(
  db: Database.Database,
  entry: ReturnType<typeof prepareLegacyPlan>,
): ReturnType<typeof prepareLegacyPlan> {
  const storedRevisionId = typeof entry.plan.source_revision_id === 'string'
      && entry.plan.source_revision_id.startsWith('trpr_legacy_')
    ? entry.plan.source_revision_id
    : entry.identities.revisionId;
  const row = db.prepare(`
    SELECT revision_id, family_id, profile_snapshot_id,
           content_hash, catalog_source_hash, revision_document_json
      FROM training_plan_revisions
     WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
       AND origin = 'LEGACY_BACKFILL'
  `).get(storedRevisionId, entry.scope.tenantId, entry.scope.userId) as {
    revision_id: string;
    family_id: string;
    profile_snapshot_id: string;
    content_hash: string;
    catalog_source_hash: string;
    revision_document_json: string;
  } | undefined;
  if (!row) return entry;
  assertLegacyBaselineCompatible(entry, row.revision_document_json);
  return {
    ...entry,
    identities: {
      ...entry.identities,
      revisionId: row.revision_id,
      familyId: row.family_id,
      profileSnapshotId: row.profile_snapshot_id,
      sourceHash: row.catalog_source_hash,
      contentHash: row.content_hash,
    },
  };
}

function applyPreparedLegacyPlan(
  db: Database.Database,
  entry: ReturnType<typeof prepareLegacyPlan>,
  env?: NodeJS.ProcessEnv,
): LegacyActivePlanBackfillPlanResult {
  if (existingBackfillStatus(db, entry)) {
    const stored = db.prepare(`
      SELECT revision_document_json FROM training_plan_revisions
       WHERE revision_id = ? AND tenant_id = ? AND user_id = ?
    `).get(entry.identities.revisionId, entry.scope.tenantId, entry.scope.userId) as {
      revision_document_json: string;
    };
    assertLegacyBaselineCompatible(entry, stored.revision_document_json);
    return { ...entry.identities, status: 'ALREADY_APPLIED' };
  }
  const activePointer = db.prepare(`
    SELECT active_revision_id FROM training_active_plan_references
     WHERE tenant_id = ? AND user_id = ? AND family_id = ?
  `).get(entry.scope.tenantId, entry.scope.userId, entry.identities.familyId) as { active_revision_id: string } | undefined;
  if (activePointer && activePointer.active_revision_id !== entry.identities.revisionId) {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_POINTER_CONFLICT', 'Legacy active pointer already targets a different revision.', 409);
  }
  const observedAt = String(entry.plan.updated_at || entry.plan.created_at || new Date().toISOString());
  const snapshotContent = {
    profileKind: 'legacy' as const,
    request: null,
    legacySource: {
      planId: entry.identities.planId,
      planVersion: Number(entry.plan.plan_version ?? 1),
      adaptationRevision: Number(entry.plan.adaptation_revision ?? 0),
      sourceHash: entry.identities.sourceHash,
    },
    catalogVersion: 'legacy-unversioned',
    catalogSourceHash: entry.identities.sourceHash,
    policyVersion: 'legacy-preservation.v1',
    consentContext: { optionalPermissionsUsed: [] },
    missingInputs: ['Normalized profile factors unavailable for legacy backfill'],
  };
  const encryptedSnapshot = encryptTrainingProfileSnapshot({
    body: snapshotContent,
    userId: entry.scope.userId,
    env,
  });
  db.prepare(`
    INSERT INTO training_profile_snapshots (
      snapshot_id, tenant_id, user_id, snapshot_sequence, schema_version,
      content_hash, encrypted_snapshot_body, snapshot_body_key_version,
      display_factor_index_json, normalized_goals_json, normalized_constraints_json,
      factor_evidence_json, source_versions_json, consent_context_json,
      missing_inputs_json, observed_at, captured_at
    ) VALUES (?, ?, ?, ?, 'legacy-training-profile-snapshot.v1', ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
  `).run(
    entry.identities.profileSnapshotId,
    entry.scope.tenantId,
    entry.scope.userId,
    nextSequence(db, 'training_profile_snapshots', 'snapshot_sequence', entry.scope),
    stableTrainingRevisionHash(snapshotContent),
    encryptedSnapshot.encryptedBody,
    encryptedSnapshot.keyVersion,
    JSON.stringify([{ inputKey: 'legacyPlan', state: 'preserved', materialEffects: ['Read-only compatibility state'] }]),
    JSON.stringify({ legacyGoal: entry.plan.goal ?? null }),
    JSON.stringify({ sourcePlanId: entry.identities.planId, preferenceState: entry.plan.preferences_json ? 'present' : 'missing' }),
    JSON.stringify([{ inputKey: 'legacyPlan', state: 'preserved', materialEffects: ['Read-only compatibility state'] }]),
    JSON.stringify({ legacyPlanVersion: entry.plan.plan_version ?? null, legacySourceHash: entry.identities.sourceHash }),
    JSON.stringify(['Normalized profile factors unavailable for legacy backfill']),
    observedAt,
    observedAt,
  );
  db.prepare(`
    INSERT INTO training_plan_families (
      family_id, tenant_id, user_id, family_key, plan_mode, discipline,
      origin, legacy_plan_id
    ) VALUES (?, ?, ?, ?, 'continuous', ?, 'LEGACY_BACKFILL', ?)
  `).run(
    entry.identities.familyId,
    entry.scope.tenantId,
    entry.scope.userId,
    `legacy:${entry.identities.planId}`,
    String(entry.plan.sport || 'unknown'),
    entry.identities.planId,
  );
  const decisionId = `legacy-backfill:${entry.identities.planId}`;
  const executionId = `legacy-backfill:${entry.identities.planId}:${entry.identities.sourceHash.slice(0, 12)}`;
  db.prepare(`
    INSERT INTO training_plan_revisions (
      revision_id, tenant_id, user_id, family_id, revision_sequence,
      profile_snapshot_id, origin, lifecycle_state, approval_state, decision_id,
      creation_context_version, policy_version, catalog_version, catalog_source_hash,
      capability_registry_version, document_schema_version,
      revision_document_json, content_hash, quality_report_json, activated_at
    ) VALUES (?, ?, ?, ?, 1, ?, 'LEGACY_BACKFILL', 'LEGACY_ACTIVE', 'APPROVED', ?,
      ?, 'legacy-preservation.v1', 'legacy-unversioned', ?,
      'training-workout-capabilities.v1', 'legacy-training-plan-revision.v1',
      ?, ?, ?, ?)
  `).run(
    entry.identities.revisionId,
    entry.scope.tenantId,
    entry.scope.userId,
    entry.identities.familyId,
    entry.identities.profileSnapshotId,
    decisionId,
    `legacy_${entry.identities.sourceHash.slice(0, 32)}`,
    entry.identities.sourceHash,
    JSON.stringify(entry.document),
    entry.identities.contentHash,
    JSON.stringify({
      qualityReport: {
        status: 'LEGACY_COMPATIBILITY',
        checks: [{ code: 'LEGACY_SOURCE_PRESERVED', status: 'WARNING', evidence: 'No regeneration or rescheduling performed' }],
        warnings: ['Legacy plan is read-only in Milestone 1.'],
      },
      causalFactors: [],
    }),
    observedAt,
  );
  db.prepare(`
    INSERT INTO training_plan_revision_approvals (
      approval_id, tenant_id, user_id, family_id, revision_id, decision_id,
      decision_record_version, action_execution_id, approved_content_hash,
      approved_context_version, actor_type, approval_source, approved_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'system_migration', 'LEGACY_EXISTING_COMMITMENT', ?)
  `).run(
    `trpa_legacy_${stableTrainingRevisionHash(executionId).slice(0, 32)}`,
    entry.scope.tenantId,
    entry.scope.userId,
    entry.identities.familyId,
    entry.identities.revisionId,
    decisionId,
    executionId,
    entry.identities.contentHash,
    `legacy_${entry.identities.sourceHash.slice(0, 32)}`,
    observedAt,
  );
  db.prepare(`
    INSERT INTO training_active_plan_references (
      tenant_id, user_id, family_id, active_revision_id, projection_plan_id,
      pointer_version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    entry.scope.tenantId,
    entry.scope.userId,
    entry.identities.familyId,
    entry.identities.revisionId,
    entry.identities.planId,
    observedAt,
    observedAt,
  );
  populateLegacyRevisionMetadata(db, entry);
  assertLegacySourceUnchanged(db, entry);
  return { ...entry.identities, status: 'APPLIED' };
}

function assertLegacyBaselineCompatible(
  entry: ReturnType<typeof prepareLegacyPlan>,
  storedDocumentJson: string,
): void {
  let stored: Record<string, any>;
  try {
    stored = JSON.parse(storedDocumentJson) as Record<string, any>;
  } catch {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_BACKFILL_BASELINE_INVALID',
      'Stored legacy baseline cannot be validated.',
      409,
    );
  }
  const storedWeeks = Array.isArray(stored.weeks) ? stored.weeks : [];
  const storedCore = legacyImmutableCore({
    plan: stored.plan ?? {},
    weeks: storedWeeks.map((week: Record<string, any>) => {
      const { sessions: _sessions, ...row } = week;
      return row;
    }),
    sessions: storedWeeks.flatMap((week: Record<string, any>) =>
      Array.isArray(week.sessions) ? week.sessions : []),
  });
  const currentCore = legacyImmutableCore({
    plan: entry.source.plan,
    weeks: entry.source.weeks,
    sessions: entry.source.sessions,
  });
  if (stableTrainingRevisionHash(currentCore) !== stableTrainingRevisionHash(storedCore)) {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_BACKFILL_BASELINE_DRIFT',
      'The immutable legacy plan prescription or schedule changed after backfill.',
      409,
    );
  }
}

function legacyImmutableCore(input: {
  plan: Record<string, any>;
  weeks: Array<Record<string, any>>;
  sessions: Array<Record<string, any>>;
}): Record<string, unknown> {
  const omit = (row: Record<string, any>, names: string[]) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !names.includes(key)),
  );
  return {
    plan: omit(input.plan, ['source_revision_id', 'adaptation_revision', 'updated_at']),
    weeks: input.weeks.map((week) => omit(week, ['source_revision_id', 'revision_week_key'])),
    sessions: input.sessions.map((session) => omit(session, [
      'source_revision_id',
      'revision_session_key',
      'calendar_event_id',
      'calendar_source',
      'status',
      'updated_at',
    ])),
  };
}

function assertLegacySourceUnchanged(db: Database.Database, entry: ReturnType<typeof prepareLegacyPlan>): void {
  const plan = db.prepare('SELECT * FROM fitness_training_plans WHERE id = ?').get(entry.identities.planId) as Record<string, any>;
  const weeks = db.prepare('SELECT * FROM training_weeks WHERE plan_id = ? ORDER BY week_number, id')
    .all(entry.identities.planId) as Array<Record<string, any>>;
  const sessions = db.prepare('SELECT * FROM training_sessions WHERE plan_id = ? ORDER BY week_id, id')
    .all(entry.identities.planId) as Array<Record<string, any>>;
  const completions = db.prepare('SELECT * FROM training_completions WHERE plan_id = ? ORDER BY completed_at, id')
    .all(entry.identities.planId);
  const calendarOwnership = db.prepare(`
    SELECT * FROM training_agenda_event_ownership
     WHERE plan_id = ?
     ORDER BY plan_version, id
  `).all(entry.identities.planId);
  const adaptations = db.prepare('SELECT * FROM training_plan_adaptations WHERE plan_id = ? ORDER BY id')
    .all(entry.identities.planId);
  const currentHash = stableTrainingRevisionHash({
    plan: stripLegacyRevisionMetadata(plan),
    weeks: weeks.map(stripLegacyRevisionMetadata),
    sessions: sessions.map(stripLegacyRevisionMetadata),
    completions,
    calendarOwnership,
    adaptations,
  });
  if (currentHash !== entry.identities.sourceHash) {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_MUTATED_SOURCE', 'Legacy source changed during backfill.', 500);
  }
}

function assertLegacyRelationships(
  plan: Record<string, any>,
  weeks: Array<Record<string, any>>,
  sessions: Array<Record<string, any>>,
  completions: Array<Record<string, any>>,
  calendarOwnership: Array<Record<string, any>>,
  adaptations: Array<Record<string, any>>,
): void {
  const planId = Number(plan.id);
  const weekIds = new Set(weeks.map((week) => Number(week.id)));
  const sessionIds = new Set(sessions.map((session) => Number(session.id)));
  const invalidSession = sessions.some((session) =>
    Number(session.plan_id) !== planId
    || Number(session.tenant_id) !== Number(plan.tenant_id)
    || !weekIds.has(Number(session.week_id)));
  const invalidCompletion = completions.some((completion) =>
    Number(completion.plan_id) !== planId || !sessionIds.has(Number(completion.session_id)));
  const invalidOwnership = calendarOwnership.some((ownership) =>
    Number(ownership.plan_id) !== planId
    || Number(ownership.user_id) !== Number(plan.user_id)
    || Number(ownership.tenant_id) !== Number(plan.tenant_id)
    || (ownership.session_id != null && !sessionIds.has(Number(ownership.session_id))));
  const invalidAdaptation = adaptations.some((adaptation) => Number(adaptation.plan_id) !== planId);
  if (invalidSession || invalidCompletion || invalidOwnership || invalidAdaptation) {
    throw new TrainingPlanRevisionError(
      'TRAINING_LEGACY_BACKFILL_ORPHAN_DETECTED',
      'Legacy Training rows do not form one scoped plan graph.',
      409,
    );
  }
}

function countByString(rows: Array<Record<string, any>>, key: string): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = String(row[key] ?? 'unknown');
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function countActivePlans(db: Database.Database, scope?: TrainingPlanRevisionScope): number {
  if (scope) {
    return Number((db.prepare(`
      SELECT COUNT(*) AS count FROM fitness_training_plans
       WHERE status = 'active' AND user_id = ? AND tenant_id = ?
    `).get(scope.userId, scope.tenantId) as { count: number }).count);
  }
  return Number((db.prepare("SELECT COUNT(*) AS count FROM fitness_training_plans WHERE status = 'active'")
    .get() as { count: number }).count);
}

function populateLegacyRevisionMetadata(
  db: Database.Database,
  entry: ReturnType<typeof prepareLegacyPlan>,
): void {
  const revisionId = entry.identities.revisionId;
  const planUpdate = db.prepare(`
    UPDATE fitness_training_plans SET source_revision_id = ?
     WHERE id = ? AND (source_revision_id IS NULL OR source_revision_id = ?)
  `).run(revisionId, entry.identities.planId, revisionId);
  if (planUpdate.changes !== 1) {
    throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_METADATA_CONFLICT', 'Legacy plan revision metadata conflicted.', 409);
  }
  const weeks = db.prepare('SELECT id, week_number FROM training_weeks WHERE plan_id = ? ORDER BY week_number, id')
    .all(entry.identities.planId) as Array<{ id: number; week_number: number }>;
  for (const week of weeks) {
    const update = db.prepare(`
      UPDATE training_weeks
         SET source_revision_id = ?, revision_week_key = ?
       WHERE id = ? AND plan_id = ?
         AND (source_revision_id IS NULL OR source_revision_id = ?)
         AND (revision_week_key IS NULL OR revision_week_key = ?)
    `).run(
      revisionId,
      `legacy-week:${week.week_number}:${week.id}`,
      week.id,
      entry.identities.planId,
      revisionId,
      `legacy-week:${week.week_number}:${week.id}`,
    );
    if (update.changes !== 1) {
      throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_METADATA_CONFLICT', 'Legacy week revision metadata conflicted.', 409);
    }
  }
  const sessions = db.prepare('SELECT id FROM training_sessions WHERE plan_id = ? ORDER BY week_id, id')
    .all(entry.identities.planId) as Array<{ id: number }>;
  for (const session of sessions) {
    const key = `legacy-session:${session.id}`;
    const update = db.prepare(`
      UPDATE training_sessions
         SET source_revision_id = ?, revision_session_key = ?
       WHERE id = ? AND plan_id = ?
         AND (source_revision_id IS NULL OR source_revision_id = ?)
         AND (revision_session_key IS NULL OR revision_session_key = ?)
    `).run(revisionId, key, session.id, entry.identities.planId, revisionId, key);
    if (update.changes !== 1) {
      throw new TrainingPlanRevisionError('TRAINING_LEGACY_BACKFILL_METADATA_CONFLICT', 'Legacy session revision metadata conflicted.', 409);
    }
  }
}

function stripLegacyRevisionMetadata(row: Record<string, any>): Record<string, any> {
  const { source_revision_id: _sourceRevisionId, revision_week_key: _weekKey, revision_session_key: _sessionKey, ...rest } = row;
  return rest;
}

function nextSequence(
  db: Database.Database,
  table: string,
  column: string,
  scope: TrainingPlanRevisionScope,
): number {
  const row = db.prepare(`
    SELECT COALESCE(MAX(${column}), 0) AS value FROM ${table}
     WHERE tenant_id = ? AND user_id = ?
  `).get(scope.tenantId, scope.userId) as { value: number };
  return row.value + 1;
}

function summarize(
  mode: LegacyActivePlanBackfillMode,
  plans: LegacyActivePlanBackfillPlanResult[],
): LegacyActivePlanBackfillResult {
  return {
    mode,
    digest: backfillDigest(plans),
    total: plans.length,
    wouldApply: plans.filter((entry) => entry.status === 'WOULD_APPLY').length,
    applied: plans.filter((entry) => entry.status === 'APPLIED').length,
    alreadyApplied: plans.filter((entry) => entry.status === 'ALREADY_APPLIED').length,
    plans,
  };
}

function backfillDigest(plans: Array<{
  planId: number;
  familyId: string;
  profileSnapshotId: string;
  revisionId: string;
  sourceHash: string;
  contentHash: string;
}>): string {
  return stableTrainingRevisionHash(plans.map((entry) => ({
    planId: entry.planId,
    familyId: entry.familyId,
    profileSnapshotId: entry.profileSnapshotId,
    revisionId: entry.revisionId,
    sourceHash: entry.sourceHash,
    contentHash: entry.contentHash,
  })).sort((left, right) => left.planId - right.planId));
}
