// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './database';
import type { CreatorVoiceCard, SourcePackage } from './content-token-economy';
import type { SourceReference } from './content-engine';

export interface ContentArtifactScope {
  tenantId: number;
  userId: number;
}

export interface PersistContentArtifactsInput extends ContentArtifactScope {
  topic: string;
  voiceCard?: CreatorVoiceCard | null;
  sourcePackage?: SourcePackage | null;
  hook?: string | null;
  angle?: string | null;
  format?: string | null;
  /** Research-only persistence must not masquerade as generated idea use. */
  recordIdeaMemory?: boolean;
}

export interface PersistedContentArtifacts {
  voiceCardVersion?: string;
  researchArtifactId?: string;
  sourcePackageId?: string;
}

export type ContentVariantFeedbackSentiment = 'approved' | 'skipped' | 'rejected';

export interface RecordContentVariantFeedbackInput extends ContentArtifactScope {
  topic: string;
  variantText: string;
  sentiment: ContentVariantFeedbackSentiment;
  variantKind?: string | null;
  sourcePackageId?: string | null;
  angle?: string | null;
  format?: string | null;
  notes?: string | null;
}

export interface RecordedContentVariantFeedback {
  topic: string;
  variantKind: string;
  sentiment: ContentVariantFeedbackSentiment;
  accepted: boolean;
  sourcePackageId: string | null;
}

export interface PublicSourcePackage {
  sourcePackageId: string;
  researchArtifactId: string;
  topicHash: string;
  freshnessClass: SourcePackage['freshnessClass'];
  language: string;
  format: string;
  sources: SourceReference[];
  sourceSummary: string[];
  tokenEstimate: number;
  expiresAt: string;
}

export interface PublicResearchArtifact {
  researchArtifactId: string;
  topicHash: string;
  freshnessClass: SourcePackage['freshnessClass'];
  language: string;
  format: string;
  claims: string[];
  claimBinding: {
    status: 'unavailable';
    reasonCode: 'CONTENT_CLAIM_SOURCE_BINDING_NOT_MODELED';
  };
  unsafeOrUnverifiedClaims: string[];
  expiresAt: string;
}

export function ensureContentTokenArtifactTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_creator_voice_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      creator_id INTEGER NOT NULL,
      voice_card_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      tone TEXT NOT NULL,
      pacing TEXT NOT NULL,
      audience TEXT NOT NULL,
      cta_style TEXT NOT NULL,
      phrases_to_use_json TEXT NOT NULL DEFAULT '[]',
      phrases_to_avoid_json TEXT NOT NULL DEFAULT '[]',
      content_pillars_json TEXT NOT NULL DEFAULT '[]',
      format_preferences_json TEXT NOT NULL DEFAULT '[]',
      examples_compressed TEXT NOT NULL DEFAULT '',
      prompt_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(tenant_id, user_id, voice_card_version)
    );

    CREATE INDEX IF NOT EXISTS idx_content_voice_cards_scope_latest
      ON content_creator_voice_cards(tenant_id, user_id, stored_at DESC);

    CREATE TABLE IF NOT EXISTS content_research_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      research_artifact_id TEXT NOT NULL,
      topic_hash TEXT NOT NULL,
      topic TEXT NOT NULL,
      freshness_class TEXT NOT NULL CHECK (freshness_class IN ('cached', 'fresh', 'deep', 'none')),
      language TEXT NOT NULL,
      format TEXT NOT NULL,
      claims_json TEXT NOT NULL DEFAULT '[]',
      unsafe_or_unverified_claims_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL,
      stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(tenant_id, user_id, research_artifact_id)
    );

    CREATE INDEX IF NOT EXISTS idx_content_research_artifacts_scope_topic
      ON content_research_artifacts(tenant_id, user_id, topic_hash, expires_at);

    CREATE TABLE IF NOT EXISTS content_source_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      source_package_id TEXT NOT NULL,
      research_artifact_id TEXT NOT NULL,
      topic_hash TEXT NOT NULL,
      freshness_class TEXT NOT NULL CHECK (freshness_class IN ('cached', 'fresh', 'deep', 'none')),
      language TEXT NOT NULL,
      format TEXT NOT NULL,
      sources_json TEXT NOT NULL DEFAULT '[]',
      source_summaries_json TEXT NOT NULL DEFAULT '[]',
      token_estimate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      expires_at TEXT NOT NULL,
      stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(tenant_id, user_id, source_package_id),
      FOREIGN KEY (tenant_id, user_id, research_artifact_id)
        REFERENCES content_research_artifacts(tenant_id, user_id, research_artifact_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_content_source_packages_scope_research
      ON content_source_packages(tenant_id, user_id, research_artifact_id, expires_at);

    CREATE TABLE IF NOT EXISTS content_idea_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      topic_hash TEXT NOT NULL,
      hook_hash TEXT NOT NULL,
      topic TEXT NOT NULL,
      hook TEXT,
      angle TEXT,
      format TEXT,
      source_package_id TEXT,
      variant_kind TEXT,
      feedback_sentiment TEXT NOT NULL DEFAULT 'generated',
      feedback_notes TEXT,
      accepted INTEGER NOT NULL DEFAULT 0,
      used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(tenant_id, user_id, topic_hash, hook_hash)
    );

    CREATE INDEX IF NOT EXISTS idx_content_idea_memory_recent
      ON content_idea_memory(tenant_id, user_id, used_at DESC);
  `);
  ensureColumn(db, 'content_idea_memory', 'variant_kind', 'TEXT');
  ensureColumn(db, 'content_idea_memory', 'feedback_sentiment', "TEXT NOT NULL DEFAULT 'generated'");
  ensureColumn(db, 'content_idea_memory', 'feedback_notes', 'TEXT');
}

export function persistContentArtifacts(
  input: PersistContentArtifactsInput,
  db: Database.Database = getDb(),
): PersistedContentArtifacts {
  ensureContentTokenArtifactTables(db);
  const tenantId = input.tenantId;
  const userId = input.userId;
  const now = new Date().toISOString();
  const result: PersistedContentArtifacts = {};

  const write = db.transaction(() => {
    if (input.voiceCard) {
      const card = input.voiceCard;
      db.prepare(`
        INSERT INTO content_creator_voice_cards (
          tenant_id, user_id, creator_id, voice_card_version, source_hash, tone, pacing,
          audience, cta_style, phrases_to_use_json, phrases_to_avoid_json,
          content_pillars_json, format_preferences_json, examples_compressed,
          prompt_text, updated_at, stored_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, user_id, voice_card_version) DO UPDATE SET
          source_hash = excluded.source_hash,
          tone = excluded.tone,
          pacing = excluded.pacing,
          audience = excluded.audience,
          cta_style = excluded.cta_style,
          phrases_to_use_json = excluded.phrases_to_use_json,
          phrases_to_avoid_json = excluded.phrases_to_avoid_json,
          content_pillars_json = excluded.content_pillars_json,
          format_preferences_json = excluded.format_preferences_json,
          examples_compressed = excluded.examples_compressed,
          prompt_text = excluded.prompt_text,
          updated_at = excluded.updated_at,
          stored_at = excluded.stored_at
      `).run(
        tenantId,
        userId,
        card.creatorId,
        card.voiceCardVersion,
        card.sourceHash,
        card.tone,
        card.pacing,
        card.audience,
        card.ctaStyle,
        stableJson(card.phrasesToUse),
        stableJson(card.phrasesToAvoid),
        stableJson(card.contentPillars),
        stableJson(card.formatPreferences),
        card.examplesCompressed,
        card.promptText,
        card.updatedAt,
        now,
      );
      result.voiceCardVersion = card.voiceCardVersion;
    }

    if (input.sourcePackage) {
      const pkg = input.sourcePackage;
      db.prepare(`
        INSERT INTO content_research_artifacts (
          tenant_id, user_id, research_artifact_id, topic_hash, topic,
          freshness_class, language, format, claims_json,
          unsafe_or_unverified_claims_json, expires_at, stored_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, user_id, research_artifact_id) DO UPDATE SET
          topic = excluded.topic,
          freshness_class = excluded.freshness_class,
          language = excluded.language,
          format = excluded.format,
          claims_json = excluded.claims_json,
          unsafe_or_unverified_claims_json = excluded.unsafe_or_unverified_claims_json,
          expires_at = excluded.expires_at,
          stored_at = excluded.stored_at
      `).run(
        tenantId,
        userId,
        pkg.researchArtifactId,
        pkg.topicHash,
        input.topic,
        pkg.freshnessClass,
        pkg.language,
        pkg.format,
        stableJson(pkg.claims),
        stableJson(pkg.unsafeOrUnverifiedClaims),
        pkg.expiresAt,
        now,
      );
      db.prepare(`
        INSERT INTO content_source_packages (
          tenant_id, user_id, source_package_id, research_artifact_id,
          topic_hash, freshness_class, language, format, sources_json,
          source_summaries_json, token_estimate, expires_at, stored_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, user_id, source_package_id) DO UPDATE SET
          research_artifact_id = excluded.research_artifact_id,
          freshness_class = excluded.freshness_class,
          language = excluded.language,
          format = excluded.format,
          sources_json = excluded.sources_json,
          source_summaries_json = excluded.source_summaries_json,
          token_estimate = excluded.token_estimate,
          expires_at = excluded.expires_at,
          stored_at = excluded.stored_at
      `).run(
        tenantId,
        userId,
        pkg.sourcePackageId,
        pkg.researchArtifactId,
        pkg.topicHash,
        pkg.freshnessClass,
        pkg.language,
        pkg.format,
        stableJson(sanitizeSources(pkg.sources)),
        stableJson(pkg.sourceSummaries),
        pkg.tokenEstimate,
        pkg.expiresAt,
        now,
      );
      result.researchArtifactId = pkg.researchArtifactId;
      result.sourcePackageId = pkg.sourcePackageId;
    }

    if (
      input.sourcePackage
      && input.recordIdeaMemory !== false
      && (input.hook || input.angle || input.topic)
    ) {
      db.prepare(`
        INSERT INTO content_idea_memory (
          tenant_id, user_id, topic_hash, hook_hash, topic, hook, angle, format,
          source_package_id, used_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, user_id, topic_hash, hook_hash) DO UPDATE SET
          topic = excluded.topic,
          hook = excluded.hook,
          angle = excluded.angle,
          format = excluded.format,
          source_package_id = excluded.source_package_id,
          used_at = excluded.used_at
      `).run(
        tenantId,
        userId,
        input.sourcePackage.topicHash,
        shortHash(input.hook || input.topic),
        input.topic,
        input.hook ?? null,
        input.angle ?? null,
        input.format ?? null,
        input.sourcePackage.sourcePackageId,
        now,
      );
    }
  });

  write();
  return result;
}

export function getContentSourcePackage(
  scope: ContentArtifactScope,
  sourcePackageId: string,
  db: Database.Database = getDb(),
): PublicSourcePackage | null {
  ensureContentTokenArtifactTables(db);
  const row = db.prepare(`
    SELECT * FROM content_source_packages
    WHERE tenant_id = ? AND user_id = ? AND source_package_id = ?
    LIMIT 1
  `).get(scope.tenantId, scope.userId, sourcePackageId) as any;
  if (!row) return null;
  return {
    sourcePackageId: row.source_package_id,
    researchArtifactId: row.research_artifact_id,
    topicHash: row.topic_hash,
    freshnessClass: row.freshness_class,
    language: row.language,
    format: row.format,
    sources: parseJsonArray(row.sources_json).map(coerceSource).filter(Boolean) as SourceReference[],
    sourceSummary: parseJsonArray(row.source_summaries_json).filter((item): item is string => typeof item === 'string'),
    tokenEstimate: Number(row.token_estimate) || 0,
    expiresAt: row.expires_at,
  };
}

export function getContentResearchArtifact(
  scope: ContentArtifactScope,
  researchArtifactId: string,
  db: Database.Database = getDb(),
): PublicResearchArtifact | null {
  ensureContentTokenArtifactTables(db);
  const row = db.prepare(`
    SELECT * FROM content_research_artifacts
    WHERE tenant_id = ? AND user_id = ? AND research_artifact_id = ?
    LIMIT 1
  `).get(scope.tenantId, scope.userId, researchArtifactId) as any;
  if (!row) return null;
  return {
    researchArtifactId: row.research_artifact_id,
    topicHash: row.topic_hash,
    freshnessClass: row.freshness_class,
    language: row.language,
    format: row.format,
    // Legacy rows may contain source summaries in claims_json. Without exact
    // source IDs per claim they are not claim evidence and must stay hidden.
    claims: [],
    claimBinding: {
      status: 'unavailable',
      reasonCode: 'CONTENT_CLAIM_SOURCE_BINDING_NOT_MODELED',
    },
    unsafeOrUnverifiedClaims: parseJsonArray(row.unsafe_or_unverified_claims_json).filter((item): item is string => typeof item === 'string'),
    expiresAt: row.expires_at,
  };
}

export function listRecentContentIdeaMemory(
  scope: ContentArtifactScope,
  limit = 5,
  db: Database.Database = getDb(),
): Array<{
  topic: string;
  hook: string | null;
  angle: string | null;
  format: string | null;
  variant_kind?: string | null;
  feedback_sentiment?: string | null;
  accepted?: number | null;
}> {
  ensureContentTokenArtifactTables(db);
  return db.prepare(`
    SELECT topic, hook, angle, format, variant_kind, feedback_sentiment, accepted FROM content_idea_memory
    WHERE tenant_id = ? AND user_id = ?
    ORDER BY used_at DESC
    LIMIT ?
  `).all(scope.tenantId, scope.userId, Math.max(1, Math.min(12, limit))) as any[];
}

export function recordContentVariantFeedback(
  input: RecordContentVariantFeedbackInput,
  db: Database.Database = getDb(),
): RecordedContentVariantFeedback {
  ensureContentTokenArtifactTables(db);
  const topic = sanitizeMemoryValue(input.topic, 240);
  const variantText = sanitizeMemoryValue(input.variantText, 360);
  if (!topic || !variantText) {
    throw new Error('topic and variantText are required');
  }

  const variantKind = sanitizeMemoryValue(input.variantKind || 'script', 64) || 'script';
  const angle = sanitizeMemoryValue(input.angle, 160);
  const format = sanitizeMemoryValue(input.format, 64);
  const notes = sanitizeMemoryValue(input.notes, 320);
  const sourcePackageId = sanitizeMemoryValue(input.sourcePackageId, 80);
  const topicHash = sourcePackageId
    ? shortHash(`${input.tenantId}:${input.userId}:${sourcePackageId}:${topic}`)
    : shortHash(topic);
  const accepted = input.sentiment === 'approved' ? 1 : 0;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO content_idea_memory (
      tenant_id, user_id, topic_hash, hook_hash, topic, hook, angle, format,
      source_package_id, variant_kind, feedback_sentiment, feedback_notes,
      accepted, used_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, user_id, topic_hash, hook_hash) DO UPDATE SET
      topic = excluded.topic,
      hook = excluded.hook,
      angle = excluded.angle,
      format = excluded.format,
      source_package_id = excluded.source_package_id,
      variant_kind = excluded.variant_kind,
      feedback_sentiment = excluded.feedback_sentiment,
      feedback_notes = excluded.feedback_notes,
      accepted = excluded.accepted,
      used_at = excluded.used_at
  `).run(
    input.tenantId,
    input.userId,
    topicHash,
    shortHash(`${variantKind}:${variantText}`),
    topic,
    variantText,
    angle,
    format,
    sourcePackageId,
    variantKind,
    input.sentiment,
    notes,
    accepted,
    now,
  );

  return {
    topic,
    variantKind,
    sentiment: input.sentiment,
    accepted: accepted === 1,
    sourcePackageId: sourcePackageId || null,
  };
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!rows.some((row) => row.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? []);
  } catch {
    return '[]';
  }
}

function parseJsonArray(value: unknown): unknown[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sanitizeSources(sources: SourceReference[]): SourceReference[] {
  return sources.slice(0, 8).map((source) => ({
    title: (source.title || '').slice(0, 180),
    url: (source.url || '').slice(0, 500),
    source_type: (source.source_type || '').slice(0, 80),
    relevance_note: (source.relevance_note || '').slice(0, 260),
  }));
}

function coerceSource(value: unknown): SourceReference | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  return {
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    source_type: typeof raw.source_type === 'string' ? raw.source_type : '',
    relevance_note: typeof raw.relevance_note === 'string' ? raw.relevance_note : '',
  };
}

function shortHash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function sanitizeMemoryValue(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
  return cleaned || null;
}
