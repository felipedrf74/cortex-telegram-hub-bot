import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import {
  assertCanonicalTimestamp,
  assertFullSha,
  assertHexSha256,
  canonicalJson,
  exactKeys,
  fail,
  OCI_DIGEST,
  sha256,
} from './release-canonical.mjs';
import {
  assertMigrationInventoryShape,
} from './migration-cd-eligibility.mjs';
import {
  assertReleaseMigrationReconciliationShape,
  releaseMigrationReconciliationDigest,
} from './production-migration-lineage.mjs';

export const RELEASE_BOOTSTRAP_BASELINE_SCHEMA = 'nexus.release-bootstrap-baseline.v2';

const MAX_BASELINE_BYTES = 2 * 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function assertOwnerExpectedBootstrapTarget({
  expectedReleaseId,
  expectedReleasePayloadDigest,
  observedReleaseId,
  observedReleasePayloadDigest,
}) {
  if (typeof expectedReleaseId !== 'string'
      || !/^[0-9a-f]{32}$/.test(expectedReleaseId)) {
    fail('owner-expected bootstrap release id is invalid');
  }
  if (typeof expectedReleasePayloadDigest !== 'string'
      || !OCI_DIGEST.test(expectedReleasePayloadDigest)) {
    fail('owner-expected bootstrap release payload digest is invalid');
  }
  if (observedReleaseId !== expectedReleaseId
      || observedReleasePayloadDigest !== expectedReleasePayloadDigest) {
    fail('resolved bootstrap target does not match owner-expected release identity');
  }
  return {
    releaseId: expectedReleaseId,
    releasePayloadDigest: expectedReleasePayloadDigest,
  };
}

export function resolveReleaseBootstrapBaselineOutputPolicy({
  policy,
  expectedReleaseId,
  candidate = false,
}) {
  if (!candidate) return policy;
  if (typeof expectedReleaseId !== 'string' || !/^[0-9a-f]{32}$/.test(expectedReleaseId)) {
    fail('owner-expected bootstrap release id is invalid');
  }
  const canonicalOutput = policy?.paths?.bootstrapBaselineFile;
  if (typeof canonicalOutput !== 'string' || !path.isAbsolute(canonicalOutput)) {
    fail('release bootstrap baseline output path is invalid');
  }
  return {
    ...policy,
    bootstrapBaselineCandidatePublication: {
      canonicalOutput,
      expectedReleaseId,
    },
    paths: {
      ...policy.paths,
      bootstrapBaselineFile: `${canonicalOutput}.next-${expectedReleaseId}`,
    },
  };
}

function governedDatabasePath(policy, environment) {
  return path.join(policy.environments[environment].dataDir, 'bot.db');
}

function legacyDatabasePath(policy, environment) {
  return environment === 'production'
    ? policy.bootstrap.legacyProductionDatabase
    : policy.bootstrap.legacyStagingDatabase;
}

function databasePaths(policy, environments = ['production', 'staging']) {
  return environments.flatMap((environment) => [
    legacyDatabasePath(policy, environment),
    governedDatabasePath(policy, environment),
  ]);
}

