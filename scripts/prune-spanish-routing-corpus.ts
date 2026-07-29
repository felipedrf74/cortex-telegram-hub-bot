#!/usr/bin/env tsx
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Owner-authorized cleanup for the eight retired es-419 synthetic routing
 * corpus fixtures. This never classifies or deletes arbitrary text.
 *
 * Deploy routing-corpus-builder@1.1.0 before running this command so a later
 * corpus rebuild cannot recreate the retired rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import {
  ROUTING_CORPUS_BUILDER_VERSION,
  hashRoutingUtterance,
  pruneSpanishSyntheticRoutingCorpusFixtures,
  type PruneSpanishSyntheticRoutingCorpusFixturesResult,
} from '../src/services/routing-corpus';
import { CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES } from '../src/services/chat-bilingual-eval-fixtures';

dotenv.config({ quiet: true });
dotenv.config({ path: '.env.local', override: false, quiet: true });

const PROTECTED_DIRECTORY_MODE = 0o700;
const PROTECTED_BACKUP_FILE_MODE = 0o600;
const RETIRED_SPANISH_FIXTURE_COUNT = 8;
const PLAN_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface InspectSpanishRoutingCorpusRetirementOptions {
  dbPath: string;
  secret: string;
  runtimeSha: string;
  artifactDigest: string;
}

export interface SpanishRoutingCorpusRetirementPlan {
  schemaVersion: 'routing_corpus_spanish_retirement_plan.v1';
  operation: 'prune_retired_spanish_synthetic_routing_corpus';
  dbPath: string;
  builderVersion: typeof ROUTING_CORPUS_BUILDER_VERSION;
  runtimeSha: string;
  artifactDigest: string;
  status: 'ready' | 'already_absent';
  expectedFixtures: 8;
  acceptedSnapshotCount: number;
  fixtureRows: Array<{
    id: number;
    tenantId: 0;
    userId: null;
    utteranceHash: string;
    utteranceTextSha256: string;
    source: 'bilingual_fixture';
    labelStatus: 'pending';
  }>;
  cacheEntries: Array<{
    utteranceHash: string;
    domain: string;
    confidence: number;
    model: string | null;
    createdAt: string;
  }>;
  integrity: 'ok';
  planDigest: string;
}

export interface RunSpanishRoutingCorpusRetirementOptions {
  dbPath: string;
  backupDir: string;
  secret: string;
  runtimeSha: string;
  artifactDigest: string;
  ownerAuthorized: boolean;
  acknowledgedPlanDigest: string;
}

export interface RunSpanishRoutingCorpusRetirementResult
  extends PruneSpanishSyntheticRoutingCorpusFixturesResult {
  schemaVersion: 'routing_corpus_spanish_retirement.v2';
  dbPath: string;
  runtimeSha: string;
  artifactDigest: string;
  planDigest: string;
  backupPath: string;
  backupIntegrity: 'ok';
  integrity: 'ok';
}

function readArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (match) return match.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assertReleaseIdentity(runtimeSha: string, artifactDigest: string): void {
  if (!/^[a-f0-9]{40}$/.test(runtimeSha)) {
    throw new Error('A full lowercase deployed runtime SHA is required');
  }
  if (!/^[a-f0-9]{64}$/.test(artifactDigest)) {
    throw new Error('A full lowercase deployed artifact SHA-256 is required');
  }
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read-only exact mutation plan. The digest binds the canonical database
 * target, deployed release identity, exact fixture row identities, matching
 * cache entries, accepted-snapshot precondition, and database integrity.
 */
export function inspectSpanishRoutingCorpusRetirement(
  options: InspectSpanishRoutingCorpusRetirementOptions,
): SpanishRoutingCorpusRetirementPlan {
  if (!options.secret) throw new Error('Missing CLASSIFY_SHADOW_HASH_SECRET');
  assertReleaseIdentity(options.runtimeSha, options.artifactDigest);
  if (!fs.existsSync(options.dbPath)) {
    throw new Error(`Database does not exist: ${options.dbPath}`);
  }
  const canonicalDbPath = fs.realpathSync(options.dbPath);
  const db = new Database(canonicalDbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Database integrity check failed before planning: ${String(integrity)}`);
    }
    const fixtures = CHAT_LOCALE_CONFUSABLE_EVAL_FIXTURES
      .filter((fixture) => fixture.promptLocale === 'es-419')
      .map((fixture) => ({
        text: fixture.prompt,
        hash: hashRoutingUtterance(options.secret, fixture.prompt),
      }));
    if (fixtures.length !== RETIRED_SPANISH_FIXTURE_COUNT) {
      throw new Error(
        `Expected ${RETIRED_SPANISH_FIXTURE_COUNT} retired Spanish fixtures, found ${fixtures.length}`,
      );
    }

    const hashes = fixtures.map((fixture) => fixture.hash);
    const texts = fixtures.map((fixture) => fixture.text);
    const placeholders = fixtures.map(() => '?').join(', ');
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
      ORDER BY utterance_hash ASC, id ASC
    `).all(...hashes, ...texts) as Array<{
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
    }>;

    if (rows.length !== 0 && rows.length !== fixtures.length) {
      throw new Error(
        `Refusing partial Spanish synthetic fixture set: expected ${fixtures.length} or 0 rows, found ${rows.length}`,
      );
    }
    for (const fixture of fixtures) {
      const matching = rows.filter((row) => (
        row.utteranceHash === fixture.hash || row.utteranceText === fixture.text
      ));
      if (rows.length === 0) break;
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

    const cacheEntries = db.prepare(`
      SELECT
        utterance_hash AS utteranceHash,
        domain,
        confidence,
        model,
        created_at AS createdAt
      FROM routing_llm_classify_cache
      WHERE utterance_hash IN (${placeholders})
      ORDER BY utterance_hash ASC
    `).all(...hashes) as SpanishRoutingCorpusRetirementPlan['cacheEntries'];
    const acceptedSnapshotCount = Number((db.prepare(`
      SELECT COUNT(*) AS count
      FROM accepted_accuracy_snapshots
      WHERE accepted = 1
    `).get() as { count: number }).count);
    const status = rows.length === 0 && cacheEntries.length === 0
      ? 'already_absent' as const
      : 'ready' as const;
    if (status === 'ready' && acceptedSnapshotCount > 0) {
      throw new Error('Refusing to plan a prune after an accepted routing accuracy snapshot exists');
    }

    const fixtureRows: SpanishRoutingCorpusRetirementPlan['fixtureRows'] = rows.map((row) => ({
      id: row.id,
      tenantId: 0,
      userId: null,
      utteranceHash: row.utteranceHash,
      utteranceTextSha256: sha256(row.utteranceText!),
      source: 'bilingual_fixture',
      labelStatus: 'pending',
    }));
    const payload = {
      schemaVersion: 'routing_corpus_spanish_retirement_plan.v1' as const,
      operation: 'prune_retired_spanish_synthetic_routing_corpus' as const,
      dbPath: canonicalDbPath,
      builderVersion: ROUTING_CORPUS_BUILDER_VERSION,
      runtimeSha: options.runtimeSha,
      artifactDigest: options.artifactDigest,
      status,
      expectedFixtures: RETIRED_SPANISH_FIXTURE_COUNT as 8,
      acceptedSnapshotCount,
      fixtureRows,
      cacheEntries,
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

function assertOwnedByCurrentUser(
  targetPath: string,
  stat: fs.Stats,
  kind: 'backup directory' | 'backup file',
): void {
  const uid = currentUid();
  if (uid != null && stat.uid !== uid) {
    throw new Error(
      `Protected ${kind} must be owned by the current user: ${targetPath}`,
    );
  }
}

function assertProtectedBackupDirectory(backupDir: string): void {
  const stat = fs.lstatSync(backupDir);
  if (stat.isSymbolicLink()) {
    throw new Error(`Protected backup directory must not be a symbolic link: ${backupDir}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Protected backup directory is not a directory: ${backupDir}`);
  }
  assertOwnedByCurrentUser(backupDir, stat, 'backup directory');
  const mode = stat.mode & 0o777;
  if ((mode & 0o700) !== 0o700 || (mode & 0o077) !== 0) {
    throw new Error(
      `Protected backup directory permissions must be 0700 (found ${mode.toString(8).padStart(3, '0')}): ${backupDir}`,
    );
  }
  fs.accessSync(backupDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

/**
 * Resolve and preflight the mutation backup directory. Existing directories
 * are never chmodded implicitly: unsafe operator input fails closed. A
 * missing directory is created owner-only and then independently verified.
 */
export function prepareProtectedBackupDirectory(inputPath: string): string {
  const backupDir = path.resolve(inputPath);
  try {
    fs.lstatSync(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    fs.mkdirSync(backupDir, { recursive: true, mode: PROTECTED_DIRECTORY_MODE });
    fs.chmodSync(backupDir, PROTECTED_DIRECTORY_MODE);
  }
  assertProtectedBackupDirectory(backupDir);
  const canonicalBackupDir = fs.realpathSync(backupDir);
  assertProtectedBackupDirectory(canonicalBackupDir);
  return canonicalBackupDir;
}

function assertProtectedBackupFile(backupPath: string): void {
  const stat = fs.lstatSync(backupPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Routing corpus backup file must not be a symbolic link: ${backupPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`Routing corpus backup path is not a regular file: ${backupPath}`);
  }
  assertOwnedByCurrentUser(backupPath, stat, 'backup file');
  const mode = stat.mode & 0o777;
  if (mode !== PROTECTED_BACKUP_FILE_MODE) {
    throw new Error(
      `Routing corpus backup file permissions must be 0600 (found ${mode.toString(8).padStart(3, '0')}): ${backupPath}`,
    );
  }
}

async function createProtectedDatabaseBackup(
  db: Database.Database,
  backupDir: string,
): Promise<string> {
  // Revalidate immediately before selecting the destination so an unsafe
  // directory cannot pass only the initial CLI preflight.
  assertProtectedBackupDirectory(backupDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `routing-corpus-before-spanish-retirement-${stamp}-${process.pid}.db`,
  );
  try {
    fs.lstatSync(backupPath);
    throw new Error(`Refusing to overwrite an existing routing corpus backup: ${backupPath}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  // better-sqlite3 creates the destination. A process-local owner-only umask
  // protects it from the first byte; chmod + lstat below verify the final
  // invariant before the prune function is ever called.
  const previousUmask = process.umask(0o077);
  try {
    await db.backup(backupPath);
  } finally {
    process.umask(previousUmask);
  }
  fs.chmodSync(backupPath, PROTECTED_BACKUP_FILE_MODE);
  assertProtectedBackupDirectory(backupDir);
  assertProtectedBackupFile(backupPath);
  return backupPath;
}

function verifySqliteIntegrity(dbPath: string): 'ok' {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Database integrity check failed: ${String(integrity)}`);
    }
    return 'ok';
  } finally {
    db.close();
  }
}

export async function runSpanishRoutingCorpusRetirement(
  options: RunSpanishRoutingCorpusRetirementOptions,
): Promise<RunSpanishRoutingCorpusRetirementResult> {
  const plan = inspectSpanishRoutingCorpusRetirement(options);
  if (options.ownerAuthorized !== true) {
    throw new Error(
      'Production routing-corpus mutation requires explicit owner authorization',
    );
  }
  if (
    !PLAN_DIGEST_RE.test(options.acknowledgedPlanDigest)
    || options.acknowledgedPlanDigest !== plan.planDigest
  ) {
    throw new Error(
      `Production routing-corpus mutation requires acknowledgement of exact plan digest ${plan.planDigest}`,
    );
  }

  // Owner authorization and exact acknowledgement are checked before this
  // call can create even the protected backup directory.
  const backupDir = prepareProtectedBackupDirectory(options.backupDir);
  const db = new Database(plan.dbPath);
  try {
    const backupPath = await createProtectedDatabaseBackup(db, backupDir);
    const backupIntegrity = verifySqliteIntegrity(backupPath);
    const currentPlan = inspectSpanishRoutingCorpusRetirement(options);
    if (currentPlan.planDigest !== options.acknowledgedPlanDigest) {
      throw new Error(
        `Routing-corpus retirement state changed after backup; inspect and authorize the new plan digest ${currentPlan.planDigest}`,
      );
    }
    const result = pruneSpanishSyntheticRoutingCorpusFixtures({
      db,
      secret: options.secret,
    });
    const integrity = db.pragma('integrity_check', { simple: true });
    if (integrity !== 'ok') {
      throw new Error(`Database integrity check failed after prune: ${String(integrity)}`);
    }
    return {
      schemaVersion: 'routing_corpus_spanish_retirement.v2',
      dbPath: plan.dbPath,
      runtimeSha: options.runtimeSha,
      artifactDigest: options.artifactDigest,
      planDigest: plan.planDigest,
      backupPath,
      backupIntegrity,
      integrity: 'ok',
      ...result,
    };
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const inspect = process.argv.includes('--inspect');
  const apply = process.argv.includes('--apply');
  if (inspect === apply) {
    throw new Error('Choose exactly one read-only --inspect or owner-authorized --apply mode');
  }

  const dbPath = readArg('--db') ?? process.env.DATABASE_PATH ?? './data/bot.db';
  const secret = process.env.CLASSIFY_SHADOW_HASH_SECRET ?? '';
  const runtimeSha = readArg('--runtime-sha') ?? '';
  const artifactDigest = readArg('--artifact-digest') ?? '';
  const baseOptions = { dbPath, secret, runtimeSha, artifactDigest };
  if (inspect) {
    console.log(JSON.stringify(inspectSpanishRoutingCorpusRetirement(baseOptions), null, 2));
    return;
  }

  const backupDir = readArg('--backup-dir');
  const acknowledgedPlanDigest = readArg('--ack-plan') ?? '';
  if (!backupDir) {
    throw new Error('Missing required --backup-dir=<protected-backup-directory>');
  }
  const result = await runSpanishRoutingCorpusRetirement({
    ...baseOptions,
    backupDir,
    ownerAuthorized: process.env.NEXUS_RELEASE_OWNER_AUTHORIZED === '1',
    acknowledgedPlanDigest,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
