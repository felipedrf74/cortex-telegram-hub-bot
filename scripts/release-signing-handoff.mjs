#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  assertFullSha,
  assertHexSha256,
  assertOciDigest,
  assertPositiveIntegerString,
  exactKeys,
  sha256,
} from './lib/release-canonical.mjs';

/**
 * Package and verify the only bytes allowed to cross from the dependency/image
 * builder into the fresh manifest-signing job. This module intentionally uses
 * Node built-ins only and never starts a child process or executes artifact
 * content. The signing key is absent in both modes; release-manifest-build.mjs
 * receives it only after `verify` succeeds and protected main is rechecked.
 */

const SCHEMA = 'nexus.release-signing-handoff.v1';
const HOSTED_RESULT_NAME = 'hosted-migration-safety.json';
const COMPOSE_NAME = 'docker-compose.release.yml';
const MANIFEST_NAME = 'release-signing-handoff.json';
const EXPECTED_FILES = [COMPOSE_NAME, HOSTED_RESULT_NAME, MANIFEST_NAME];
const MAX_HOSTED_RESULT_BYTES = 32 * 1024 * 1024;
const MAX_COMPOSE_BYTES = 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

function fail(message, code = 65) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArguments(argv) {
  const [mode, ...rest] = argv;
  if (!['create', 'verify'].includes(mode)) {
    fail('usage: release-signing-handoff.mjs <create|verify> [flags]', 64);
  }
  if (rest.length % 2 !== 0) fail('every flag requires exactly one value', 64);
  const values = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    const value = rest[index + 1];
    if (!/^--[a-z][a-z-]*$/.test(name) || values.has(name) || !value) {
      fail(`invalid or duplicate argument: ${name}`, 64);
    }
    values.set(name, value);
  }
  const allowed = mode === 'create'
    ? new Set([
      '--source-sha', '--ci-run-id', '--migration-base', '--backend-digest',
      '--content-engine-digest', '--hosted-migration-result',
      '--hosted-migration-digest', '--compose', '--output-directory',
    ])
    : new Set([
      '--directory', '--expected-digest', '--source-sha', '--ci-run-id',
      '--migration-base', '--backend-digest', '--content-engine-digest',
    ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) fail(`unsupported argument for ${mode}: ${name}`, 64);
  }
  for (const name of allowed) {
    if (!values.has(name)) fail(`${name} is required for ${mode}`, 64);
  }
  return { mode, values };
}