function assertGovernedFile(file, label, { privateMode = false, ownerUid = null } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    fail(`${label} is missing`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    fail(`${label} must be a single-link regular file`);
  }
  if (privateMode && (stat.mode & 0o077) !== 0) {
    fail(`${label} must not be accessible by group or other users`);
  }
  if (ownerUid !== null && stat.uid !== ownerUid) {
    fail(`${label} must be owned by the poller user`);
  }
  return stat;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function lstatIfPresent(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function publicationTemporaryPaths(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.next-`;
  return fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const suffix = name.slice(prefix.length);
      if (!/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(suffix)) {
        fail('release bootstrap baseline has an unsafe publication temporary');
      }
      return path.join(directory, name);
    });
}

function readPublicationBaseline({ file, policy, allowedLinkCounts }) {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink()
      || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o600
      || !allowedLinkCounts.includes(before.nlink)
      || before.size <= 0 || before.size > MAX_BASELINE_BYTES) {
    fail('release bootstrap baseline publication file is unsafe');
  }
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('release bootstrap baseline publication file changed identity');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(file);
    if (bytes.length !== opened.size
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino) {
      fail('release bootstrap baseline publication file changed while read');
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      fail('release bootstrap baseline publication file is not valid JSON');
    }
    return {
      baseline: assertReleaseBootstrapBaselineShape(parsed, policy),
      stat: opened,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameBaselineExceptCreationTime(left, right) {
  return canonicalJson({ ...left, createdAt: right.createdAt }) === canonicalJson(right);
}

function assertNoSQLiteSidecars(file, label) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(`${file}${suffix}`);
      fail(`${label} still has a SQLite ${suffix.slice(1)} sidecar`);
    } catch (error) {
      if (!(error && error.code === 'ENOENT')) throw error;
    }
  }
}

export function assertReleaseBootstrapQuiescent({
  policy,
  environments = ['production', 'staging'],
  lsofBin = process.env.NEXUS_RELEASE_LSOF_BIN || '/usr/bin/lsof',
  exec = spawnSync,
}) {
  const files = databasePaths(policy, environments);
  const candidates = [];
  for (const file of files) {
    try {
      fs.lstatSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        fail('bootstrap database is missing before open-handle probe');
      }
      fail('bootstrap database path probe could not run');
    }
    candidates.push(file);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${file}${suffix}`;
      try {
        fs.lstatSync(sidecar);
        candidates.push(sidecar);
      } catch (error) {
        if (!(error && error.code === 'ENOENT')) {
          fail('bootstrap database path probe could not run');
        }
      }
    }
  }
  const result = exec(lsofBin, ['-t', '--', ...candidates], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (
    result.error
    || ![0, 1].includes(result.status)
    || String(result.stderr ?? '').trim().length > 0
  ) {
    fail('bootstrap database open-handle probe could not run');
  }
  if (result.status === 0 || String(result.stdout ?? '').trim().length > 0) {
    fail('bootstrap databases still have open handles');
  }
  for (const environment of environments) {
    assertNoSQLiteSidecars(
      legacyDatabasePath(policy, environment),
      `bootstrap legacy ${environment} database`,
    );
    assertNoSQLiteSidecars(
      governedDatabasePath(policy, environment),
      `bootstrap target ${environment} database`,
    );
  }
}

function normalizedSnapshotDigest(bytes) {
  const normalized = Buffer.from(bytes);
  // SQLite `.backup` preserves every page but legitimately changes these
  // volatile header fields: WAL read/write version, file-change counter,
  // schema cookie, and version-valid-for. SQLite's online backup API may bump
  // the target schema cookie even when every logical page is identical.
  // Normalizing only those header fields lets the owner prove each legacy
  // source and target snapshot carry identical database contents.
  normalized[18] = 1;
  normalized[19] = 1;
  normalized.fill(0, 24, 28);
  normalized.fill(0, 40, 44);
  normalized.fill(0, 92, 96);
  return sha256(normalized);
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function reconcileBootstrapLedger({ applied, inventory, legacyRows, label }) {
  const inventoryByFile = new Map(inventory.map((entry) => [entry.file, entry]));
  const expectedLegacy = legacyRows.map((entry) => entry.file).sort();
  const observedLegacy = applied.filter((file) => !inventoryByFile.has(file)).sort();
  if (!sameValues(observedLegacy, expectedLegacy)) {
    const unexpected = observedLegacy.filter((file) => !expectedLegacy.includes(file));
    const missing = expectedLegacy.filter((file) => !observedLegacy.includes(file));
    fail(
      `${label} legacy ledger does not exactly match the signed lineage `
      + `(unexpected: ${unexpected[0] ?? 'none'}; missing: ${missing[0] ?? 'none'})`,
    );
  }
  const canonicalApplied = inventory.filter((entry) => applied.includes(entry.file));
  const expectedPrefix = inventory.slice(0, canonicalApplied.length);
  if (!sameValues(
    canonicalApplied.map((entry) => entry.file),
    expectedPrefix.map((entry) => entry.file),
  )) {
    fail(`${label} canonical ledger is not an ordered inventory prefix`);
  }
  const pending = inventory.slice(canonicalApplied.length);
  const blocking = pending.find((entry) => !entry.predecessorCompatible);
  if (blocking) {
    fail(`${label} has a pending predecessor-incompatible migration: ${blocking.file}`);
  }
  return {
    canonicalApplied: canonicalApplied.map(({ file, sha256: digest }) => ({
      file,
      sha256: digest,
    })),
    legacyRows: legacyRows.map((entry) => ({
      file: entry.file,
      retiredSha256: entry.retiredSha256,
      sourceCommit: entry.sourceCommit,
      replacement: { ...entry.replacement },
    })),
    pending: pending.map(({ file, sha256: digest, kind, predecessorCompatible }) => ({
      file,
      sha256: digest,
      kind,
      predecessorCompatible,
    })),
  };
}

function stripForeignKeyPragmas(sql) {
  return sql.split('\n')
    .filter((line) => !/^\s*PRAGMA\s+foreign_keys\s*=/i.test(line))
    .join('\n');
}

function stripWrappingTransactionStatements(sql) {
  let insideTrigger = false;
  return sql.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(trimmed)) insideTrigger = true;
    const wrapper = !insideTrigger
      && /^(BEGIN(?:\s+TRANSACTION)?|COMMIT(?:\s+TRANSACTION)?|END(?:\s+TRANSACTION)?)\s*;$/i.test(trimmed);
    if (insideTrigger && /^END\s*;$/i.test(trimmed)) insideTrigger = false;
    return !wrapper;
  }).join('\n');
}

function filterAlreadyAppliedAddColumns(database, sql) {
  return sql.split(';').map((statement, index, statements) => {
    const suffix = index < statements.length - 1 ? ';' : '';
    const match = statement.match(
      /\bALTER\s+TABLE\s+([A-Za-z_][\w]*)\s+ADD\s+COLUMN\s+([A-Za-z_][\w]*)\b/i,
    );
    if (!match) return `${statement}${suffix}`;
    const columns = database.prepare(`PRAGMA table_info(${match[1]})`).all();
    return columns.some((entry) => entry.name === match[2]) ? '' : `${statement}${suffix}`;
  }).join('');
}

function applyRehearsalMigration(database, entry, migrationsDirectory) {
  const bytes = fs.readFileSync(path.join(migrationsDirectory, entry.file));
  if (sha256(bytes) !== entry.sha256) {
    fail(`bootstrap rehearsal migration digest changed: ${entry.file}`);
  }
  database.function('nexus_sha256', { deterministic: true }, (value) => (
    createHash('sha256').update(String(value ?? '')).digest('hex')
  ));
  database.function('nexus_plain_text_revision_hash', { deterministic: true }, (value) => (
    createHash('sha256')
      .update(JSON.stringify({ format: 'plain_text', text: String(value ?? '') }))
      .digest('hex')
  ));
  const rawSql = bytes.toString('utf8');
  const priorForeignKeys = Number(database.pragma('foreign_keys', { simple: true })) === 1;
  const needsForeignKeysOff = /\bPRAGMA\s+foreign_keys\s*=\s*OFF\b/i.test(rawSql);
  const sql = filterAlreadyAppliedAddColumns(
    database,
    stripWrappingTransactionStatements(stripForeignKeyPragmas(rawSql)),
  );
  if (needsForeignKeysOff) database.pragma('foreign_keys = OFF');
  try {
    database.transaction(() => {
      database.exec(sql);
      database.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(entry.file);
    })();
  } finally {
    database.pragma(`foreign_keys = ${priorForeignKeys ? 'ON' : 'OFF'}`);
  }
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqliteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedSql(sql) {
  return typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : null;
}

function canonicalSchemaSql(sql) {
  if (typeof sql !== 'string') return [];
  const tokens = [];
  for (let index = 0; index < sql.length;) {
    const character = sql[index];
    if (/\s/.test(character)) {
      index += 1;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      index += 2;
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) fail('bootstrap schema SQL contains an unterminated comment');
      index = end + 2;
      continue;
    }
    if (["'", '"', '`', '['].includes(character)) {
      const start = index;
      const closing = character === '[' ? ']' : character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] !== closing) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === closing) {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      if (!closed) fail('bootstrap schema SQL contains an unterminated quoted token');
      tokens.push(sql.slice(start, index));
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(character)) {
      const start = index;
      while (index < sql.length && /[A-Za-z0-9_$]/.test(sql[index])) index += 1;
      tokens.push(sql.slice(start, index).toLowerCase());
      continue;
    }
    tokens.push(character);
    index += 1;
  }
  return tokens.filter((token, index) => !(
    token === 'if' && tokens[index + 1] === 'not' && tokens[index + 2] === 'exists'
    || token === 'not' && tokens[index - 1] === 'if' && tokens[index + 1] === 'exists'
    || token === 'exists' && tokens[index - 2] === 'if' && tokens[index - 1] === 'not'
  ));
}

