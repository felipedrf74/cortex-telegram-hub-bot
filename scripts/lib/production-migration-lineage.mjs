// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PRODUCTION_MIGRATION_LINEAGE_SCHEMA =
  'nexus.production-migration-lineages.v1';

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const MIGRATION_FILE = /^\d{3}_[^/]+\.sql$/;
const RELATIONSHIPS = new Set([
  'byte_identical_renumber',
  'comment_only_renumber',
  'schema_reconciliation',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameValues(left, right) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function assertRegularFile(file, message) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(message); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
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

  const lineageIds = new Set();
  const retiredFiles = new Set();
  const replacementFiles = new Set();
  const migrationSets = new Set();
  const lineages = parsed.lineages.map((lineage) => {
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
    const migrations = lineage.migrations.map((entry) => {
      const replacement = entry?.replacement;
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
  return Object.freeze({
    schema: parsed.schema,
    sha256: sha256(raw),
    lineages: Object.freeze(lineages),
  });
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
