// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Milestone 7 — golden routing corpus builder + labeling store.
 *
 * Collects candidate utterances for the human-labeled routing corpus from
 * deterministic local sources only (no LLM calls, no network):
 *
 *   a. classify-shadow disagreement rows (agree=0) — text recovered by
 *      re-hashing recent chat-history user turns with the same HMAC scheme;
 *   b. online-eval sampler captures — text recovered via turn_id → messages;
 *   c. supported English + Portuguese eval fixture prompts (synthetic);
 *   d. owner-reviewable English + Portuguese product-profile prompts
 *      (synthetic);
 *   e. recent chat-history turns whose routed domain is not supported by the
 *      manifest routing vocabulary for that utterance (suspicious routes).
 *
 * Items are deduped by identity HMAC (first source wins within each identity
 * namespace) and inserted as `pending`. The actual ~300-item labeling pass is
 * owner-gated and happens through the portal labeling page or the exact
 * owner-reviewed synthetic batch.
 *
 * Privacy: private observations use the byte-identical classify-shadow HMAC
 * so those rows correlate. Every checked-in synthetic control uses a separate
 * domain-prefixed HMAC and cannot collide with a private observation. Raw text
 * is stored only when it already exists in local chat history or a checked-in
 * fixture; it is never reconstructed from hashes.
 */

import type Database from 'better-sqlite3';
import { getDb } from './database';
import { hmacSha256 } from '../utils/hmac';
import {
  CHAT_BILINGUAL_EVAL_FIXTURES,
  CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES,
} from './chat-bilingual-eval-fixtures';
import {
  ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES,
  projectBilingualFixturePromptForRoutingCorpus,
} from './routing-corpus-product-profile-fixtures';
import { loadCapabilityManifest } from './capability-manifest';
import { resolveIntentAgainst } from './intent-resolution/intent-resolver';
import {
  getCompiledIntentVocabulary,
  type CompiledCapabilityVocabulary,
} from './intent-resolution/vocabulary';

export const ROUTING_CORPUS_BUILDER_VERSION = 'routing-corpus-builder@1.2.0';

const UNSUPPORTED_SPANISH_FIXTURE_COUNT = 8;

export type RoutingCorpusSource =
  | 'classify_shadow_disagreement'
  | 'online_eval_sampler'
  | 'bilingual_fixture'
  | 'history_unmatched'
  | 'manual';

export type RoutingCorpusLabelStatus = 'pending' | 'labeled' | 'skipped';

export interface RoutingCorpusItem {
  id: number;
  tenantId: number;
  userId: number | null;
  utteranceHash: string;
  utteranceText: string | null;
  source: RoutingCorpusSource;
  suggestedDomain: string | null;
  suggestedSkill: string | null;
  labelDomain: string | null;
  labelSkill: string | null;
  labelStatus: RoutingCorpusLabelStatus;
  labeledAt: string | null;
  createdAt: string;
}

export interface RoutingCorpusBuildSummary {
  builderVersion: string;
  inserted: number;
  duplicates: number;
  unrecoverableText: number;
  perSource: Record<RoutingCorpusSource, number>;
}

/** Special routing labels available in addition to manifest domains. */
export const ROUTING_SPECIAL_LABELS = ['clarify', 'none'] as const;

/** Fixture skill/owner-skill → legacy runtime domain used by routing surfaces. */
const FIXTURE_SKILL_TO_DOMAIN: Record<string, string> = {
  secretary: 'secretary',
  calendar: 'secretary',
  tasks: 'secretary',
  training: 'triathlon',
  content: 'content',
  cooking: 'cooking',
  finance: 'finance',
  connections: 'connections',
  notifications: 'notifications',
  decision_center: 'decision_center',
};

export function hashRoutingUtterance(secret: string, text: string): string {
  // Byte-identical to classify-shadow's hashing so corpus rows correlate
  // with classify_shadow_runs.message_hash.
  return hmacSha256(secret, text.trim().toLowerCase());
}

/**
 * Domain-separated identity for every checked-in synthetic control. These
 * prompts are not classify-shadow observations, so they must not contend with
 * an identical private/history utterance for the globally unique corpus hash.
 */
export function hashRoutingCorpusSyntheticControl(secret: string, text: string): string {
  return hmacSha256(
    secret,
    `routing-corpus-control:v1\u0000${text.trim().toLowerCase()}`,
  );
}

