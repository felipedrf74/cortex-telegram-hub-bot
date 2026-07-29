#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Digest-bound owner review and all-or-nothing application for the synthetic
 * 300-item routing corpus product profile.
 *
 * This command does not turn agent proposals into human ground truth by
 * itself. Read-only inspect writes the exact utterance/domain/skill manifest
 * to an owner-only local file. Apply is permitted only after Felipe reviews
 * that complete file and explicitly authorizes the exact printed plan digest.
 *
 * No provider calls, network calls, or private production utterances are used.
 * If the pre-1.2 builder's 224 raw-HMAC bilingual aliases remain, the same
 * owner-authorized transaction retires that exact all-or-none set after
 * binding it by checked-in text, provenance, state, and row identity.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  CHAT_BILINGUAL_EVAL_FIXTURES,
  CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES,
} from '../src/services/chat-bilingual-eval-fixtures';
import {
  ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES,
  isRoutingCorpusSecretaryCalendarScenario,
  projectBilingualFixturePromptForRoutingCorpus,
} from '../src/services/routing-corpus-product-profile-fixtures';
import {
  ROUTING_CORPUS_BUILDER_VERSION,
  getRoutingLabelCandidates,
  hashRoutingCorpusSyntheticControl,
} from '../src/services/routing-corpus';
import { loadCapabilityManifest } from '../src/services/capability-manifest';
import { prepareProtectedBackupDirectory } from './prune-spanish-routing-corpus';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const PLAN_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const REVIEW_FILE_MODE = 0o600;
const BACKUP_FILE_MODE = 0o600;
const EXPECTED_ITEM_COUNT = 300;
const EXPECTED_MINIMUM_PER_ACTION_SKILL = 20;

type SupportedLocale = 'en' | 'pt';
type SyntheticCorpusSource = 'bilingual_fixture' | 'manual';
type SyntheticCorpusHashScheme = 'synthetic_control_v1';

export interface RoutingCorpusLabelReviewItem {
  proposalId: string;
  locale: SupportedLocale;
  utteranceText: string;
  normalizedUtterance: string;
  source: SyntheticCorpusSource;
  hashScheme: SyntheticCorpusHashScheme;
  labelDomain: string;
  labelSkill: string | null;
  scenarioRefs: string[];
  labelBasis: 'checked_in_fixture_profile' | 'product_profile_expansion';
}

export interface RoutingCorpusLabelReviewSummary {
  total: number;
  byLocale: Record<SupportedLocale, number>;
  bySource: Record<SyntheticCorpusSource, number>;
  byDomain: Record<string, number>;
  bySkill: Record<string, number>;
}

export interface RoutingCorpusLabelReviewManifest {
  schemaVersion: 'routing_corpus_label_review_manifest.v1';
  provenance: 'agent_proposed_owner_review_required';
  sourcePolicy: {
    supportedLocales: ['en', 'pt'];
    spanishRetired: true;
    interpretation: 'product_profile_context';
    privateProductionUtterancesIncluded: false;
  };
  builderVersion: typeof ROUTING_CORPUS_BUILDER_VERSION;
  capabilityManifestVersion: string;
  summary: RoutingCorpusLabelReviewSummary;
  items: RoutingCorpusLabelReviewItem[];
  manifestDigest: string;
}

export interface RoutingCorpusLabelPlanItem {
  id: number;
  tenantId: 0;
  userId: null;
  utteranceHash: string;
  hashScheme: SyntheticCorpusHashScheme;
  utteranceTextSha256: string;
  source: SyntheticCorpusSource;
  labelDomain: string;
  labelSkill: string | null;
  labelStatus: 'pending';
}

export interface RoutingCorpusLegacyAliasPlanItem {
  id: number;
  tenantId: 0;
  userId: null;
  utteranceHash: string;
  utteranceTextSha256: string;
  source: 'bilingual_fixture';
  labelStatus: 'pending';
}

export interface RoutingCorpusLabelPlan {
  schemaVersion: 'routing_corpus_label_plan.v1';
  operation: 'apply_owner_reviewed_routing_corpus_labels';
  dbPath: string;
  builderVersion: typeof ROUTING_CORPUS_BUILDER_VERSION;
  runtimeSha: string;
  artifactDigest: string;
  reviewManifestDigest: string;
  expectedItems: 300;
  acceptedSnapshotCount: 0;
  summary: RoutingCorpusLabelReviewSummary;
  itemRows: RoutingCorpusLabelPlanItem[];
  legacyAliasRows: RoutingCorpusLegacyAliasPlanItem[];
  expectedLegacyAliasesToDelete: 0 | 224;
  integrity: 'ok';
  planDigest: string;
}

