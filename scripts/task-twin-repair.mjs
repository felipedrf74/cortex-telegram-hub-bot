#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.
//
// One-shot repair for NEX-02 provider twins: before the links-first upsert
// routing (findRowByActiveLink) and marker adoption (adoptRowByNexusMarker)
// landed, a pull of a Nexus-created, pushed provider task could import it as
// a SECOND unified_tasks row keyed by (provider, external_id) — a twin of the
// canonical Nexus task the active provider link already pointed at. The code
// fix stops new twins; this script repairs the existing backlog.
//
// Detection is link/marker-only — NO content-fingerprint merging:
//   - link twin:   a live provider-origin row whose external_id equals an
//     ACTIVE task_provider_links.provider_task_id owned by a DIFFERENT live
//     nexus-origin task (the survivor, by definition of the link).
//   - marker twin: a live provider-origin row whose provider_data
//     linkedResources marker names a DIFFERENT live nexus-origin task and
//     whose provider id has no active foreign link claim (the Microsoft-move
//     shape: same Nexus task, fresh Graph id). The provider id is adopted
//     onto the survivor's link slot before the common repair.
//
// Per twin: merge metadata into the survivor only where the survivor's field
// is NULL/empty, union checklists by normalized displayName (trim+lowercase,
// prefer isChecked=true, adopt the twin's Graph item ids), tombstone the twin
// (is_deleted=1, sync_state='synced' so no push path ever deletes the still-
// live provider task), RETIRE its external_id, record merged_into in its
// provider_data (resolver alias + isMergedTombstone guard), supersede its
// pending task.delete mutations, remap its other pending mutations to the
// survivor, orphan its links, and orphan the survivor's redundant same-
// provider NULL-provider_task_id link (pre-migration-234 R1-b leftovers).
// Twins with conflicting identity signals get a task_sync_issue, no mutation.
// Post-repair validation fails closed (throw -> rollback).
//
// DRY-RUN by default: the full repair runs inside a transaction that is
// rolled back, so the reported counts are exact. Pass --apply to commit.
//
// Usage:
//   node scripts/task-twin-repair.mjs [--db path/to/bot.db] [--user <id>]
//     [--apply] [--json]

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TWIN_PROVIDERS = ['ms_todo', 'todoist'];
// Mutation statuses the worker can still claim (readyMutations); 'syncing'
// is an in-flight lease and is deliberately NOT touched — a twin holding one
// fails closed in validation instead of being mutated under a live worker.
const PENDING_MUTATION_STATUSES = ['queued', 'accepted_local', 'failed'];
const OPEN_MUTATION_STATUSES = [...PENDING_MUTATION_STATUSES, 'syncing'];

function parseJson(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Mirrors offline-first-task-service normalizeChecklistItems.
function normalizeChecklistItems(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const id = String(item.id || item.itemId || '').trim();
      const displayName = String(item.displayName || item.title || item.name || '').trim();
      if (!id || !displayName) return null;
      return { id, displayName, isChecked: Boolean(item.isChecked ?? item.checked ?? item.completed) };
    })
    .filter((item) => item != null);
}

// Mirrors the push worker's checklist matching rule (trim + lowercase).
function normalizeChecklistName(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * Union the twin's checklist into the survivor's by normalized displayName.
 * Same-name duplicates within one side collapse (accepted loss, reported);
 * name collisions across sides prefer isChecked=true and adopt the twin's
 * provider (Graph) item id so the local ids converge with the provider.
 */
export function unionChecklists(rawSurvivorItems, rawTwinItems) {
  const survivorItems = normalizeChecklistItems(rawSurvivorItems);
  const twinItems = normalizeChecklistItems(rawTwinItems);
  const collapsedLosses = [];
  const collapse = (items) => {
    const byName = new Map();
    for (const item of items) {
      const key = normalizeChecklistName(item.displayName);
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, { ...item });
        continue;
      }
      collapsedLosses.push(item.displayName);
      if (item.isChecked) existing.isChecked = true;
    }
    return byName;
  };
  const survivorByName = collapse(survivorItems);
  const twinByName = collapse(twinItems);

  let added = 0;
  let adopted = 0;
  const union = [];
  for (const [key, item] of survivorByName) {
    const twinMatch = twinByName.get(key);
    if (twinMatch) {
      twinByName.delete(key);
      if (twinMatch.id !== item.id) adopted += 1;
      union.push({ ...item, id: twinMatch.id, isChecked: item.isChecked || twinMatch.isChecked });
    } else {
      union.push(item);
    }
  }
  for (const item of twinByName.values()) {
    union.push(item);
    added += 1;
  }
  const changed = JSON.stringify(union) !== JSON.stringify(survivorItems);
  return { union, added, adopted, collapsedLosses, changed };
}