function configuredSyntheticControlSecret(explicit?: string): string {
  const secret = explicit ?? process.env.CLASSIFY_SHADOW_HASH_SECRET ?? '';
  if (!secret) {
    throw new Error('Routing corpus synthetic controls require CLASSIFY_SHADOW_HASH_SECRET');
  }
  return secret;
}

function checkedInSyntheticControls(secret: string): Map<string, {
  utteranceText: string;
  source: 'bilingual_fixture' | 'manual';
}> {
  const controls = new Map<string, {
    utteranceText: string;
    source: 'bilingual_fixture' | 'manual';
  }>();
  const record = (
    utteranceText: string,
    source: 'bilingual_fixture' | 'manual',
  ): void => {
    controls.set(hashRoutingCorpusSyntheticControl(secret, utteranceText), {
      utteranceText,
      source,
    });
  };
  for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
    record(
      projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'pt', fixture.pt),
      'bilingual_fixture',
    );
    record(
      projectBilingualFixturePromptForRoutingCorpus(fixture.scenario, 'en', fixture.en),
      'bilingual_fixture',
    );
  }
  for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
    if (fixture.promptLocale === 'pt-BR') record(fixture.prompt, 'bilingual_fixture');
  }
  for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
    record(fixture.prompt, 'manual');
  }
  return controls;
}

export function isCheckedInSyntheticRoutingCorpusItem(
  item: Pick<
    RoutingCorpusItem,
    'tenantId' | 'userId' | 'utteranceHash' | 'utteranceText' | 'source'
  >,
  explicitSecret?: string,
): boolean {
  if (item.tenantId !== 0 || item.userId !== null || item.utteranceText === null) return false;
  if (item.source !== 'bilingual_fixture' && item.source !== 'manual') return false;
  const controls = checkedInSyntheticControls(configuredSyntheticControlSecret(explicitSecret));
  const expected = controls.get(item.utteranceHash);
  return expected?.source === item.source && expected.utteranceText === item.utteranceText;
}