export interface InspectRoutingCorpusLabelPlanOptions {
  dbPath: string;
  secret: string;
  runtimeSha: string;
  artifactDigest: string;
}

export interface RunRoutingCorpusLabelPlanOptions extends InspectRoutingCorpusLabelPlanOptions {
  backupDir: string;
  ownerAuthorized: boolean;
  acknowledgedPlanDigest: string;
  /** Test-only interleaving seam; production CLI never supplies this. */
  _testBeforeApplyTransaction?: () => void;
}

export interface RoutingCorpusLabelApplyResult {
  schemaVersion: 'routing_corpus_label_apply.v1';
  status: 'applied';
  dbPath: string;
  runtimeSha: string;
  artifactDigest: string;
  planDigest: string;
  reviewManifestDigest: string;
  labeledItems: 300;
  deletedLegacyAliases: 0 | 224;
  backupPath: string;
  backupIntegrity: 'ok';
  integrity: 'ok';
}

function normalizeUtterance(text: string): string {
  return text.trim().toLocaleLowerCase('und').replace(/\s+/g, ' ');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function fixtureDomain(skill: string): string {
  if (skill === 'secretary' || skill === 'calendar' || skill === 'tasks') return 'secretary';
  if (skill === 'training') return 'triathlon';
  return skill;
}

function fixtureActionSkill(skill: string, scenario: string): string | null {
  if (skill === 'secretary' && isRoutingCorpusSecretaryCalendarScenario(scenario)) {
    return 'secretary_calendar';
  }
  if (skill === 'secretary') return null;
  if (skill === 'calendar') return 'secretary_calendar';
  return skill;
}

function confusableActionSkill(scenario: string): string {
  if (scenario.includes('meeting') || scenario.includes('agenda')) return 'secretary_calendar';
  if (scenario.includes('reminder')) return 'secretary_reminders';
  return 'tasks';
}

function legacyBilingualFixtureUtterances(): string[] {
  const byNormalized = new Map<string, string>();
  for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
    for (const utteranceText of [fixture.pt, fixture.en]) {
      byNormalized.set(normalizeUtterance(utteranceText), utteranceText);
    }
  }
  for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
    if (fixture.promptLocale === 'pt-BR') {
      byNormalized.set(normalizeUtterance(fixture.prompt), fixture.prompt);
    }
  }
  const utterances = [...byNormalized.values()];
  if (utterances.length !== 224) {
    throw new Error(`Expected 224 legacy bilingual fixture utterances; found ${utterances.length}`);
  }
  return utterances;
}

function makeReviewItem(input: Omit<RoutingCorpusLabelReviewItem, 'proposalId' | 'normalizedUtterance'>): RoutingCorpusLabelReviewItem {
  const normalizedUtterance = normalizeUtterance(input.utteranceText);
  return {
    proposalId: sha256(`${input.locale}\u0000${normalizedUtterance}`).slice(0, 16),
    normalizedUtterance,
    ...input,
  };
}

function hashReviewItem(secret: string, item: RoutingCorpusLabelReviewItem): string {
  return hashRoutingCorpusSyntheticControl(secret, item.utteranceText);
}

function summarizeReviewItems(items: readonly RoutingCorpusLabelReviewItem[]): RoutingCorpusLabelReviewSummary {
  const byDomain: Record<string, number> = {};
  const bySkill: Record<string, number> = {};
  const summary: RoutingCorpusLabelReviewSummary = {
    total: items.length,
    byLocale: { en: 0, pt: 0 },
    bySource: { bilingual_fixture: 0, manual: 0 },
    byDomain,
    bySkill,
  };
  for (const item of items) {
    summary.byLocale[item.locale] += 1;
    summary.bySource[item.source] += 1;
    byDomain[item.labelDomain] = (byDomain[item.labelDomain] ?? 0) + 1;
    const skill = item.labelSkill ?? 'unlabeled';
    bySkill[skill] = (bySkill[skill] ?? 0) + 1;
  }
  return summary;
}