function sortedRows(rows) {
  return [...rows].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
}

function semanticSchema(database, environment, exclusions) {
  const excluded = (type, name, tableName) => exclusions.some((entry) => (
    entry.environment === environment && entry.type === type
      && entry.name === name && entry.tableName === tableName
  ));
  const objects = database.prepare(
    `SELECT type, name, tbl_name AS tableName, sql
       FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name`,
  ).all().filter((entry) => !excluded(entry.type, entry.name, entry.tableName));
  const tables = objects.filter((entry) => entry.type === 'table').map((entry) => {
    const columns = database.prepare(`PRAGMA table_xinfo(${sqliteString(entry.name)})`).all()
      .map((column) => ({
        ordinal: Number(column.cid),
        name: column.name,
        type: String(column.type ?? '').toUpperCase(),
        notNull: Number(column.notnull ?? 0),
        defaultValue: column.dflt_value ?? null,
        primaryKey: Number(column.pk ?? 0),
        hidden: Number(column.hidden ?? 0),
      })).sort((left, right) => left.ordinal - right.ordinal);
    const foreignKeys = sortedRows(
      database.prepare(`PRAGMA foreign_key_list(${sqliteString(entry.name)})`).all()
        .map((foreignKey) => ({
          id: foreignKey.id,
          sequence: foreignKey.seq,
          table: foreignKey.table,
          from: foreignKey.from,
          to: foreignKey.to,
          onUpdate: foreignKey.on_update,
          onDelete: foreignKey.on_delete,
          match: foreignKey.match,
        })),
    );
    const indexes = database.prepare(`PRAGMA index_list(${sqliteString(entry.name)})`).all()
      .filter((index) => !excluded('index', index.name, entry.name))
      .map((index) => ({
        name: index.name,
        unique: Number(index.unique ?? 0),
        origin: index.origin,
        partial: Number(index.partial ?? 0),
        columns: database.prepare(`PRAGMA index_xinfo(${sqliteString(index.name)})`).all()
          .map((column) => ({
            sequence: column.seqno,
            columnId: column.cid,
            name: column.name ?? null,
            descending: Number(column.desc ?? 0),
            collation: column.coll ?? null,
            key: Number(column.key ?? 0),
          })),
      })).sort((left, right) => left.name.localeCompare(right.name));
    const sql = normalizedSql(entry.sql) ?? '';
    const checks = [...sql.matchAll(/\bCHECK\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/gi)]
      .map((match) => normalizedSql(match[1]))
      .sort();
    return {
      name: entry.name,
      createTableSql: canonicalSchemaSql(entry.sql),
      columns,
      foreignKeys,
      indexes,
      checks,
      strict: /\bSTRICT\s*$/i.test(sql),
      withoutRowid: /\bWITHOUT\s+ROWID\b/i.test(sql),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  const programs = objects.filter((entry) => ['trigger', 'view'].includes(entry.type))
    .map((entry) => ({
      type: entry.type,
      name: entry.name,
      tableName: entry.tableName,
      sql: normalizedSql(entry.sql),
    }));
  const descriptor = { tables, programs };
  return { descriptor, digest: sha256(canonicalJson(descriptor)) };
}

function tableDataEvidence(database, tableName) {
  const exists = database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?",
  ).get(tableName);
  if (!exists) fail(`bootstrap staging fixture table is missing: ${tableName}`);
  const columns = database.prepare(`PRAGMA table_xinfo(${sqliteString(tableName)})`).all()
    .map((entry) => entry.name);
  const rows = database.prepare(`SELECT * FROM ${sqliteIdentifier(tableName)}`).all()
    .map((row) => Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
  const ordered = sortedRows(rows);
  return {
    rowCount: ordered.length,
    digest: sha256(canonicalJson({ columns, rows: ordered })),
  };
}

function observedExplicitUniqueIndex(database, name) {
  const schemaRows = database.prepare(
    "SELECT type, tbl_name AS tableName FROM sqlite_schema WHERE name = ?",
  ).all(name);
  if (schemaRows.length === 0) return null;
  if (schemaRows.length !== 1 || schemaRows[0].type !== 'index') {
    fail(`bootstrap governed index name is bound to a non-index object: ${name}`);
  }
  const tableName = schemaRows[0].tableName;
  const listed = database.prepare(`PRAGMA index_list(${sqliteString(tableName)})`).all()
    .filter((entry) => entry.name === name);
  if (listed.length !== 1) fail(`bootstrap governed index metadata is incomplete: ${name}`);
  const keyColumns = database.prepare(`PRAGMA index_xinfo(${sqliteString(name)})`).all()
    .filter((entry) => Number(entry.key ?? 0) === 1)
    .sort((left, right) => Number(left.seqno) - Number(right.seqno));
  return {
    name,
    tableName,
    columns: keyColumns.map((entry) => entry.name),
    unique: Number(listed[0].unique ?? 0) === 1,
    explicit: listed[0].origin === 'c',
    partial: Number(listed[0].partial ?? 0) === 1,
    simple: keyColumns.every((entry) => Number(entry.cid) >= 0 && typeof entry.name === 'string'),
    ascendingBinary: keyColumns.every((entry) => (
      Number(entry.desc ?? 0) === 0 && String(entry.coll ?? '').toUpperCase() === 'BINARY'
    )),
  };
}

function assertGovernedIndexDefinition(database, expected, { allowAbsent, phase }) {
  const observed = observedExplicitUniqueIndex(database, expected.name);
  if (observed === null && allowAbsent) return;
  if (observed === null
      || observed.tableName !== expected.tableName
      || !sameValues(observed.columns, expected.columns)
      || observed.unique !== true || observed.explicit !== true
      || observed.partial !== false || observed.simple !== true
      || observed.ascendingBinary !== true) {
    fail(`bootstrap ${phase} governed index definition is unsafe: ${expected.name}`);
  }
}

function rehearseInspection({
  inspection, inventory, root, environment, exclusions, indexTransition,
}) {
  const bytes = Buffer.from(inspection.inspectionBytes);
  const database = new Database(bytes);
  try {
    const fixtureExclusion = exclusions.find((entry) => (
      entry.environment === environment && entry.type === 'table' && entry.preserveData
    ));
    const fixtureBefore = fixtureExclusion
      ? tableDataEvidence(database, fixtureExclusion.tableName)
      : null;
    if (indexTransition && inspection.evidence.ledger.canonicalApplied
      .some(({ file }) => file === indexTransition.file)) {
      for (const transition of indexTransition.allowedDropIndexes) {
        if (observedExplicitUniqueIndex(database, transition.name) !== null) {
          fail(`bootstrap applied convergence migration retained obsolete index: ${transition.name}`);
        }
        assertGovernedIndexDefinition(database, transition.replacement, {
          allowAbsent: false,
          phase: 'live-applied',
        });
      }
    }
    for (const entry of inspection.evidence.ledger.pending) {
      const governedTransition = indexTransition?.file === entry.file
        ? indexTransition.allowedDropIndexes
        : null;
      if (governedTransition) {
        for (const transition of governedTransition) {
          assertGovernedIndexDefinition(database, transition, {
            allowAbsent: transition.allowAbsent === true,
            phase: 'pre-drop',
          });
        }
      }
      applyRehearsalMigration(database, entry, path.join(root, 'migrations'));
      if (governedTransition) {
        for (const transition of governedTransition) {
          assertGovernedIndexDefinition(database, transition.replacement, {
            allowAbsent: false,
            phase: 'post-create',
          });
        }
      }
    }
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      fail(`bootstrap ${environment} post-migration rehearsal failed integrity_check`);
    }
    if (database.pragma('foreign_key_check').length !== 0) {
      fail(`bootstrap ${environment} post-migration rehearsal failed foreign_key_check`);
    }
    const fixtureAfter = fixtureExclusion
      ? tableDataEvidence(database, fixtureExclusion.tableName)
      : null;
    if (fixtureBefore && canonicalJson(fixtureBefore) !== canonicalJson(fixtureAfter)) {
      fail('bootstrap staging fixture data changed during in-memory migration rehearsal');
    }
    const semantic = semanticSchema(database, environment, exclusions);
    return {
      pendingMigrations: inspection.evidence.ledger.pending.map(({ file, sha256: digest }) => ({
        file,
        sha256: digest,
      })),
      postMigrationSchemaDigest: semantic.digest,
      preservedFixture: fixtureBefore
        ? { tableName: fixtureExclusion.tableName, ...fixtureBefore }
        : null,
    };
  } finally {
    database.close();
  }
}

function inspectDatabase({ file, inventory, legacyRows, label, maxBytes }) {
  const before = assertGovernedFile(file, label);
  assertNoSQLiteSidecars(file, label);

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(file, flags);
  let database;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail(`${label} changed identity before inspection`);
    }
    if (opened.size <= 0 || opened.size > maxBytes) {
      fail(`${label} is empty or exceeds the descriptor-inspection size bound`);
    }
    // Query the exact bytes held by the descriptor. Opening `file` again here
    // would reintroduce a path-swap race between the identity check and SQLite.
    // better-sqlite3 deserializes a Buffer into a private in-memory database, so
    // the schema, ledger, and digest below all describe one descriptor-bound
    // snapshot and never follow a replacement path.
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length !== opened.size) {
      fail(`${label} changed size while its descriptor was read`);
    }
    // A checkpointed main file may retain WAL read/write-version bytes (header
    // offsets 18/19 = 2). SQLite cannot attach WAL to an in-memory deserialize,
    // so inspect a copy with only those two journal-mode header bytes normalized
    // to rollback mode. The evidence digest remains over the untouched descriptor
    // bytes, and non-empty WAL was rejected both before and after this snapshot.
    const inspectionBytes = Buffer.from(bytes);
    inspectionBytes[18] = 1;
    inspectionBytes[19] = 1;
    database = new Database(inspectionBytes);
    const integrity = database.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      fail(`${label} failed integrity_check`);
    }
    if (database.pragma('foreign_key_check').length !== 0) {
      fail(`${label} failed foreign_key_check`);
    }
    const ledgerExists = database.prepare(
      "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='_migrations'",
    ).get();
    if (!ledgerExists) fail(`${label} has no migration ledger`);
    const applied = database.prepare(
      'SELECT filename FROM _migrations ORDER BY filename',
    ).all().map((row) => row.filename);
    const ledger = reconcileBootstrapLedger({
      applied,
      inventory,
      legacyRows,
      label,
    });
    const schema = database.prepare(
      `SELECT type, name, tbl_name AS tableName, sql
         FROM sqlite_schema
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name`,
    ).all();
    const evidence = {
      path: file,
      sha256: sha256(bytes),
      snapshotDigest: normalizedSnapshotDigest(bytes),
      schemaDigest: sha256(canonicalJson(schema)),
      ledger,
    };
    database.close();
    database = null;
    const after = assertGovernedFile(file, label);
    if (after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      fail(`${label} changed while baseline evidence was collected`);
    }
    assertNoSQLiteSidecars(file, label);
    return { evidence, inspectionBytes };
  } finally {
    database?.close();
    fs.closeSync(descriptor);
  }
}