export function ensureRoutingCorpusTables(db: Database.Database = getDb()): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_corpus_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      user_id INTEGER,
      utterance_hash TEXT NOT NULL UNIQUE CHECK (length(utterance_hash) = 64),
      utterance_text TEXT,
      source TEXT NOT NULL CHECK (source IN (
        'classify_shadow_disagreement',
        'online_eval_sampler',
        'bilingual_fixture',
        'history_unmatched',
        'manual'
      )),
      suggested_domain TEXT,
      suggested_skill TEXT,
      label_domain TEXT,
      label_skill TEXT,
      label_status TEXT NOT NULL DEFAULT 'pending' CHECK (label_status IN ('pending', 'labeled', 'skipped')),
      labeled_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      CHECK (
        (label_status = 'pending' AND label_domain IS NULL AND label_skill IS NULL AND labeled_at IS NULL)
        OR (label_status = 'labeled' AND label_domain IS NOT NULL AND labeled_at IS NOT NULL)
        OR (label_status = 'skipped' AND label_domain IS NULL AND label_skill IS NULL AND labeled_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_status
      ON routing_corpus_items(label_status, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_tenant_status
      ON routing_corpus_items(tenant_id, label_status);
    CREATE INDEX IF NOT EXISTS idx_routing_corpus_items_source
      ON routing_corpus_items(source, label_status);

    CREATE TABLE IF NOT EXISTS routing_llm_classify_cache (
      utterance_hash TEXT PRIMARY KEY CHECK (length(utterance_hash) = 64),
      domain TEXT NOT NULL,
      confidence REAL NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accepted_accuracy_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      snapshot_json TEXT NOT NULL,
      accepted INTEGER NOT NULL DEFAULT 0 CHECK (accepted IN (0, 1))
    );

    CREATE INDEX IF NOT EXISTS idx_accepted_accuracy_snapshots_accepted
      ON accepted_accuracy_snapshots(accepted, created_at DESC, id DESC);
  `);
}

interface CandidateInsert {
  tenantId: number;
  userId: number | null;
  utteranceHash: string;
  utteranceText: string | null;
  source: RoutingCorpusSource;
  suggestedDomain: string | null;
  suggestedSkill: string | null;
}

export interface BuildRoutingCorpusOptions {
  db?: Database.Database;
  /** HMAC secret — same scheme/secret as CLASSIFY_SHADOW_HASH_SECRET. */
  secret: string;
  /** How many recent user turns to scan for text recovery + unmatched routes. */
  historyLimit?: number;
  /** Test seam: synthetic compiled vocabulary instead of the manifest singleton. */
  vocabulary?: readonly CompiledCapabilityVocabulary[];
}

export interface PruneSpanishSyntheticRoutingCorpusFixturesOptions {
  db?: Database.Database;
  /** HMAC secret used when the fixture rows were built. */
  secret: string;
}

export interface PruneSpanishSyntheticRoutingCorpusFixturesResult {
  status: 'pruned' | 'already_absent';
  expectedFixtures: number;
  deletedItems: number;
  deletedCacheEntries: number;
}

export function buildRoutingCorpus(options: BuildRoutingCorpusOptions): RoutingCorpusBuildSummary {
  const db = options.db ?? getDb();
  if (typeof options.secret !== 'string' || options.secret.length === 0) {
    throw new Error('buildRoutingCorpus requires the classify-shadow HMAC secret');
  }
  const historyLimit = boundedHistoryLimit(options.historyLimit);
  const vocabulary = options.vocabulary ?? getCompiledIntentVocabulary();
  ensureRoutingCorpusTables(db);

  const summary: RoutingCorpusBuildSummary = {
    builderVersion: ROUTING_CORPUS_BUILDER_VERSION,
    inserted: 0,
    duplicates: 0,
    unrecoverableText: 0,
    perSource: {
      classify_shadow_disagreement: 0,
      online_eval_sampler: 0,
      bilingual_fixture: 0,
      history_unmatched: 0,
      manual: 0,
    },
  };

  const history = loadRecentUserTurns(db, historyLimit);
  const textByHash = new Map<string, HistoryTurn>();
  const textByTurnId = new Map<string, HistoryTurn>();
  for (const turn of history) {
    const hash = hashRoutingUtterance(options.secret, turn.text);
    if (!textByHash.has(hash)) textByHash.set(hash, turn);
    if (turn.messageUuid && !textByTurnId.has(turn.messageUuid)) textByTurnId.set(turn.messageUuid, turn);
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO routing_corpus_items (
      tenant_id, user_id, utterance_hash, utterance_text, source,
      suggested_domain, suggested_skill, label_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
  `);
  const record = (candidate: CandidateInsert): void => {
    const result = insert.run(
      candidate.tenantId,
      candidate.userId,
      candidate.utteranceHash,
      candidate.utteranceText,
      candidate.source,
      candidate.suggestedDomain,
      candidate.suggestedSkill,
    );
    if (result.changes > 0) {
      summary.inserted += 1;
      summary.perSource[candidate.source] += 1;
    } else {
      summary.duplicates += 1;
    }
  };

  // (a) classify-shadow disagreements — recover text via HMAC match.
  for (const row of loadShadowDisagreements(db)) {
    const recovered = textByHash.get(row.messageHash);
    if (!recovered) {
      summary.unrecoverableText += 1;
      continue;
    }
    record({
      tenantId: row.tenantId,
      userId: row.userId > 0 ? row.userId : null,
      utteranceHash: row.messageHash,
      utteranceText: recovered.text,
      source: 'classify_shadow_disagreement',
      suggestedDomain: row.geminiDomain,
      suggestedSkill: null,
    });
  }

  // (b) online-eval sampler captures — recover text via turn_id → messages.
  for (const row of loadOnlineEvalSamples(db)) {
    const recovered = textByTurnId.get(row.turnId);
    if (!recovered) {
      summary.unrecoverableText += 1;
      continue;
    }
    record({
      tenantId: row.tenantId,
      userId: row.userId,
      utteranceHash: hashRoutingUtterance(options.secret, recovered.text),
      utteranceText: recovered.text,
      source: 'online_eval_sampler',
      suggestedDomain: row.domain,
      suggestedSkill: null,
    });
  }

  // (c) synthetic eval fixture prompts for supported locales (pt + en).
  for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
    const suggestedDomain = FIXTURE_SKILL_TO_DOMAIN[fixture.skill] ?? null;
    for (const [locale, original] of [['pt', fixture.pt], ['en', fixture.en]] as const) {
      const prompt = projectBilingualFixturePromptForRoutingCorpus(
        fixture.scenario,
        locale,
        original,
      );
      record({
        tenantId: 0,
        userId: null,
        utteranceHash: hashRoutingCorpusSyntheticControl(options.secret, prompt),
        utteranceText: prompt,
        source: 'bilingual_fixture',
        suggestedDomain,
        suggestedSkill: fixture.expectedOwnerSkill,
      });
    }
  }
  for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
    if (fixture.promptLocale !== 'pt-BR') continue;
    record({
      tenantId: 0,
      userId: null,
      utteranceHash: hashRoutingCorpusSyntheticControl(options.secret, fixture.prompt),
      utteranceText: fixture.prompt,
      source: 'bilingual_fixture',
      suggestedDomain: null,
      suggestedSkill: null,
    });
  }

  // (d) owner-reviewable product-profile prompts complete the 300-item
  // supported-language queue while remaining pending for the golden pass.
  for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
    record({
      tenantId: 0,
      userId: null,
      utteranceHash: hashRoutingCorpusSyntheticControl(options.secret, fixture.prompt),
      utteranceText: fixture.prompt,
      source: 'manual',
      suggestedDomain: fixture.labelDomain,
      suggestedSkill: fixture.labelSkill,
    });
  }

  // (e) recent turns whose routed domain has no vocabulary support for the
  // utterance — the manifest resolver produced zero candidates for the
  // domain the live router picked (including domains absent from the
  // registry vocabulary entirely).
  for (const turn of history) {
    if (!turn.domain) continue;
    const candidates = resolveIntentAgainst(vocabulary, turn.text);
    if (candidates.some((candidate) => candidate.domain === turn.domain)) continue;
    record({
      tenantId: turn.tenantId,
      userId: turn.userId,
      utteranceHash: hashRoutingUtterance(options.secret, turn.text),
      utteranceText: turn.text,
      source: 'history_unmatched',
      suggestedDomain: candidates[0]?.domain ?? null,
      suggestedSkill: candidates[0]?.skill ?? null,
    });
  }

  return summary;
}

