// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training compatibility-state repair (F5, Phase 1C).
 *
 * The Phase 1A/1B fixes stop NEW corrupt states from being created. They do
 * nothing for rows already on disk, and there was no repair path at all —
 * `src/tools/` has staging smokes, fixtures and eval harnesses, but nothing
 * that inspects or fixes Training plan state.
 *
 * Existing corrupt states are detected and repaired only when the database
 * itself proves the authoritative action:
 *
 *   1. `stale_idempotency_claim` — an `in_progress` claim whose lease has
 *      elapsed (or which predates the lease entirely). The owning process is
 *      gone; the claim can never resolve itself. Until F1 shipped, this made
 *      the deterministic key 409 forever.
 *
 *   2. `corrupt_idempotency_payload` — a `succeeded` claim whose stored
 *      response is missing, unreadable, or not an object. It cannot replay
 *      truthfully, so it becomes retryable without losing its audit identity.
 *
 *   3. `orphaned_pending_plan` — a `pending_activation` plan row that was
 *      never promoted, left behind if the process died between persist and
 *      activation. Invisible to every reader (all filter `status = 'active'`),
 *      so it is harmless but accumulates, and it blocks nothing.
 *
 *   4. `partial_plan` — an `active` plan whose complete week/session graph was
 *      not persisted. It is quarantined as superseded only when no active
 *      revision pointer or live provider ownership references it.
 *
 *   5. `duplicate_active_plan` — only duplicate plans for the same sport are
 *      candidates. A loser is superseded only when one complete plan has a
 *      revision pointer whose active revision matches the projection source.
 *
 *   6. `orphaned_provider_event` — deletion is attempted only from a durable
 *      orphaned ownership row, through an injected provider boundary. The row
 *      becomes deleted only after that precise delete succeeds/already-gone.
 *
 * Dry-run is the default. Apply requires the exact digest from a matching
 * dry-run even at the service boundary; the compiled CLI adds the environment
 * and confirmation interlocks. Every repair is idempotent — re-running after
 * a fresh post-apply rehearsal makes no additional changes.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  acquireTrainingCalendarOperationLock,
  type TrainingOperationLockLease,
} from './training-operation-locks';

export type TrainingPlanRepairKind =
  | 'stale_idempotency_claim'
  | 'corrupt_idempotency_payload'
  | 'orphaned_pending_plan'
  | 'partial_plan'
  | 'duplicate_active_plan'
  | 'orphaned_provider_event';

export interface TrainingPlanRepairFinding {
  kind: TrainingPlanRepairKind;
  userId: number;
  tenantId: number;
  /** Plan id, or the idempotency key for claim findings. */
  subject: string;
  detail: string;
  /** False for findings that are reported for operator judgement only. */
  repairable: boolean;
}

export interface TrainingPlanRepairResult {
  mode: 'dry_run' | 'apply';
  findings: TrainingPlanRepairFinding[];
  repaired: number;
  /** Stable digest of the findings, so an apply can be pinned to a dry-run. */
  digest: string;
}

export interface TrainingPlanRepairScope {
  userId: number;
  tenantId: number;
}

export interface OwnedTrainingProviderEventDeletion {
  ownershipId: number;
  planId: number;
  userId: number;
  tenantId: number;
  eventId: string;
  source: 'google' | 'outlook';
}

export interface TrainingPlanRepairDependencies {
  /**
   * Must delete only the exact event named by the ownership proof. Tests pass
   * a fake; the operator CLI supplies the governed calendar adapter boundary.
   */
  deleteOwnedProviderEvent?: (
    input: OwnedTrainingProviderEventDeletion,
  ) => Promise<{ alreadyGone?: boolean } | void>;
}

