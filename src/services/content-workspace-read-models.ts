// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Tenant-scoped operational read models for the canonical Content workspace.
 *
 * These projections deliberately read only the canonical workspace root,
 * immutable artifacts/revisions, workflow events, and Secretary-owned work
 * schedule bindings. The frozen `content_pipeline` and `content_topics`
 * tables are rollback/export archives and must never inform live guidance.
 */

import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { getDb } from './database';
import type { ContentWorkspaceScope } from './content-workspace';
import {
  isContentWorkScheduleAuthorityAvailable,
  loadContentWorkScheduleSummaries,
} from './content-workspace-schedule-summary';

export const CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION =
  'content-workspace-operational-read-model-v1' as const;
export const CONTENT_WORKSPACE_TODAY_SUMMARY_SCHEMA_VERSION =
  'content-workspace-today-summary-v1' as const;

export type ContentWorkspacePipelineStage = 'approved' | 'scripted' | 'filming' | 'editing' | 'published';

export interface ContentWorkspacePipelineStats {
  schemaVersion: typeof CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION;
  availability: 'available';
  source: 'content_workspace';
  stages: Record<ContentWorkspacePipelineStage, number>;
  stageTracking: Record<ContentWorkspacePipelineStage, {
    tracking: 'canonical' | 'derived' | 'not_modeled';
    source: string | null;
    reasonCode: string | null;
  }>;
  bottleneck: { stage: 'approved' | 'scripted'; count: number; avgDays: number } | null;
  publishedThisWeek: number;
  totalActive: number;
}

export interface ContentWorkspacePipelineOperationalMetrics {
  schemaVersion: typeof CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION;
  availability: 'available';
  source: 'content_workspace';
  approvalToPublishRate: number;
  approvalToScriptRate: number;
  avgDaysPerStage: Record<string, number>;
  staleInventory: Array<{
    id: number;
    title: string;
    stage: 'approved' | 'scripted';
    daysStuck: number;
    niche: null;
  }>;
  formatDistribution: Record<string, number>;
  weeklyThroughput: number[];
  totalEverEntered: number;
  totalPublished: number;
}

export interface ContentWorkspaceRecentItem {
  id: number;
  topicTitle: string;
  niche: null;
  stage: 'approved' | 'scripted' | 'published';
  productionState: string;
  artifactPhase: string;
  createdAt: string;
  updatedAt: string;
  publishedUrl: null;
  publishedAt: string | null;
  publicationEvidence: 'canonical_workflow_event' | 'not_recorded';
}

export interface ContentWorkspaceSummaryCounts {
  schemaVersion: typeof CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION;
  availability: 'available';
  source: 'content_workspace';
  ideasNeedingReview: number;
  scriptsInProgress: number;
  scheduledThisWeek: number;
  scheduleAttentionThisWeek: number;
  scheduleAuthorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
  pendingCount: number;
  scheduleSemantics: 'private_work_session';
}

export interface ContentWorkspaceTodaySummary {
  schemaVersion: typeof CONTENT_WORKSPACE_TODAY_SUMMARY_SCHEMA_VERSION;
  source: 'content_workspace_and_secretary';
  complete: boolean;
  itemCount: number;
  inboxCount: number;
  activeCount: number;
  reviewCount: number;
  approvedCount: number;
  publishedCount: number;
  privateWorkBlockCount: number;
  scheduleAttentionCount: number;
  scheduleAuthorityStatus: 'current' | 'partially_unavailable' | 'unavailable';
  scheduleSemantics: 'private_work_session';
  publicationExecution: 'not_performed';
}

export interface ContentWorkspaceRecentScript {
  itemId: number;
  artifactId: number;
  revisionNumber: number;
  topic: string;
  text: string;
  createdAt: string;
}

export interface ResolvedContentWorkspaceIdentifier {
  itemId: number;
  resolvedAs: 'workspace_item' | 'legacy_pipeline_binding';
  requestedId: number;
}

export class ContentWorkspaceReadModelError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ContentWorkspaceReadModelError';
  }
}

type WorkspaceOperationalRow = {
  id: number;
  title: string;
  production_state: string;
  artifact_phase: string;
  format_id: string | null;
  created_at: string;
  updated_at: string;
  days_stuck: number;
  has_script: number;
  published_at: string | null;
};

