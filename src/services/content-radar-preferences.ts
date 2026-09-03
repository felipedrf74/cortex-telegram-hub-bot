// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { AgentSignal } from './intelligence-bus';
import {
  contentScopeForInsert,
  contentScopeParams,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';
import { contentTextTokens, foldContentText } from './content-text-utils';
import { safeContentLogErrorFields } from './content-log-safety';

export interface ContentRadarPreferences {
  topics: string[];
  updatedAt: string | null;
}

export interface ContentRadarTopicSummary {
  name: string;
  keywordCount: number;
}

export class ContentRadarPreferencesUnavailableError extends Error {
  readonly code = 'CONTENT_RADAR_PREFERENCES_UNAVAILABLE';
  readonly statusCode = 503;
  readonly retryable = true;

  constructor() {
    super('Content radar preferences are temporarily unavailable.');
    this.name = 'ContentRadarPreferencesUnavailableError';
  }
}

export const CONTENT_RADAR_PREFERENCES_MAX_TOPICS = 12;
export const CONTENT_RADAR_PREFERENCE_MAX_CHARS = 120;

export class ContentRadarPreferencesValidationError extends Error {
  readonly code = 'CONTENT_RADAR_PREFERENCES_INVALID';
  readonly statusCode = 400;
  readonly details = {
    maxTopics: CONTENT_RADAR_PREFERENCES_MAX_TOPICS,
    maxTopicChars: CONTENT_RADAR_PREFERENCE_MAX_CHARS,
  } as const;

  constructor() {
    super('topics must be an array of at most 12 non-empty, single-line strings without commas; each topic is limited to 120 characters');
    this.name = 'ContentRadarPreferencesValidationError';
  }
}

export function validateContentRadarPreferenceTopics(input: unknown): string[] {
  if (!Array.isArray(input) || input.length > CONTENT_RADAR_PREFERENCES_MAX_TOPICS) {
    throw new ContentRadarPreferencesValidationError();
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of input) {
    if (typeof value !== 'string') throw new ContentRadarPreferencesValidationError();
    const topic = value.replace(/\s+/gu, ' ').trim();
    if (!topic
      || topic.length > CONTENT_RADAR_PREFERENCE_MAX_CHARS
      || topic.includes(',')
      || /[\u0000-\u001F\u007F]/u.test(value)) {
      throw new ContentRadarPreferencesValidationError();
    }
    const folded = foldContentText(topic);
    if (seen.has(folded)) continue;
    seen.add(folded);
    normalized.push(topic);
  }
  return normalized;
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_radar_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      scope_status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id)
    )
  `);
  ensureContentTenantScopeColumns(db);
  ensureTenantOwnerPreferenceShape(db);
}

export function getContentRadarPreferences(
  userId: number,
  tenantId?: number,
  options: { strict?: boolean } = {},
): ContentRadarPreferences {
  try {
    ensureTable();
    const row = getDb().prepare(`
      SELECT topics_json, updated_at
      FROM content_radar_preferences
      WHERE tenant_id = ?
        AND owner_user_id = ?
        AND COALESCE(scope_status, 'active') = 'active'
      LIMIT 1
    `).get(...contentScopeParams(userId, tenantId).slice(0, 2)) as { topics_json: string; updated_at: string } | undefined;

    return {
      topics: row ? parseStoredTopics(row.topics_json) : [],
      updatedAt: row?.updated_at ?? null,
    };
  } catch (err) {
    logger.debug({ ...safeContentLogErrorFields(err), userId }, 'content radar preferences lookup failed');
    if (options.strict) throw new ContentRadarPreferencesUnavailableError();
    return { topics: [], updatedAt: null };
  }
}

export function setContentRadarPreferences(userId: number, topics: string[], tenantId?: number): ContentRadarPreferences {
  const normalizedTopics = validateContentRadarPreferenceTopics(topics);
  try {
    ensureTable();
    const scope = contentScopeForInsert(userId, tenantId);
    getDb().prepare(`
      INSERT INTO content_radar_preferences (
        user_id, topics_json, updated_at, tenant_id, owner_user_id, visibility_scope,
        lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json, created_at
      )
      VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(tenant_id, owner_user_id) DO UPDATE SET
        user_id = excluded.user_id,
        topics_json = excluded.topics_json,
        visibility_scope = excluded.visibility_scope,
        lifecycle_state = excluded.lifecycle_state,
        scope_status = excluded.scope_status,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `).run(
      userId,
      JSON.stringify(normalizedTopics),
      scope.tenantId,
      scope.ownerUserId,
      scope.visibilityScope,
      scope.lifecycleState,
      scope.scopeStatus,
      scope.createdBy,
      scope.updatedBy,
      scope.auditMetadataJson,
    );

    return getContentRadarPreferences(userId, tenantId, { strict: true });
  } catch (error) {
    logger.warn(
      { ...safeContentLogErrorFields(error), userId },
      'content radar preferences write failed',
    );
    if (error instanceof ContentRadarPreferencesUnavailableError) throw error;
    throw new ContentRadarPreferencesUnavailableError();
  }
}

export function filterSignalsForRadarPreferences(
  signals: AgentSignal[],
  topics: string[],
): AgentSignal[] {
  const normalizedTopics = normalizeTopics(topics);
  if (normalizedTopics.length === 0) return signals;

  return signals.filter((signal) => {
    const haystack = foldContentText(JSON.stringify({
      type: signal.signal_type,
      title: signal.payload?.title,
      topic: signal.payload?.topic,
      keyword: signal.payload?.keyword,
      summary: signal.payload?.summary,
      reason: signal.payload?.reason,
      description: signal.payload?.description,
      observation: signal.payload?.observation,
      note: signal.payload?.note,
      pillar: signal.payload?.pillar,
      channel: signal.payload?.channel,
      reaction_angle: signal.payload?.reaction_angle,
      your_counter_position: signal.payload?.your_counter_position,
    }));

    return normalizedTopics.some((topic) => {
      const foldedTopic = foldContentText(topic);
      if (haystack.includes(foldedTopic)) return true;
      const tokens = contentTextTokens(foldedTopic);
      return tokens.length > 0 && tokens.every((token) => haystack.includes(token));
    });
  });
}

export function buildRadarTopicSummaries(
  topics: string[],
  signals: AgentSignal[],
): ContentRadarTopicSummary[] {
  return normalizeTopics(topics).map((topic) => ({
    name: topic,
    keywordCount: Math.max(1, countSignalMatches(topic, signals)),
  }));
}

function countSignalMatches(topic: string, signals: AgentSignal[]): number {
  const foldedTopic = foldContentText(topic);
  return signals.reduce((count, signal) => {
    const haystack = foldContentText(JSON.stringify(signal.payload || {}));
    return haystack.includes(foldedTopic) ? count + 1 : count;
  }, 0);
}

function normalizeTopics(topics: string[], maxTopics = CONTENT_RADAR_PREFERENCES_MAX_TOPICS): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of topics) {
    const candidates = raw.split(',').map((part) => part.replace(/\s+/g, ' ').trim());
    for (const trimmed of candidates) {
      if (!trimmed) continue;
      const folded = foldContentText(trimmed);
      if (seen.has(folded)) continue;
      seen.add(folded);
      ordered.push(trimmed);
      if (ordered.length >= maxTopics) return ordered;
    }
  }
  return ordered;
}

function parseStoredTopics(raw: unknown): string[] {
  if (typeof raw !== 'string') throw new Error('Stored radar topics have an invalid shape.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Stored radar topics have an invalid shape.');
  }
  if (!Array.isArray(parsed)
    || parsed.some((value) => typeof value !== 'string'
      || !value.trim()
      || value.length > CONTENT_RADAR_PREFERENCE_MAX_CHARS
      || /[\u0000-\u001F\u007F]/u.test(value))) {
    throw new Error('Stored radar topics have an invalid shape.');
  }
  // Preserve the legacy comma-separated read convention, but never truncate
  // an overfilled expansion into apparently confirmed preference truth.
  const normalized = normalizeTopics(parsed as string[], Number.POSITIVE_INFINITY);
  if (normalized.length > CONTENT_RADAR_PREFERENCES_MAX_TOPICS) {
    throw new Error('Stored radar topics exceed the supported preference limit.');
  }
  return normalized;
}

function ensureTenantOwnerPreferenceShape(db: any): void {
  const columns = tableColumns(db, 'content_radar_preferences');
  if (columns.has('id')) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_owner
        ON content_radar_preferences(tenant_id, owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_scope
        ON content_radar_preferences(tenant_id, owner_user_id, visibility_scope, scope_status);
    `);
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS content_radar_preferences__tenant_owner (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      topics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      tenant_id INTEGER NOT NULL,
      owner_user_id INTEGER NOT NULL,
      visibility_scope TEXT NOT NULL DEFAULT 'user_private',
      lifecycle_state TEXT NOT NULL DEFAULT 'active',
      scope_status TEXT NOT NULL DEFAULT 'active',
      created_by INTEGER NOT NULL,
      updated_by INTEGER NOT NULL,
      audit_metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(tenant_id, owner_user_id)
    );
    INSERT OR IGNORE INTO content_radar_preferences__tenant_owner (
      user_id, topics_json, updated_at, tenant_id, owner_user_id, visibility_scope,
      lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json, created_at
    )
    SELECT
      CASE WHEN user_id > 0 THEN user_id ELSE COALESCE(owner_user_id, 0) END,
      COALESCE(topics_json, '[]'),
      COALESCE(updated_at, datetime('now')),
      COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
      COALESCE(owner_user_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
      COALESCE(visibility_scope, CASE WHEN user_id > 0 THEN 'user_private' ELSE 'platform_internal' END),
      COALESCE(lifecycle_state, 'active'),
      COALESCE(scope_status, CASE WHEN user_id > 0 THEN 'active' ELSE 'quarantined' END),
      COALESCE(created_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
      COALESCE(updated_by, CASE WHEN user_id > 0 THEN user_id ELSE 0 END),
      COALESCE(audit_metadata_json, '{}'),
      COALESCE(updated_at, datetime('now'))
    FROM content_radar_preferences
    WHERE COALESCE(tenant_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) > 0
      AND COALESCE(owner_user_id, CASE WHEN user_id > 0 THEN user_id ELSE 0 END) > 0;
    DROP TABLE content_radar_preferences;
    ALTER TABLE content_radar_preferences__tenant_owner RENAME TO content_radar_preferences;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_owner
      ON content_radar_preferences(tenant_id, owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_content_radar_preferences_tenant_scope
      ON content_radar_preferences(tenant_id, owner_user_id, visibility_scope, scope_status);
  `);
}

function tableColumns(db: any, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}