export type TrainingPlanRepairOptions =
  | { mode: 'dry_run'; scope?: TrainingPlanRepairScope }
  | { mode: 'apply'; expectedDigest: string; scope?: TrainingPlanRepairScope };

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function findStaleIdempotencyClaims(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  const table = 'training_plan_generation_idempotency_scoped';
  if (!tableExists(db, table)) return [];
  // A claim is stale when its lease has elapsed, or when it has no lease at
  // all AND predates the lease migration's grace. Never reclaim a live lease:
  // that is what keeps concurrent duplicate generation impossible.
  const rows = db.prepare(`
    SELECT user_id, tenant_id, idempotency_key, updated_at, lease_expires_at
      FROM ${table}
     WHERE status = 'in_progress'
       AND (
         (lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime('now'))
         OR (lease_expires_at IS NULL AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', '-30 minutes'))
       )
       ${scope ? 'AND user_id = ? AND tenant_id = ?' : ''}
  `).all(...(scope ? [scope.userId, scope.tenantId] : [])) as Array<{
    user_id: number; tenant_id: number; idempotency_key: string;
    updated_at: string | null; lease_expires_at: string | null;
  }>;
  return rows.map((row) => ({
    kind: 'stale_idempotency_claim' as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    subject: row.idempotency_key,
    detail: `in_progress since ${row.updated_at ?? 'unknown'}; lease ${row.lease_expires_at ?? 'absent'}`,
    repairable: true,
  }));
}

function findCorruptIdempotencyPayloads(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  const table = 'training_plan_generation_idempotency_scoped';
  if (!tableExists(db, table)) return [];
  const corruptPredicate = `
    CASE
      WHEN response_json IS NULL THEN 1
      WHEN json_valid(response_json) = 0 THEN 1
      WHEN json_type(response_json) <> 'object' THEN 1
      ELSE 0
    END = 1
  `;
  const rows = db.prepare(`
    SELECT user_id, tenant_id, idempotency_key,
           CASE
             WHEN response_json IS NULL THEN 'missing'
             WHEN json_valid(response_json) = 0 THEN 'unreadable'
             ELSE 'non_object'
           END AS payload_state
      FROM ${table}
     WHERE status = 'succeeded'
       AND ${corruptPredicate}
       ${scope ? 'AND user_id = ? AND tenant_id = ?' : ''}
     ORDER BY user_id, tenant_id, idempotency_key
  `).all(...(scope ? [scope.userId, scope.tenantId] : [])) as Array<{
    user_id: number;
    tenant_id: number;
    idempotency_key: string;
    payload_state: 'missing' | 'unreadable' | 'non_object';
  }>;
  return rows.map((row) => ({
    kind: 'corrupt_idempotency_payload',
    userId: row.user_id,
    tenantId: row.tenant_id,
    subject: row.idempotency_key,
    detail: `succeeded replay payload is ${row.payload_state}`,
    repairable: true,
  }));
}

function findOrphanedPendingPlans(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  const rows = db.prepare(`
    SELECT id, user_id, tenant_id, created_at
      FROM fitness_training_plans
     WHERE status = 'pending_activation'
       AND datetime(created_at) <= datetime('now', '-1 hour')
       ${scope ? 'AND user_id = ? AND COALESCE(tenant_id, user_id) = ?' : ''}
  `).all(...(scope ? [scope.userId, scope.tenantId] : [])) as Array<{
    id: number; user_id: number; tenant_id: number; created_at: string;
  }>;
  return rows.map((row) => ({
    kind: 'orphaned_pending_plan' as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    subject: String(row.id),
    detail: `pending_activation since ${row.created_at}, never promoted`,
    repairable: true,
  }));
}

interface ActivePlanGraphState {
  id: number;
  userId: number;
  tenantId: number;
  sport: string;
  issues: string[];
  pointerCount: number;
  verifiedPointerCount: number;
  liveOwnershipCount: number;
}