/**
 * Remove the retired es-419 synthetic fixture rows without treating language
 * detection as deletion authority. Only the exact checked-in fixture text,
 * its HMAC under the supplied corpus secret, and synthetic-row provenance are
 * accepted.
 *
 * The all-or-nothing cardinality guard makes the operation safe to retry:
 * either all eight fixture rows are present and pending, or none are. A
 * partial/mismatched set, human labeling, or an accepted accuracy snapshot
 * refuses the mutation.
 */
export function pruneSpanishSyntheticRoutingCorpusFixtures(
  options: PruneSpanishSyntheticRoutingCorpusFixturesOptions,
): PruneSpanishSyntheticRoutingCorpusFixturesResult {
  const db = options.db ?? getDb();
  if (typeof options.secret !== 'string' || options.secret.length === 0) {
    throw new Error('pruneSpanishSyntheticRoutingCorpusFixtures requires the corpus HMAC secret');
  }
  ensureRoutingCorpusTables(db);

  const fixtures = CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
    .filter((fixture) => fixture.promptLocale === 'es-419')
    .map((fixture) => ({
      text: fixture.prompt,
      hash: hashRoutingUtterance(options.secret, fixture.prompt),
    }));
  if (fixtures.length !== UNSUPPORTED_SPANISH_FIXTURE_COUNT) {
    throw new Error(
      `Expected ${UNSUPPORTED_SPANISH_FIXTURE_COUNT} retired Spanish fixtures, found ${fixtures.length}`,
    );
  }

  const hashes = fixtures.map((fixture) => fixture.hash);
  const texts = fixtures.map((fixture) => fixture.text);
  const placeholders = fixtures.map(() => '?').join(', ');
  const prune = db.transaction(() => {
    const rows = db.prepare(`
      SELECT
        id,
        tenant_id AS tenantId,
        user_id AS userId,
        utterance_hash AS utteranceHash,
        utterance_text AS utteranceText,
        source,
        label_domain AS labelDomain,
        label_skill AS labelSkill,
        label_status AS labelStatus,
        labeled_at AS labeledAt
      FROM routing_corpus_items
      WHERE utterance_hash IN (${placeholders})
         OR utterance_text IN (${placeholders})
    `).all(...hashes, ...texts) as Array<{
      id: number;
      tenantId: number;
      userId: number | null;
      utteranceHash: string;
      utteranceText: string | null;
      source: string;
      labelDomain: string | null;
      labelSkill: string | null;
      labelStatus: RoutingCorpusLabelStatus;
      labeledAt: string | null;
    }>;

    if (rows.length !== 0 && rows.length !== fixtures.length) {
      throw new Error(
        `Refusing partial Spanish synthetic fixture set: expected ${fixtures.length} or 0 rows, found ${rows.length}`,
      );
    }

    if (rows.length > 0) {
      for (const fixture of fixtures) {
        const matching = rows.filter((row) => (
          row.utteranceHash === fixture.hash || row.utteranceText === fixture.text
        ));
        if (
          matching.length !== 1
          || matching[0].utteranceHash !== fixture.hash
          || matching[0].utteranceText !== fixture.text
          || matching[0].source !== 'bilingual_fixture'
          || matching[0].tenantId !== 0
          || matching[0].userId !== null
        ) {
          throw new Error('Refusing partial Spanish synthetic fixture set with mismatched identity or provenance');
        }
        if (
          matching[0].labelStatus !== 'pending'
          || matching[0].labelDomain !== null
          || matching[0].labelSkill !== null
          || matching[0].labeledAt !== null
        ) {
          throw new Error('Spanish synthetic fixtures must remain pending and unlabeled before pruning');
        }
      }
    }

    const matchingCacheEntries = db.prepare(`
      SELECT COUNT(*) AS count
      FROM routing_llm_classify_cache
      WHERE utterance_hash IN (${placeholders})
    `).get(...hashes) as { count: number };
    if (rows.length === 0 && matchingCacheEntries.count === 0) {
      return {
        status: 'already_absent' as const,
        expectedFixtures: fixtures.length,
        deletedItems: 0,
        deletedCacheEntries: 0,
      };
    }

    const acceptedSnapshots = db.prepare(`
      SELECT COUNT(*) AS count
      FROM accepted_accuracy_snapshots
      WHERE accepted = 1
    `).get() as { count: number };
    if (acceptedSnapshots.count > 0) {
      throw new Error('Refusing to prune after an accepted routing accuracy snapshot exists');
    }

    const cacheResult = db.prepare(`
      DELETE FROM routing_llm_classify_cache
      WHERE utterance_hash IN (${placeholders})
    `).run(...hashes);
    let deletedItems = 0;
    if (rows.length > 0) {
      const itemResult = db.prepare(`
        DELETE FROM routing_corpus_items
        WHERE utterance_hash IN (${placeholders})
          AND source = 'bilingual_fixture'
          AND tenant_id = 0
          AND user_id IS NULL
          AND label_status = 'pending'
          AND label_domain IS NULL
          AND label_skill IS NULL
          AND labeled_at IS NULL
      `).run(...hashes);
      deletedItems = itemResult.changes;
      if (deletedItems !== fixtures.length) {
        throw new Error(
          `Spanish synthetic fixture prune changed ${deletedItems} rows; expected ${fixtures.length}`,
        );
      }
    }
    return {
      status: 'pruned' as const,
      expectedFixtures: fixtures.length,
      deletedItems,
      deletedCacheEntries: cacheResult.changes,
    };
  });

  // BEGIN IMMEDIATE closes the portal-labeling/snapshot race between
  // validation and deletion while keeping the transaction short.
  return prune.immediate();
}

