// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from './release-canonical.mjs';

export const PRODUCTION_MIGRATION_LINEAGE_SCHEMA =
  'nexus.production-migration-lineages.v4';
export const RELEASE_MIGRATION_RECONCILIATION_SCHEMA =
  'nexus.release-migration-reconciliation.v2';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const MIGRATION_FILE = /^\d{3}_[^/]+\.sql$/;
const GIT_HISTORY_SOURCE_MODE = 'git_history';
const REPOSITORY_ARCHIVE_SOURCE_MODE = 'repository_archive';
const REPOSITORY_ARCHIVE_DIRECTORY =
  'docs/release/evidence/retired-migrations';
const RELATIONSHIPS = new Set([
  'byte_identical_renumber',
  'comment_only_renumber',
  'schema_reconciliation',
]);
const RELEASE_ENVIRONMENTS = Object.freeze(['production', 'staging']);
const RELEASE_ENVIRONMENT_LINEAGES = Object.freeze({
  production: Object.freeze(['production-2026-05-branch-history']),
  staging: Object.freeze([
    'production-2026-05-branch-history',
    'staging-2026-08-notification-renumber-history',
  ]),
});
const RELEASE_SCHEMA_CONVERGENCE_FILE = '283_release_schema_convergence.sql';
const RELEASE_SCHEMA_CONVERGENCE_ID = 'release-schema-convergence-283';
const RELEASE_SCHEMA_CONVERGENCE_REASON =
  'remove_obsolete_global_unique_indexes_after_tenant_safe_composite_replacement';