function loadActivePlanGraphStates(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): ActivePlanGraphState[] {
  const plans = db.prepare(`
    SELECT plans.id, plans.user_id, plans.tenant_id, plans.sport,
           plans.duration_weeks, plans.source_revision_id
      FROM fitness_training_plans plans
     WHERE plans.status = 'active'
       ${scope ? 'AND plans.user_id = ? AND COALESCE(plans.tenant_id, plans.user_id) = ?' : ''}
     ORDER BY plans.user_id, plans.tenant_id, LOWER(plans.sport), plans.id
  `).all(...(scope ? [scope.userId, scope.tenantId] : [])) as Array<{
    id: number;
    user_id: number;
    tenant_id: number;
    sport: string;
    duration_weeks: number;
    source_revision_id: string | null;
  }>;
  const hasPointers = tableExists(db, 'training_active_plan_references');
  const hasOwnership = tableExists(db, 'training_agenda_event_ownership');

  return plans.map((plan) => {
    const weeks = db.prepare(`
      SELECT weeks.id, weeks.week_number, COUNT(sessions.id) AS sessionCount
        FROM training_weeks weeks
        LEFT JOIN training_sessions sessions
          ON sessions.week_id = weeks.id
         AND sessions.plan_id = weeks.plan_id
       WHERE weeks.plan_id = ?
       GROUP BY weeks.id, weeks.week_number
       ORDER BY weeks.week_number, weeks.id
    `).all(plan.id) as Array<{ id: number; week_number: number; sessionCount: number }>;
    const issues: string[] = [];
    const durationWeeks = Number(plan.duration_weeks);
    if (!Number.isSafeInteger(durationWeeks) || durationWeeks <= 0 || durationWeeks > 104) {
      issues.push(`invalid duration_weeks ${String(plan.duration_weeks)}`);
    } else {
      const counts = new Map<number, number>();
      for (const week of weeks) {
        counts.set(week.week_number, (counts.get(week.week_number) ?? 0) + 1);
      }
      const missingWeeks: number[] = [];
      for (let weekNumber = 1; weekNumber <= durationWeeks; weekNumber += 1) {
        if (!counts.has(weekNumber)) missingWeeks.push(weekNumber);
      }
      if (missingWeeks.length > 0) issues.push(`missing weeks ${missingWeeks.join(', ')}`);
      const duplicateWeeks = [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([weekNumber]) => weekNumber);
      if (duplicateWeeks.length > 0) issues.push(`duplicate weeks ${duplicateWeeks.join(', ')}`);
      const outOfRangeWeeks = [...counts.keys()]
        .filter((weekNumber) => weekNumber < 1 || weekNumber > durationWeeks);
      if (outOfRangeWeeks.length > 0) issues.push(`out-of-range weeks ${outOfRangeWeeks.join(', ')}`);
    }
    const emptyWeeks = weeks.filter((week) => Number(week.sessionCount) === 0)
      .map((week) => week.week_number);
    if (emptyWeeks.length > 0) issues.push(`weeks without sessions ${emptyWeeks.join(', ')}`);

    const pointers = hasPointers
      ? db.prepare(`
          SELECT active_revision_id
            FROM training_active_plan_references
           WHERE tenant_id = ? AND user_id = ? AND projection_plan_id = ?
           ORDER BY family_id
        `).all(plan.tenant_id, plan.user_id, plan.id) as Array<{ active_revision_id: string }>
      : [];
    const liveOwnershipCount = hasOwnership
      ? Number((db.prepare(`
          SELECT COUNT(*) AS count
            FROM training_agenda_event_ownership
           WHERE tenant_id = ? AND user_id = ? AND plan_id = ?
             AND status IN ('active', 'orphaned')
        `).get(plan.tenant_id, plan.user_id, plan.id) as { count: number }).count)
      : 0;
    return {
      id: plan.id,
      userId: plan.user_id,
      tenantId: plan.tenant_id,
      sport: String(plan.sport || '').trim().toLowerCase(),
      issues,
      pointerCount: pointers.length,
      verifiedPointerCount: pointers.filter((pointer) =>
        Boolean(plan.source_revision_id) && pointer.active_revision_id === plan.source_revision_id).length,
      liveOwnershipCount,
    };
  });
}