const ACTIVE_ITEM_SCOPE_SQL = `
  item.tenant_id = ?
  AND item.owner_user_id = ?
  AND item.visibility_scope = 'user_private'
  AND item.scope_status = 'active'
  AND item.deleted_at IS NULL
  AND item.object_type = 'content_item'
`;

export function getContentWorkspacePipelineStats(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
  now = new Date(),
): ContentWorkspacePipelineStats {
  const scope = normalizeScope(scopeInput);
  const rows = readOperationalRows(scope, db, now);
  const stages = emptyStages();
  const stuckByStage: Record<'approved' | 'scripted', number[]> = { approved: [], scripted: [] };

  for (const row of rows) {
    const stage = projectPipelineStage(row);
    if (stage === null) continue;
    stages[stage] += 1;
    if ((stage === 'approved' || stage === 'scripted')
      && row.days_stuck > stageThresholdDays(stage)) {
      stuckByStage[stage].push(row.days_stuck);
    }
  }

  const bottlenecks = (Object.entries(stuckByStage) as Array<['approved' | 'scripted', number[]]>)
    .filter(([, durations]) => durations.length > 0)
    .map(([stage, durations]) => ({
      stage,
      count: durations.length,
      avgDays: roundOne(durations.reduce((sum, days) => sum + days, 0) / durations.length),
    }))
    .sort((left, right) => right.count - left.count || right.avgDays - left.avgDays);

  return {
    schemaVersion: CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION,
    availability: 'available',
    source: 'content_workspace',
    stages,
    stageTracking: {
      approved: { tracking: 'derived', source: 'production_state+artifact_phase', reasonCode: null },
      scripted: { tracking: 'derived', source: 'artifact_phase+script_artifact', reasonCode: null },
      filming: { tracking: 'not_modeled', source: null, reasonCode: 'CONTENT_FILMING_STATE_NOT_MODELED' },
      editing: { tracking: 'not_modeled', source: null, reasonCode: 'CONTENT_EDITING_STATE_NOT_MODELED' },
      published: { tracking: 'canonical', source: 'production_state+content_workflow_events', reasonCode: null },
    },
    bottleneck: bottlenecks[0] ?? null,
    publishedThisWeek: countPublishedInWindow(scope, db, daysAgo(now, 7), now),
    totalActive: stages.approved + stages.scripted,
  };
}

export function getContentWorkspacePipelineOperationalMetrics(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
  now = new Date(),
): ContentWorkspacePipelineOperationalMetrics {
  const scope = normalizeScope(scopeInput);
  const rows = readOperationalRows(scope, db, now);
  const totalEverEntered = rows.length;
  const totalPublished = countEverPublished(scope, db);
  const totalScripted = rows.filter((row) => row.has_script === 1 || ['draft', 'final'].includes(row.artifact_phase)).length;
  const staleInventory = rows
    .flatMap((row) => {
      const stage = projectPipelineStage(row);
      if ((stage !== 'approved' && stage !== 'scripted') || row.days_stuck <= 3) return [];
      return [{
        id: Number(row.id),
        title: row.title,
        stage,
        daysStuck: roundOne(row.days_stuck),
        niche: null,
      }];
    })
    .sort((left, right) => right.daysStuck - left.daysStuck)
    .slice(0, 20);

  const formatDistribution: Record<string, number> = {};
  for (const row of rows) {
    const stage = projectPipelineStage(row);
    if (stage === null || stage === 'published') continue;
    const format = row.format_id?.trim() || 'unknown';
    formatDistribution[format] = (formatDistribution[format] ?? 0) + 1;
  }

  const weeklyThroughput: number[] = [];
  for (let offset = 4; offset > 0; offset -= 1) {
    const start = daysAgo(now, offset * 7);
    const end = daysAgo(now, (offset - 1) * 7);
    weeklyThroughput.push(countPublishedInWindow(scope, db, start, end));
  }

  return {
    schemaVersion: CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION,
    availability: 'available',
    source: 'content_workspace',
    approvalToPublishRate: percentage(totalPublished, totalEverEntered),
    approvalToScriptRate: percentage(totalScripted, totalEverEntered),
    avgDaysPerStage: averageCanonicalStageDurations(scope, db),
    staleInventory,
    formatDistribution,
    weeklyThroughput,
    totalEverEntered,
    totalPublished,
  };
}

