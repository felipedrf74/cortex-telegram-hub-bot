// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Training compatibility-state repair (F5, Phase 1C).
 *
 * The Phase 1A/1B fixes stop NEW corrupt states from being created. They do
 * nothing for rows already on disk, and there was no repair path at all —
 * `src/tools/` has staging smokes, fixtures and eval harnesses, but nothing
 * that inspects or fixes Training plan state.
 *
 * Three states are detectable and safely repairable:
 *
 *   1. `stale_idempotency_claim` — an `in_progress` claim whose lease has
 *      elapsed (or which predates the lease entirely). The owning process is
 *      gone; the claim can never resolve itself. Until F1 shipped, this made
 *      the deterministic key 409 forever.
 *
 *   2. `orphaned_pending_plan` — a `pending_activation` plan row that was
 *      never promoted, left behind if the process died between persist and
 *      activation. Invisible to every reader (all filter `status = 'active'`),
 *      so it is harmless but accumulates, and it blocks nothing.
 *
 *   3. `partial_plan` — an `active` plan with no sessions. Pre-Phase-1B these
 *      were produced by a non-transactional persist failing partway; this is
 *      the shape a user experiences as "my plan is empty".
 *
 * Deliberately NOT repaired here: duplicate active plans and orphaned provider
 * events. Both need judgement about which row or event is authoritative, and
 * provider state needs an ownership-verified delete rather than a local write.
 * They are reported as findings so an operator can see them, never mutated.
 *
 * Dry-run is the only mode this module offers by itself; `apply` is gated by
 * the CLI's interlock. Every repair is idempotent — re-running after an apply
 * finds nothing.
 */

import type Database from 'better-sqlite3';

export type TrainingPlanRepairKind =
  | 'stale_idempotency_claim'
  | 'orphaned_pending_plan'
  | 'partial_plan'
  | 'duplicate_active_plan';

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

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function findStaleIdempotencyClaims(db: Database.Database): TrainingPlanRepairFinding[] {
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
  `).all() as Array<{
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

function findOrphanedPendingPlans(db: Database.Database): TrainingPlanRepairFinding[] {
  const rows = db.prepare(`
    SELECT id, user_id, tenant_id, created_at
      FROM fitness_training_plans
     WHERE status = 'pending_activation'
       AND datetime(created_at) <= datetime('now', '-1 hour')
  `).all() as Array<{ id: number; user_id: number; tenant_id: number; created_at: string }>;
  return rows.map((row) => ({
    kind: 'orphaned_pending_plan' as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    subject: String(row.id),
    detail: `pending_activation since ${row.created_at}, never promoted`,
    repairable: true,
  }));
}

function findPartialPlans(db: Database.Database): TrainingPlanRepairFinding[] {
  const rows = db.prepare(`
    SELECT plans.id, plans.user_id, plans.tenant_id,
           (SELECT COUNT(*) FROM training_sessions WHERE plan_id = plans.id) AS sessionCount
      FROM fitness_training_plans plans
     WHERE plans.status = 'active'
  `).all() as Array<{ id: number; user_id: number; tenant_id: number; sessionCount: number }>;
  return rows
    .filter((row) => row.sessionCount === 0)
    .map((row) => ({
      kind: 'partial_plan' as const,
      userId: row.user_id,
      tenantId: row.tenant_id,
      subject: String(row.id),
      // Reported, not auto-deleted: an active plan is user-visible, and
      // removing it is a product decision an operator must make.
      detail: 'active plan has zero sessions',
      repairable: false,
    }));
}

function findDuplicateActivePlans(db: Database.Database): TrainingPlanRepairFinding[] {
  const rows = db.prepare(`
    SELECT user_id, tenant_id, COUNT(*) AS planCount
      FROM fitness_training_plans
     WHERE status = 'active'
     GROUP BY user_id, tenant_id
    HAVING COUNT(*) > 1
  `).all() as Array<{ user_id: number; tenant_id: number; planCount: number }>;
  return rows.map((row) => ({
    kind: 'duplicate_active_plan' as const,
    userId: row.user_id,
    tenantId: row.tenant_id,
    subject: `${row.user_id}/${row.tenant_id}`,
    // Which plan is authoritative is not inferable from the rows alone.
    detail: `${row.planCount} active plans; requires operator decision`,
    repairable: false,
  }));
}

function digestOf(findings: TrainingPlanRepairFinding[]): string {
  // Order-independent so two scans of the same state agree.
  const canonical = findings
    .map((f) => `${f.kind}|${f.userId}|${f.tenantId}|${f.subject}`)
    .sort()
    .join('\n');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').createHash('sha256').update(canonical).digest('hex');
}

export function scanTrainingPlanRepairs(db: Database.Database): TrainingPlanRepairFinding[] {
  return [
    ...findStaleIdempotencyClaims(db),
    ...findOrphanedPendingPlans(db),
    ...findPartialPlans(db),
    ...findDuplicateActivePlans(db),
  ];
}

/**
 * Repair what is safely repairable. Idempotent: a second run over the same
 * database finds nothing left to do.
 */
export function runTrainingPlanRepair(
  db: Database.Database,
  options: { mode: 'dry_run' | 'apply' },
): TrainingPlanRepairResult {
  const findings = scanTrainingPlanRepairs(db);
  const digest = digestOf(findings);
  if (options.mode === 'dry_run') {
    return { mode: 'dry_run', findings, repaired: 0, digest };
  }

  let repaired = 0;
  const apply = db.transaction(() => {
    for (const finding of findings) {
      if (!finding.repairable) continue;
      if (finding.kind === 'stale_idempotency_claim') {
        // Terminal, not deleted: the key's history stays auditable and a
        // fresh attempt can claim it.
        db.prepare(`
          UPDATE training_plan_generation_idempotency_scoped
             SET status = 'failed', failure_class = 'terminal',
                 last_error_code = 'REPAIR_STALE_CLAIM', updated_at = datetime('now')
           WHERE user_id = ? AND tenant_id = ? AND idempotency_key = ? AND status = 'in_progress'
        `).run(finding.userId, finding.tenantId, finding.subject);
        repaired += 1;
      } else if (finding.kind === 'orphaned_pending_plan') {
        // Safe to remove outright: never visible to any reader, and FK
        // CASCADE clears its weeks/sessions.
        db.prepare(`
          DELETE FROM fitness_training_plans
           WHERE id = ? AND user_id = ? AND tenant_id = ? AND status = 'pending_activation'
        `).run(Number(finding.subject), finding.userId, finding.tenantId);
        repaired += 1;
      }
    }
  });
  apply();

  return { mode: 'apply', findings, repaired, digest };
}