const RELEASE_SCHEMA_INDEX_TRANSITIONS = Object.freeze([
  Object.freeze({
    name: 'idx_ref_channels_url',
    tableName: 'content_ref_channels',
    columns: Object.freeze(['channel_url']),
    unique: true,
    allowAbsent: true,
    replacement: Object.freeze({
      name: 'idx_content_ref_channels_user_url',
      tableName: 'content_ref_channels',
      columns: Object.freeze(['user_id', 'channel_url']),
      unique: true,
    }),
  }),
  Object.freeze({
    name: 'idx_transcript_video',
    tableName: 'video_transcripts',
    columns: Object.freeze(['video_id']),
    unique: true,
    allowAbsent: true,
    replacement: Object.freeze({
      name: 'idx_video_transcripts_user_video',
      tableName: 'video_transcripts',
      columns: Object.freeze(['user_id', 'video_id']),
      unique: true,
    }),
  }),
  Object.freeze({
    name: 'idx_vendor_sender',
    tableName: 'invoice_vendors',
    columns: Object.freeze(['sender_pattern']),
    unique: true,
    allowAbsent: true,
    replacement: Object.freeze({
      name: 'idx_invoice_vendors_user_sender',
      tableName: 'invoice_vendors',
      columns: Object.freeze(['user_id', 'sender_pattern']),
      unique: true,
    }),
  }),
]);
const RELEASE_SEMANTIC_SCHEMA_EXCLUSIONS = Object.freeze([
  Object.freeze({
    environment: 'staging',
    type: 'index',
    name: 'idx_staging_fixture_calendar_user_time',
    tableName: 'staging_fixture_calendar_events',
    preserveData: false,
  }),
  Object.freeze({
    environment: 'staging',
    type: 'table',
    name: 'staging_fixture_calendar_events',
    tableName: 'staging_fixture_calendar_events',
    preserveData: true,
  }),
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function exactKeys(value, expected, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameValues(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(message);
  }
  return value;
}

function executableSqlTokens(bytes, label) {
  const sql = bytes.toString('utf8');
  const tokens = [];
  const operators = ['->>', '||', '->', '<<', '>>', '<=', '>=', '==', '!=', '<>'];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && !['\n', '\r'].includes(sql[index])) index += 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) throw new Error(`${label} has an unterminated block comment`);
      index = end + 2;
      continue;
    }
    if (["'", '"', '`'].includes(character)) {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== character) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === character) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) throw new Error(`${label} has an unterminated quoted token`);
      tokens.push(sql.slice(start, index));
      continue;
    }
    if (character === '[') {
      const start = index;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== ']') {
          index += 1;
          continue;
        }
        if (sql[index + 1] === ']') {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) throw new Error(`${label} has an unterminated bracketed token`);
      tokens.push(sql.slice(start, index));
      continue;
    }
    const number = sql.slice(index).match(
      /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/,
    );
    if (number) {
      tokens.push(number[0]);
      index += number[0].length;
      continue;
    }
    const identifier = sql.slice(index).match(/^[A-Za-z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*/u);
    if (identifier) {
      tokens.push(identifier[0]);
      index += identifier[0].length;
      continue;
    }
    const operator = operators.find((candidate) => sql.startsWith(candidate, index));
    if (operator) {
      tokens.push(operator);
      index += operator.length;
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  return tokens;
}

function simpleUniqueIndexDefinitions(bytes, label) {
  const tokens = executableSqlTokens(bytes, label);
  const definitions = [];
  const lower = (value) => typeof value === 'string' ? value.toLowerCase() : '';
  const identifier = (value) => (
    typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
      ? value.toLowerCase()
      : null
  );
  for (let index = 0; index < tokens.length; index += 1) {
    if (lower(tokens[index]) !== 'create' || lower(tokens[index + 1]) !== 'unique'
        || lower(tokens[index + 2]) !== 'index') continue;
    let cursor = index + 3;
    if (lower(tokens[cursor]) === 'if' && lower(tokens[cursor + 1]) === 'not'
        && lower(tokens[cursor + 2]) === 'exists') cursor += 3;
    const name = identifier(tokens[cursor]);
    const tableName = lower(tokens[cursor + 1]) === 'on'
      ? identifier(tokens[cursor + 2])
      : null;
    cursor += 3;
    if (!name || !tableName || tokens[cursor] !== '(') continue;
    cursor += 1;
    const columns = [];
    let valid = true;
    while (cursor < tokens.length && tokens[cursor] !== ')') {
      const column = identifier(tokens[cursor]);
      if (!column) {
        valid = false;
        break;
      }
      columns.push(column);
      cursor += 1;
      if (tokens[cursor] === ',') cursor += 1;
      else if (tokens[cursor] !== ')') {
        valid = false;
        break;
      }
    }
    if (valid && columns.length > 0 && tokens[cursor] === ')') {
      definitions.push({ name, tableName, columns, unique: true });
    }
  }
  return definitions;
}

function assertExactReplacementIndexes(bytes, label) {
  const definitions = simpleUniqueIndexDefinitions(bytes, label);
  for (const transition of RELEASE_SCHEMA_INDEX_TRANSITIONS) {
    const matches = definitions.filter(({ name }) => name === transition.replacement.name);
    if (matches.length !== 1
        || canonicalJson(matches[0]) !== canonicalJson(transition.replacement)) {
      throw new Error(`${label} has no exact governed replacement index: ${transition.replacement.name}`);
    }
  }
}

function frozenIndexTransitions(transitions) {
  return Object.freeze(transitions.map((transition) => Object.freeze({
    ...transition,
    columns: Object.freeze([...transition.columns]),
    replacement: Object.freeze({
      ...transition.replacement,
      columns: Object.freeze([...transition.replacement.columns]),
    }),
  })));
}

function assertRegularFile(file, message) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(message); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
}

function repositoryArchivePath(sourceCommit, file) {
  return `${REPOSITORY_ARCHIVE_DIRECTORY}/${sourceCommit}/${file}`;
}

export function readRepositoryArchiveFromGitIndex({
  root,
  sourceCommit,
  file,
  sourcePath,
  execGit = execFileSync,
}) {
  if (!root || !COMMIT_SHA.test(sourceCommit || '')
    || !MIGRATION_FILE.test(file || '')
    || sourcePath !== repositoryArchivePath(sourceCommit, file)
    || typeof execGit !== 'function') {
    throw new Error('repository archive locator is invalid');
  }
  const raw = execGit(
    'git',
    ['ls-files', '--stage', '-z', '--', sourcePath],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const records = Buffer.from(raw).toString('utf8').split('\0').filter(Boolean);
  if (records.length !== 1) {
    throw new Error(`repository archive is not an exact staged file: ${sourcePath}`);
  }
  const match = records[0].match(/^(100644) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t(.+)$/);
  if (!match || match[3] !== sourcePath) {
    throw new Error(`repository archive has an unsafe staged identity: ${sourcePath}`);
  }
  return Buffer.from(execGit(
    'git',
    ['show', `:${sourcePath}`],
    { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] },
  ));
}