export function getContentWorkspaceRecentItems(
  scopeInput: ContentWorkspaceScope,
  limit = 30,
  db: Database.Database = getDb(),
  now = new Date(),
): ContentWorkspaceRecentItem[] {
  const scope = normalizeScope(scopeInput);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_READ_LIMIT_INVALID',
      'Content workspace read limit must be between 1 and 200.',
      400,
    );
  }
  return readOperationalRows(scope, db, now)
    .flatMap((row) => {
      const stage = projectPipelineStage(row);
      if (stage === null) return [];
      return [{
        id: Number(row.id),
        topicTitle: row.title,
        niche: null,
        stage,
        productionState: row.production_state,
        artifactPhase: row.artifact_phase,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        publishedUrl: null,
        publishedAt: row.published_at,
        publicationEvidence: row.published_at == null ? 'not_recorded' as const : 'canonical_workflow_event' as const,
      }];
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id - left.id)
    .slice(0, limit);
}

export function getContentWorkspaceSummaryCounts(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
  now = new Date(),
  timezone = 'UTC',
): ContentWorkspaceSummaryCounts {
  const scope = normalizeScope(scopeInput);
  const itemCounts = db.prepare(`
    SELECT
      SUM(CASE WHEN item.production_state = 'review' THEN 1 ELSE 0 END) AS ideas_needing_review,
      SUM(CASE WHEN item.production_state IN ('inbox', 'active', 'review', 'approved') THEN 1 ELSE 0 END) AS pending_count,
      COUNT(DISTINCT CASE
        WHEN item.production_state NOT IN ('published', 'archived', 'rejected')
         AND artifact.artifact_type = 'script'
         AND artifact.scope_status = 'active'
         AND artifact.current_revision_id IS NOT NULL
        THEN item.id END
      ) AS scripts_in_progress
    FROM content_domain_objects item
    LEFT JOIN content_artifacts artifact
      ON artifact.item_id = item.id
     AND artifact.tenant_id = item.tenant_id
     AND artifact.owner_user_id = item.owner_user_id
    WHERE ${ACTIVE_ITEM_SCOPE_SQL}
  `).get(scope.tenantId, scope.userId) as {
    ideas_needing_review: unknown;
    pending_count: unknown;
    scripts_in_progress: unknown;
  } | undefined;
  const itemIds = readActiveContentItemIds(scope, db);
  const weekWindow = nextSevenDayWindow(now, timezone);
  const scheduleCounts = summarizeSchedulesInWindow(scope, itemIds, weekWindow, db);

  return {
    schemaVersion: CONTENT_WORKSPACE_OPERATIONAL_READ_MODEL_SCHEMA_VERSION,
    availability: 'available',
    source: 'content_workspace',
    ideasNeedingReview: safeCount(itemCounts?.ideas_needing_review),
    scriptsInProgress: safeCount(itemCounts?.scripts_in_progress),
    scheduledThisWeek: scheduleCounts.confirmed,
    scheduleAttentionThisWeek: scheduleCounts.attention,
    scheduleAuthorityStatus: scheduleCounts.authorityStatus,
    pendingCount: safeCount(itemCounts?.pending_count),
    scheduleSemantics: 'private_work_session',
  };
}

/**
 * Complete, non-paginated dashboard counts. List endpoints intentionally stay
 * bounded; Today must never present the first page as a total. Secretary's
 * safe schedule projection remains authoritative for private work blocks.
 */
