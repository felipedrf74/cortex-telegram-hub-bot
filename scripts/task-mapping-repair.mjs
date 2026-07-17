#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// One-shot repair for tasks parked by the NEX-05 create-target defect:
// creates into Microsoft-backed lists resolved their listName to the hidden
// nexus mirror project, so no container mapping matched and the mutation
// parked as failed_permanent/provider_list_missing with a NULL-container
// provider link. The code fix (resolveCreateTargetProject) stops new tasks
// from parking; this script repairs the existing backlog.
//
// Per affected task it: re-points the task to the visible provider project,
// backfills the provider link's container id, resets the parked mutation's
// retry budget, and re-arms it for the next worker batch. Resolution is
// deterministic-else-issue:
//   1. legacy mirror-keyed container mapping (id-keyed, deterministic), else
//   2. unique case-insensitive name match among the provider's project rows,
//   3. otherwise no mutation — a task_sync_issue records the candidates for
//      manual review.
//
// DRY-RUN by default: the full repair runs inside a transaction that is
// rolled back, so the reported counts are exact. Pass --apply to commit.
//
// Usage:
//   node scripts/task-mapping-repair.mjs [--db path/to/bot.db] [--user <id>]
//     [--apply] [--json]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PARKED_ERROR_CODES = ['provider_list_missing', 'provider_project_missing'];

export function selectParkedCreateTargets(db, scope = {}) {
  const where = [
    "m.status = 'failed'",
    'm.next_retry_at IS NULL',
    `(m.last_error_code IN (${PARKED_ERROR_CODES.map(() => '?').join(', ')}) OR m.last_error_code IS NULL)`,
  ];
  const args = [...PARKED_ERROR_CODES];
  if (scope.userId != null) {
    where.push('m.user_id = ?');
    args.push(scope.userId);
  }
  return db.prepare(
    `SELECT DISTINCT
       t.id AS task_row_id,
       t.nexus_task_id,
       t.tenant_id,
       t.user_id,
       t.project_id,
       t.project_name,
       t.sync_state,
       p.provider AS project_provider,
       p.name AS project_row_name,
       l.id AS link_id,
       l.provider AS link_provider,
       l.provider_list_id AS link_provider_list_id
     FROM task_mutations m
     JOIN unified_tasks t
       ON t.nexus_task_id = m.task_id
      AND t.user_id = m.user_id
      AND COALESCE(t.tenant_id, t.user_id) = COALESCE(m.tenant_id, m.user_id)
     LEFT JOIN unified_projects p ON p.id = t.project_id
     LEFT JOIN task_provider_links l
       ON l.task_id = t.nexus_task_id
      AND l.user_id = t.user_id
      AND l.provider != 'nexus_local'
      AND l.link_state NOT IN ('orphaned')
     WHERE ${where.join(' AND ')}
       AND t.is_deleted = 0`,
  ).all(...args);
}

function resolveProviderProject(db, target) {
  // Without a provider link we cannot know which provider the task was meant
  // to sync to — record the issue instead of guessing (conservative).
  if (!target.link_provider) {
    return { resolution: 'unresolved', provider: 'ms_todo', candidates: [], reason: 'no_provider_link' };
  }
  const provider = target.link_provider === 'todoist' ? 'todoist' : 'ms_todo';

  // 1. Legacy mirror-keyed mapping: deterministic, id-keyed.
  const legacyMapping = db.prepare(
    `SELECT provider_container_id
     FROM task_container_mappings
     WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
       AND nexus_list_id = ? AND provider = ?
     LIMIT 1`,
  ).get(target.user_id, target.tenant_id ?? target.user_id, String(target.project_id), provider);
  if (legacyMapping?.provider_container_id) {
    const row = db.prepare(
      `SELECT id, name, external_id FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
         AND provider = ? AND external_id = ?
       LIMIT 1`,
    ).get(target.user_id, target.tenant_id ?? target.user_id, provider, legacyMapping.provider_container_id);
    if (row) return { resolution: 'legacy_mapping', provider, row };
  }

  // 2. Unique case-insensitive name match among the provider's own rows.
  const name = String(target.project_row_name || target.project_name || '').trim();
  if (name) {
    const candidates = db.prepare(
      `SELECT id, name, external_id FROM unified_projects
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
         AND provider = ? AND lower(name) = lower(?)`,
    ).all(target.user_id, target.tenant_id ?? target.user_id, provider, name);
    if (candidates.length === 1) return { resolution: 'unique_name', provider, row: candidates[0] };
    if (candidates.length > 1) return { resolution: 'ambiguous', provider, candidates };
  }
  return { resolution: 'unresolved', provider, candidates: [] };
}

