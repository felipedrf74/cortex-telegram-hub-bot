// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { getDb } from '../services/database';
import {
  contentScopeForInsert,
  ensureContentTenantScopeColumns,
  resolveContentTenantId,
} from '../services/content-tenant-scope';
import { normalizeContentOutputLanguage } from '../services/content-output-language';
import { logger } from '../utils/logger';

// ─────────────────────────────────────────────────────────────────────
// CONTENT-UI-O1 (2026-05-04): unified per-tenant ContentCreatorProfile
//
// Singleton row per (tenant_id, owner_user_id). The iOS Codable struct
// serializes 1:1 to the route payload; the route serializes/deserializes
// JSON arrays to/from the SQLite columns at the boundary.
//
// Tenant safety: all reads use `(tenant_id = ? AND owner_user_id = ?)`.
// Cross-tenant leakage is impossible by construction. Nothing here
// trusts ANY input scope from the client — the userId/tenantId are
// derived from the JWT-authenticated request.
// ─────────────────────────────────────────────────────────────────────

export interface ContentPlatformPreference {
  name: string;
  cadence: string;
  enabled: boolean;
}

export interface ContentCreatorProfile {
  pillars: string[];
  niches: string[];
  audience: string;
  platforms: ContentPlatformPreference[];
  voiceRules: string[];
  preferredFormats: string[];
  dislikedTopics: string[];
  bannedTopics: string[];
  trustedSources: string[];
  dislikedSources: string[];
  contentGoals: string[];
  languagePreference: string;
  voiceExamples: string[];
  updatedAt?: string | null;
}

const EMPTY_PROFILE: ContentCreatorProfile = {
  pillars: [],
  niches: [],
  audience: '',
  platforms: [],
  voiceRules: [],
  preferredFormats: [],
  dislikedTopics: [],
  bannedTopics: [],
  trustedSources: [],
  dislikedSources: [],
  contentGoals: [],
  languagePreference: '',
  voiceExamples: [],
  updatedAt: null,
};

// ─── Defensive parse helpers ─────────────────────────────────────────

function safeParseJsonArray<T = unknown>(raw: unknown): T[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (_err) {
    return [];
  }
}

function safeParseStringArray(raw: unknown): string[] {
  return safeParseJsonArray<unknown>(raw)
    .filter((v) => typeof v === 'string')
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function safeParsePlatforms(raw: unknown): ContentPlatformPreference[] {
  return safeParseJsonArray<unknown>(raw)
    .map((v): ContentPlatformPreference | null => {
      if (!v || typeof v !== 'object') return null;
      const o = v as Record<string, unknown>;
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!name) return null;
      const cadence = typeof o.cadence === 'string' ? o.cadence : '';
      const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;
      return { name, cadence, enabled };
    })
    .filter((v): v is ContentPlatformPreference => v != null);
}

function rowToProfile(row: Record<string, unknown> | undefined): ContentCreatorProfile {
  if (!row) return { ...EMPTY_PROFILE };
  return {
    pillars: safeParseStringArray(row.pillars_json),
    niches: safeParseStringArray(row.niches_json),
    audience: typeof row.audience === 'string' ? row.audience : '',
    platforms: safeParsePlatforms(row.platforms_json),
    voiceRules: safeParseStringArray(row.voice_rules_json),
    preferredFormats: safeParseStringArray(row.preferred_formats_json),
    dislikedTopics: safeParseStringArray(row.disliked_topics_json),
    bannedTopics: safeParseStringArray(row.banned_topics_json),
    trustedSources: safeParseStringArray(row.trusted_sources_json),
    dislikedSources: safeParseStringArray(row.disliked_sources_json),
    contentGoals: safeParseStringArray(row.content_goals_json),
    // Project legacy/raw rows at the read boundary. This intentionally does
    // not update the stored value; historical data remains byte-for-byte
    // intact until the owner makes a new profile write.
    languagePreference: normalizeContentOutputLanguage(row.language_preference),
    voiceExamples: safeParseStringArray(row.voice_examples_json),
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
  };
}

// ─── Sanitize incoming payloads ──────────────────────────────────────

