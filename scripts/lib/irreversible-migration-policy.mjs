// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const IRREVERSIBLE_MIGRATION_POLICY_SCHEMA = 'nexus.irreversible-migrations.v2';
export const IRREVERSIBLE_MIGRATION_REVIEW_APPROVAL_SCHEMA = 'nexus.migration-review-approval.v1';

export function sha256Text(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

export function irreversibleMigrationReviewSubject(parsed) {
  return {
    schema: parsed.schema,
    migrations: parsed.migrations.map(({
      file, sha256, reason, rollback,
    }) => ({ file, sha256, reason, rollback })),
    syntaxExemptions: parsed.syntaxExemptions.map(({
      file, sha256, reason,
    }) => ({ file, sha256, reason })),
  };
}

export function irreversibleMigrationReviewSubjectSha256(parsed) {
  return sha256Text(JSON.stringify(irreversibleMigrationReviewSubject(parsed)));
}

export function loadIrreversibleMigrationPolicy({
  root,
  policyPath = path.join(root, 'config/irreversible-migrations.json'),
  fileExists = fs.existsSync,
  readText = (file) => fs.readFileSync(file),
} = {}) {
  if (!root || !fileExists(policyPath)) {
    throw new Error('irreversible migration policy is missing');
  }
  let parsed;
  try {
    parsed = JSON.parse(readText(policyPath));
  } catch {
    throw new Error('irreversible migration policy is invalid JSON');
  }
  if (parsed?.schema !== IRREVERSIBLE_MIGRATION_POLICY_SCHEMA
    || !Array.isArray(parsed.migrations)
    || !Array.isArray(parsed.syntaxExemptions)) {
    throw new Error('irreversible migration policy has an invalid schema');
  }
  const governed = new Map();
  const exemptions = new Map();
  const prefixes = new Map();
  const integrityIssues = [];
  for (const entry of parsed.migrations) {
    assertEntry(entry, 'migrations');
    assertUniqueEntry(entry, governed, exemptions, prefixes);
    if (entry.rollback !== 'exact_pre_migration_snapshot') {
      throw new Error(`irreversible migration policy has unsupported rollback mode: ${entry.file}`);
    }
    governed.set(entry.file, validateIdentity({ entry, root, fileExists, readText, integrityIssues }));
  }
  for (const entry of parsed.syntaxExemptions) {
    assertEntry(entry, 'syntaxExemptions');
    assertUniqueEntry(entry, governed, exemptions, prefixes);
    exemptions.set(entry.file, validateIdentity({ entry, root, fileExists, readText, integrityIssues }));
  }
  return Object.freeze({
    governed,
    exemptions,
    integrityIssues: Object.freeze(integrityIssues),
    reviewSubjectSha256: irreversibleMigrationReviewSubjectSha256(parsed),
    policyPath,
  });
}

export function irreversibleMigrationReason(file, sql, policy) {
  const governed = policy.governed.get(file);
  if (governed) {
    return sha256Text(sql) === governed.sha256
      ? `POLICY:${governed.reason}`
      : `POLICY_DIGEST_DRIFT:${governed.reason}`;
  }
  const exemption = policy.exemptions.get(file);
  if (exemption) {
    return sha256Text(sql) === exemption.sha256
      ? null
      : `POLICY_EXEMPTION_DIGEST_DRIFT:${exemption.reason}`;
  }
  const stripped = stripSqlComments(sql);
  const checks = [
    ['DROP TABLE', /\bDROP\s+TABLE\b/i],
    ['DROP COLUMN', /\bDROP\s+COLUMN\b/i],
    ['ALTER TABLE RENAME', /\bALTER\s+TABLE\b[^;]*\bRENAME\b/i],
    ['RENAME TO', /\bRENAME\s+TO\b/i],
  ];
  for (const [label, pattern] of checks) {
    if (pattern.test(stripped)) return label;
  }
  return null;
}

function assertEntry(entry, field) {
  if (!entry || typeof entry.file !== 'string'
    || !/^migrations\/\d{3}_[^/]+\.sql$/.test(entry.file)
    || typeof entry.sha256 !== 'string'
    || !/^[a-f0-9]{64}$/.test(entry.sha256)
    || typeof entry.reason !== 'string'
    || !/^[a-z0-9_]+$/.test(entry.reason)) {
    throw new Error(`irreversible migration policy has invalid ${field} entry`);
  }
}

function assertUniqueEntry(entry, governed, exemptions, prefixes) {
  if (governed.has(entry.file) || exemptions.has(entry.file)) {
    throw new Error(`irreversible migration policy has duplicate entry: ${entry.file}`);
  }
  const prefix = entry.file.slice('migrations/'.length, 'migrations/'.length + 3);
  const existing = prefixes.get(prefix);
  if (existing) {
    throw new Error(`irreversible migration policy has conflicting prefix ${prefix}: ${existing},${entry.file}`);
  }
  prefixes.set(prefix, entry.file);
}

function validateIdentity({ entry, root, fileExists, readText, integrityIssues }) {
  const absolute = path.join(root, entry.file);
  let actualSha256 = null;
  let identity = 'missing';
  if (fileExists(absolute)) {
    actualSha256 = sha256Text(readText(absolute));
    identity = actualSha256 === entry.sha256 ? 'verified' : 'digest_mismatch';
  }
  if (identity !== 'verified') {
    integrityIssues.push(Object.freeze({
      file: entry.file,
      type: identity,
      expectedSha256: entry.sha256,
      actualSha256,
    }));
  }
  return Object.freeze({ ...entry, actualSha256, identity });
}

function stripSqlComments(sql) {
  return String(sql)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}