function findPartialPlans(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  return loadActivePlanGraphStates(db, scope)
    .filter((plan) => plan.issues.length > 0)
    .map((plan) => {
      const blockers = [
        ...(plan.pointerCount > 0 ? [`${plan.pointerCount} active pointer(s)`] : []),
        ...(plan.liveOwnershipCount > 0 ? [`${plan.liveOwnershipCount} live ownership row(s)`] : []),
      ];
      return {
        kind: 'partial_plan' as const,
        userId: plan.userId,
        tenantId: plan.tenantId,
        subject: String(plan.id),
        detail: `incomplete active plan graph: ${plan.issues.join('; ')}`
          + (blockers.length > 0 ? `; repair blocked by ${blockers.join(' and ')}` : ''),
        // Quarantining the incomplete graph is reversible, but only when no
        // revision pointer or provider ownership asserts it is authoritative.
        repairable: blockers.length === 0,
      };
    });
}

function findDuplicateActivePlans(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  const states = loadActivePlanGraphStates(db, scope);
  const groups = new Map<string, ActivePlanGraphState[]>();
  for (const state of states) {
    const key = `${state.userId}/${state.tenantId}/${state.sport}`;
    const group = groups.get(key) ?? [];
    group.push(state);
    groups.set(key, group);
  }
  const findings: TrainingPlanRepairFinding[] = [];
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const pointerBacked = group.filter((plan) =>
      plan.pointerCount === 1
      && plan.verifiedPointerCount === 1
      && plan.issues.length === 0);
    if (pointerBacked.length !== 1) {
      const [first] = group;
      findings.push({
        kind: 'duplicate_active_plan',
        userId: first.userId,
        tenantId: first.tenantId,
        subject: key,
        detail: `${group.length} active ${first.sport || 'unknown'} plans; no single complete pointer-backed authority`,
        repairable: false,
      });
      continue;
    }
    const authority = pointerBacked[0];
    for (const loser of group.filter((plan) => plan.id !== authority.id)) {
      const repairable = loser.pointerCount === 0 && loser.liveOwnershipCount === 0;
      findings.push({
        kind: 'duplicate_active_plan',
        userId: loser.userId,
        tenantId: loser.tenantId,
        subject: String(loser.id),
        detail: `duplicate ${loser.sport || 'unknown'} plan; authoritative pointer-backed plan ${authority.id}`
          + (repairable ? '' : '; loser still has a pointer or live ownership'),
        repairable,
      });
    }
  }
  return findings;
}

function findOrphanedProviderEvents(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  if (!tableExists(db, 'training_agenda_event_ownership')) return [];
  const rows = db.prepare(`
    SELECT id, plan_id, user_id, tenant_id, calendar_event_id, calendar_source
      FROM training_agenda_event_ownership
     WHERE status = 'orphaned'
       ${scope ? 'AND user_id = ? AND tenant_id = ?' : ''}
     ORDER BY id ASC
  `).all(...(scope ? [scope.userId, scope.tenantId] : [])) as Array<{
    id: number;
    plan_id: number;
    user_id: number;
    tenant_id: number;
    calendar_event_id: string;
    calendar_source: string;
  }>;
  return rows.map((row) => ({
    kind: 'orphaned_provider_event' as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    // Provider event ids can be sensitive: emit only the durable ownership id
    // and a one-way fingerprint that pins event drift between dry-run/apply.
    subject: `ownership:${row.id}`,
    detail: `plan ${row.plan_id} has orphaned ${row.calendar_source} ownership fingerprint `
      + providerEventFingerprint(row.calendar_source, row.calendar_event_id),
    repairable: (row.calendar_source === 'google' || row.calendar_source === 'outlook'),
  }));
}