export function createReleaseBootstrapBaseline({
  policy,
  root,
  manifestPayload,
  productionSourceSha,
  stagingSourceSha,
  target,
  now = () => Date.now(),
  quiescenceProbe = assertReleaseBootstrapQuiescent,
}) {
  assertFullSha(productionSourceSha, 'bootstrap production source sha');
  assertFullSha(stagingSourceSha, 'bootstrap staging source sha');
  const inventory = assertMigrationInventoryShape(manifestPayload?.migrations?.inventory);
  const reconciliation = assertReleaseMigrationReconciliationShape(
    manifestPayload?.migrations?.reconciliation,
  );
  const reconciliationDigest = releaseMigrationReconciliationDigest(reconciliation);
  quiescenceProbe({ policy });
  const legacyProduction = inspectDatabase({
    file: legacyDatabasePath(policy, 'production'),
    inventory,
    legacyRows: reconciliation.environments.production.legacyRows,
    label: 'bootstrap legacy production database',
    maxBytes: policy.bootstrap.maxDatabaseBytes,
  });
  const legacyStaging = inspectDatabase({
    file: legacyDatabasePath(policy, 'staging'),
    inventory,
    legacyRows: reconciliation.environments.staging.legacyRows,
    label: 'bootstrap legacy staging database',
    maxBytes: policy.bootstrap.maxDatabaseBytes,
  });
  const production = inspectDatabase({
    file: governedDatabasePath(policy, 'production'),
    inventory,
    legacyRows: reconciliation.environments.production.legacyRows,
    label: 'bootstrap target production database',
    maxBytes: policy.bootstrap.maxDatabaseBytes,
  });
  const staging = inspectDatabase({
    file: governedDatabasePath(policy, 'staging'),
    inventory,
    legacyRows: reconciliation.environments.staging.legacyRows,
    label: 'bootstrap target staging database',
    maxBytes: policy.bootstrap.maxDatabaseBytes,
  });
  quiescenceProbe({ policy });
  for (const [environment, legacy, snapshot] of [
    ['production', legacyProduction, production],
    ['staging', legacyStaging, staging],
  ]) {
    if (legacy.evidence.snapshotDigest !== snapshot.evidence.snapshotDigest
        || legacy.evidence.schemaDigest !== snapshot.evidence.schemaDigest
        || canonicalJson(legacy.evidence.ledger) !== canonicalJson(snapshot.evidence.ledger)) {
      fail(`bootstrap ${environment} target is not the exact legacy database snapshot`);
    }
  }
  const productionRehearsal = rehearseInspection({
    inspection: production,
    inventory,
    root,
    environment: 'production',
    exclusions: reconciliation.semanticSchemaExclusions,
    indexTransition: reconciliation.compatibilityExemptions[0],
  });
  const stagingRehearsal = rehearseInspection({
    inspection: staging,
    inventory,
    root,
    environment: 'staging',
    exclusions: reconciliation.semanticSchemaExclusions,
    indexTransition: reconciliation.compatibilityExemptions[0],
  });
  if (productionRehearsal.postMigrationSchemaDigest
      !== stagingRehearsal.postMigrationSchemaDigest) {
    fail('bootstrap post-migration semantic schemas do not converge');
  }
  const baseline = {
    schema: RELEASE_BOOTSTRAP_BASELINE_SCHEMA,
    createdAt: new Date(now()).toISOString(),
    migrationInventoryDigest: sha256(canonicalJson(inventory)),
    migrationReconciliationDigest: reconciliationDigest,
    target,
    legacyRuntime: {
      productionSourceSha,
      stagingSourceSha,
    },
    legacyDatabases: {
      production: legacyProduction.evidence,
      staging: legacyStaging.evidence,
    },
    databases: {
      production: production.evidence,
      staging: staging.evidence,
    },
    schemaProof: {
      schema: 'nexus.release-bootstrap-semantic-schema-proof.v2',
      exclusions: reconciliation.semanticSchemaExclusions.map((entry) => ({ ...entry })),
      production: productionRehearsal,
      staging: stagingRehearsal,
      convergedSchemaDigest: productionRehearsal.postMigrationSchemaDigest,
    },
  };
  return assertReleaseBootstrapBaselineShape(baseline, policy);
}