function assertReviewManifestCoverage(
  items: readonly RoutingCorpusLabelReviewItem[],
  summary: RoutingCorpusLabelReviewSummary,
): void {
  if (items.length !== EXPECTED_ITEM_COUNT) {
    throw new Error(`Routing label review manifest must contain exactly ${EXPECTED_ITEM_COUNT} items; found ${items.length}`);
  }
  if (new Set(items.map((item) => item.normalizedUtterance)).size !== items.length) {
    throw new Error('Routing label review manifest contains duplicate normalized utterances');
  }
  if (items.some((item) => item.locale !== 'en' && item.locale !== 'pt')) {
    throw new Error('Routing label review manifest may contain only supported English and Portuguese rows');
  }

  const candidates = getRoutingLabelCandidates();
  for (const item of items) {
    if (candidates.specialLabels.includes(item.labelDomain)) {
      if (item.labelSkill !== null) {
        throw new Error(`Special routing label ${item.labelDomain} cannot carry a skill`);
      }
      continue;
    }
    const skills = candidates.skillsByDomain[item.labelDomain];
    if (!candidates.domains.includes(item.labelDomain) || !skills) {
      throw new Error(`Unknown routing label domain in review manifest: ${item.labelDomain}`);
    }
    if (item.labelSkill !== null && !skills.includes(item.labelSkill)) {
      throw new Error(`Skill ${item.labelSkill} does not belong to domain ${item.labelDomain}`);
    }
  }

  for (const domain of candidates.domains) {
    if ((summary.byDomain[domain] ?? 0) === 0) {
      throw new Error(`Routing label review manifest does not cover domain ${domain}`);
    }
  }
  for (const special of candidates.specialLabels) {
    if ((summary.byDomain[special] ?? 0) === 0) {
      throw new Error(`Routing label review manifest does not cover special label ${special}`);
    }
  }
  const actionSkills = new Set(Object.values(candidates.skillsByDomain).flat());
  for (const skill of actionSkills) {
    const count = summary.bySkill[skill] ?? 0;
    if (count < EXPECTED_MINIMUM_PER_ACTION_SKILL) {
      throw new Error(
        `Routing label review manifest needs at least ${EXPECTED_MINIMUM_PER_ACTION_SKILL} items for skill ${skill}; found ${count}`,
      );
    }
  }
}

/**
 * Build the complete private owner-review artifact from checked-in,
 * version-controlled product profile fixtures. The result is deterministic.
 */
export function buildRoutingCorpusLabelReviewManifest(): RoutingCorpusLabelReviewManifest {
  const deduped = new Map<string, RoutingCorpusLabelReviewItem>();
  const record = (item: RoutingCorpusLabelReviewItem): void => {
    const prior = deduped.get(item.normalizedUtterance);
    if (!prior) {
      deduped.set(item.normalizedUtterance, item);
      return;
    }
    if (prior.labelDomain !== item.labelDomain || prior.labelSkill !== item.labelSkill) {
      throw new Error(`Conflicting product-profile labels for duplicate utterance ${item.proposalId}`);
    }
    prior.scenarioRefs = [...new Set([...prior.scenarioRefs, ...item.scenarioRefs])].sort();
  };

  for (const fixture of CHAT_BILINGUAL_EVAL_FIXTURES) {
    const labelDomain = fixtureDomain(fixture.skill);
    const labelSkill = fixtureActionSkill(fixture.skill, fixture.scenario);
    for (const [locale, original] of [['pt', fixture.pt], ['en', fixture.en]] as const) {
      const utteranceText = projectBilingualFixturePromptForRoutingCorpus(
        fixture.scenario,
        locale,
        original,
      );
      record(makeReviewItem({
        locale,
        utteranceText,
        source: 'bilingual_fixture',
        hashScheme: 'synthetic_control_v1',
        labelDomain,
        labelSkill,
        scenarioRefs: [fixture.scenario],
        labelBasis: 'checked_in_fixture_profile',
      }));
    }
  }

  for (const fixture of CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES) {
    if (fixture.promptLocale !== 'pt-BR') continue;
    record(makeReviewItem({
      locale: 'pt',
      utteranceText: fixture.prompt,
      source: 'bilingual_fixture',
      hashScheme: 'synthetic_control_v1',
      labelDomain: 'secretary',
      labelSkill: confusableActionSkill(fixture.scenario),
      scenarioRefs: [fixture.scenario],
      labelBasis: 'checked_in_fixture_profile',
    }));
  }

  for (const fixture of ROUTING_CORPUS_PRODUCT_PROFILE_FIXTURES) {
    record(makeReviewItem({
      locale: fixture.locale,
      utteranceText: fixture.prompt,
      source: 'manual',
      hashScheme: 'synthetic_control_v1',
      labelDomain: fixture.labelDomain,
      labelSkill: fixture.labelSkill,
      scenarioRefs: [`product_profile_expansion:${sha256(normalizeUtterance(fixture.prompt)).slice(0, 16)}`],
      labelBasis: 'product_profile_expansion',
    }));
  }

  const items = [...deduped.values()].sort((left, right) => (
    left.proposalId.localeCompare(right.proposalId)
  ));
  const summary = summarizeReviewItems(items);
  assertReviewManifestCoverage(items, summary);
  const payload = {
    schemaVersion: 'routing_corpus_label_review_manifest.v1' as const,
    provenance: 'agent_proposed_owner_review_required' as const,
    sourcePolicy: {
      supportedLocales: ['en', 'pt'] as ['en', 'pt'],
      spanishRetired: true as const,
      interpretation: 'product_profile_context' as const,
      privateProductionUtterancesIncluded: false as const,
    },
    builderVersion: ROUTING_CORPUS_BUILDER_VERSION,
    capabilityManifestVersion: loadCapabilityManifest().version,
    summary,
    items,
  };
  return {
    ...payload,
    manifestDigest: `sha256:${sha256(canonicalJson(payload))}`,
  };
}