export function getContentWorkspaceTodaySummary(
  scopeInput: ContentWorkspaceScope,
  db: Database.Database = getDb(),
  now = new Date(),
  timezone = 'UTC',
): ContentWorkspaceTodaySummary {
  const scope = normalizeScope(scopeInput);
  const rows = db.prepare(`
    SELECT item.id, item.production_state
      FROM content_domain_objects item
     WHERE ${ACTIVE_ITEM_SCOPE_SQL}
  `).all(scope.tenantId, scope.userId) as Array<{ id: number; production_state: string }>;
  const counts = {
    inbox: 0,
    active: 0,
    review: 0,
    approved: 0,
    published: 0,
  };
  for (const row of rows) {
    if (row.production_state in counts) {
      counts[row.production_state as keyof typeof counts] += 1;
    }
  }
  let privateWorkBlockCount = 0;
  let scheduleAttentionCount = 0;
  let unavailableScheduleCount = 0;
  let currentScheduleCount = 0;
  const scheduleProjectionAvailable = isContentWorkScheduleAuthorityAvailable(db);
  const todayWindow = localDayWindow(now, timezone);
  for (let offset = 0; scheduleProjectionAvailable && offset < rows.length; offset += 400) {
    const summaries = loadContentWorkScheduleSummaries(
      scope,
      rows.slice(offset, offset + 400).map((row) => Number(row.id)),
      db,
    );
    for (const summary of summaries.values()) {
      if (!timestampInWindow(summary.scheduledStart, todayWindow)) continue;
      if (summary.authorityStatus === 'unavailable') {
        unavailableScheduleCount += 1;
      } else {
        currentScheduleCount += 1;
      }
      if (summary.authorityStatus === 'current'
        && ['scheduled', 'provider_synced'].includes(summary.state)) {
        privateWorkBlockCount += 1;
      }
      if (summary.recoverable) scheduleAttentionCount += 1;
    }
  }
  const scheduleAuthorityStatus: ContentWorkspaceTodaySummary['scheduleAuthorityStatus'] =
    !scheduleProjectionAvailable
      ? 'unavailable'
      : unavailableScheduleCount === 0
      ? 'current'
      : currentScheduleCount === 0
        ? 'unavailable'
        : 'partially_unavailable';
  return {
    schemaVersion: CONTENT_WORKSPACE_TODAY_SUMMARY_SCHEMA_VERSION,
    source: 'content_workspace_and_secretary',
    complete: scheduleProjectionAvailable && unavailableScheduleCount === 0,
    itemCount: rows.length,
    inboxCount: counts.inbox,
    activeCount: counts.active,
    reviewCount: counts.review,
    approvedCount: counts.approved,
    publishedCount: counts.published,
    privateWorkBlockCount,
    scheduleAttentionCount,
    scheduleAuthorityStatus,
    scheduleSemantics: 'private_work_session',
    publicationExecution: 'not_performed',
  };
}

type ScheduleWindow = { startMillis: number; endMillis: number };

function readActiveContentItemIds(
  scope: ContentWorkspaceScope,
  db: Database.Database,
): number[] {
  return (db.prepare(`
    SELECT item.id
      FROM content_domain_objects item
     WHERE ${ACTIVE_ITEM_SCOPE_SQL}
  `).all(scope.tenantId, scope.userId) as Array<{ id: number }>)
    .map((row) => Number(row.id));
}

function summarizeSchedulesInWindow(
  scope: ContentWorkspaceScope,
  itemIds: number[],
  window: ScheduleWindow,
  db: Database.Database,
): {
  confirmed: number;
  attention: number;
  authorityStatus: ContentWorkspaceSummaryCounts['scheduleAuthorityStatus'];
} {
  if (!isContentWorkScheduleAuthorityAvailable(db)) {
    return { confirmed: 0, attention: 0, authorityStatus: 'unavailable' };
  }
  let confirmed = 0;
  let attention = 0;
  let current = 0;
  let unavailable = 0;
  for (let offset = 0; offset < itemIds.length; offset += 400) {
    const summaries = loadContentWorkScheduleSummaries(scope, itemIds.slice(offset, offset + 400), db);
    for (const summary of summaries.values()) {
      if (!timestampInWindow(summary.scheduledStart, window)) continue;
      if (summary.authorityStatus === 'unavailable') unavailable += 1;
      else current += 1;
      if (summary.authorityStatus === 'current'
        && ['scheduled', 'provider_synced'].includes(summary.state)) confirmed += 1;
      if (summary.recoverable) attention += 1;
    }
  }
  return {
    confirmed,
    attention,
    authorityStatus: unavailable === 0
      ? 'current'
      : current === 0
        ? 'unavailable'
        : 'partially_unavailable',
  };
}

function localDayWindow(now: Date, timezone: string): ScheduleWindow {
  const local = validZonedTime(now, timezone);
  return {
    startMillis: local.startOf('day').toUTC().toMillis(),
    endMillis: local.plus({ days: 1 }).startOf('day').toUTC().toMillis(),
  };
}

function nextSevenDayWindow(now: Date, timezone: string): ScheduleWindow {
  const local = validZonedTime(now, timezone);
  return {
    startMillis: local.toUTC().toMillis(),
    endMillis: local.plus({ days: 7 }).toUTC().toMillis(),
  };
}