function assertDatabaseEvidence(value, expectedPath, label) {
  const evidence = exactKeys(
    value,
    ['path', 'sha256', 'snapshotDigest', 'schemaDigest', 'ledger'],
    label,
  );
  if (evidence.path !== expectedPath) fail(`${label} path is not governed`);
  assertHexSha256(evidence.sha256, `${label} sha256`);
  assertHexSha256(evidence.snapshotDigest, `${label} snapshotDigest`);
  assertHexSha256(evidence.schemaDigest, `${label} schemaDigest`);
  const ledger = exactKeys(
    evidence.ledger,
    ['canonicalApplied', 'legacyRows', 'pending'],
    `${label} ledger`,
  );
  if (!Array.isArray(ledger.canonicalApplied) || ledger.canonicalApplied.length > 1024
      || !Array.isArray(ledger.legacyRows) || ledger.legacyRows.length > 128
      || !Array.isArray(ledger.pending) || ledger.pending.length > 1024) {
    fail(`${label} ledger collections are invalid`);
  }
  for (const entry of ledger.canonicalApplied) {
    exactKeys(entry, ['file', 'sha256'], `${label} ledger entry`);
    if (typeof entry.file !== 'string') fail(`${label} ledger filename is invalid`);
    assertHexSha256(entry.sha256, `${label} ledger digest`);
  }
  for (const entry of ledger.legacyRows) {
    exactKeys(
      entry,
      ['file', 'retiredSha256', 'sourceCommit', 'replacement'],
      `${label} legacy ledger entry`,
    );
    if (typeof entry.file !== 'string') fail(`${label} legacy ledger filename is invalid`);
    assertHexSha256(entry.retiredSha256, `${label} legacy ledger digest`);
    assertFullSha(entry.sourceCommit, `${label} legacy ledger sourceCommit`);
    exactKeys(
      entry.replacement,
      ['file', 'sha256', 'relationship'],
      `${label} legacy ledger replacement`,
    );
    if (typeof entry.replacement.file !== 'string'
        || typeof entry.replacement.relationship !== 'string') {
      fail(`${label} legacy ledger replacement is invalid`);
    }
    assertHexSha256(entry.replacement.sha256, `${label} legacy replacement digest`);
  }
  for (const entry of ledger.pending) {
    exactKeys(
      entry,
      ['file', 'sha256', 'kind', 'predecessorCompatible'],
      `${label} pending ledger entry`,
    );
    if (typeof entry.file !== 'string' || typeof entry.kind !== 'string'
        || entry.predecessorCompatible !== true) {
      fail(`${label} pending ledger entry is not predecessor compatible`);
    }
    assertHexSha256(entry.sha256, `${label} pending ledger digest`);
  }
  return evidence;
}