function assertReleaseIdentity(runtimeSha: string, artifactDigest: string): void {
  if (!/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('A full lowercase deployed runtime SHA is required');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error('A full lowercase deployed artifact SHA-256 is required');
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

interface RoutingCorpusStateRow {
  id: number;
  tenantId: number;
  userId: number | null;
  utteranceHash: string;
  utteranceText: string | null;
  source: string;
  labelDomain: string | null;
  labelSkill: string | null;
  labelStatus: string;
  labeledAt: string | null;
}

function collectProductProfileRows(
  db: Database.Database,
  manifest: RoutingCorpusLabelReviewManifest,
  secret: string,
): RoutingCorpusLabelPlanItem[] {
  const expected = manifest.items.map((item) => ({
    item,
    utteranceHash: hashReviewItem(secret, item),
  }));
  const hashes = expected.map((entry) => entry.utteranceHash);
  const placeholders = hashes.map(() => '?').join(', ');
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
    ORDER BY utterance_hash ASC, id ASC
  `).all(...hashes) as RoutingCorpusStateRow[];

  if (rows.length !== EXPECTED_ITEM_COUNT) {
    throw new Error(`Expected ${EXPECTED_ITEM_COUNT} exact product-profile corpus rows; found ${rows.length}`);
  }
  const rowByHash = new Map(rows.map((row) => [row.utteranceHash, row]));
  const itemRows: RoutingCorpusLabelPlanItem[] = [];
  for (const entry of expected) {
    const row = rowByHash.get(entry.utteranceHash);
    if (
      !row
      || row.utteranceText !== entry.item.utteranceText
      || row.tenantId !== 0
      || row.userId !== null
      || row.source !== entry.item.source
    ) {
      throw new Error(`Product-profile corpus row identity or provenance mismatch for ${entry.item.proposalId}`);
    }
    if (
      row.labelStatus !== 'pending'
      || row.labelDomain !== null
      || row.labelSkill !== null
      || row.labeledAt !== null
    ) {
      throw new Error('All product-profile corpus rows must remain pending and unlabeled before apply');
    }
    itemRows.push({
      id: row.id,
      tenantId: 0,
      userId: null,
      utteranceHash: row.utteranceHash,
      hashScheme: entry.item.hashScheme,
      utteranceTextSha256: sha256(row.utteranceText),
      source: entry.item.source,
      labelDomain: entry.item.labelDomain,
      labelSkill: entry.item.labelSkill,
      labelStatus: 'pending',
    });
  }
  return itemRows.sort((left, right) => left.utteranceHash.localeCompare(right.utteranceHash));
}

function collectLegacyAliasRows(
  db: Database.Database,
  manifest: RoutingCorpusLabelReviewManifest,
  itemRows: readonly RoutingCorpusLabelPlanItem[],
): RoutingCorpusLegacyAliasPlanItem[] {
  const expectedUtterances = legacyBilingualFixtureUtterances();

  const currentBilingualIds = new Set(
    itemRows
      .filter((row) => row.source === 'bilingual_fixture')
      .map((row) => row.id),
  );
  if (currentBilingualIds.size !== 224) {
    throw new Error(`Expected 224 current bilingual fixture rows; found ${currentBilingualIds.size}`);
  }

  // Select by immutable fixture provenance, not a recomputed raw HMAC. This
  // intentionally finds aliases created under an older hash secret.
  const rows = (db.prepare(`
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
    WHERE source = 'bilingual_fixture'
    ORDER BY utterance_hash ASC, id ASC
  `).all() as RoutingCorpusStateRow[])
    .filter((row) => !currentBilingualIds.has(row.id));

  if (rows.length !== 0 && rows.length !== 224) {
    throw new Error(`Legacy bilingual aliases must be all present or all absent; found ${rows.length}`);
  }
  if (rows.length === 0) return [];

  const expectedByText = new Set(expectedUtterances);
  const seenTexts = new Set<string>();
  const aliases = rows.map((row) => {
    const expectedText = row.utteranceText !== null && expectedByText.has(row.utteranceText)
      ? row.utteranceText
      : undefined;
    if (
      !expectedText
      || seenTexts.has(expectedText)
      || row.tenantId !== 0
      || row.userId !== null
      || row.source !== 'bilingual_fixture'
      || row.labelStatus !== 'pending'
      || row.labelDomain !== null
      || row.labelSkill !== null
      || row.labeledAt !== null
    ) {
      throw new Error('Legacy bilingual alias identity, provenance, or pending state mismatch');
    }
    seenTexts.add(expectedText);
    return {
      id: row.id,
      tenantId: 0 as const,
      userId: null,
      utteranceHash: row.utteranceHash,
      utteranceTextSha256: sha256(expectedText),
      source: 'bilingual_fixture' as const,
      labelStatus: 'pending' as const,
    };
  });
  if (seenTexts.size !== expectedUtterances.length) {
    throw new Error(
      `Legacy bilingual alias identity set is incomplete; expected ${expectedUtterances.length} unique fixture texts, found ${seenTexts.size}`,
    );
  }
  return aliases.sort((left, right) => (
    left.utteranceHash.localeCompare(right.utteranceHash) || left.id - right.id
  ));
}

function collectPlanState(
  db: Database.Database,
  manifest: RoutingCorpusLabelReviewManifest,
  secret: string,
): {
  itemRows: RoutingCorpusLabelPlanItem[];
  legacyAliasRows: RoutingCorpusLegacyAliasPlanItem[];
  acceptedSnapshotCount: number;
} {
  const itemRows = collectProductProfileRows(db, manifest, secret);
  const legacyAliasRows = collectLegacyAliasRows(db, manifest, itemRows);
  const acceptedSnapshotCount = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM accepted_accuracy_snapshots
    WHERE accepted = 1
  `).get() as { count: number }).count);
  return { itemRows, legacyAliasRows, acceptedSnapshotCount };
}