function readBoundedRegularFile(filePath, maximumBytes, label) {
  let descriptor;
  try {
    descriptor = fs.openSync(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) {
      throw new Error('is not a bounded non-empty regular file');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
      throw new Error('changed while it was read');
    }
    return bytes;
  } catch (error) {
    fail(`${label} is invalid: ${error instanceof Error ? error.message : 'read failed'}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function requireSafeDirectory(directory, { mustBeEmpty = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch {
    if (!mustBeEmpty) fail(`handoff directory does not exist: ${directory}`);
    fs.mkdirSync(directory, { mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail(`handoff directory is not a real directory: ${directory}`);
  }
  const entries = fs.readdirSync(directory).sort();
  if (mustBeEmpty && entries.length !== 0) {
    fail('handoff output directory must be empty');
  }
  return entries;
}

function validateIdentity(values) {
  try {
    const identity = {
      sourceSha: assertFullSha(values.get('--source-sha'), 'handoff source SHA'),
      ciRunId: assertPositiveIntegerString(values.get('--ci-run-id'), 'handoff CI run id'),
      migrationBase: assertFullSha(
        values.get('--migration-base'),
        'handoff migration comparison base',
      ),
      backendDigest: assertOciDigest(
        values.get('--backend-digest'),
        'handoff backend digest',
      ),
      contentEngineDigest: assertOciDigest(
        values.get('--content-engine-digest'),
        'handoff content-engine digest',
      ),
    };
    if (identity.backendDigest === identity.contentEngineDigest) {
      throw new Error('handoff application image digests must be distinct');
    }
    return identity;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'handoff identity is invalid', 64);
  }
}

function assertHostedResult(bytes, migrationBase) {
  let result;
  try {
    result = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('hosted migration result is not valid JSON');
  }
  if (result?.ok !== true
      || result.comparisonBase !== migrationBase
      || !result.cdEligibility
      || !Array.isArray(result.migrationInventory)
      || result.migrationInventory.length === 0
      || !result.migrationReconciliation) {
    fail('hosted migration result is incomplete or bound to another comparison base');
  }
}

function createHandoff(values) {
  const identity = validateIdentity(values);
  const outputDirectory = path.resolve(values.get('--output-directory'));
  requireSafeDirectory(outputDirectory, { mustBeEmpty: true });

  const hostedBytes = readBoundedRegularFile(
    path.resolve(values.get('--hosted-migration-result')),
    MAX_HOSTED_RESULT_BYTES,
    'hosted migration result',
  );
  let hostedExpectedDigest;
  try {
    hostedExpectedDigest = assertHexSha256(
      values.get('--hosted-migration-digest'),
      'hosted migration verification digest',
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : 'hosted migration digest is invalid', 64);
  }
  if (sha256(hostedBytes) !== hostedExpectedDigest) {
    fail('hosted migration result changed after the secretless recomputation');
  }
  assertHostedResult(hostedBytes, identity.migrationBase);
  const composeBytes = readBoundedRegularFile(
    path.resolve(values.get('--compose')),
    MAX_COMPOSE_BYTES,
    'release Compose file',
  );

  const handoff = {
    schema: SCHEMA,
    source: {
      sha: identity.sourceSha,
      ciRunId: identity.ciRunId,
      migrationBase: identity.migrationBase,
    },
    images: {
      backendDigest: identity.backendDigest,
      contentEngineDigest: identity.contentEngineDigest,
    },
    hostedMigrationResult: {
      path: HOSTED_RESULT_NAME,
      sha256: sha256(hostedBytes),
    },
    compose: {
      path: COMPOSE_NAME,
      sha256: sha256(composeBytes),
    },
  };

  fs.writeFileSync(path.join(outputDirectory, HOSTED_RESULT_NAME), hostedBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  fs.writeFileSync(path.join(outputDirectory, COMPOSE_NAME), composeBytes, {
    flag: 'wx',
    mode: 0o600,
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(handoff, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDirectory, MANIFEST_NAME), manifestBytes, {
    flag: 'wx',
    mode: 0o600,
  });

  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-signing-handoff-create.v1',
    digest: sha256(manifestBytes),
  })}\n`);
}

function verifyHandoff(values) {
  const identity = validateIdentity(values);
  let expectedDigest;
  try {
    expectedDigest = assertHexSha256(
      values.get('--expected-digest'),
      'expected handoff digest',
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : 'expected handoff digest is invalid', 64);
  }

  const directory = path.resolve(values.get('--directory'));
  const entries = requireSafeDirectory(directory);
  if (JSON.stringify(entries) !== JSON.stringify(EXPECTED_FILES)) {
    fail('signing handoff must contain exactly the governed three files');
  }

  const manifestBytes = readBoundedRegularFile(
    path.join(directory, MANIFEST_NAME),
    MAX_MANIFEST_BYTES,
    'signing handoff manifest',
  );
  if (sha256(manifestBytes) !== expectedDigest) {
    fail('signing handoff manifest digest does not match the builder output');
  }

  let handoff;
  try {
    handoff = JSON.parse(manifestBytes.toString('utf8'));
    exactKeys(
      handoff,
      ['schema', 'source', 'images', 'hostedMigrationResult', 'compose'],
      'signing handoff',
    );
    exactKeys(handoff.source, ['sha', 'ciRunId', 'migrationBase'], 'signing handoff source');
    exactKeys(
      handoff.images,
      ['backendDigest', 'contentEngineDigest'],
      'signing handoff images',
    );
    exactKeys(handoff.hostedMigrationResult, ['path', 'sha256'], 'signing handoff migration');
    exactKeys(handoff.compose, ['path', 'sha256'], 'signing handoff Compose');
  } catch (error) {
    fail(error instanceof Error ? error.message : 'signing handoff schema is invalid');
  }

  if (handoff.schema !== SCHEMA
      || handoff.source.sha !== identity.sourceSha
      || handoff.source.ciRunId !== identity.ciRunId
      || handoff.source.migrationBase !== identity.migrationBase
      || handoff.images.backendDigest !== identity.backendDigest
      || handoff.images.contentEngineDigest !== identity.contentEngineDigest
      || handoff.hostedMigrationResult.path !== HOSTED_RESULT_NAME
      || handoff.compose.path !== COMPOSE_NAME) {
    fail('signing handoff identity does not match the protected builder outputs');
  }
  try {
    assertHexSha256(handoff.hostedMigrationResult.sha256, 'handoff migration digest');
    assertHexSha256(handoff.compose.sha256, 'handoff Compose digest');
  } catch (error) {
    fail(error instanceof Error ? error.message : 'signing handoff file digest is invalid');
  }

  const hostedBytes = readBoundedRegularFile(
    path.join(directory, HOSTED_RESULT_NAME),
    MAX_HOSTED_RESULT_BYTES,
    'hosted migration result',
  );
  const composeBytes = readBoundedRegularFile(
    path.join(directory, COMPOSE_NAME),
    MAX_COMPOSE_BYTES,
    'release Compose file',
  );
  if (sha256(hostedBytes) !== handoff.hostedMigrationResult.sha256
      || sha256(composeBytes) !== handoff.compose.sha256) {
    fail('signing handoff file digest does not match its closed manifest');
  }
  assertHostedResult(hostedBytes, identity.migrationBase);

  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-signing-handoff-verification.v1',
    digest: expectedDigest,
    hostedMigrationDigest: handoff.hostedMigrationResult.sha256,
    composeDigest: handoff.compose.sha256,
  })}\n`);
}

const { mode, values } = parseArguments(process.argv.slice(2));
if (mode === 'create') createHandoff(values);
else verifyHandoff(values);