function assertRehearsalEvidence(value, label, { fixtureRequired }) {
  const rehearsal = exactKeys(
    value,
    ['pendingMigrations', 'postMigrationSchemaDigest', 'preservedFixture'],
    label,
  );
  if (!Array.isArray(rehearsal.pendingMigrations)
      || rehearsal.pendingMigrations.length > 1024) {
    fail(`${label} pending migrations are invalid`);
  }
  for (const entry of rehearsal.pendingMigrations) {
    exactKeys(entry, ['file', 'sha256'], `${label} pending migration`);
    if (typeof entry.file !== 'string') fail(`${label} pending migration filename is invalid`);
    assertHexSha256(entry.sha256, `${label} pending migration digest`);
  }
  assertHexSha256(rehearsal.postMigrationSchemaDigest, `${label} schema digest`);
  if (fixtureRequired) {
    const fixture = exactKeys(
      rehearsal.preservedFixture,
      ['tableName', 'rowCount', 'digest'],
      `${label} preserved fixture`,
    );
    if (fixture.tableName !== 'staging_fixture_calendar_events'
        || !Number.isSafeInteger(fixture.rowCount) || fixture.rowCount < 0) {
      fail(`${label} preserved fixture evidence is invalid`);
    }
    assertHexSha256(fixture.digest, `${label} preserved fixture digest`);
  } else if (rehearsal.preservedFixture !== null) {
    fail(`${label} must not carry staging fixture evidence`);
  }
  return rehearsal;
}

export function assertReleaseBootstrapBaselineShape(baseline, policy) {
  exactKeys(baseline, [
    'schema', 'createdAt', 'migrationInventoryDigest', 'migrationReconciliationDigest',
    'target', 'legacyRuntime', 'legacyDatabases', 'databases', 'schemaProof',
  ], 'release bootstrap baseline');
  if (baseline.schema !== RELEASE_BOOTSTRAP_BASELINE_SCHEMA) {
    fail('release bootstrap baseline schema is unsupported');
  }
  assertCanonicalTimestamp(baseline.createdAt, 'release bootstrap baseline createdAt');
  assertHexSha256(
    baseline.migrationInventoryDigest,
    'release bootstrap baseline migrationInventoryDigest',
  );
  assertHexSha256(
    baseline.migrationReconciliationDigest,
    'release bootstrap baseline migrationReconciliationDigest',
  );
  const target = exactKeys(
    baseline.target,
    ['releaseId', 'sourceSha', 'releasePayloadDigest', 'manifestDigest'],
    'release bootstrap baseline target',
  );
  if (typeof target.releaseId !== 'string' || !/^[0-9a-f]{32}$/.test(target.releaseId)) {
    fail('release bootstrap baseline target releaseId is invalid');
  }
  assertFullSha(target.sourceSha, 'release bootstrap baseline target sourceSha');
  if (typeof target.releasePayloadDigest !== 'string'
      || !OCI_DIGEST.test(target.releasePayloadDigest)) {
    fail('release bootstrap baseline target releasePayloadDigest is invalid');
  }
  assertHexSha256(target.manifestDigest, 'release bootstrap baseline target manifestDigest');
  const legacy = exactKeys(
    baseline.legacyRuntime,
    ['productionSourceSha', 'stagingSourceSha'],
    'release bootstrap baseline legacyRuntime',
  );
  assertFullSha(legacy.productionSourceSha, 'bootstrap production source sha');
  assertFullSha(legacy.stagingSourceSha, 'bootstrap staging source sha');
  const databases = exactKeys(
    baseline.databases,
    ['production', 'staging'],
    'release bootstrap baseline databases',
  );
  const legacyDatabases = exactKeys(
    baseline.legacyDatabases,
    ['production', 'staging'],
    'release bootstrap baseline legacyDatabases',
  );
  const legacyProduction = assertDatabaseEvidence(
    legacyDatabases.production,
    legacyDatabasePath(policy, 'production'),
    'release bootstrap baseline legacy production',
  );
  const legacyStaging = assertDatabaseEvidence(
    legacyDatabases.staging,
    legacyDatabasePath(policy, 'staging'),
    'release bootstrap baseline legacy staging',
  );
  const production = assertDatabaseEvidence(
    databases.production,
    governedDatabasePath(policy, 'production'),
    'release bootstrap baseline production',
  );
  const staging = assertDatabaseEvidence(
    databases.staging,
    governedDatabasePath(policy, 'staging'),
    'release bootstrap baseline staging',
  );
  for (const [environment, legacy, snapshot] of [
    ['production', legacyProduction, production],
    ['staging', legacyStaging, staging],
  ]) {
    if (legacy.snapshotDigest !== snapshot.snapshotDigest
        || legacy.schemaDigest !== snapshot.schemaDigest
        || canonicalJson(legacy.ledger) !== canonicalJson(snapshot.ledger)) {
      fail(`release bootstrap baseline ${environment} source and target do not match`);
    }
  }
  const schemaProof = exactKeys(
    baseline.schemaProof,
    ['schema', 'exclusions', 'production', 'staging', 'convergedSchemaDigest'],
    'release bootstrap baseline schemaProof',
  );
  if (schemaProof.schema !== 'nexus.release-bootstrap-semantic-schema-proof.v2'
      || !Array.isArray(schemaProof.exclusions)
      || schemaProof.exclusions.length !== 2) {
    fail('release bootstrap baseline semantic schema proof is invalid');
  }
  const productionProof = assertRehearsalEvidence(
    schemaProof.production,
    'release bootstrap baseline production schema proof',
    { fixtureRequired: false },
  );
  const stagingProof = assertRehearsalEvidence(
    schemaProof.staging,
    'release bootstrap baseline staging schema proof',
    { fixtureRequired: true },
  );
  assertHexSha256(
    schemaProof.convergedSchemaDigest,
    'release bootstrap baseline convergedSchemaDigest',
  );
  if (productionProof.postMigrationSchemaDigest !== schemaProof.convergedSchemaDigest
      || stagingProof.postMigrationSchemaDigest !== schemaProof.convergedSchemaDigest) {
    fail('release bootstrap baseline semantic schema proof does not converge');
  }
  return baseline;
}