function validZonedTime(now: Date, timezone: string): DateTime {
  const value = DateTime.fromJSDate(now, { zone: timezone });
  if (!value.isValid) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_TIMEZONE_INVALID',
      'The Content schedule timezone is invalid.',
      400,
    );
  }
  return value;
}

function timestampInWindow(value: string, window: ScheduleWindow): boolean {
  const timestamp = DateTime.fromISO(value, { setZone: true });
  return timestamp.isValid
    && timestamp.toMillis() >= window.startMillis
    && timestamp.toMillis() < window.endMillis;
}

/**
 * Returns the authoritative current script revisions used by downstream
 * learning agents. Superseded revisions and the frozen `content_scripts`
 * compatibility archive are intentionally excluded.
 */
export function getRecentContentWorkspaceScripts(
  scopeInput: ContentWorkspaceScope,
  days = 30,
  limit = 10,
  db: Database.Database = getDb(),
): ContentWorkspaceRecentScript[] {
  const scope = normalizeScope(scopeInput);
  if (!Number.isSafeInteger(days) || days < 1 || days > 3650) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_SCRIPT_WINDOW_INVALID',
      'Content script history window must be between 1 and 3650 days.',
      400,
    );
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_READ_LIMIT_INVALID',
      'Content workspace read limit must be between 1 and 200.',
      400,
    );
  }

  const rows = db.prepare(`
    SELECT item.id AS item_id,
           item.title AS topic,
           artifact.id AS artifact_id,
           revision.revision_number,
           revision.content_format,
           revision.content_text,
           revision.structured_content_json,
           revision.created_at
      FROM content_domain_objects item
      JOIN content_artifacts artifact
        ON artifact.item_id = item.id
       AND artifact.tenant_id = item.tenant_id
       AND artifact.owner_user_id = item.owner_user_id
      JOIN content_revisions revision
        ON revision.id = artifact.current_revision_id
       AND revision.artifact_id = artifact.id
       AND revision.tenant_id = artifact.tenant_id
       AND revision.owner_user_id = artifact.owner_user_id
     WHERE ${ACTIVE_ITEM_SCOPE_SQL}
       AND artifact.visibility_scope = 'user_private'
       AND artifact.scope_status = 'active'
       AND artifact.artifact_type IN ('script', 'platform_variant')
       AND datetime(revision.created_at) >= datetime('now', ?)
     ORDER BY datetime(revision.created_at) DESC, revision.id DESC
     LIMIT ?
  `).all(scope.tenantId, scope.userId, `-${days} days`, limit) as Array<{
    item_id: number;
    topic: string;
    artifact_id: number;
    revision_number: number;
    content_format: string;
    content_text: string | null;
    structured_content_json: string | null;
    created_at: string;
  }>;

  return rows.flatMap((row) => {
    const text = row.content_format === 'structured_json'
      ? readableStructuredRevision(row.structured_content_json)
      : row.content_text?.trim() ?? '';
    if (!text) return [];
    return [{
      itemId: Number(row.item_id),
      artifactId: Number(row.artifact_id),
      revisionNumber: Number(row.revision_number),
      topic: row.topic,
      text,
      createdAt: row.created_at,
    }];
  });
}

/** Resolve a canonical item ID or a scoped legacy pipeline compatibility ID. */
export function resolveContentWorkspaceIdentifier(
  scopeInput: ContentWorkspaceScope,
  requestedId: number,
  db: Database.Database = getDb(),
): ResolvedContentWorkspaceIdentifier | null {
  const scope = normalizeScope(scopeInput);
  if (!Number.isSafeInteger(requestedId) || requestedId <= 0) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_IDENTIFIER_INVALID',
      'Content identifier must be a positive integer.',
      400,
    );
  }
  const direct = db.prepare(`
    SELECT item.id
      FROM content_domain_objects item
     WHERE item.id = ? AND ${ACTIVE_ITEM_SCOPE_SQL}
     LIMIT 1
  `).get(requestedId, scope.tenantId, scope.userId) as { id: number } | undefined;
  const migrated = db.prepare(`
    SELECT binding.item_id
      FROM content_workspace_ingress_bindings binding
      JOIN content_domain_objects item
        ON item.id = binding.item_id
       AND item.tenant_id = binding.tenant_id
       AND item.owner_user_id = binding.owner_user_id
     WHERE binding.tenant_id = ?
       AND binding.owner_user_id = ?
       AND binding.source_kind = 'legacy_pipeline'
       AND binding.source_id = ?
       AND ${ACTIVE_ITEM_SCOPE_SQL}
     LIMIT 1
  `).get(scope.tenantId, scope.userId, String(requestedId), scope.tenantId, scope.userId) as {
    item_id: number;
  } | undefined;

  if (direct && migrated && Number(direct.id) !== Number(migrated.item_id)) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_IDENTIFIER_AMBIGUOUS',
      'The legacy identifier conflicts with a canonical workspace item ID.',
      409,
    );
  }
  if (migrated) {
    return { itemId: Number(migrated.item_id), resolvedAs: 'legacy_pipeline_binding', requestedId };
  }
  if (direct) {
    return { itemId: Number(direct.id), resolvedAs: 'workspace_item', requestedId };
  }
  return null;
}