export function loadProductionMigrationLineagePolicy({
  root,
  policyPath = path.join(root, 'config/production-migration-lineages.json'),
} = {}) {
  if (!root) throw new Error('production migration lineage root is missing');
  assertRegularFile(policyPath, 'production migration lineage policy is missing or unsafe');
  const raw = fs.readFileSync(policyPath);
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    throw new Error('production migration lineage policy is invalid JSON');
  }
  if (parsed?.schema !== PRODUCTION_MIGRATION_LINEAGE_SCHEMA
    || !Array.isArray(parsed.lineages)
    || parsed.lineages.length === 0) {
    throw new Error('production migration lineage policy has an invalid schema');
  }
  exactKeys(
    parsed,
    ['schema', 'lineages', 'release'],
    'production migration lineage policy has invalid top-level fields',
  );

  const lineageIds = new Set();
  const retiredFiles = new Set();
  const replacementFiles = new Set();
  const repositoryArchiveLocators = new Set();
  const migrationSets = new Set();
  const lineages = parsed.lineages.map((candidate) => {
    const lineage = exactKeys(
      candidate,
      ['id', 'reason', 'migrations'],
      'production migration lineage policy has an invalid lineage',
    );
    if (!lineage || typeof lineage.id !== 'string'
      || !/^[a-z0-9-]+$/.test(lineage.id)
      || typeof lineage.reason !== 'string'
      || !/^[a-z0-9_]+$/.test(lineage.reason)
      || !Array.isArray(lineage.migrations)
      || lineage.migrations.length === 0
      || lineageIds.has(lineage.id)) {
      throw new Error('production migration lineage policy has an invalid lineage');
    }
    lineageIds.add(lineage.id);

    const files = lineage.migrations.map((entry) => entry?.file);
    if (!sameValues(files, [...files].sort())) {
      throw new Error(`production migration lineage is not sorted: ${lineage.id}`);
    }
    const migrations = lineage.migrations.map((candidateEntry) => {
      const hasArchiveFields = candidateEntry?.sourceMode !== undefined
        || candidateEntry?.sourcePath !== undefined;
      const entry = exactKeys(
        candidateEntry,
        hasArchiveFields
          ? ['file', 'sha256', 'sourceCommit', 'sourceMode', 'sourcePath', 'replacement']
          : ['file', 'sha256', 'sourceCommit', 'replacement'],
        `production migration lineage has an invalid migration: ${lineage.id}`,
      );
      const replacement = exactKeys(
        entry.replacement,
        ['file', 'sha256', 'relationship'],
        `production migration lineage has an invalid migration: ${lineage.id}`,
      );
      if (!entry || typeof entry.file !== 'string' || !MIGRATION_FILE.test(entry.file)
        || !SHA256.test(entry.sha256 || '')
        || !COMMIT_SHA.test(entry.sourceCommit || '')
        || !replacement || typeof replacement.file !== 'string'
        || !MIGRATION_FILE.test(replacement.file)
        || !SHA256.test(replacement.sha256 || '')
        || !RELATIONSHIPS.has(replacement.relationship)
        || retiredFiles.has(entry.file)
        || replacementFiles.has(replacement.file)) {
        throw new Error(`production migration lineage has an invalid migration: ${lineage.id}`);
      }
      const sourceMode = hasArchiveFields
        ? entry.sourceMode
        : GIT_HISTORY_SOURCE_MODE;
      const sourcePath = hasArchiveFields
        ? entry.sourcePath
        : `migrations/${entry.file}`;
      if (hasArchiveFields && (
        sourceMode !== REPOSITORY_ARCHIVE_SOURCE_MODE
        || sourcePath
          !== repositoryArchivePath(entry.sourceCommit, entry.file)
        || repositoryArchiveLocators.has(sourcePath)
      )) {
        throw new Error(`production migration lineage has an invalid source: ${entry.file}`);
      }
      if (sourceMode === REPOSITORY_ARCHIVE_SOURCE_MODE) {
        repositoryArchiveLocators.add(sourcePath);
      }
      retiredFiles.add(entry.file);
      replacementFiles.add(replacement.file);
      const retiredPath = path.join(root, 'migrations', entry.file);
      if (fs.existsSync(retiredPath)) {
        throw new Error(`retired migration remains executable: ${entry.file}`);
      }
      const replacementPath = path.join(root, 'migrations', replacement.file);
      assertRegularFile(replacementPath, `replacement migration is missing or unsafe: ${replacement.file}`);
      const actualReplacementSha256 = sha256(fs.readFileSync(replacementPath));
      if (actualReplacementSha256 !== replacement.sha256) {
        throw new Error(`replacement migration digest mismatch: ${replacement.file}`);
      }
      if (replacement.relationship === 'byte_identical_renumber'
        && entry.sha256 !== replacement.sha256) {
        throw new Error(`byte-identical migration digest mismatch: ${entry.file}`);
      }
      if (replacement.relationship === 'comment_only_renumber'
        && entry.sha256 === replacement.sha256) {
        throw new Error(`comment-only migration unexpectedly has identical bytes: ${entry.file}`);
      }
      return Object.freeze({
        file: entry.file,
        sha256: entry.sha256,
        sourceCommit: entry.sourceCommit,
        sourceMode,
        sourcePath,
        replacement: Object.freeze({ ...replacement }),
      });
    });
    const migrationFiles = migrations.map(({ file }) => file);
    const migrationSetSha256 = sha256(Buffer.from(JSON.stringify(migrationFiles)));
    if (migrationSets.has(migrationSetSha256)) {
      throw new Error('production migration lineage policy has a duplicate migration set');
    }
    migrationSets.add(migrationSetSha256);
    return Object.freeze({
      id: lineage.id,
      reason: lineage.reason,
      migrations: Object.freeze(migrations),
      migrationFiles: Object.freeze(migrationFiles),
      migrationCount: migrationFiles.length,
      migrationSetSha256,
    });
  });
  const sortedIds = [...lineageIds].sort();
  if (!sameValues(parsed.lineages.map(({ id }) => id), sortedIds)) {
    throw new Error('production migration lineages are not sorted');
  }
  const lineagesById = new Map(lineages.map((lineage) => [lineage.id, lineage]));
  const release = assertReleasePolicy({
    value: parsed.release,
    root,
    lineagesById,
  });
  const policy = {
    schema: parsed.schema,
    sha256: sha256(raw),
    lineages: Object.freeze(lineages),
    release,
  };
  return Object.freeze({
    ...policy,
    releaseReconciliation: releaseMigrationReconciliationProjection(policy),
  });
}