export function runTaskMappingRepair(db, options = {}) {
  const apply = options.apply === true;
  const runId = options.runId
    || `mapping-repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const nowIso = new Date().toISOString();
  const summary = {
    runId,
    mode: apply ? 'apply' : 'dry-run',
    startedAt: nowIso,
    candidates: 0,
    repaired: 0,
    requeuedMutations: 0,
    linksBackfilled: 0,
    ambiguous: 0,
    unresolved: 0,
    skippedAlreadyProviderProject: 0,
    perUser: {},
    details: [],
  };

  const repairedTaskIds = [];
  const work = db.transaction(() => {
    const targets = selectParkedCreateTargets(db, { userId: options.userId });
    summary.candidates = targets.length;

    for (const target of targets) {
      const userKey = String(target.user_id);
      summary.perUser[userKey] = summary.perUser[userKey]
        || { candidates: 0, repaired: 0, ambiguous: 0, unresolved: 0 };
      summary.perUser[userKey].candidates += 1;

      if (target.project_provider && target.project_provider !== 'nexus') {
        summary.skippedAlreadyProviderProject += 1;
        continue;
      }

      const resolved = resolveProviderProject(db, target);
      if (resolved.resolution === 'ambiguous' || resolved.resolution === 'unresolved') {
        if (resolved.resolution === 'ambiguous') summary.ambiguous += 1;
        else summary.unresolved += 1;
        summary.perUser[userKey][resolved.resolution === 'ambiguous' ? 'ambiguous' : 'unresolved'] += 1;
        const issueMessage = 'Could not deterministically resolve the provider list for this parked task. Choose a sync target manually.';
        const issueDetails = JSON.stringify({
          repairRunId: runId,
          reason: resolved.reason || resolved.resolution,
          projectName: target.project_row_name || target.project_name,
          candidates: (resolved.candidates || []).map((c) => ({ id: c.id, name: c.name })),
        });
        const openIssue = db.prepare(
          `SELECT id FROM task_sync_issues
           WHERE COALESCE(tenant_id, user_id) = ? AND user_id = ? AND task_id = ?
             AND provider = ? AND code = 'provider_list_missing' AND state = 'open'
           LIMIT 1`,
        ).get(target.tenant_id ?? target.user_id, target.user_id, target.nexus_task_id, resolved.provider);
        if (openIssue) {
          db.prepare(
            'UPDATE task_sync_issues SET message = ?, details_json = ? WHERE id = ?',
          ).run(issueMessage, issueDetails, openIssue.id);
        } else {
          db.prepare(
            `INSERT INTO task_sync_issues (
               id, task_id, tenant_id, user_id, provider, code, message, details_json, state, created_at
             ) VALUES (?, ?, ?, ?, ?, 'provider_list_missing', ?, ?, 'open', datetime('now'))`,
          ).run(
            `issue_${crypto.randomBytes(16).toString('hex')}`,
            target.nexus_task_id,
            target.tenant_id ?? target.user_id,
            target.user_id,
            resolved.provider,
            issueMessage,
            issueDetails,
          );
        }
        summary.details.push({
          taskId: target.nexus_task_id,
          userId: target.user_id,
          outcome: resolved.resolution,
        });
        continue;
      }

      const providerRow = resolved.row;
      db.prepare(
        `UPDATE unified_tasks
         SET project_id = ?, project_name = ?, sync_state = 'queued', updated_at = datetime('now')
         WHERE id = ?`,
      ).run(providerRow.id, providerRow.name, target.task_row_id);

      if (target.link_id != null) {
        // Container column is provider-shaped: ms_todo lists live in
        // provider_list_id, todoist projects in provider_project_id
        // (mirrors task-sync-policy's providerContainerType routing).
        const containerColumn = resolved.provider === 'todoist' ? 'provider_project_id' : 'provider_list_id';
        const backfilled = db.prepare(
          `UPDATE task_provider_links
           SET ${containerColumn} = COALESCE(${containerColumn}, ?), updated_at = datetime('now')
           WHERE id = ?`,
        ).run(providerRow.external_id, target.link_id);
        if (backfilled.changes > 0 && target.link_provider_list_id == null) summary.linksBackfilled += 1;
      }

      const requeued = db.prepare(
        `UPDATE task_mutations
         SET next_retry_at = ?, retry_count = 0, locked_at = NULL
         WHERE task_id = ? AND user_id = ? AND status = 'failed' AND next_retry_at IS NULL
           AND (last_error_code IN (${PARKED_ERROR_CODES.map(() => '?').join(', ')}) OR last_error_code IS NULL)`,
      ).run(nowIso, target.nexus_task_id, target.user_id, ...PARKED_ERROR_CODES);
      summary.requeuedMutations += requeued.changes;
      summary.repaired += 1;
      repairedTaskIds.push(target.nexus_task_id);
      summary.perUser[userKey].repaired += 1;
      summary.details.push({
        taskId: target.nexus_task_id,
        userId: target.user_id,
        outcome: `repaired:${resolved.resolution}`,
        providerProjectId: providerRow.id,
        providerContainerId: providerRow.external_id,
      });
    }

    // Validation: every task repaired IN THIS RUN whose provider link is
    // active must now carry a container. Fail closed (throw → rollback).
    if (repairedTaskIds.length > 0) {
      const placeholders = repairedTaskIds.map(() => '?').join(', ');
      const dangling = db.prepare(
        `SELECT COUNT(*) AS count
         FROM task_provider_links l
         WHERE l.task_id IN (${placeholders})
           AND l.provider != 'nexus_local' AND l.link_state NOT IN ('orphaned')
           AND ((l.provider = 'todoist' AND l.provider_project_id IS NULL)
             OR (l.provider != 'todoist' AND l.provider_list_id IS NULL))`,
      ).get(...repairedTaskIds).count;
      if (dangling > 0) {
        throw new Error(`Validation failed: ${dangling} repaired task(s) still have a NULL link container`);
      }
    }

    if (!apply) throw new RollbackSignal();
  });

  try {
    work();
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
  summary.finishedAt = new Date().toISOString();
  return summary;
}

class RollbackSignal extends Error {
  constructor() {
    super('dry-run rollback');
  }
}

function main() {
  const args = process.argv.slice(2);
  const readArg = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const dbPath = readArg('--db') || path.join(root, 'data/bot.db');
  const userId = readArg('--user') != null ? Number(readArg('--user')) : undefined;
  const apply = args.includes('--apply');
  const asJson = args.includes('--json');

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    const summary = runTaskMappingRepair(db, { apply, userId });
    const outDir = path.join(root, '.local', 'mapping-repair');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${summary.runId}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`[${summary.mode}] run ${summary.runId}`);
      console.log(`candidates=${summary.candidates} repaired=${summary.repaired} requeued=${summary.requeuedMutations} linksBackfilled=${summary.linksBackfilled} ambiguous=${summary.ambiguous} unresolved=${summary.unresolved}`);
      console.log(`summary written to ${outPath}`);
      if (!apply) console.log('Dry-run only — re-run with --apply to commit.');
    }
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