// Mirrors unified-task-store extractNexusMarkerTaskId.
function extractNexusMarkerTaskId(providerData) {
  const raw = providerData?.linkedResources;
  if (!Array.isArray(raw)) return null;
  for (const entry of raw) {
    const externalId = typeof entry?.externalId === 'string' ? entry.externalId : null;
    if (externalId && /^task_[A-Za-z0-9_-]+$/.test(externalId)) return externalId;
  }
  return null;
}

// Mirrors unified-task-store computeContentHash, from row-shaped values.
function computeRowContentHash(row) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.tags || '[]');
    if (Array.isArray(parsed)) tags = parsed;
  } catch { /* invalid tags JSON — hash as empty */ }
  const hashInput = [
    row.title || '',
    row.status,
    row.due_date || '',
    String(row.priority),
    tags.slice().sort().join(','),
    row.project_name || '',
  ].join('|');
  return crypto.createHash('sha256').update(hashInput).digest('hex').slice(0, 16);
}

// Mirrors unified-task-store providerContainerId, from provider_data.
function providerContainerIdFromData(providerData) {
  for (const key of ['listId', 'list_id', 'parentFolderId', 'project_id', 'projectId']) {
    const value = providerData?.[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return null;
}

function tenantKeyOf(row) {
  return row.tenant_id ?? row.user_id;
}

function twinNexusIdOf(row) {
  return row.nexus_task_id || `task_legacy_${row.id}`;
}

/**
 * Select NEX-02 twin candidates. Read-only. Link detection binds a live
 * provider-origin row to the ACTIVE link that owns its provider task id
 * (standard `${provider}:${userId}` account slots only — exotic accounts are
 * left alone so runtime routing stays coherent). Marker detection covers
 * twins whose provider id is unclaimed but whose linkedResources marker
 * names the survivor. Conflicting signals become 'ambiguous' candidates
 * (issue, no mutation) — never a guess.
 */
export function selectTwinCandidates(db, scope = {}) {
  const userWhere = scope.userId != null ? ' AND twin.user_id = ?' : '';
  const userArgs = scope.userId != null ? [scope.userId] : [];

  const linkRows = db.prepare(
    `SELECT
       twin.id AS twin_row_id,
       COALESCE(twin.nexus_task_id, 'task_legacy_' || twin.id) AS twin_nexus_task_id,
       twin.user_id,
       twin.tenant_id,
       twin.provider,
       twin.external_id AS provider_task_id,
       survivor.id AS survivor_row_id,
       survivor.nexus_task_id AS survivor_nexus_task_id,
       l.id AS canonical_link_id,
       l.provider_account_id
     FROM unified_tasks twin
     JOIN task_provider_links l
       ON l.provider = twin.provider
      AND l.provider_task_id = twin.external_id
      AND l.user_id = twin.user_id
      AND COALESCE(l.tenant_id, l.user_id) = COALESCE(twin.tenant_id, twin.user_id)
      AND l.link_state NOT IN ('orphaned')
      AND l.task_id != COALESCE(twin.nexus_task_id, 'task_legacy_' || twin.id)
      AND l.provider_account_id = (l.provider || ':' || CAST(l.user_id AS TEXT))
     JOIN unified_tasks survivor
       ON survivor.nexus_task_id = l.task_id
      AND survivor.user_id = l.user_id
      AND COALESCE(survivor.tenant_id, survivor.user_id) = COALESCE(l.tenant_id, l.user_id)
     WHERE twin.provider IN (${TWIN_PROVIDERS.map(() => '?').join(', ')})
       AND twin.is_deleted = 0
       AND survivor.is_deleted = 0
       AND survivor.provider = 'nexus'
       AND survivor.id != twin.id${userWhere}
     ORDER BY twin.id, l.id`,
  ).all(...TWIN_PROVIDERS, ...userArgs);

  const candidates = [];
  const byTwinRowId = new Map();
  for (const row of linkRows) {
    // At most one active link can hold a provider task id in the standard
    // account slot (partial unique index from migration 234), so each twin
    // resolves to exactly one canonical link here.
    if (byTwinRowId.has(row.twin_row_id)) continue;
    const candidate = { detection: 'link', ...row };
    byTwinRowId.set(row.twin_row_id, candidate);
    candidates.push(candidate);
  }

  const markerScanWhere = scope.userId != null ? ' AND t.user_id = ?' : '';
  const markerRows = db.prepare(
    `SELECT t.*
     FROM unified_tasks t
     WHERE t.provider IN (${TWIN_PROVIDERS.map(() => '?').join(', ')})
       AND t.is_deleted = 0
       AND t.provider_data LIKE '%linkedResources%'${markerScanWhere}
     ORDER BY t.id`,
  ).all(...TWIN_PROVIDERS, ...userArgs);

  for (const row of markerRows) {
    if (byTwinRowId.has(row.id)) continue; // link detection wins
    const markerTaskId = extractNexusMarkerTaskId(parseJson(row.provider_data, {}));
    const twinNexusId = twinNexusIdOf(row);
    if (!markerTaskId || markerTaskId === twinNexusId) continue;
    const survivor = db.prepare(
      `SELECT id, nexus_task_id FROM unified_tasks
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
         AND nexus_task_id = ? AND is_deleted = 0 AND provider = 'nexus' AND id != ?
       LIMIT 1`,
    ).get(row.user_id, tenantKeyOf(row), markerTaskId, row.id);
    if (!survivor) continue; // marker names no live nexus task — not a twin
    const foreignClaims = db.prepare(
      `SELECT id, task_id FROM task_provider_links
       WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ?
         AND provider = ? AND provider_task_id = ?
         AND link_state NOT IN ('orphaned') AND task_id != ?`,
    ).all(row.user_id, tenantKeyOf(row), row.provider, row.external_id, twinNexusId);
    const candidate = {
      twin_row_id: row.id,
      twin_nexus_task_id: twinNexusId,
      user_id: row.user_id,
      tenant_id: row.tenant_id,
      provider: row.provider,
      provider_task_id: row.external_id,
      survivor_row_id: survivor.id,
      survivor_nexus_task_id: survivor.nexus_task_id,
      canonical_link_id: null,
      provider_account_id: `${row.provider}:${row.user_id}`,
      detection: foreignClaims.length > 0 ? 'ambiguous' : 'marker',
    };
    if (foreignClaims.length > 0) {
      // An active link claims the provider id for a task that did NOT
      // qualify as a survivor (deleted or provider-origin) while the marker
      // names another — conflicting signals, adjudicate manually.
      candidate.claims = [
        { marker: markerTaskId },
        ...foreignClaims.map((claim) => ({ linkId: claim.id, taskId: claim.task_id })),
      ];
    }
    byTwinRowId.set(row.id, candidate);
    candidates.push(candidate);
  }

  return candidates;
}

const MERGE_FIELDS = ['description', 'notes', 'completed_at', 'url'];

function isEmptyValue(value) {
  return value == null || String(value).trim() === '';
}

function recordAmbiguousIssue(db, runId, candidate) {
  const tenantKey = candidate.tenant_id ?? candidate.user_id;
  const message = 'Conflicting twin identity signals for this provider task. Adjudicate the canonical task manually.';
  const details = JSON.stringify({
    repairRunId: runId,
    reason: 'twin_repair_ambiguous',
    providerTaskId: candidate.provider_task_id,
    claims: candidate.claims || [],
  });
  const openIssue = db.prepare(
    `SELECT id FROM task_sync_issues
     WHERE COALESCE(tenant_id, user_id) = ? AND user_id = ? AND task_id = ?
       AND provider = ? AND code = 'manual_resolution_required' AND state = 'open'
     LIMIT 1`,
  ).get(tenantKey, candidate.user_id, candidate.twin_nexus_task_id, candidate.provider);
  if (openIssue) {
    db.prepare('UPDATE task_sync_issues SET message = ?, details_json = ? WHERE id = ?')
      .run(message, details, openIssue.id);
    return;
  }
  db.prepare(
    `INSERT INTO task_sync_issues (
       id, task_id, tenant_id, user_id, provider, code, message, details_json, state, created_at
     ) VALUES (?, ?, ?, ?, ?, 'manual_resolution_required', ?, ?, 'open', datetime('now'))`,
  ).run(
    `issue_${crypto.randomBytes(16).toString('hex')}`,
    candidate.twin_nexus_task_id,
    tenantKey,
    candidate.user_id,
    candidate.provider,
    message,
    details,
  );
}

export function runTaskTwinRepair(db, options = {}) {
  const apply = options.apply === true;
  const runId = options.runId
    || `twin-repair-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const summary = {
    runId,
    mode: apply ? 'apply' : 'dry-run',
    startedAt: new Date().toISOString(),
    candidates: 0,
    repaired: 0,
    skipped: 0,
    ambiguous: 0,
    mutationsSuperseded: 0,
    mutationsRemapped: 0,
    twinLinksOrphaned: 0,
    redundantLinksOrphaned: 0,
    checklistItemsAdded: 0,
    checklistIdsAdopted: 0,
    checklistDuplicatesCollapsed: 0,
    perUser: {},
    details: [],
  };

  const work = db.transaction(() => {
    const candidates = selectTwinCandidates(db, { userId: options.userId });
    summary.candidates = candidates.length;
    const repairedCandidates = [];

    for (const candidate of candidates) {
      const userKey = String(candidate.user_id);
      summary.perUser[userKey] = summary.perUser[userKey]
        || { candidates: 0, repaired: 0, skipped: 0, ambiguous: 0 };
      summary.perUser[userKey].candidates += 1;

      if (candidate.detection === 'ambiguous') {
        summary.ambiguous += 1;
        summary.perUser[userKey].ambiguous += 1;
        recordAmbiguousIssue(db, runId, candidate);
        summary.details.push({
          taskId: candidate.twin_nexus_task_id,
          userId: candidate.user_id,
          provider: candidate.provider,
          providerTaskId: candidate.provider_task_id,
          outcome: 'ambiguous',
          claims: candidate.claims || [],
        });
        continue;
      }

      const tenantKey = candidate.tenant_id ?? candidate.user_id;
      // Fresh reads: an earlier candidate in this run may have touched the
      // same survivor (two twins merging into one canonical task).
      const survivorRow = db.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(candidate.survivor_row_id);
      const twinRow = db.prepare('SELECT * FROM unified_tasks WHERE id = ?').get(candidate.twin_row_id);
      if (!survivorRow || survivorRow.is_deleted !== 0 || !twinRow || twinRow.is_deleted !== 0) {
        summary.skipped += 1;
        summary.perUser[userKey].skipped += 1;
        summary.details.push({
          taskId: candidate.twin_nexus_task_id,
          userId: candidate.user_id,
          outcome: 'skipped:row_state_changed',
        });
        continue;
      }
      const twinNexusId = candidate.twin_nexus_task_id;
      const survivorNexusId = candidate.survivor_nexus_task_id;
      const twinData = parseJson(twinRow.provider_data, {});

      // Marker path only: adopt the twin's provider id onto the survivor's
      // link slot (the Microsoft-move shape) BEFORE the common repair, so
      // the provider task stays reachable once the twin's identity retires.
      if (candidate.detection === 'marker') {
        const oldLinks = db.prepare(
          `SELECT * FROM task_provider_links
           WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
             AND provider = ? AND provider_account_id = ? AND link_state NOT IN ('orphaned')`,
        ).all(candidate.user_id, tenantKey, survivorNexusId, candidate.provider, candidate.provider_account_id);
        let carriedListId = null;
        let carriedProjectId = null;
        for (const link of oldLinks) {
          carriedListId = carriedListId ?? link.provider_list_id;
          carriedProjectId = carriedProjectId ?? link.provider_project_id;
          db.prepare(
            `UPDATE task_provider_links SET link_state = 'orphaned', updated_at = datetime('now') WHERE id = ?`,
          ).run(link.id);
        }
        const containerId = providerContainerIdFromData(twinData);
        db.prepare(
          `INSERT INTO task_provider_links (
             id, task_id, tenant_id, user_id, provider, provider_account_id,
             provider_task_id, provider_list_id, provider_project_id,
             last_synced_at, last_verified_at, ownership, link_state
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), 'nexus_created', 'linked')
           ON CONFLICT(tenant_id, user_id, provider, provider_account_id, provider_task_id)
           DO UPDATE SET
             task_id = excluded.task_id,
             provider_list_id = COALESCE(task_provider_links.provider_list_id, excluded.provider_list_id),
             provider_project_id = COALESCE(task_provider_links.provider_project_id, excluded.provider_project_id),
             link_state = 'linked',
             last_synced_at = datetime('now'),
             updated_at = datetime('now')`,
        ).run(
          `task_link_${crypto.randomBytes(16).toString('hex')}`,
          survivorNexusId,
          tenantKey,
          candidate.user_id,
          candidate.provider,
          candidate.provider_account_id,
          candidate.provider_task_id,
          candidate.provider === 'ms_todo' ? (containerId ?? carriedListId) : carriedListId,
          candidate.provider === 'todoist' ? (containerId ?? carriedProjectId) : carriedProjectId,
        );
      }

      // 1. Metadata merge: fill the survivor's NULL/empty fields only.
      const mergedFields = [];
      const sets = [];
      const args = [];
      for (const field of MERGE_FIELDS) {
        if (isEmptyValue(survivorRow[field]) && !isEmptyValue(twinRow[field])) {
          sets.push(`${field} = ?`);
          args.push(twinRow[field]);
          mergedFields.push(field);
        }
      }
      let mergedDueDate = null;
      if (isEmptyValue(survivorRow.due_date) && !isEmptyValue(twinRow.due_date)) {
        sets.push('due_date = ?', 'due_is_datetime = ?');
        args.push(twinRow.due_date, twinRow.due_is_datetime ?? 0);
        mergedFields.push('due_date');
        mergedDueDate = twinRow.due_date;
      }

      // 2. Checklist union into the survivor's provider_data.
      const survivorData = parseJson(survivorRow.provider_data, {});
      const checklist = unionChecklists(survivorData.checklistItems, twinData.checklistItems);
      if (checklist.changed) {
        survivorData.checklistItems = checklist.union;
        sets.push('provider_data = ?');
        args.push(JSON.stringify(survivorData));
        summary.checklistItemsAdded += checklist.added;
        summary.checklistIdsAdopted += checklist.adopted;
        summary.checklistDuplicatesCollapsed += checklist.collapsedLosses.length;
      }

      if (sets.length > 0) {
        if (mergedDueDate != null) {
          // due_date participates in the pull change-detection hash; refresh
          // it so the next identical provider pull stays on the no-write hot
          // path and preserves the merged provider_data.
          sets.push('content_hash = ?');
          args.push(computeRowContentHash({ ...survivorRow, due_date: mergedDueDate }));
        }
        sets.push("updated_at = datetime('now')");
        db.prepare(`UPDATE unified_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, survivorRow.id);
      }

      // 3. Tombstone the twin and retire its identity. sync_state='synced'
      // (NOT deleted_pending_sync) keeps every push path away from the
      // still-live provider task; the retired external_id can never collide
      // with future imports nor win getTaskRowByAnyTaskId's external_id tie.
      const retiredExternalId = `retired:${twinRow.external_id}:${twinRow.id}`;
      twinData.merged_into = survivorNexusId;
      db.prepare(
        `UPDATE unified_tasks SET
           is_deleted = 1,
           deleted_at = datetime('now'),
           sync_state = 'synced',
           external_id = ?,
           provider_data = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(retiredExternalId, JSON.stringify(twinData), twinRow.id);

      // 4. Mutations: cancel the twin's pending deletes (the provider task
      // survives), remap its other pending mutations onto the survivor.
      const superseded = db.prepare(
        `UPDATE task_mutations SET
           status = 'synced', locked_at = NULL, last_error_code = 'twin_repair_superseded'
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND operation = 'task.delete'
           AND status IN (${PENDING_MUTATION_STATUSES.map(() => '?').join(', ')})`,
      ).run(candidate.user_id, tenantKey, twinNexusId, ...PENDING_MUTATION_STATUSES);
      const remapped = db.prepare(
        `UPDATE task_mutations SET task_id = ?
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND operation != 'task.delete'
           AND status IN (${PENDING_MUTATION_STATUSES.map(() => '?').join(', ')})`,
      ).run(survivorNexusId, candidate.user_id, tenantKey, twinNexusId, ...PENDING_MUTATION_STATUSES);
      summary.mutationsSuperseded += superseded.changes;
      summary.mutationsRemapped += remapped.changes;

      // 5. The twin holds no active links after repair (belt-and-braces: the
      // canonical link points at the survivor already; the marker path just
      // re-pointed the twin's own slot row to the survivor above).
      const twinLinks = db.prepare(
        `UPDATE task_provider_links SET link_state = 'orphaned', updated_at = datetime('now')
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND link_state NOT IN ('orphaned')`,
      ).run(candidate.user_id, tenantKey, twinNexusId);
      summary.twinLinksOrphaned += twinLinks.changes;

      // 6. Survivor cleanup: orphan a redundant same-provider link with no
      // provider_task_id when a linked one exists (pre-migration-234 R1-b
      // leftovers), carrying its container onto the kept link if missing.
      // The survivor's canonical link — including ownership — stays as-is.
      const survivorLinks = db.prepare(
        `SELECT * FROM task_provider_links
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND provider = ? AND link_state NOT IN ('orphaned')
         ORDER BY id`,
      ).all(candidate.user_id, tenantKey, survivorNexusId, candidate.provider);
      const keptLink = survivorLinks.find((link) => link.provider_task_id != null);
      if (keptLink) {
        for (const link of survivorLinks) {
          if (link.id === keptLink.id || link.provider_task_id != null) continue;
          db.prepare(
            `UPDATE task_provider_links SET
               provider_list_id = COALESCE(provider_list_id, ?),
               provider_project_id = COALESCE(provider_project_id, ?),
               updated_at = datetime('now')
             WHERE id = ?`,
          ).run(link.provider_list_id, link.provider_project_id, keptLink.id);
          db.prepare(
            `UPDATE task_provider_links SET link_state = 'orphaned', updated_at = datetime('now') WHERE id = ?`,
          ).run(link.id);
          summary.redundantLinksOrphaned += 1;
        }
      }

      summary.repaired += 1;
      summary.perUser[userKey].repaired += 1;
      repairedCandidates.push(candidate);
      summary.details.push({
        taskId: twinNexusId,
        survivorTaskId: survivorNexusId,
        userId: candidate.user_id,
        provider: candidate.provider,
        providerTaskId: candidate.provider_task_id,
        outcome: `repaired:${candidate.detection}`,
        mergedFields,
        mutationsSuperseded: superseded.changes,
        mutationsRemapped: remapped.changes,
        checklist: {
          added: checklist.added,
          idsAdopted: checklist.adopted,
          acceptedLosses: checklist.collapsedLosses,
        },
      });
    }

    // Validation: fail closed (throw -> rollback) if any repaired provider
    // task id does not resolve to exactly its survivor, if a survivor holds
    // duplicate active links in one provider slot, or if a twin retains
    // active links or claimable mutations.
    for (const candidate of repairedCandidates) {
      const tenantKey = candidate.tenant_id ?? candidate.user_id;
      const reachable = db.prepare(
        `SELECT t.id FROM unified_tasks t
         WHERE t.user_id = ? AND COALESCE(t.tenant_id, t.user_id) = ?
           AND t.provider = ? AND t.external_id = ? AND t.is_deleted = 0
         UNION
         SELECT t.id FROM task_provider_links l
         JOIN unified_tasks t
           ON t.nexus_task_id = l.task_id
          AND t.user_id = l.user_id
          AND COALESCE(t.tenant_id, t.user_id) = COALESCE(l.tenant_id, l.user_id)
         WHERE l.user_id = ? AND COALESCE(l.tenant_id, l.user_id) = ?
           AND l.provider = ? AND l.provider_task_id = ?
           AND l.link_state NOT IN ('orphaned') AND t.is_deleted = 0`,
      ).all(
        candidate.user_id, tenantKey, candidate.provider, candidate.provider_task_id,
        candidate.user_id, tenantKey, candidate.provider, candidate.provider_task_id,
      );
      if (reachable.length !== 1 || reachable[0].id !== candidate.survivor_row_id) {
        throw new Error(
          `Validation failed: provider task ${candidate.provider_task_id} resolves to ${reachable.length} live row(s) instead of exactly its survivor`,
        );
      }
      const slotDuplicates = db.prepare(
        `SELECT provider, provider_account_id, COUNT(*) AS links
         FROM task_provider_links
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND link_state NOT IN ('orphaned')
         GROUP BY provider, provider_account_id
         HAVING links > 1`,
      ).all(candidate.user_id, tenantKey, candidate.survivor_nexus_task_id);
      if (slotDuplicates.length > 0) {
        throw new Error(
          `Validation failed: survivor ${candidate.survivor_nexus_task_id} holds duplicate active links in a provider slot`,
        );
      }
      const twinActiveLinks = db.prepare(
        `SELECT COUNT(*) AS count FROM task_provider_links
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND link_state NOT IN ('orphaned')`,
      ).get(candidate.user_id, tenantKey, candidate.twin_nexus_task_id).count;
      const twinOpenMutations = db.prepare(
        `SELECT COUNT(*) AS count FROM task_mutations
         WHERE user_id = ? AND COALESCE(tenant_id, user_id) = ? AND task_id = ?
           AND status IN (${OPEN_MUTATION_STATUSES.map(() => '?').join(', ')})`,
      ).get(candidate.user_id, tenantKey, candidate.twin_nexus_task_id, ...OPEN_MUTATION_STATUSES).count;
      if (twinActiveLinks > 0 || twinOpenMutations > 0) {
        throw new Error(
          `Validation failed: twin ${candidate.twin_nexus_task_id} retains ${twinActiveLinks} active link(s) and ${twinOpenMutations} open mutation(s)`,
        );
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
    const summary = runTaskTwinRepair(db, { apply, userId });
    const outDir = path.join(root, '.local', 'twin-repair');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${summary.runId}.json`);
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
    if (asJson) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(`[${summary.mode}] run ${summary.runId}`);
      console.log(`candidates=${summary.candidates} repaired=${summary.repaired} skipped=${summary.skipped} ambiguous=${summary.ambiguous} mutationsSuperseded=${summary.mutationsSuperseded} mutationsRemapped=${summary.mutationsRemapped} checklistAdded=${summary.checklistItemsAdded} checklistLosses=${summary.checklistDuplicatesCollapsed}`);
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