function digestOf(findings: TrainingPlanRepairFinding[]): string {
  // Order-independent so two scans of the same state agree.
  const canonical = findings
    // Detail contains only sanitized row ids/counts/timestamps, never provider
    // ids. Including it pins authority-relevant evidence (for example the
    // pointer-backed winning plan) rather than merely the finding category.
    .map((f) => [
      f.kind,
      f.userId,
      f.tenantId,
      f.subject,
      f.repairable ? 'repair' : 'report',
      f.detail,
    ].join('|'))
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

function providerEventFingerprint(source: string, eventId: string): string {
  return createHash('sha256').update(`${source}\0${eventId}`).digest('hex').slice(0, 16);
}

export function scanTrainingPlanRepairs(
  db: Database.Database,
  scope?: TrainingPlanRepairScope,
): TrainingPlanRepairFinding[] {
  return [
    ...findStaleIdempotencyClaims(db, scope),
    ...findCorruptIdempotencyPayloads(db, scope),
    ...findOrphanedPendingPlans(db, scope),
    ...findPartialPlans(db, scope),
    ...findDuplicateActivePlans(db, scope),
    ...findOrphanedProviderEvents(db, scope),
  ];
}

/**
 * Repair what is safely repairable. Idempotent: a second run over the same
 * database finds nothing left to do.
 */
export async function runTrainingPlanRepair(
  db: Database.Database,
  options: TrainingPlanRepairOptions,
  dependencies: TrainingPlanRepairDependencies = {},
): Promise<TrainingPlanRepairResult> {
  if (options.mode === 'dry_run') {
    const findings = scanTrainingPlanRepairs(db, options.scope);
    const digest = digestOf(findings);
    return { mode: 'dry_run', findings, repaired: 0, digest };
  }

  if (!/^[a-f0-9]{64}$/.test(options.expectedDigest)) {
    throw new Error('Training plan repair apply requires a 64-character dry-run digest');
  }

  // The first scan exists only to determine the sorted lock set. The digest
  // is deliberately checked again after every lock is held, closing the
  // dry-run/apply race without making a read-only rehearsal contend.
  const preflight = scanTrainingPlanRepairs(db, options.scope);
  const leases = await acquireRepairLeases(db, preflight);
  try {
    assertRepairLeasesActive(leases);
    const findings = scanTrainingPlanRepairs(db, options.scope);
    const digest = digestOf(findings);
    if (digest !== options.expectedDigest) {
      throw new Error('Training plan repair digest mismatch; run a fresh dry-run before apply');
    }

    const providerDeletions = await deleteOwnedProviderOrphans(
      db,
      findings,
      dependencies,
      leases,
    );
    assertRepairLeasesActive(leases);

    const apply = db.transaction((): TrainingPlanRepairResult => {
      assertRepairLeasesActive(leases);
      let repaired = 0;
      for (const finding of findings) {
        if (!finding.repairable) continue;
        if (finding.kind === 'stale_idempotency_claim') {
          // Retryable, not deleted: the key's history stays auditable and the
          // normal F1 claim path can fence a fresh attempt. Marking this
          // terminal would turn a stale lease into a permanent conflict.
          const changes = db.prepare(`
            UPDATE training_plan_generation_idempotency_scoped
               SET status = 'failed', failure_class = 'retryable',
                   last_error_code = 'REPAIR_STALE_CLAIM', updated_at = datetime('now')
             WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ? AND status = 'in_progress'
               AND (
                 (lease_expires_at IS NOT NULL AND datetime(lease_expires_at) <= datetime('now'))
                 OR (lease_expires_at IS NULL AND datetime(COALESCE(updated_at, created_at)) <= datetime('now', '-30 minutes'))
               )
          `).run(finding.userId, finding.tenantId, finding.subject).changes;
          repaired += Number(changes);
        } else if (finding.kind === 'corrupt_idempotency_payload') {
          // The prior success cannot be replayed truthfully. Preserve the
          // deterministic key/audit row, but make the normal F1 claim path
          // eligible to acquire a fresh fenced attempt.
          const changes = db.prepare(`
            UPDATE training_plan_generation_idempotency_scoped
               SET status = 'failed', response_json = NULL, status_code = NULL,
                   failure_class = 'retryable',
                   last_error_code = 'REPAIR_CORRUPT_RESPONSE',
                   lease_expires_at = NULL, updated_at = datetime('now')
             WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ?
               AND status = 'succeeded'
               AND CASE
                 WHEN response_json IS NULL THEN 1
                 WHEN json_valid(response_json) = 0 THEN 1
                 WHEN json_type(response_json) <> 'object' THEN 1
                 ELSE 0
               END = 1
          `).run(finding.userId, finding.tenantId, finding.subject).changes;
          repaired += Number(changes);
        } else if (finding.kind === 'orphaned_pending_plan') {
          // Safe to remove outright: never visible to any reader, and FK
          // CASCADE clears its weeks/sessions.
          const changes = db.prepare(`
            DELETE FROM fitness_training_plans
             WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'pending_activation'
               AND datetime(created_at) <= datetime('now', '-1 hour')
          `).run(Number(finding.subject), finding.userId, finding.tenantId).changes;
          repaired += Number(changes);
        } else if (finding.kind === 'partial_plan') {
          // Never synthesize missing coaching content. Quarantine the broken
          // projection only while the database still proves no revision
          // pointer or live provider ownership relies on it.
          const changes = db.prepare(`
            UPDATE fitness_training_plans
               SET status = 'superseded', updated_at = datetime('now')
             WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM training_active_plan_references refs
                  WHERE refs.tenant_id = ? AND refs.user_id = ?
                    AND refs.projection_plan_id = fitness_training_plans.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM training_agenda_event_ownership ownership
                  WHERE ownership.tenant_id = ? AND ownership.user_id = ?
                    AND ownership.plan_id = fitness_training_plans.id
                    AND ownership.status IN ('active', 'orphaned')
               )
          `).run(
            Number(finding.subject), finding.userId, finding.tenantId,
            finding.tenantId, finding.userId,
            finding.tenantId, finding.userId,
          ).changes;
          repaired += Number(changes);
        } else if (finding.kind === 'duplicate_active_plan') {
          // Revalidate the authority proof inside the write transaction. The
          // shared lock prevents a legitimate plan operation racing this CAS;
          // the recheck protects service misuse and future lock refactors.
          const stillProven = findDuplicateActivePlans(db, {
            userId: finding.userId,
            tenantId: finding.tenantId,
          }).some((candidate) =>
            candidate.repairable
            && candidate.subject === finding.subject
            && candidate.detail === finding.detail);
          if (!stillProven) continue;
          const changes = db.prepare(`
            UPDATE fitness_training_plans
               SET status = 'superseded', updated_at = datetime('now')
             WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM training_active_plan_references refs
                  WHERE refs.tenant_id = ? AND refs.user_id = ?
                    AND refs.projection_plan_id = fitness_training_plans.id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM training_agenda_event_ownership ownership
                  WHERE ownership.tenant_id = ? AND ownership.user_id = ?
                    AND ownership.plan_id = fitness_training_plans.id
                    AND ownership.status IN ('active', 'orphaned')
               )
          `).run(
            Number(finding.subject), finding.userId, finding.tenantId,
            finding.tenantId, finding.userId,
            finding.tenantId, finding.userId,
          ).changes;
          repaired += Number(changes);
        } else if (finding.kind === 'orphaned_provider_event') {
          const proof = providerDeletions.get(finding.subject);
          if (!proof) continue;
          const changes = db.prepare(`
            UPDATE training_agenda_event_ownership
               SET status = 'deleted', deleted_at = datetime('now'),
                   delete_reason = ?
             WHERE id = ? AND plan_id = ? AND user_id = ? AND tenant_id = ?
               AND calendar_event_id = ? AND calendar_source = ?
               AND status = 'orphaned'
          `).run(
            proof.alreadyGone
              ? 'repair_orphan_event_gone_upstream'
              : 'repair_orphan_provider_event',
            proof.ownershipId,
            proof.planId,
            proof.userId,
            proof.tenantId,
            proof.eventId,
            proof.source,
          ).changes;
          repaired += Number(changes);
        }
      }
      assertRepairLeasesActive(leases);
      return { mode: 'apply', findings, repaired, digest };
    });
    return apply();
  } finally {
    for (const lease of [...leases].reverse()) lease();
  }
}

async function acquireRepairLeases(
  db: Database.Database,
  findings: TrainingPlanRepairFinding[],
): Promise<TrainingOperationLockLease[]> {
  const scopes = [...new Map(
    findings
      .filter((finding) => finding.repairable)
      .map((finding) => [
        `${finding.tenantId}/${finding.userId}`,
        { tenantId: finding.tenantId, userId: finding.userId },
      ] as const),
  ).values()].sort((left, right) =>
    left.tenantId - right.tenantId || left.userId - right.userId);
  const leases: TrainingOperationLockLease[] = [];
  try {
    for (const scope of scopes) {
      leases.push(await acquireTrainingCalendarOperationLock({
        ...scope,
        operation: 'plan_repair',
        db,
      }));
    }
    return leases;
  } catch (error) {
    for (const lease of [...leases].reverse()) lease();
    throw error;
  }
}

function assertRepairLeasesActive(leases: TrainingOperationLockLease[]): void {
  for (const lease of leases) lease.assertActive();
}

async function deleteOwnedProviderOrphans(
  db: Database.Database,
  findings: TrainingPlanRepairFinding[],
  dependencies: TrainingPlanRepairDependencies,
  leases: TrainingOperationLockLease[],
): Promise<Map<string, OwnedTrainingProviderEventDeletion & { alreadyGone: boolean }>> {
  const candidates = findings.filter((finding) =>
    finding.kind === 'orphaned_provider_event' && finding.repairable);
  if (candidates.length === 0) return new Map();
  if (!dependencies.deleteOwnedProviderEvent) {
    throw new Error('Training plan repair requires an ownership-scoped provider deletion boundary');
  }

  const deleted = new Map<string, OwnedTrainingProviderEventDeletion & { alreadyGone: boolean }>();
  for (const finding of candidates) {
    const ownershipId = parseOwnershipSubject(finding.subject);
    const row = db.prepare(`
      SELECT id, plan_id, user_id, tenant_id, calendar_event_id, calendar_source
        FROM training_agenda_event_ownership
       WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'orphaned'
    `).get(ownershipId, finding.userId, finding.tenantId) as {
      id: number;
      plan_id: number;
      user_id: number;
      tenant_id: number;
      calendar_event_id: string;
      calendar_source: string;
    } | undefined;
    if (!row || (row.calendar_source !== 'google' && row.calendar_source !== 'outlook')) {
      throw new Error('Training plan repair ownership proof changed; run a fresh dry-run before apply');
    }
    const expectedDetail = `plan ${row.plan_id} has orphaned ${row.calendar_source} ownership fingerprint `
      + providerEventFingerprint(row.calendar_source, row.calendar_event_id);
    if (finding.detail !== expectedDetail) {
      throw new Error('Training plan repair ownership proof changed; run a fresh dry-run before apply');
    }
    const proof: OwnedTrainingProviderEventDeletion = {
      ownershipId: row.id,
      planId: row.plan_id,
      userId: row.user_id,
      tenantId: row.tenant_id,
      eventId: row.calendar_event_id,
      source: row.calendar_source,
    };
    assertRepairLeasesActive(leases);
    const result = await dependencies.deleteOwnedProviderEvent(proof);
    assertRepairLeasesActive(leases);
    deleted.set(finding.subject, { ...proof, alreadyGone: result?.alreadyGone === true });
  }
  return deleted;
}

function parseOwnershipSubject(subject: string): number {
  const match = subject.match(/^ownership:([1-9]\d*)$/);
  const value = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(value)) {
    throw new Error('Training plan repair ownership proof is malformed');
  }
  return value;
}
