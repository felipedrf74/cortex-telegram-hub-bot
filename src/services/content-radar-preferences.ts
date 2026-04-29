// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from './database';
import { logger } from '../utils/logger';
import type { AgentSignal } from './intelligence-bus';
import {
  contentScopeForInsert,
  contentScopeParams,
  contentScopePredicate,
  ensureContentTenantScopeColumns,
} from './content-tenant-scope';

export interface ContentRadarPreferences {
  topics: string[];
  updatedAt: string | null;
}

export interface ContentRadarTopicSummary {
  name: string;
  keywordCount: number;
}

function ensureTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS content_radar_preferences (
      user_id INTEGER PRIMARY KEY,
      topics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  ensureContentTenantScopeColumns(getDb());
}

export function getContentRadarPreferences(userId: number, tenantId?: number): ContentRadarPreferences {
  try {
    ensureTable();
    const row = getDb().prepare(`
      SELECT topics_json, updated_at
      FROM content_radar_preferences
      WHERE ${contentScopePredicate()}
      LIMIT 1
    `).get(...contentScopeParams(userId, tenantId)) as { topics_json: string; updated_at: string } | undefined;

    return {
      topics: row ? normalizeTopics(safeJsonArray(row.topics_json)) : [],
      updatedAt: row?.updated_at ?? null,
    };
  } catch (err) {
    logger.debug({ err, userId }, 'content radar preferences lookup failed');
    return { topics: [], updatedAt: null };
  }
}

export function setContentRadarPreferences(userId: number, topics: string[], tenantId?: number): ContentRadarPreferences {
  ensureTable();
  const normalizedTopics = normalizeTopics(topics);
  const scope = contentScopeForInsert(userId, tenantId);
  getDb().prepare(`
    INSERT INTO content_radar_preferences (
      user_id, topics_json, updated_at, tenant_id, owner_user_id, visibility_scope,
      lifecycle_state, scope_status, created_by, updated_by, audit_metadata_json
    )
    VALUES (?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      topics_json = excluded.topics_json,
      tenant_id = excluded.tenant_id,
      owner_user_id = excluded.owner_user_id,
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

  return getContentRadarPreferences(userId, tenantId);
}

export function filterSignalsForRadarPreferences(
  signals: AgentSignal[],
  topics: string[],
): AgentSignal[] {
  const normalizedTopics = normalizeTopics(topics);
  if (normalizedTopics.length === 0) return signals;

  return signals.filter((signal) => {
    const haystack = foldText(JSON.stringify({
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
      const foldedTopic = foldText(topic);
      if (haystack.includes(foldedTopic)) return true;
      const tokens = foldedTopic.split(/\s+/).filter((token) => token.length >= 3);
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
  const foldedTopic = foldText(topic);
  return signals.reduce((count, signal) => {
    const haystack = foldText(JSON.stringify(signal.payload || {}));
    return haystack.includes(foldedTopic) ? count + 1 : count;
  }, 0);
}

function normalizeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const raw of topics) {
    const candidates = raw.split(',').map((part) => part.replace(/\s+/g, ' ').trim());
    for (const trimmed of candidates) {
      if (!trimmed) continue;
      const folded = foldText(trimmed);
      if (seen.has(folded)) continue;
      seen.add(folded);
      ordered.push(trimmed);
      if (ordered.length >= 12) return ordered;
    }
  }
  return ordered;
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

function foldText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}