// ─── Labeling store (portal) ──────────────────────────────────────

export interface RoutingLabelCandidates {
  domains: string[];
  skills: string[];
  skillsByDomain: Record<string, string[]>;
  specialLabels: string[];
}

/** Candidate labels for the portal page: manifest domains + clarify/none. */
export function getRoutingLabelCandidates(): RoutingLabelCandidates {
  const manifest = loadCapabilityManifest();
  const domains: string[] = [];
  const skills: string[] = [];
  const skillsByDomain: Record<string, string[]> = {};
  for (const entry of manifest.capabilities) {
    const domain = entry.runtimeRouting.domain;
    if (!domains.includes(domain)) domains.push(domain);
    skillsByDomain[domain] = [
      ...new Set([...(skillsByDomain[domain] ?? []), ...entry.chatActionSkills]),
    ];
    for (const skill of entry.chatActionSkills) {
      if (!skills.includes(skill)) skills.push(skill);
    }
  }
  return { domains, skills, skillsByDomain, specialLabels: [...ROUTING_SPECIAL_LABELS] };
}

export function isValidRoutingLabelDomain(labelDomain: string, candidates: RoutingLabelCandidates): boolean {
  return candidates.domains.includes(labelDomain) || candidates.specialLabels.includes(labelDomain);
}