function readOperationalRows(
  scope: ContentWorkspaceScope,
  db: Database.Database,
  now: Date,
): WorkspaceOperationalRow[] {
  return db.prepare(`
    SELECT item.id,
           item.title,
           item.production_state,
           item.artifact_phase,
           item.format_id,
           item.created_at,
           item.updated_at,
           MAX(0, julianday(?) - julianday(item.updated_at)) AS days_stuck,
           CASE WHEN EXISTS (
             SELECT 1
               FROM content_artifacts artifact
              WHERE artifact.tenant_id = item.tenant_id
                AND artifact.owner_user_id = item.owner_user_id
                AND artifact.item_id = item.id
                AND artifact.scope_status = 'active'
                AND artifact.artifact_type = 'script'
                AND artifact.current_revision_id IS NOT NULL
           ) THEN 1 ELSE 0 END AS has_script,
           (
             SELECT MAX(event.created_at)
               FROM content_workflow_events event
              WHERE event.tenant_id = item.tenant_id
                AND event.owner_user_id = item.owner_user_id
                AND event.visibility_scope = 'user_private'
                AND event.scope_status = 'active'
                AND event.object_type = 'content_item'
                AND event.object_id = CAST(item.id AS TEXT)
                AND event.action = 'workspace_state_changed'
                AND event.to_state = 'published'
           ) AS published_at
      FROM content_domain_objects item
     WHERE ${ACTIVE_ITEM_SCOPE_SQL}
     ORDER BY item.updated_at DESC, item.id DESC
  `).all(now.toISOString(), scope.tenantId, scope.userId) as WorkspaceOperationalRow[];
}

function readableStructuredRevision(raw: string | null): string {
  if (!raw) return '';
  try {
    const value: unknown = JSON.parse(raw);
    const text: string[] = [];
    const visit = (candidate: unknown): void => {
      if (typeof candidate === 'string') {
        const normalized = candidate.trim();
        if (normalized) text.push(normalized);
        return;
      }
      if (Array.isArray(candidate)) {
        for (const entry of candidate) visit(entry);
        return;
      }
      if (candidate && typeof candidate === 'object') {
        for (const entry of Object.values(candidate as Record<string, unknown>)) visit(entry);
      }
    };
    visit(value);
    return text.join('\n');
  } catch {
    return '';
  }
}

function projectPipelineStage(
  row: Pick<WorkspaceOperationalRow, 'production_state' | 'artifact_phase' | 'has_script'>,
): 'approved' | 'scripted' | 'published' | null {
  if (row.production_state === 'published') return 'published';
  if (row.production_state === 'archived' || row.production_state === 'rejected') return null;
  if (row.has_script === 1 || row.artifact_phase === 'draft' || row.artifact_phase === 'final') return 'scripted';
  return 'approved';
}