function assertReleasePolicy({ value, root, lineagesById }) {
  const release = exactKeys(
    value,
    ['environmentLineages', 'compatibilityExemptions', 'semanticSchemaExclusions'],
    'production migration lineage release policy has invalid fields',
  );
  const environmentLineages = exactKeys(
    release.environmentLineages,
    RELEASE_ENVIRONMENTS,
    'production migration lineage release environments are invalid',
  );
  const normalizedEnvironmentLineages = {};
  for (const environment of RELEASE_ENVIRONMENTS) {
    const ids = environmentLineages[environment];
    if (!Array.isArray(ids) || ids.length === 0
      || !sameValues(ids, [...new Set(ids)].sort())
      || !sameValues(ids, RELEASE_ENVIRONMENT_LINEAGES[environment])
      || ids.some((id) => typeof id !== 'string' || !lineagesById.has(id))) {
      throw new Error(`production migration lineage release ${environment} lineages are invalid`);
    }
    normalizedEnvironmentLineages[environment] = Object.freeze([...ids]);
  }

  if (!Array.isArray(release.compatibilityExemptions)
    || release.compatibilityExemptions.length !== 1) {
    throw new Error('production migration lineage release compatibility exemptions are invalid');
  }
  const compatibilityExemptions = release.compatibilityExemptions.map((candidate) => {
    const exemption = exactKeys(candidate, [
      'id', 'file', 'sha256', 'genericKind', 'effectiveKind', 'reason',
      'allowedDropIndexes',
    ], 'production migration lineage release compatibility exemption is invalid');
    if (exemption.id !== RELEASE_SCHEMA_CONVERGENCE_ID
      || exemption.file !== RELEASE_SCHEMA_CONVERGENCE_FILE
      || !SHA256.test(exemption.sha256 || '')
      || exemption.genericKind !== 'contract'
      || exemption.effectiveKind !== 'expand'
      || exemption.reason !== RELEASE_SCHEMA_CONVERGENCE_REASON
      || !Array.isArray(exemption.allowedDropIndexes)
      || canonicalJson(exemption.allowedDropIndexes)
        !== canonicalJson(RELEASE_SCHEMA_INDEX_TRANSITIONS)) {
      throw new Error('production migration lineage release compatibility exemption is invalid');
    }
    const migrationPath = path.join(root, 'migrations', exemption.file);
    assertRegularFile(
      migrationPath,
      `release compatibility migration is missing or unsafe: ${exemption.file}`,
    );
    const sqlBytes = fs.readFileSync(migrationPath);
    if (sha256(sqlBytes) !== exemption.sha256) {
      throw new Error(`release compatibility migration digest mismatch: ${exemption.file}`);
    }
    const sql = sqlBytes.toString('utf8').replace(/--.*$/gm, '');
    const droppedIndexes = [...sql.matchAll(
      /\bDROP\s+INDEX\s+IF\s+EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/gi,
    )].map((match) => match[1]).sort();
    const expectedDrops = RELEASE_SCHEMA_INDEX_TRANSITIONS.map(({ name }) => name).sort();
    if (!sameValues(droppedIndexes, expectedDrops)) {
      throw new Error('release compatibility migration drop-index scope has drifted');
    }
    assertExactReplacementIndexes(sqlBytes, 'release compatibility migration');
    const replacementSqlPath = path.join(root, 'migrations', '058_composite_unique_constraints.sql');
    assertRegularFile(replacementSqlPath, 'tenant-safe composite-index migration is missing or unsafe');
    assertExactReplacementIndexes(
      fs.readFileSync(replacementSqlPath),
      'tenant-safe composite-index migration',
    );
    return Object.freeze({
      ...exemption,
      allowedDropIndexes: frozenIndexTransitions(exemption.allowedDropIndexes),
    });
  });

  if (!Array.isArray(release.semanticSchemaExclusions)
    || canonicalJson(release.semanticSchemaExclusions)
      !== canonicalJson(RELEASE_SEMANTIC_SCHEMA_EXCLUSIONS)) {
    throw new Error('production migration lineage release semantic schema exclusions are invalid');
  }
  return Object.freeze({
    environmentLineages: Object.freeze(normalizedEnvironmentLineages),
    compatibilityExemptions: Object.freeze(compatibilityExemptions),
    semanticSchemaExclusions: Object.freeze(
      release.semanticSchemaExclusions.map((entry) => Object.freeze({ ...entry })),
    ),
  });
}