/**
 * A domain label can remain skill-null when the utterance is genuinely
 * domain-generic. If a skill is supplied, it must be one of that domain's
 * executable manifest skills. Special labels never carry a skill.
 */
export function isValidRoutingLabelSelection(
  labelDomain: string,
  labelSkill: string | undefined,
  candidates: RoutingLabelCandidates,
): boolean {
  if (candidates.specialLabels.includes(labelDomain)) {
    return labelSkill === undefined;
  }
  if (!candidates.domains.includes(labelDomain)) return false;
  return labelSkill === undefined || (candidates.skillsByDomain[labelDomain] ?? []).includes(labelSkill);
}

export function getNextPendingRoutingCorpusItem(
  db: Database.Database = getDb(),
  options: { tenantId?: number; syntheticOnly?: boolean } = {},
): RoutingCorpusItem | null {
  ensureRoutingCorpusTables(db);
  if (options.syntheticOnly) {
    if (options.tenantId !== undefined && options.tenantId !== 0) {
      throw new Error('Checked-in synthetic routing corpus scope must use tenant 0');
    }
    const secret = configuredSyntheticControlSecret();
    const controls = checkedInSyntheticControls(secret);
    const hashes = [...controls.keys()];
    const placeholders = hashes.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT * FROM routing_corpus_items
      WHERE label_status = 'pending'
        AND tenant_id = 0
        AND user_id IS NULL
        AND source IN ('bilingual_fixture', 'manual')
        AND utterance_hash IN (${placeholders})
        AND utterance_text IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `).all(...hashes);
    const item = rows
      .map(mapItemRow)
      .find((candidate) => isCheckedInSyntheticRoutingCorpusItem(candidate, secret));
    return item ?? null;
  }
  const row = options.tenantId !== undefined
    ? db.prepare(`
        SELECT * FROM routing_corpus_items
        WHERE label_status = 'pending' AND tenant_id = ? AND utterance_text IS NOT NULL
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).get(options.tenantId)
    : db.prepare(`
        SELECT * FROM routing_corpus_items
        WHERE label_status = 'pending' AND utterance_text IS NOT NULL
        ORDER BY created_at ASC, id ASC LIMIT 1
      `).get();
  return row ? mapItemRow(row) : null;
}

export function getRoutingCorpusItemById(
  id: number,
  db: Database.Database = getDb(),
): RoutingCorpusItem | null {
  ensureRoutingCorpusTables(db);
  const row = db.prepare('SELECT * FROM routing_corpus_items WHERE id = ?').get(id);
  return row ? mapItemRow(row) : null;
}

export interface LabelRoutingCorpusItemInput {
  id: number;
  action: 'label' | 'skip';
  labelDomain?: string;
  labelSkill?: string;
}

export class RoutingCorpusLabelConflictError extends Error {
  readonly itemId: number;
  readonly currentStatus: RoutingCorpusLabelStatus;

  constructor(itemId: number, currentStatus: RoutingCorpusLabelStatus) {
    super(`Routing corpus item ${itemId} is not pending (current status: ${currentStatus})`);
    this.name = 'RoutingCorpusLabelConflictError';
    this.itemId = itemId;
    this.currentStatus = currentStatus;
  }
}