function countEverPublished(scope: ContentWorkspaceScope, db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT event.object_id) AS count
      FROM content_workflow_events event
      JOIN content_domain_objects item
        ON item.id = CAST(event.object_id AS INTEGER)
       AND item.tenant_id = event.tenant_id
       AND item.owner_user_id = event.owner_user_id
     WHERE event.tenant_id = ?
       AND event.owner_user_id = ?
       AND event.visibility_scope = 'user_private'
       AND event.scope_status = 'active'
       AND event.object_type = 'content_item'
       AND event.action = 'workspace_state_changed'
       AND event.to_state = 'published'
       AND ${ACTIVE_ITEM_SCOPE_SQL}
  `).get(scope.tenantId, scope.userId, scope.tenantId, scope.userId) as { count: unknown } | undefined;
  return safeCount(row?.count);
}

function countPublishedInWindow(
  scope: ContentWorkspaceScope,
  db: Database.Database,
  start: Date,
  end: Date,
): number {
  const row = db.prepare(`
    SELECT COUNT(DISTINCT event.object_id) AS count
      FROM content_workflow_events event
      JOIN content_domain_objects item
        ON item.id = CAST(event.object_id AS INTEGER)
       AND item.tenant_id = event.tenant_id
       AND item.owner_user_id = event.owner_user_id
     WHERE event.tenant_id = ?
       AND event.owner_user_id = ?
       AND event.visibility_scope = 'user_private'
       AND event.scope_status = 'active'
       AND event.object_type = 'content_item'
       AND event.action = 'workspace_state_changed'
       AND event.to_state = 'published'
       AND julianday(event.created_at) >= julianday(?)
       AND julianday(event.created_at) < julianday(?)
       AND ${ACTIVE_ITEM_SCOPE_SQL}
  `).get(
    scope.tenantId,
    scope.userId,
    start.toISOString(),
    end.toISOString(),
    scope.tenantId,
    scope.userId,
  ) as { count: unknown } | undefined;
  return safeCount(row?.count);
}

function averageCanonicalStageDurations(
  scope: ContentWorkspaceScope,
  db: Database.Database,
): Record<string, number> {
  const events = db.prepare(`
    SELECT event.object_id, event.from_state, event.to_state, event.created_at
      FROM content_workflow_events event
      JOIN content_domain_objects item
        ON item.id = CAST(event.object_id AS INTEGER)
       AND item.tenant_id = event.tenant_id
       AND item.owner_user_id = event.owner_user_id
     WHERE event.tenant_id = ?
       AND event.owner_user_id = ?
       AND event.visibility_scope = 'user_private'
       AND event.scope_status = 'active'
       AND event.object_type = 'content_item'
       AND event.action = 'workspace_state_changed'
       AND ${ACTIVE_ITEM_SCOPE_SQL}
     ORDER BY event.object_id ASC, event.created_at ASC, event.id ASC
  `).all(scope.tenantId, scope.userId, scope.tenantId, scope.userId) as Array<{
    object_id: string;
    from_state: string | null;
    to_state: string | null;
    created_at: string;
  }>;
  const previousByItem = new Map<string, { toState: string | null; at: number }>();
  const durations = new Map<string, number[]>();
  for (const event of events) {
    const at = sqliteTimestampMillis(event.created_at);
    if (at === null) continue;
    const previous = previousByItem.get(event.object_id);
    if (previous && previous.toState) {
      const days = Math.max(0, (at - previous.at) / (24 * 60 * 60 * 1000));
      const values = durations.get(previous.toState) ?? [];
      values.push(days);
      durations.set(previous.toState, values);
    }
    previousByItem.set(event.object_id, { toState: event.to_state ?? event.from_state, at });
  }
  return Object.fromEntries([...durations.entries()].map(([stage, values]) => [
    stage,
    roundOne(values.reduce((sum, value) => sum + value, 0) / values.length),
  ]));
}

function normalizeScope(scope: ContentWorkspaceScope): ContentWorkspaceScope {
  const tenantId = Number(scope?.tenantId);
  const userId = Number(scope?.userId);
  if (!Number.isSafeInteger(tenantId) || tenantId <= 0
    || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_SCOPE_REQUIRED',
      'A valid tenant and user scope is required for Content workspace reads.',
      400,
    );
  }
  return { tenantId, userId };
}

function emptyStages(): Record<ContentWorkspacePipelineStage, number> {
  return { approved: 0, scripted: 0, filming: 0, editing: 0, published: 0 };
}

function stageThresholdDays(stage: 'approved' | 'scripted'): number {
  return stage === 'approved' ? 3 : 7;
}

function percentage(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function safeCount(value: unknown): number {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new ContentWorkspaceReadModelError(
      'CONTENT_WORKSPACE_READ_MODEL_INVALID',
      'Content workspace returned an invalid aggregate.',
      500,
    );
  }
  return count;
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
}

function sqliteTimestampMillis(value: string): number | null {
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value.replace(' ', 'T')}Z`;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