function sanitizeStringArray(input: unknown, maxItems = 50, maxLen = 240): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    out.push(trimmed.slice(0, maxLen));
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizePlatforms(input: unknown): ContentPlatformPreference[] {
  if (!Array.isArray(input)) return [];
  const out: ContentPlatformPreference[] = [];
  for (const v of input) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
    if (!name) continue;
    const cadence = typeof o.cadence === 'string' ? o.cadence.trim().slice(0, 80) : '';
    const enabled = typeof o.enabled === 'boolean' ? o.enabled : true;
    out.push({ name, cadence, enabled });
    if (out.length >= 25) break;
  }
  return out;
}

export function sanitizeContentCreatorProfile(input: unknown): ContentCreatorProfile {
  const o = (input && typeof input === 'object') ? (input as Record<string, unknown>) : {};
  return {
    pillars: sanitizeStringArray(o.pillars),
    niches: sanitizeStringArray(o.niches),
    audience: typeof o.audience === 'string' ? o.audience.trim().slice(0, 1500) : '',
    platforms: sanitizePlatforms(o.platforms),
    voiceRules: sanitizeStringArray(o.voiceRules),
    preferredFormats: sanitizeStringArray(o.preferredFormats),
    dislikedTopics: sanitizeStringArray(o.dislikedTopics),
    bannedTopics: sanitizeStringArray(o.bannedTopics),
    trustedSources: sanitizeStringArray(o.trustedSources),
    dislikedSources: sanitizeStringArray(o.dislikedSources),
    contentGoals: sanitizeStringArray(o.contentGoals),
    languagePreference: normalizeContentOutputLanguage(o.languagePreference),
    voiceExamples: sanitizeStringArray(o.voiceExamples, 25, 600),
  };
}

// ─── Public state API ────────────────────────────────────────────────

export function getContentCreatorProfile(
  userId: number,
  tenantId?: number | null,
): ContentCreatorProfile {
  if (!Number.isFinite(userId) || userId <= 0) return { ...EMPTY_PROFILE };
  ensureContentTenantScopeColumns();
  const db = getDb();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  try {
    const row = db.prepare(`
      SELECT * FROM content_creator_profile
      WHERE tenant_id = ? AND owner_user_id = ? AND scope_status = 'active'
      LIMIT 1
    `).get(resolvedTenantId, userId) as Record<string, unknown> | undefined;
    return rowToProfile(row);
  } catch (err) {
    logger.warn({ err, userId, tenantId: resolvedTenantId },
      'content-creator-profile.get failed');
    return { ...EMPTY_PROFILE };
  }
}