/**
 * Read-only database-bound plan. Raw utterances stay in the separate review
 * manifest; stdout-safe plan rows contain only HMAC and text digests.
 */
export function inspectRoutingCorpusLabelPlan(
  options: InspectRoutingCorpusLabelPlanOptions,
): RoutingCorpusLabelPlan {
  if (!options.secret) throw new Error('Missing CLASSIFY_SHADOW_HASH_SECRET');
  assertReleaseIdentity(options.runtimeSha, options.artifactDigest);
  if (!fs.existsSync(options.dbPath)) throw new Error(`Database does not exist: ${options.dbPath}`);

  const manifest = buildRoutingCorpusLabelReviewManifest();
  const canonicalDbPath = fs.realpathSync(options.dbPath);
  const db = new Database(canonicalDbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Database integrity check failed before planning: ${String(integrity)}`);
    }
    if (!tableExists(db, 'routing_corpus_items') || !tableExists(db, 'accepted_accuracy_snapshots')) {
      throw new Error('Routing corpus schema is not present in the target database');
    }

    const { itemRows, legacyAliasRows, acceptedSnapshotCount } = collectPlanState(
      db,
      manifest,
      options.secret,
    );
    if (acceptedSnapshotCount > 0) {
      throw new Error('Refusing to label after an accepted routing accuracy snapshot exists');
    }

    const payload = {
      schemaVersion: 'routing_corpus_label_plan.v1' as const,
      operation: 'apply_owner_reviewed_routing_corpus_labels' as const,
      dbPath: canonicalDbPath,
      builderVersion: ROUTING_CORPUS_BUILDER_VERSION,
      runtimeSha: options.runtimeSha,
      artifactDigest: options.artifactDigest,
      reviewManifestDigest: manifest.manifestDigest,
      expectedItems: EXPECTED_ITEM_COUNT as 300,
      acceptedSnapshotCount: 0 as const,
      summary: manifest.summary,
      itemRows,
      legacyAliasRows,
      expectedLegacyAliasesToDelete: legacyAliasRows.length as 0 | 224,
      integrity: 'ok' as const,
    };
    return {
      ...payload,
      planDigest: `sha256:${sha256(canonicalJson(payload))}`,
    };
  } finally {
    db.close();
  }
}

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertProtectedBackupFile(backupPath: string): void {
  const stat = fs.lstatSync(backupPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Routing corpus backup must be a regular non-symlink file: ${backupPath}`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Routing corpus backup must be owned by the current user: ${backupPath}`);
  }
  if ((stat.mode & 0o777) !== BACKUP_FILE_MODE) {
    throw new Error(`Routing corpus backup permissions must be 0600: ${backupPath}`);
  }
}

function verifySqliteIntegrity(dbPath: string): 'ok' {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') throw new Error(`Database integrity check failed: ${String(integrity)}`);
    return 'ok';
  } finally {
    db.close();
  }
}

async function createProtectedBackup(
  db: Database.Database,
  inputBackupDir: string,
): Promise<{ backupPath: string; backupIntegrity: 'ok' }> {
  const backupDir = prepareProtectedBackupDirectory(inputBackupDir);
  // Revalidate immediately before destination selection.
  if (prepareProtectedBackupDirectory(backupDir) !== backupDir) {
    throw new Error('Protected backup directory identity changed during preflight');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `routing-corpus-before-owner-reviewed-labels-${stamp}-${process.pid}.db`,
  );
  if (fs.existsSync(backupPath)) throw new Error(`Refusing to overwrite routing corpus backup: ${backupPath}`);

  const previousUmask = process.umask(0o077);
  try {
    await db.backup(backupPath);
  } finally {
    process.umask(previousUmask);
  }
  fs.chmodSync(backupPath, BACKUP_FILE_MODE);
  assertProtectedBackupFile(backupPath);
  return { backupPath, backupIntegrity: verifySqliteIntegrity(backupPath) };
}

function auditReceiptDetails(plan: RoutingCorpusLabelPlan): Record<string, unknown> {
  return {
    provenance: 'agent_proposed_owner_approved',
    planDigest: plan.planDigest,
    reviewManifestDigest: plan.reviewManifestDigest,
    labeledItems: plan.expectedItems,
    deletedLegacyAliases: plan.expectedLegacyAliasesToDelete,
    runtimeSha: plan.runtimeSha,
    artifactDigest: plan.artifactDigest,
    builderVersion: plan.builderVersion,
    summary: plan.summary,
  };
}

export async function runRoutingCorpusLabelPlan(
  options: RunRoutingCorpusLabelPlanOptions,
): Promise<RoutingCorpusLabelApplyResult> {
  const plan = inspectRoutingCorpusLabelPlan(options);
  if (options.ownerAuthorized !== true) {
    throw new Error('Production routing-corpus mutation requires explicit owner authorization');
  }
  if (
    !PLAN_DIGEST_RE.test(options.acknowledgedPlanDigest)
    || options.acknowledgedPlanDigest !== plan.planDigest
  ) {
    throw new Error(
      `Production routing-corpus mutation requires acknowledgement of exact plan digest ${plan.planDigest}`,
    );
  }

  // Authorization and exact acknowledgement precede even backup-directory creation.
  const backupDir = prepareProtectedBackupDirectory(options.backupDir);
  const db = new Database(plan.dbPath);
  try {
    if (!tableExists(db, 'audit_trail')) {
      throw new Error('Durable audit_trail schema is required before routing corpus label apply');
    }
    const { backupPath, backupIntegrity } = await createProtectedBackup(db, backupDir);
    const currentPlan = inspectRoutingCorpusLabelPlan(options);
    if (currentPlan.planDigest !== options.acknowledgedPlanDigest) {
      throw new Error(
        `Routing-corpus labeling state changed after backup; inspect and authorize ${currentPlan.planDigest}`,
      );
    }

    const manifest = buildRoutingCorpusLabelReviewManifest();
    if (manifest.manifestDigest !== currentPlan.reviewManifestDigest) {
      throw new Error('Routing corpus review manifest changed after plan inspection');
    }
    const labelByHash = new Map(manifest.items.map((item) => [
      hashReviewItem(options.secret, item),
      item,
    ]));
    const bilingualTextByDigest = new Map(
      legacyBilingualFixtureUtterances()
        .map((utteranceText) => [sha256(utteranceText), utteranceText]),
    );
    const legacyTextByHash = new Map(
      currentPlan.legacyAliasRows.map((row) => [
        row.utteranceHash,
        bilingualTextByDigest.get(row.utteranceTextSha256),
      ]),
    );
    const labeledAt = new Date().toISOString();
    options._testBeforeApplyTransaction?.();
    const apply = db.transaction(() => {
      let reboundState: ReturnType<typeof collectPlanState>;
      try {
        reboundState = collectPlanState(db, manifest, options.secret);
      } catch (error) {
        throw new Error(
          `Routing-corpus labeling state changed inside the immediate transaction: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { cause: error },
        );
      }
      if (reboundState.acceptedSnapshotCount > 0) {
        throw new Error(
          'An accepted routing accuracy snapshot appeared before the label transaction; re-inspect the rollout state',
        );
      }
      const expectedState = {
        itemRows: currentPlan.itemRows,
        legacyAliasRows: currentPlan.legacyAliasRows,
      };
      const actualState = {
        itemRows: reboundState.itemRows,
        legacyAliasRows: reboundState.legacyAliasRows,
      };
      if (canonicalJson(actualState) !== canonicalJson(expectedState)) {
        throw new Error(
          'Routing-corpus labeling state changed inside the immediate transaction; inspect and authorize a new plan digest',
        );
      }

      const update = db.prepare(`
        UPDATE routing_corpus_items
        SET label_status = 'labeled', label_domain = ?, label_skill = ?, labeled_at = ?
        WHERE id = ?
          AND utterance_hash = ?
          AND utterance_text = ?
          AND tenant_id = 0
          AND user_id IS NULL
          AND source = ?
          AND label_status = 'pending'
          AND label_domain IS NULL
          AND label_skill IS NULL
          AND labeled_at IS NULL
      `);
      let labeledItems = 0;
      for (const row of currentPlan.itemRows) {
        const label = labelByHash.get(row.utteranceHash);
        if (!label) throw new Error(`Missing approved label for corpus row ${row.id}`);
        const result = update.run(
          label.labelDomain,
          label.labelSkill,
          labeledAt,
          row.id,
          row.utteranceHash,
          label.utteranceText,
          row.source,
        );
        if (result.changes !== 1) {
          throw new Error(`Routing corpus label update changed ${result.changes} rows for id ${row.id}`);
        }
        labeledItems += 1;
      }
      if (labeledItems !== EXPECTED_ITEM_COUNT) {
        throw new Error(`Routing corpus label transaction changed ${labeledItems} rows; expected ${EXPECTED_ITEM_COUNT}`);
      }

      const removeLegacyAlias = db.prepare(`
        DELETE FROM routing_corpus_items
        WHERE id = ?
          AND utterance_hash = ?
          AND utterance_text = ?
          AND tenant_id = 0
          AND user_id IS NULL
          AND source = 'bilingual_fixture'
          AND label_status = 'pending'
          AND label_domain IS NULL
          AND label_skill IS NULL
          AND labeled_at IS NULL
      `);
      let deletedLegacyAliases = 0;
      for (const row of currentPlan.legacyAliasRows) {
        const utteranceText = legacyTextByHash.get(row.utteranceHash);
        if (typeof utteranceText !== 'string') {
          throw new Error(`Missing reviewed text for legacy bilingual alias ${row.id}`);
        }
        const result = removeLegacyAlias.run(row.id, row.utteranceHash, utteranceText);
        if (result.changes !== 1) {
          throw new Error(`Legacy bilingual alias delete changed ${result.changes} rows for id ${row.id}`);
        }
        deletedLegacyAliases += 1;
      }
      if (deletedLegacyAliases !== currentPlan.expectedLegacyAliasesToDelete) {
        throw new Error(
          `Legacy bilingual alias cleanup changed ${deletedLegacyAliases} rows; expected ${currentPlan.expectedLegacyAliasesToDelete}`,
        );
      }

      const receipt = db.prepare(`
        INSERT INTO audit_trail (
          tenant_id, user_id, actor_id, action, resource, details, ip_address
        ) VALUES (0, 0, 0, 'admin_mutation', 'routing_corpus.owner_reviewed_batch', ?, NULL)
      `).run(canonicalJson(auditReceiptDetails(currentPlan)));
      if (receipt.changes !== 1) {
        throw new Error('Failed to write the routing corpus owner-review audit receipt');
      }
      const transactionIntegrity = db.pragma('integrity_check', { simple: true });
      if (transactionIntegrity !== 'ok') {
        throw new Error(
          `Database integrity check failed inside label transaction: ${String(transactionIntegrity)}`,
        );
      }
      return { labeledItems, deletedLegacyAliases };
    });
    const { labeledItems, deletedLegacyAliases } = apply.immediate();

    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Database integrity check failed after labeling: ${String(integrity)}`);
    }
    return {
      schemaVersion: 'routing_corpus_label_apply.v1',
      status: 'applied',
      dbPath: plan.dbPath,
      runtimeSha: plan.runtimeSha,
      artifactDigest: plan.artifactDigest,
      planDigest: plan.planDigest,
      reviewManifestDigest: plan.reviewManifestDigest,
      labeledItems: labeledItems as 300,
      deletedLegacyAliases: deletedLegacyAliases as 0 | 224,
      backupPath,
      backupIntegrity,
      integrity: 'ok',
    };
  } finally {
    db.close();
  }
}

export function writeRoutingCorpusLabelReviewManifest(
  outputPath: string,
  manifest = buildRoutingCorpusLabelReviewManifest(),
): { outputPath: string; manifestDigest: string } {
  const resolved = path.resolve(outputPath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Review manifest parent directory does not exist: ${parent}`);
  }
  const previousUmask = process.umask(0o077);
  let fd: number | undefined;
  try {
    fd = fs.openSync(resolved, 'wx', REVIEW_FILE_MODE);
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    process.umask(previousUmask);
  }
  fs.chmodSync(resolved, REVIEW_FILE_MODE);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== REVIEW_FILE_MODE) {
    throw new Error(`Review manifest must be a regular owner-only file: ${resolved}`);
  }
  return { outputPath: resolved, manifestDigest: manifest.manifestDigest };
}

function readArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (match) return match.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const inspect = process.argv.includes('--inspect');
  const apply = process.argv.includes('--apply');
  if (inspect === apply) {
    throw new Error('Choose exactly one read-only --inspect or owner-authorized --apply mode');
  }

  const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
  const runtimeSha = readArg('--runtime-sha') ?? '';
  const artifactDigest = readArg('--artifact-digest') ?? '';
  const secret = process.env.CLASSIFY_SHADOW_HASH_SECRET ?? '';
  const baseOptions = { dbPath, runtimeSha, artifactDigest, secret };

  if (inspect) {
    const reviewOut = readArg('--review-out');
    if (!reviewOut) throw new Error('Read-only inspect requires --review-out=<owner-only-local-json>');
    const review = writeRoutingCorpusLabelReviewManifest(reviewOut);
    const plan = inspectRoutingCorpusLabelPlan(baseOptions);
    console.log(JSON.stringify({ ...plan, reviewFile: review.outputPath }, null, 2));
    return;
  }

  const backupDir = readArg('--backup-dir');
  if (!backupDir) throw new Error('Apply requires --backup-dir=<protected-backup-directory>');
  const result = await runRoutingCorpusLabelPlan({
    ...baseOptions,
    backupDir,
    ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
    acknowledgedPlanDigest: readArg('--ack-plan') ?? '',
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