export function labelRoutingCorpusItem(
  input: LabelRoutingCorpusItemInput,
  db: Database.Database = getDb(),
): RoutingCorpusItem | null {
  ensureRoutingCorpusTables(db);
  let mutationChanges = 0;
  if (input.action === 'label') {
    if (typeof input.labelDomain !== 'string' || input.labelDomain.length === 0) {
      throw new Error('labelDomain is required to label a routing corpus item');
    }
    const candidates = getRoutingLabelCandidates();
    if (!isValidRoutingLabelDomain(input.labelDomain, candidates)) {
      throw new Error(`Unknown routing corpus label domain: ${input.labelDomain}`);
    }
    if (
      input.labelSkill !== undefined
      && (typeof input.labelSkill !== 'string' || input.labelSkill.length === 0)
    ) {
      throw new Error('labelSkill must be a non-empty string when provided');
    }
    if (!isValidRoutingLabelSelection(input.labelDomain, input.labelSkill, candidates)) {
      if (candidates.specialLabels.includes(input.labelDomain)) {
        throw new Error(`Special routing label ${input.labelDomain} must not include a skill`);
      }
      throw new Error(
        `Routing label skill ${input.labelSkill} does not belong to domain ${input.labelDomain}`,
      );
    }
    mutationChanges = db.prepare(`
      UPDATE routing_corpus_items
      SET label_status = 'labeled', label_domain = ?, label_skill = ?, labeled_at = datetime('now')
      WHERE id = ? AND label_status = 'pending'
    `).run(input.labelDomain, input.labelSkill ?? null, input.id).changes;
  } else {
    mutationChanges = db.prepare(`
      UPDATE routing_corpus_items
      SET label_status = 'skipped', label_domain = NULL, label_skill = NULL, labeled_at = datetime('now')
      WHERE id = ? AND label_status = 'pending'
    `).run(input.id).changes;
  }
  if (mutationChanges === 0) {
    const existing = db.prepare(
      'SELECT label_status AS labelStatus FROM routing_corpus_items WHERE id = ?',
    ).get(input.id) as { labelStatus: RoutingCorpusLabelStatus } | undefined;
    if (!existing) return null;
    throw new RoutingCorpusLabelConflictError(input.id, existing.labelStatus);
  }
  const row = db.prepare('SELECT * FROM routing_corpus_items WHERE id = ?').get(input.id);
  return row ? mapItemRow(row) : null;
}

export interface RoutingCorpusProgress {
  total: number;
  pending: number;
  labeled: number;
  skipped: number;
  bySource: Record<string, { total: number; labeled: number }>;
  byDomain: Record<string, number>;
  bySkill: Record<string, number>;
}

export function getRoutingCorpusProgress(
  db: Database.Database = getDb(),
  options: { tenantId?: number; syntheticOnly?: boolean } = {},
): RoutingCorpusProgress {
  ensureRoutingCorpusTables(db);
  if (options.syntheticOnly) {
    if (options.tenantId !== undefined && options.tenantId !== 0) {
      throw new Error('Checked-in synthetic routing corpus scope must use tenant 0');
    }
    const secret = configuredSyntheticControlSecret();
    const controls = checkedInSyntheticControls(secret);
    const hashes = [...controls.keys()];
    const placeholders = hashes.map(() => '?').join(', ');
    const items = (db.prepare(`
      SELECT * FROM routing_corpus_items
      WHERE tenant_id = 0
        AND user_id IS NULL
        AND source IN ('bilingual_fixture', 'manual')
        AND utterance_hash IN (${placeholders})
        AND utterance_text IS NOT NULL
      ORDER BY created_at ASC, id ASC
    `).all(...hashes))
      .map(mapItemRow)
      .filter((item) => isCheckedInSyntheticRoutingCorpusItem(item, secret));
    return summarizeRoutingCorpusProgress(items.map((item) => ({
      source: item.source,
      labelStatus: item.labelStatus,
      labelDomain: item.labelDomain,
      labelSkill: item.labelSkill,
      count: 1,
    })));
  }
  const where = options.tenantId !== undefined ? 'WHERE tenant_id = ?' : '';
  const params = options.tenantId !== undefined ? [options.tenantId] : [];
  const rows = db.prepare(`
    SELECT
      source,
      label_status AS labelStatus,
      label_domain AS labelDomain,
      label_skill AS labelSkill,
      COUNT(*) AS count
    FROM routing_corpus_items ${where}
    GROUP BY source, label_status, label_domain, label_skill
  `).all(...params) as Array<{
    source: string;
    labelStatus: RoutingCorpusLabelStatus;
    labelDomain: string | null;
    labelSkill: string | null;
    count: number;
  }>;

  return summarizeRoutingCorpusProgress(rows);
}

function summarizeRoutingCorpusProgress(
  rows: Array<{
    source: string;
    labelStatus: RoutingCorpusLabelStatus;
    labelDomain: string | null;
    labelSkill: string | null;
    count: number;
  }>,
): RoutingCorpusProgress {
  const progress: RoutingCorpusProgress = {
    total: 0,
    pending: 0,
    labeled: 0,
    skipped: 0,
    bySource: {},
    byDomain: {},
    bySkill: {},
  };
  for (const row of rows) {
    progress.total += row.count;
    progress[row.labelStatus] += row.count;
    const source = progress.bySource[row.source] ?? { total: 0, labeled: 0 };
    source.total += row.count;
    if (row.labelStatus === 'labeled') source.labeled += row.count;
    progress.bySource[row.source] = source;
    if (row.labelStatus === 'labeled' && row.labelDomain) {
      progress.byDomain[row.labelDomain] = (progress.byDomain[row.labelDomain] ?? 0) + row.count;
    }
    if (row.labelStatus === 'labeled' && row.labelSkill) {
      progress.bySkill[row.labelSkill] = (progress.bySkill[row.labelSkill] ?? 0) + row.count;
    }
  }
  return progress;
}