export function releaseMigrationReconciliationProjection(policy) {
  if (!policy?.release || !Array.isArray(policy.lineages)) {
    throw new Error('release migration reconciliation policy is missing');
  }
  const lineagesById = new Map(policy.lineages.map((lineage) => [lineage.id, lineage]));
  const environments = {};
  for (const environment of RELEASE_ENVIRONMENTS) {
    const lineageIds = policy.release.environmentLineages[environment];
    const legacyRows = lineageIds.flatMap((id) => {
      const lineage = lineagesById.get(id);
      if (!lineage) throw new Error(`release migration reconciliation lineage is missing: ${id}`);
      return lineage.migrations.map(({ file, sha256: retiredSha256, sourceCommit, replacement }) => ({
        file,
        retiredSha256,
        sourceCommit,
        replacement: {
          file: replacement.file,
          sha256: replacement.sha256,
          relationship: replacement.relationship,
        },
      }));
    }).sort((left, right) => left.file.localeCompare(right.file));
    if (new Set(legacyRows.map(({ file }) => file)).size !== legacyRows.length) {
      throw new Error(`release migration reconciliation ${environment} has duplicate legacy rows`);
    }
    environments[environment] = {
      lineageIds: [...lineageIds],
      legacyRows,
    };
  }
  return assertReleaseMigrationReconciliationShape({
    schema: RELEASE_MIGRATION_RECONCILIATION_SCHEMA,
    sourcePolicySha256: policy.sha256,
    environments,
    compatibilityExemptions: policy.release.compatibilityExemptions.map((entry) => ({
      ...entry,
      allowedDropIndexes: entry.allowedDropIndexes.map((transition) => ({
        ...transition,
        columns: [...transition.columns],
        replacement: {
          ...transition.replacement,
          columns: [...transition.replacement.columns],
        },
      })),
    })),
    semanticSchemaExclusions: policy.release.semanticSchemaExclusions.map((entry) => ({
      ...entry,
    })),
  });
}