function readBaseline(policy) {
  const file = policy.paths.bootstrapBaselineFile;
  const before = assertGovernedFile(file, 'release bootstrap baseline', {
    privateMode: true,
    ownerUid: process.getuid(),
  });
  const descriptor = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('release bootstrap baseline changed identity before it was read');
    }
    if (opened.size <= 0 || opened.size > MAX_BASELINE_BYTES) {
      fail('release bootstrap baseline is empty or exceeds its size bound');
    }
    const bytes = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = assertGovernedFile(file, 'release bootstrap baseline', {
      privateMode: true,
      ownerUid: process.getuid(),
    });
    if (bytes.length !== opened.size
        || afterDescriptor.dev !== opened.dev || afterDescriptor.ino !== opened.ino
        || afterDescriptor.size !== opened.size || afterDescriptor.mtimeMs !== opened.mtimeMs
        || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino) {
      fail('release bootstrap baseline changed while it was read');
    }
    try {
      return assertReleaseBootstrapBaselineShape(JSON.parse(bytes.toString('utf8')), policy);
    } catch (error) {
      if (error instanceof SyntaxError) fail('release bootstrap baseline is not valid JSON');
      throw error;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyBaseline({
  policy,
  root,
  manifestPayload,
  releaseId,
  releasePayloadDigest,
  manifestDigest,
  environments,
  now = () => Date.now(),
  quiescenceProbe = assertReleaseBootstrapQuiescent,
}) {
  assertMigrationInventoryShape(manifestPayload?.migrations?.inventory);
  const reconciliation = assertReleaseMigrationReconciliationShape(
    manifestPayload?.migrations?.reconciliation,
  );
  const baseline = readBaseline(policy);
  const createdAt = Date.parse(baseline.createdAt);
  const age = now() - createdAt;
  if (!Number.isFinite(createdAt)
      || age < -MAX_CLOCK_SKEW_MS
      || age > policy.bootstrap.maxBaselineAgeSeconds * 1000) {
    fail('release bootstrap baseline is outside the accepted freshness window');
  }
  if (baseline.target.releaseId !== releaseId
      || baseline.target.sourceSha !== manifestPayload?.source?.sha
      || baseline.target.releasePayloadDigest !== releasePayloadDigest
      || baseline.target.manifestDigest !== manifestDigest) {
    fail('release bootstrap baseline authorizes a different target release');
  }
  const inventoryDigest = sha256(canonicalJson(manifestPayload.migrations.inventory));
  if (baseline.migrationInventoryDigest !== inventoryDigest) {
    fail('release bootstrap baseline does not match the signed migration inventory');
  }
  const reconciliationDigest = releaseMigrationReconciliationDigest(reconciliation);
  if (baseline.migrationReconciliationDigest !== reconciliationDigest
      || canonicalJson(baseline.schemaProof.exclusions)
        !== canonicalJson(reconciliation.semanticSchemaExclusions)) {
    fail('release bootstrap baseline does not match the signed migration reconciliation');
  }
  const inventory = manifestPayload.migrations.inventory;
  quiescenceProbe({ policy, environments });
  for (const environment of environments) {
    const legacy = inspectDatabase({
      file: legacyDatabasePath(policy, environment),
      inventory,
      legacyRows: reconciliation.environments[environment].legacyRows,
      label: `bootstrap legacy ${environment} database`,
      maxBytes: policy.bootstrap.maxDatabaseBytes,
    });
    const target = inspectDatabase({
      file: governedDatabasePath(policy, environment),
      inventory,
      legacyRows: reconciliation.environments[environment].legacyRows,
      label: `bootstrap target ${environment} database`,
      maxBytes: policy.bootstrap.maxDatabaseBytes,
    });
    if (canonicalJson(legacy.evidence)
          !== canonicalJson(baseline.legacyDatabases[environment])
        || canonicalJson(target.evidence)
          !== canonicalJson(baseline.databases[environment])) {
      fail('release bootstrap databases changed after owner baseline authorization');
    }
    const rehearsal = rehearseInspection({
      inspection: target,
      inventory,
      root,
      environment,
      exclusions: reconciliation.semanticSchemaExclusions,
    });
    if (canonicalJson(rehearsal)
        !== canonicalJson(baseline.schemaProof[environment])) {
      fail('release bootstrap semantic schema proof changed after owner baseline authorization');
    }
  }
  quiescenceProbe({ policy, environments });
  return {
    passed: true,
    baseline,
    baselineDigest: sha256(canonicalJson(baseline)),
  };
}

export function verifyReleaseBootstrapBaseline(input) {
  return verifyBaseline({ ...input, environments: ['production', 'staging'] });
}

export function verifyReleaseBootstrapProductionBaseline(input) {
  return verifyBaseline({ ...input, environments: ['production'] });
}

export function writeReleaseBootstrapBaseline({
  policy,
  baseline,
  beforePublish = () => {},
  afterLink = () => {},
  candidateOutput = false,
  onPublication = () => {},
}) {
  assertReleaseBootstrapBaselineShape(baseline, policy);
  const file = policy.paths.bootstrapBaselineFile;
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (candidateOutput) {
    const candidatePublication = policy.bootstrapBaselineCandidatePublication;
    if (candidatePublication?.expectedReleaseId !== baseline.target.releaseId
        || file !== `${candidatePublication?.canonicalOutput}.next-${baseline.target.releaseId}`) {
      fail('release bootstrap candidate output is not the fixed target-bound path');
    }
  }
  const existingOutput = lstatIfPresent(file);
  if (existingOutput && !candidateOutput) {
    if (existingOutput.nlink !== 2) {
      fail('refusing to overwrite an existing release bootstrap baseline');
    }
    const temporaries = publicationTemporaryPaths(file);
    if (temporaries.length !== 1) {
      fail('existing release bootstrap baseline lacks one safe publication temporary');
    }
    const published = readPublicationBaseline({
      file,
      policy,
      allowedLinkCounts: [2],
    });
    const linked = readPublicationBaseline({
      file: temporaries[0],
      policy,
      allowedLinkCounts: [2],
    });
    if (linked.stat.dev !== published.stat.dev || linked.stat.ino !== published.stat.ino
        || !sameBaselineExceptCreationTime(published.baseline, baseline)) {
      fail('existing release bootstrap baseline differs from this authorization');
    }
    fs.unlinkSync(temporaries[0]);
    fsyncDirectory(directory);
    const repaired = readPublicationBaseline({
      file,
      policy,
      allowedLinkCounts: [1],
    });
    if (repaired.stat.dev !== published.stat.dev
        || repaired.stat.ino !== published.stat.ino
        || !sameBaselineExceptCreationTime(repaired.baseline, baseline)) {
      fail('repaired release bootstrap baseline changed identity or authorization');
    }
    onPublication({
      baseline: repaired.baseline,
      mode: 'canonical',
      disposition: 'repaired_after_link',
      retiredOrphanCount: 0,
    });
    return file;
  }

  let retiredOrphanCount = 0;
  if (candidateOutput) {
    const temporaries = publicationTemporaryPaths(file);
    if (existingOutput && temporaries.length === 0) {
      fail('refusing to overwrite an existing release bootstrap baseline');
    }
    const inspected = temporaries.map((temporary) => ({
      temporary,
      ...readPublicationBaseline({
        file: temporary,
        policy,
        allowedLinkCounts: [1, 2],
      }),
    }));
    for (const entry of inspected) {
      if (!sameBaselineExceptCreationTime(entry.baseline, baseline)) {
        fail('release bootstrap candidate temporary differs from this authorization');
      }
    }
    if (existingOutput) {
      const published = readPublicationBaseline({
        file,
        policy,
        allowedLinkCounts: [2],
      });
      if (!sameBaselineExceptCreationTime(published.baseline, baseline)) {
        fail('existing release bootstrap candidate differs from this authorization');
      }
      const linked = inspected.filter(({ stat }) => (
        stat.dev === published.stat.dev && stat.ino === published.stat.ino
      ));
      if (linked.length !== 1 || linked[0].stat.nlink !== 2
          || inspected.some(({ stat }) => stat.nlink !== 1
            && !(stat.dev === published.stat.dev && stat.ino === published.stat.ino))) {
        fail('existing release bootstrap candidate lacks one safe publication temporary');
      }
      for (const { temporary } of inspected) fs.unlinkSync(temporary);
      fsyncDirectory(directory);
      const repaired = readPublicationBaseline({
        file,
        policy,
        allowedLinkCounts: [1],
      });
      if (repaired.stat.dev !== published.stat.dev
          || repaired.stat.ino !== published.stat.ino
          || !sameBaselineExceptCreationTime(repaired.baseline, baseline)) {
        fail('repaired release bootstrap candidate changed identity or authorization');
      }
      onPublication({
        baseline: repaired.baseline,
        mode: 'candidate',
        disposition: 'repaired_after_link',
        retiredOrphanCount: inspected.length - 1,
      });
      return file;
    }
    if (inspected.some(({ stat }) => stat.nlink !== 1)) {
      fail('orphan release bootstrap candidate temporary has an unsafe link count');
    }
    for (const { temporary } of inspected) fs.unlinkSync(temporary);
    retiredOrphanCount = inspected.length;
    if (retiredOrphanCount > 0) fsyncDirectory(directory);
  }
  const temporary = `${file}.next-${process.pid}-${randomUUID()}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(baseline, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(directory);
  beforePublish({ output: file, temporary });
  try {
    // `link` is the atomic no-replace publication primitive. Unlike rename it
    // fails with EEXIST if another owner command won the race after our initial
    // diagnostic check, so one authorization can never overwrite another.
    fs.linkSync(temporary, file);
  } catch (error) {
    fs.unlinkSync(temporary);
    fsyncDirectory(directory);
    if (error && error.code === 'EEXIST') {
      fail('refusing to overwrite an existing release bootstrap baseline');
    }
    throw error;
  }
  fsyncDirectory(directory);
  afterLink({ output: file, temporary });
  fs.unlinkSync(temporary);
  fsyncDirectory(directory);
  onPublication({
    baseline,
    mode: candidateOutput ? 'candidate' : 'canonical',
    disposition: 'published',
    retiredOrphanCount,
  });
  return file;
}