export function listLabeledRoutingCorpusItems(db: Database.Database = getDb()): RoutingCorpusItem[] {
  ensureRoutingCorpusTables(db);
  const rows = db.prepare(`
    SELECT * FROM routing_corpus_items
    WHERE label_status = 'labeled' AND utterance_text IS NOT NULL
    ORDER BY created_at ASC, id ASC
  `).all();
  return rows.map(mapItemRow);
}

// ─── Internals ────────────────────────────────────────────────────

interface HistoryTurn {
  tenantId: number;
  userId: number | null;
  messageUuid: string | null;
  text: string;
  domain: string | null;
}

function loadRecentUserTurns(db: Database.Database, limit: number): HistoryTurn[] {
  if (!tableExists(db, 'messages')) return [];
  const rows = db.prepare(`
    SELECT tenant_id AS tenantId, user_id AS userId, message_uuid AS messageUuid, text, domain
    FROM messages
    WHERE role = 'user' AND text IS NOT NULL AND trim(text) != ''
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    tenantId: toInteger(row.tenantId) ?? 0,
    userId: toInteger(row.userId),
    messageUuid: typeof row.messageUuid === 'string' ? row.messageUuid : null,
    text: String(row.text),
    domain: typeof row.domain === 'string' && row.domain.length > 0 ? row.domain : null,
  }));
}

interface ShadowDisagreementRow {
  tenantId: number;
  userId: number;
  messageHash: string;
  geminiDomain: string | null;
}

function loadShadowDisagreements(db: Database.Database): ShadowDisagreementRow[] {
  if (!tableExists(db, 'classify_shadow_runs')) return [];
  const rows = db.prepare(`
    SELECT tenant_id AS tenantId, user_id AS userId, message_hash AS messageHash, gemini_domain AS geminiDomain
    FROM classify_shadow_runs
    WHERE agree = 0 AND ollama_domain IS NOT NULL
    ORDER BY id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    tenantId: toInteger(row.tenantId) ?? 0,
    userId: toInteger(row.userId) ?? 0,
    messageHash: String(row.messageHash),
    geminiDomain: typeof row.geminiDomain === 'string' && row.geminiDomain.length > 0 ? row.geminiDomain : null,
  }));
}

interface OnlineEvalSampleRow {
  tenantId: number;
  userId: number | null;
  turnId: string;
  domain: string | null;
}

function loadOnlineEvalSamples(db: Database.Database): OnlineEvalSampleRow[] {
  if (!tableExists(db, 'chat_v2_online_eval_samples')) return [];
  const rows = db.prepare(`
    SELECT tenant_id AS tenantId, user_id AS userId, turn_id AS turnId, domain
    FROM chat_v2_online_eval_samples
    WHERE status = 'sampled'
    ORDER BY id ASC
  `).all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    tenantId: toInteger(row.tenantId) ?? 0,
    userId: toInteger(row.userId),
    turnId: String(row.turnId),
    domain: typeof row.domain === 'string' && row.domain.length > 0 ? row.domain : null,
  }));
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  return row !== undefined;
}

function toInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function boundedHistoryLimit(limit: number | undefined): number {
  return Math.min(Math.max(Math.trunc(limit ?? 2000), 1), 20000);
}

function mapItemRow(raw: unknown): RoutingCorpusItem {
  const row = raw as Record<string, unknown>;
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    userId: row.user_id === null || row.user_id === undefined ? null : Number(row.user_id),
    utteranceHash: String(row.utterance_hash),
    utteranceText: row.utterance_text === null || row.utterance_text === undefined ? null : String(row.utterance_text),
    source: row.source as RoutingCorpusSource,
    suggestedDomain: stringOrNull(row.suggested_domain),
    suggestedSkill: stringOrNull(row.suggested_skill),
    labelDomain: stringOrNull(row.label_domain),
    labelSkill: stringOrNull(row.label_skill),
    labelStatus: row.label_status as RoutingCorpusLabelStatus,
    labeledAt: stringOrNull(row.labeled_at),
    createdAt: String(row.created_at),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}