export function upsertContentCreatorProfile(
  userId: number,
  tenantId: number | null | undefined,
  patch: Partial<ContentCreatorProfile>,
): ContentCreatorProfile {
  if (!Number.isFinite(userId) || userId <= 0) {
    throw new Error('upsertContentCreatorProfile requires a positive userId');
  }
  ensureContentTenantScopeColumns();
  const db = getDb();
  const scopeMeta = contentScopeForInsert(userId, tenantId, 'user_private', 'active');

  const existing = getContentCreatorProfile(userId, tenantId);
  const merged = sanitizeContentCreatorProfile({
    pillars: patch.pillars ?? existing.pillars,
    niches: patch.niches ?? existing.niches,
    audience: patch.audience ?? existing.audience,
    platforms: patch.platforms ?? existing.platforms,
    voiceRules: patch.voiceRules ?? existing.voiceRules,
    preferredFormats: patch.preferredFormats ?? existing.preferredFormats,
    dislikedTopics: patch.dislikedTopics ?? existing.dislikedTopics,
    bannedTopics: patch.bannedTopics ?? existing.bannedTopics,
    trustedSources: patch.trustedSources ?? existing.trustedSources,
    dislikedSources: patch.dislikedSources ?? existing.dislikedSources,
    contentGoals: patch.contentGoals ?? existing.contentGoals,
    languagePreference: patch.languagePreference ?? existing.languagePreference,
    voiceExamples: patch.voiceExamples ?? existing.voiceExamples,
  });

  const payload = {
    pillars_json: JSON.stringify(merged.pillars),
    niches_json: JSON.stringify(merged.niches),
    audience: merged.audience,
    platforms_json: JSON.stringify(merged.platforms),
    voice_rules_json: JSON.stringify(merged.voiceRules),
    preferred_formats_json: JSON.stringify(merged.preferredFormats),
    disliked_topics_json: JSON.stringify(merged.dislikedTopics),
    banned_topics_json: JSON.stringify(merged.bannedTopics),
    trusted_sources_json: JSON.stringify(merged.trustedSources),
    disliked_sources_json: JSON.stringify(merged.dislikedSources),
    content_goals_json: JSON.stringify(merged.contentGoals),
    language_preference: merged.languagePreference,
    voice_examples_json: JSON.stringify(merged.voiceExamples),
  };

  const stmt = db.prepare(`
    INSERT INTO content_creator_profile (
      user_id, tenant_id, owner_user_id, visibility_scope, lifecycle_state,
      scope_status, created_by, updated_by, audit_metadata_json,
      pillars_json, niches_json, audience, platforms_json,
      voice_rules_json, preferred_formats_json, disliked_topics_json,
      banned_topics_json, trusted_sources_json, disliked_sources_json,
      content_goals_json, language_preference, voice_examples_json,
      created_at, updated_at
    ) VALUES (
      @user_id, @tenant_id, @owner_user_id, @visibility_scope, @lifecycle_state,
      @scope_status, @created_by, @updated_by, @audit_metadata_json,
      @pillars_json, @niches_json, @audience, @platforms_json,
      @voice_rules_json, @preferred_formats_json, @disliked_topics_json,
      @banned_topics_json, @trusted_sources_json, @disliked_sources_json,
      @content_goals_json, @language_preference, @voice_examples_json,
      datetime('now'), datetime('now')
    )
    ON CONFLICT(tenant_id, owner_user_id) DO UPDATE SET
      pillars_json          = excluded.pillars_json,
      niches_json           = excluded.niches_json,
      audience              = excluded.audience,
      platforms_json        = excluded.platforms_json,
      voice_rules_json      = excluded.voice_rules_json,
      preferred_formats_json= excluded.preferred_formats_json,
      disliked_topics_json  = excluded.disliked_topics_json,
      banned_topics_json    = excluded.banned_topics_json,
      trusted_sources_json  = excluded.trusted_sources_json,
      disliked_sources_json = excluded.disliked_sources_json,
      content_goals_json    = excluded.content_goals_json,
      language_preference   = excluded.language_preference,
      voice_examples_json   = excluded.voice_examples_json,
      updated_by            = excluded.updated_by,
      updated_at            = datetime('now')
    WHERE content_creator_profile.scope_status != 'archived'
  `);

  stmt.run({
    user_id: userId,
    tenant_id: scopeMeta.tenantId,
    owner_user_id: scopeMeta.ownerUserId,
    visibility_scope: scopeMeta.visibilityScope,
    lifecycle_state: scopeMeta.lifecycleState,
    scope_status: scopeMeta.scopeStatus,
    created_by: scopeMeta.createdBy,
    updated_by: scopeMeta.updatedBy,
    audit_metadata_json: scopeMeta.auditMetadataJson,
    ...payload,
  });

  return getContentCreatorProfile(userId, tenantId);
}

export function resetContentCreatorProfile(
  userId: number,
  tenantId?: number | null,
): void {
  if (!Number.isFinite(userId) || userId <= 0) return;
  ensureContentTenantScopeColumns();
  const resolvedTenantId = resolveContentTenantId(userId, tenantId);
  const db = getDb();
  db.prepare(`
    UPDATE content_creator_profile
       SET scope_status = 'archived',
           updated_at   = datetime('now')
     WHERE tenant_id = ? AND owner_user_id = ?
  `).run(resolvedTenantId, userId);
}

// Compute a 0..1 completeness score that mirrors iOS
// `ContentCreatorProfile.completeness`. Useful for the home banner +
// portal aggregate views.
export function computeContentCreatorProfileCompleteness(
  profile: ContentCreatorProfile,
): number {
  const weights: Array<[boolean, number]> = [
    [profile.pillars.length > 0, 1.5],
    [profile.niches.length > 0, 1.0],
    [profile.audience.length > 0, 1.0],
    [profile.platforms.length > 0, 1.5],
    [profile.voiceRules.length > 0, 1.0],
    [profile.preferredFormats.length > 0, 0.5],
    [profile.dislikedTopics.length > 0, 0.5],
    [profile.bannedTopics.length > 0, 0.5],
    [profile.trustedSources.length > 0, 1.0],
    [profile.dislikedSources.length > 0, 0.5],
    [profile.contentGoals.length > 0, 1.0],
    [profile.languagePreference.length > 0, 0.5],
  ];
  const total = weights.reduce((acc, [_, w]) => acc + w, 0);
  const earned = weights.reduce((acc, [pop, w]) => acc + (pop ? w : 0), 0);
  if (total === 0) return 0;
  return Math.min(1, earned / total);
}