export function assertReleaseMigrationReconciliationShape(value) {
  const reconciliation = exactKeys(value, [
    'schema', 'sourcePolicySha256', 'environments', 'compatibilityExemptions',
    'semanticSchemaExclusions',
  ], 'release migration reconciliation fields are invalid');
  if (reconciliation.schema !== RELEASE_MIGRATION_RECONCILIATION_SCHEMA
    || !SHA256.test(reconciliation.sourcePolicySha256 || '')) {
    throw new Error('release migration reconciliation schema is invalid');
  }
  exactKeys(
    reconciliation.environments,
    RELEASE_ENVIRONMENTS,
    'release migration reconciliation environments are invalid',
  );
  for (const environment of RELEASE_ENVIRONMENTS) {
    const entry = exactKeys(
      reconciliation.environments[environment],
      ['lineageIds', 'legacyRows'],
      `release migration reconciliation ${environment} fields are invalid`,
    );
    if (!Array.isArray(entry.lineageIds) || entry.lineageIds.length === 0
      || !sameValues(entry.lineageIds, [...new Set(entry.lineageIds)].sort())
      || entry.lineageIds.some((id) => typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id))
      || !Array.isArray(entry.legacyRows)) {
      throw new Error(`release migration reconciliation ${environment} lineage is invalid`);
    }
    let previous = '';
    for (const candidate of entry.legacyRows) {
      const legacy = exactKeys(candidate, [
        'file', 'retiredSha256', 'sourceCommit', 'replacement',
      ], `release migration reconciliation ${environment} legacy row is invalid`);
      const replacement = exactKeys(legacy.replacement, [
        'file', 'sha256', 'relationship',
      ], `release migration reconciliation ${environment} replacement is invalid`);
      if (!MIGRATION_FILE.test(legacy.file || '') || legacy.file <= previous
        || !SHA256.test(legacy.retiredSha256 || '')
        || !COMMIT_SHA.test(legacy.sourceCommit || '')
        || !MIGRATION_FILE.test(replacement.file || '')
        || !SHA256.test(replacement.sha256 || '')
        || !RELATIONSHIPS.has(replacement.relationship)) {
        throw new Error(`release migration reconciliation ${environment} legacy row is invalid`);
      }
      previous = legacy.file;
    }
  }
  if (!Array.isArray(reconciliation.compatibilityExemptions)
    || reconciliation.compatibilityExemptions.length !== 1) {
    throw new Error('release migration reconciliation compatibility exemptions are invalid');
  }
  const exemption = exactKeys(reconciliation.compatibilityExemptions[0], [
    'id', 'file', 'sha256', 'genericKind', 'effectiveKind', 'reason',
    'allowedDropIndexes',
  ], 'release migration reconciliation compatibility exemption is invalid');
  if (exemption.id !== RELEASE_SCHEMA_CONVERGENCE_ID
    || exemption.file !== RELEASE_SCHEMA_CONVERGENCE_FILE
    || !SHA256.test(exemption.sha256 || '')
    || exemption.genericKind !== 'contract'
    || exemption.effectiveKind !== 'expand'
    || exemption.reason !== RELEASE_SCHEMA_CONVERGENCE_REASON
    || !Array.isArray(exemption.allowedDropIndexes)
    || canonicalJson(exemption.allowedDropIndexes)
      !== canonicalJson(RELEASE_SCHEMA_INDEX_TRANSITIONS)) {
    throw new Error('release migration reconciliation compatibility exemption is invalid');
  }
  if (!Array.isArray(reconciliation.semanticSchemaExclusions)
    || canonicalJson(reconciliation.semanticSchemaExclusions)
      !== canonicalJson(RELEASE_SEMANTIC_SCHEMA_EXCLUSIONS)) {
    throw new Error('release migration reconciliation semantic schema exclusions are invalid');
  }
  return reconciliation;
}

export function releaseMigrationReconciliationDigest(value) {
  return sha256(Buffer.from(canonicalJson(assertReleaseMigrationReconciliationShape(value))));
}

/**
 * Prove retired migration evidence at the hosted signing boundary. Runtime
 * images intentionally carry no Git history; they trust the signed projection.
 * CI reads ordinary rows from their exact source commit. Rows whose historical
 * commit is not repository-reachable retain that commit as metadata and bind an
 * exact non-executable archive in the signed candidate checkout instead.
 */
export function verifyProductionMigrationLineageHistory({
  policy,
  readHistoricalMigration,
  readRepositoryArchive,
  readReplacementMigration,
}) {
  if (!policy?.lineages || typeof readHistoricalMigration !== 'function'
    || typeof readRepositoryArchive !== 'function'
    || typeof readReplacementMigration !== 'function') {
    throw new Error('production migration lineage history verifier is not configured');
  }
  let verifiedCount = 0;
  for (const lineage of policy.lineages) {
    for (const migration of lineage.migrations) {
      const sourceMode = migration.sourceMode ?? GIT_HISTORY_SOURCE_MODE;
      const sourcePath = migration.sourcePath ?? `migrations/${migration.file}`;
      if (![GIT_HISTORY_SOURCE_MODE, REPOSITORY_ARCHIVE_SOURCE_MODE].includes(sourceMode)) {
        throw new Error(`retired migration source mode is invalid: ${migration.file}`);
      }
      let bytes;
      try {
        bytes = sourceMode === REPOSITORY_ARCHIVE_SOURCE_MODE
          ? readRepositoryArchive({
            sourceCommit: migration.sourceCommit,
            file: migration.file,
            sourcePath,
          })
          : readHistoricalMigration({
            commit: migration.sourceCommit,
            file: migration.file,
            sourcePath,
          });
      } catch {
        bytes = null;
      }
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new Error(
          sourceMode === REPOSITORY_ARCHIVE_SOURCE_MODE
            ? `retired migration is absent from its repository archive: ${migration.file}`
            : `retired migration is absent from its source commit: ${migration.file}`,
        );
      }
      if (sha256(bytes) !== migration.sha256) {
        throw new Error(
          sourceMode === REPOSITORY_ARCHIVE_SOURCE_MODE
            ? `retired migration digest does not match its repository archive: ${migration.file}`
            : `retired migration digest does not match its source commit: ${migration.file}`,
        );
      }
      let replacementBytes;
      try {
        replacementBytes = readReplacementMigration({
          file: migration.replacement.file,
        });
      } catch {
        replacementBytes = null;
      }
      if (!Buffer.isBuffer(replacementBytes) || replacementBytes.length === 0) {
        throw new Error(
          `replacement migration is absent at the signing boundary: ${migration.replacement.file}`,
        );
      }
      if (sha256(replacementBytes) !== migration.replacement.sha256) {
        throw new Error(
          `replacement migration digest changed at the signing boundary: ${migration.replacement.file}`,
        );
      }
      if (migration.replacement.relationship === 'byte_identical_renumber'
          && !bytes.equals(replacementBytes)) {
        throw new Error(
          `byte-identical replacement differs from retired migration: ${migration.file}`,
        );
      }
      if (migration.replacement.relationship === 'comment_only_renumber') {
        const retiredTokens = executableSqlTokens(bytes, migration.file);
        const replacementTokens = executableSqlTokens(
          replacementBytes,
          migration.replacement.file,
        );
        if (!sameValues(retiredTokens, replacementTokens)) {
          throw new Error(
            `comment-only replacement changes executable SQL: ${migration.file}`,
          );
        }
      }
      verifiedCount += 1;
    }
  }
  return Object.freeze({ verifiedCount });
}

export function resolveProductionMigrationLineage(policy, retiredMigrationFiles) {
  const files = [...retiredMigrationFiles].sort();
  if (files.length === 0) {
    return Object.freeze({
      id: 'canonical',
      migrationFiles: Object.freeze([]),
      migrationCount: 0,
      migrationSetSha256: sha256(Buffer.from(JSON.stringify([]))),
    });
  }
  return policy.lineages.find((lineage) => sameValues(files, lineage.migrationFiles)) ?? null;
}
