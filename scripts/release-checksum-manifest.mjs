#!/usr/bin/env node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseBundle } from './lib/release-artifact-manifest.mjs';
import {
  buildReleaseTestPartition,
  testInventoryDigest,
  verifyReleaseTestResults,
} from './lib/release-test-partition.mjs';

export const RELEASE_CHECKSUM_MANIFEST_SCHEMA = 'nexus.release-checksum-manifest.v1';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const command = args.shift() || 'validate';

function valueOf(name, fallback = '') {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1] || fallback;
}

function hasFlag(name) {
  return args.includes(name);
}

function fail(message) {
  throw new Error(message);
}

function readRegularBytes(filename, label) {
  if (!filename) fail(`${label} path is required`);
  const resolved = path.resolve(filename);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 16 * 1024 * 1024) {
    fail(`${label} is not a bounded regular file`);
  }
  return fs.readFileSync(resolved);
}

function readJson(filename, label) {
  return JSON.parse(readRegularBytes(filename, label).toString('utf8'));
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} must be a positive integer`);
  return parsed;
}

function validSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value ?? '')) fail(`${label} is not a full lowercase Git SHA`);
  return value;
}

function validDigest(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value ?? '')) fail(`${label} is not a lowercase SHA-256`);
  return value;
}

function canonicalDeployedSha() {
  const state = readJson(
    path.join(repositoryRoot, 'docs/release/release-state.json'),
    'canonical protected release state',
  );
  return validSha(state?.backend?.runtimeSha, 'canonical deployed SHA');
}

function normalizeGroups(selection) {
  if (selection?.schema !== 'nexus.test-selection.v2'
      || typeof selection.docsOnly !== 'boolean'
      || !Array.isArray(selection.selected)) {
    fail('protected-main test selection schema is invalid');
  }
  const groups = selection?.groups
    ?? selection?.vitest?.groups
    ?? selection?.selection?.groups
    ?? [];
  if (!Array.isArray(groups)) {
    fail('protected-main test selection does not declare selected groups');
  }
  const normalized = [...new Set(groups.map((group) => String(group)))].sort();
  if (normalized.some((group) => !/^[a-z][a-z0-9-]{1,63}$/.test(group))) {
    fail('protected-main test selection contains an invalid group name');
  }
  const selected = [...new Set(selection.selected.map((file) => String(file)))].sort();
  if (JSON.stringify(selection.selected) !== JSON.stringify(selected)
      || selected.some((file) => file.length === 0
        || path.isAbsolute(file)
        || file.split('/').includes('..'))) {
    fail('protected-main selected test inventory is invalid');
  }
  if (selection.docsOnly) {
    if (normalized.length !== 0 || selected.length !== 0) {
      fail('docs-only protected-main selection must not contain tests or groups');
    }
  } else if (normalized.length === 0 || selected.length === 0) {
    fail('non-docs protected-main selection must contain tests and groups');
  }
  return normalized;
}

function vitestSummary(filename, label) {
  const report = readJson(filename, label);
  const failed = Number(report.numFailedTests ?? 0);
  const total = Number(report.numTotalTests);
  const passed = Number(report.numPassedTests);
  if (!Number.isSafeInteger(total) || total <= 0
      || !Number.isSafeInteger(passed) || passed < 0
      || !Number.isSafeInteger(failed) || failed !== 0
      || passed > total
      || report.success === false) {
    fail(`${label} is not a complete passing result`);
  }
  return {
    total,
    digest: sha256(fs.readFileSync(path.resolve(filename))),
    report,
  };
}

function shardSummary(filename, shard) {
  const summary = vitestSummary(filename, `Vitest shard ${shard} result`);
  return {
    manifest: {
      shard: `${shard}/4`,
      status: 'passed',
      tests: summary.total,
      resultSha256: summary.digest,
    },
    report: summary.report,
  };
}

function selectedTestSummary(selection, filename) {
  if (selection.docsOnly) {
    if (filename) fail('docs-only protected-main selection must not have a Vitest result');
    return {
      manifest: { status: 'skipped', tests: 0, resultSha256: null },
      report: null,
    };
  }
  if (!filename) fail('focused protected-main selection is missing its Vitest result');
  const summary = vitestSummary(filename, 'protected-main selected Vitest result');
  return {
    manifest: { status: 'passed', tests: summary.total, resultSha256: summary.digest },
    report: summary.report,
  };
}

function validateManifest(
  value,
  { bundle = '', expectedSha = '', expectedArtifactDigest = '' } = {},
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== RELEASE_CHECKSUM_MANIFEST_SCHEMA) {
    fail('release checksum manifest schema is invalid');
  }
  validSha(value.sourceSha, 'manifest source SHA');
  if (expectedSha && value.sourceSha !== validSha(expectedSha, 'expected source SHA')) {
    fail('release checksum manifest source SHA mismatch');
  }
  if (typeof value.version !== 'string' || !/^[0-9A-Za-z.+-]+$/.test(value.version)) {
    fail('release checksum manifest version is invalid');
  }
  if (!Number.isFinite(Date.parse(value.createdAt ?? ''))) {
    fail('release checksum manifest creation time is invalid');
  }
  if (typeof value.artifact?.name !== 'string'
      || value.artifact.name !== `release-bundle-${value.sourceSha}-${value.artifact.sha256}`) {
    fail('release checksum manifest artifact name is not exact');
  }
  validDigest(value.artifact?.sha256, 'release artifact digest');
  if (expectedArtifactDigest
      && value.artifact.sha256 !== validDigest(
        expectedArtifactDigest,
        'expected release artifact digest',
      )) {
    fail('release checksum manifest artifact digest mismatch');
  }
  positiveInteger(value.protectedMain?.runId, 'protected-main run ID');
  positiveInteger(value.protectedMain?.runAttempt, 'protected-main run attempt');
  positiveInteger(value.releaseCheckpoint?.runId, 'release-checkpoint run ID');
  positiveInteger(value.releaseCheckpoint?.runAttempt, 'release-checkpoint run attempt');
  if (value.protectedMain?.workflow !== 'ci.yml'
      || value.releaseCheckpoint?.workflow !== 'release-candidate-evidence.yml') {
    fail('release checksum manifest workflow identities are invalid');
  }
  if (typeof value.protectedMain?.docsOnly !== 'boolean'
      || !['passed', 'skipped'].includes(value.protectedMain?.selectedTests?.status)
      || !Number.isSafeInteger(value.protectedMain?.selectedTests?.tests)
      || value.protectedMain.selectedTests.tests < 0
      || !Number.isSafeInteger(value.protectedMain?.selectedTests?.files)
      || value.protectedMain.selectedTests.files < 0
      || (value.protectedMain.docsOnly
        && (value.protectedMain.selectedTests.status !== 'skipped'
          || value.protectedMain.selectedTests.tests !== 0
          || value.protectedMain.selectedTests.files !== 0
          || value.protectedMain.selectedTests.resultSha256 !== null))
      || (!value.protectedMain.docsOnly
        && (value.protectedMain.selectedTests.status !== 'passed'
          || value.protectedMain.selectedTests.tests <= 0
          || value.protectedMain.selectedTests.files <= 0))) {
    fail('release checksum manifest protected-main selected result is invalid');
  }
  validDigest(
    value.protectedMain.selectedTests.inventorySha256,
    'protected-main selected inventory digest',
  );
  if (!value.protectedMain.docsOnly) {
    validDigest(
      value.protectedMain.selectedTests.resultSha256,
      'protected-main selected result digest',
    );
  }
  validDigest(value.testPolicySha256, 'test policy digest');
  if (!Array.isArray(value.selectedGroups)
      || value.selectedGroups.some((group) => !/^[a-z][a-z0-9-]{1,63}$/.test(group))) {
    fail('release checksum manifest selected groups are invalid');
  }
  if ((value.protectedMain.docsOnly && value.selectedGroups.length !== 0)
      || (!value.protectedMain.docsOnly && value.selectedGroups.length === 0)) {
    fail('release checksum manifest selected groups do not match docs-only status');
  }
  const normalizedGroups = [...new Set(value.selectedGroups)].sort();
  if (JSON.stringify(value.selectedGroups) !== JSON.stringify(normalizedGroups)) {
    fail('release checksum manifest selected groups must be sorted and unique');
  }
  validSha(value.releaseImpact?.deployedSha, 'release-impact deployed SHA');
  if (value.releaseImpact.deployedSha !== canonicalDeployedSha()) {
    fail('release-impact deployed SHA does not match canonical protected release state');
  }
  if (!Array.isArray(value.releaseImpact?.groups)
      || value.releaseImpact.groups.some(
        (group) => !/^[a-z][a-z0-9-]{1,63}$/.test(group),
      )) {
    fail('release checksum manifest cumulative release groups are invalid');
  }
  const normalizedReleaseGroups = [...new Set(value.releaseImpact.groups)].sort();
  if (JSON.stringify(value.releaseImpact.groups) !== JSON.stringify(normalizedReleaseGroups)) {
    fail('release checksum manifest cumulative release groups must be sorted and unique');
  }
  if (!Array.isArray(value.fullSuite?.shards) || value.fullSuite.shards.length !== 4
      || value.fullSuite.status !== 'passed'
      || value.fullSuite.execution !== 'protected-main-selection-plus-checkpoint-remainder'
      || !Number.isSafeInteger(value.fullSuite.tests)
      || value.fullSuite.tests <= 0
      || !Number.isSafeInteger(value.fullSuite.files)
      || value.fullSuite.files <= 0) {
    fail('release checksum manifest must contain one complete deterministic execution');
  }
  validDigest(value.fullSuite.inventorySha256, 'deterministic test inventory digest');
  const shardNames = value.fullSuite.shards.map((entry) => entry?.shard);
  if (JSON.stringify(shardNames) !== JSON.stringify(['1/4', '2/4', '3/4', '4/4'])) {
    fail('release checksum manifest Vitest shard identities are invalid');
  }
  for (const entry of value.fullSuite.shards) {
    if (entry.status !== 'passed'
        || !Number.isSafeInteger(entry.tests) || entry.tests <= 0
        || !Number.isSafeInteger(entry.files) || entry.files <= 0) {
      fail(`release checksum manifest Vitest shard ${entry.shard} is invalid`);
    }
    validDigest(entry.resultSha256, `Vitest shard ${entry.shard} result digest`);
    validDigest(entry.inventorySha256, `Vitest shard ${entry.shard} inventory digest`);
  }
  const partition = value.fullSuite.partition;
  if (!partition || typeof partition !== 'object' || Array.isArray(partition)
      || partition.disjoint !== true || partition.complete !== true
      || !partition.deterministic || !partition.selected || !partition.remaining) {
    fail('release checksum manifest deterministic partition proof is missing');
  }
  for (const [name, inventory] of Object.entries({
    deterministic: partition.deterministic,
    selected: partition.selected,
    remaining: partition.remaining,
  })) {
    if (!Number.isSafeInteger(inventory.files) || inventory.files < 0) {
      fail(`release checksum manifest ${name} file count is invalid`);
    }
    validDigest(inventory.sha256, `${name} inventory digest`);
  }
  validDigest(partition.proofSha256, 'deterministic partition proof digest');
  const expectedProofDigest = sha256(JSON.stringify({
    deterministic: partition.deterministic,
    selected: partition.selected,
    remaining: partition.remaining,
  }));
  if (partition.proofSha256 !== expectedProofDigest
      || partition.deterministic.files !== partition.selected.files + partition.remaining.files
      || partition.deterministic.files !== value.fullSuite.files
      || partition.deterministic.sha256 !== value.fullSuite.inventorySha256
      || partition.selected.files !== value.protectedMain.selectedTests.files
      || partition.selected.sha256 !== value.protectedMain.selectedTests.inventorySha256) {
    fail('release checksum manifest deterministic partition proof is inconsistent');
  }
  const remainingTests = value.fullSuite.shards.reduce((sum, entry) => sum + entry.tests, 0);
  const remainingFiles = value.fullSuite.shards.reduce((sum, entry) => sum + entry.files, 0);
  if (value.fullSuite.tests !== value.protectedMain.selectedTests.tests + remainingTests
      || partition.remaining.files !== remainingFiles) {
    fail('release checksum manifest deterministic suite totals are invalid');
  }
  if (typeof value.python?.required !== 'boolean'
      || !['passed', 'skipped'].includes(value.python?.status)
      || (value.python.required && value.python.status !== 'passed')
      || (!value.python.required && value.python.status !== 'skipped')) {
    fail('release checksum manifest Python result is invalid');
  }
  if (typeof value.migrations?.required !== 'boolean'
      || !['passed', 'skipped'].includes(value.migrations?.status)
      || typeof value.migrations?.approvalRequired !== 'boolean'
      || typeof value.migrations?.governanceReviewRequired !== 'boolean'
      || (value.migrations.required
        && (value.migrations.status !== 'passed'
          || (value.migrations.approvalRequired
            && !/^[0-9a-f]{64}$/.test(value.migrations.reviewSubjectSha256 ?? ''))
          || (!value.migrations.approvalRequired
            && value.migrations.reviewSubjectSha256 !== null)
          || (value.migrations.governanceReviewRequired
            && !/^[0-9a-f]{64}$/.test(
              value.migrations.governanceReviewSubjectSha256 ?? '',
            ))
          || (!value.migrations.governanceReviewRequired
            && value.migrations.governanceReviewSubjectSha256 !== null)))
      || (!value.migrations.required
        && (value.migrations.status !== 'skipped'
          || value.migrations.approvalRequired
          || value.migrations.governanceReviewRequired
          || value.migrations.reviewSubjectSha256 !== null
          || value.migrations.governanceReviewSubjectSha256 !== null))) {
    fail('release checksum manifest migration result is invalid');
  }
  if (bundle) {
    const verified = verifyReleaseBundle(path.resolve(bundle), value.sourceSha);
    if (verified.digest !== value.artifact.sha256) {
      fail('release checksum manifest does not match the exact runtime bundle');
    }
    if (verified.marker.packageVersion !== value.version) {
      fail('release checksum manifest version does not match the exact runtime bundle');
    }
  }
  return value;
}

function validateTransaction(value, manifest, expectedRole = '', options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== 'nexus.lean-release-transaction.v1') {
    fail('lean release transaction schema is invalid');
  }
  if (!['staging', 'production'].includes(value.role)
      || (expectedRole && value.role !== expectedRole)) {
    fail('lean release transaction role is invalid');
  }
  // Receipts written before the first-install path existed simply omit the
  // marker, which means the same thing as false. Anything else is a receipt this
  // validator does not understand.
  if (value.firstInstall !== undefined && typeof value.firstInstall !== 'boolean') {
    fail('lean release transaction first-install marker is invalid');
  }
  // A first install is the one transaction that can honestly have no
  // predecessor: it bootstraps a host that has never released, so there is
  // nothing to record, nothing to restore, and rollback readiness was never
  // applicable. That is legitimate for staging only. Production always has a
  // predecessor and a promote-time backup lineage, and bootstrapping it is a
  // separate, separately audited operation.
  const firstInstall = value.firstInstall === true;
  if (firstInstall && value.role !== 'staging') {
    fail('lean release transaction first install is valid only for staging');
  }
  // Structural validity is not promotability. A first install proved health, the
  // authenticated smoke, database integrity, and the soak, but it never proved it
  // could be rolled back, because there was nothing to roll back to. A promotion
  // gate asks for the stronger property.
  if (firstInstall && options.requirePromotable === true) {
    fail('lean release transaction is a first install and is not promotable');
  }
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$/.test(value.transactionId ?? '')
      || value.runtimeSha !== manifest.sourceSha
      || value.artifactDigest !== manifest.artifact.sha256
      || value.phase !== 'completed'
      || value.status !== 'passed'
      || value.healthResult !== 'passed'
      || value.rollbackResult !== 'not_required'
      || value.rollbackDurationMs !== null
      || (firstInstall
        ? (value.predecessorSha !== null || value.predecessorDigest !== null)
        : (!/^[0-9a-f]{40}$/.test(value.predecessorSha ?? '')
          || !/^[0-9a-f]{64}$/.test(value.predecessorDigest ?? '')))
      || (value.role === 'production'
        && value.predecessorSha !== manifest.releaseImpact.deployedSha)
      || !Number.isSafeInteger(value.stabilitySeconds)
      || value.stabilitySeconds < (value.role === 'production' ? 60 : 1)
      || !Number.isFinite(Date.parse(value.soakStartedAt ?? ''))
      || !Number.isFinite(Date.parse(value.soakCompletedAt ?? ''))
      || Date.parse(value.soakCompletedAt) - Date.parse(value.soakStartedAt)
        < value.stabilitySeconds * 1000
      || value.candidateHealthBudgetSeconds !== 45
      || value.rollbackHealthBudgetSeconds !== 45
      || value.rollbackObjectiveSeconds !== 120
      || value.faultInjection !== null
      || value.candidateRemoved !== false
      || !Number.isFinite(Date.parse(value.startedAt ?? ''))
      || !Number.isFinite(Date.parse(value.completedAt ?? ''))
      || !Number.isFinite(Date.parse(value.updatedAt ?? ''))
      || Date.parse(value.startedAt) > Date.parse(value.completedAt)
      || Date.parse(value.startedAt) > Date.parse(value.soakStartedAt)
      || Date.parse(value.soakCompletedAt) > Date.parse(value.completedAt)
      || Date.parse(value.completedAt) > Date.parse(value.updatedAt)) {
    fail('lean release transaction is not completed for the exact manifest');
  }
  const releasePrefix = value.role === 'staging'
    ? '/home/dominguez/telegram-hub-bot-staging/releases/'
    : '/home/dominguez/telegram-hub-bot/releases/';
  if (typeof value.releaseDir !== 'string'
      || !value.releaseDir.startsWith(releasePrefix)
      || (firstInstall
        ? value.predecessor !== null
        : (typeof value.predecessor !== 'string'
          || !value.predecessor.startsWith(releasePrefix)
          || value.predecessor === value.releaseDir))) {
    fail('lean release transaction release directory is invalid');
  }
  const expectedChecks = {
    artifactParity: 'passed',
    migrationStartup: 'passed',
    authenticatedSmoke: 'passed',
    databaseIntegrity: 'passed',
    prePromotionBackup: value.role === 'production' ? 'passed' : 'skipped',
    // Not applicable and passed are not interchangeable. Only a declared first
    // install may report the former, and it may never report the latter.
    rollbackReadiness: firstInstall ? 'not_applicable' : 'passed',
  };
  if (!value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)
      || JSON.stringify(Object.keys(value.checks).sort())
        !== JSON.stringify(Object.keys(expectedChecks).sort())
      || Object.entries(expectedChecks)
        .some(([name, status]) => value.checks[name] !== status)) {
    fail('lean release transaction checks are incomplete');
  }
  return value;
}

function verifyCachedManifest() {
  const cachedPath = valueOf('--manifest');
  const downloadedPath = valueOf('--downloaded-manifest');
  const expectedManifestDigest = validDigest(
    valueOf('--expect-manifest-sha256'),
    'expected manifest digest',
  );
  const cachedBytes = readRegularBytes(cachedPath, 'cached release checksum manifest');
  const downloadedBytes = readRegularBytes(
    downloadedPath,
    're-downloaded release checksum manifest',
  );
  if (sha256(cachedBytes) !== expectedManifestDigest) {
    fail('cached release checksum manifest digest drifted from prepared state');
  }
  if (sha256(downloadedBytes) !== expectedManifestDigest
      || !cachedBytes.equals(downloadedBytes)) {
    fail('re-downloaded release checksum manifest does not exactly match prepared state');
  }
  const options = {
    expectedSha: valueOf('--expect-source-sha'),
    expectedArtifactDigest: valueOf('--expect-artifact-digest'),
  };
  const cached = validateManifest(JSON.parse(cachedBytes.toString('utf8')), options);
  validateManifest(JSON.parse(downloadedBytes.toString('utf8')), options);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceSha: cached.sourceSha,
    artifact: cached.artifact,
    manifestSha256: expectedManifestDigest,
    releaseImpact: cached.releaseImpact,
  })}\n`);
}

function runChatEvalPreflight() {
  const manifestBytes = readRegularBytes(
    valueOf('--manifest'),
    'release checksum manifest',
  );
  const expectedManifestDigest = valueOf('--expect-manifest-sha256');
  if (expectedManifestDigest
      && sha256(manifestBytes) !== validDigest(
        expectedManifestDigest,
        'expected manifest digest',
      )) {
    fail('release checksum manifest digest mismatch');
  }
  const manifest = validateManifest(
    JSON.parse(manifestBytes.toString('utf8')),
    {
      expectedSha: valueOf('--expect-source-sha'),
      expectedArtifactDigest: valueOf('--expect-artifact-digest'),
    },
  );
  const required = manifest.releaseImpact.groups.includes('chat-secretary');
  if (!required) {
    process.stderr.write(
      'chat-eval gate: cumulative release impact does not include chat-secretary; '
      + 'exact-SHA evaluation is not required\n',
    );
    process.stdout.write(`${JSON.stringify({
      ok: true,
      sourceSha: manifest.sourceSha,
      artifact: manifest.artifact,
      releaseImpact: manifest.releaseImpact,
      chatEvaluation: { required: false, status: 'skipped' },
    })}\n`);
    return;
  }

  const databasePath = path.resolve(
    process.env.CHAT_EVAL_DB_PATH
      || path.join(repositoryRoot, 'reports/chat-eval/chat-eval-history.sqlite'),
  );
  if (!fs.existsSync(databasePath)) {
    fail(
      `chat-eval gate: no chat-eval history database at ${databasePath}. `
      + 'The gate reads CHAT_EVAL_DB_PATH '
      + '(default reports/chat-eval/chat-eval-history.sqlite); '
      + 'scripts/chat-eval-local.sh may have persisted to a different, '
      + '.env.local-configured CHAT_EVAL_DB_PATH (split-brain). Align '
      + 'CHAT_EVAL_DB_PATH for both, then run scripts/chat-eval-local.sh first',
    );
  }

  const { DatabaseSync } = require('node:sqlite');
  let database;
  let row;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    row = database.prepare(
      'SELECT id, run_id, passed, git_commit, generated_at, created_at '
      + 'FROM chat_eval_runs WHERE mode = ? AND git_commit = ? '
      + 'ORDER BY created_at DESC, id DESC LIMIT 1',
    ).get('local_engine', manifest.sourceSha);
  } catch (error) {
    fail(
      `chat-eval gate: unable to read chat-eval history (${error.message}); `
      + 'rerun scripts/chat-eval-local.sh',
    );
  } finally {
    database?.close();
  }
  if (!row) {
    fail(
      `chat-eval gate: no local_engine chat-eval run recorded for exact SHA `
      + `${manifest.sourceSha}; run scripts/chat-eval-local.sh first`,
    );
  }
  if (Number(row.passed) !== 1) {
    fail(
      `chat-eval gate: latest local_engine run ${row.run_id} (${row.created_at}) `
      + 'FAILED; fix chat quality or rerun scripts/chat-eval-local.sh',
    );
  }
  const recordedCommit = typeof row.git_commit === 'string' ? row.git_commit.trim() : '';
  if (recordedCommit !== manifest.sourceSha) {
    fail(
      `chat-eval gate: chat-eval run ${row.run_id} is not bound to the exact `
      + `target SHA ${manifest.sourceSha}; rerun scripts/chat-eval-local.sh`,
    );
  }
  process.stderr.write(
    `chat-eval gate: latest local_engine run ${row.run_id} passed `
    + `(${row.created_at}, commit ${recordedCommit})\n`,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceSha: manifest.sourceSha,
    artifact: manifest.artifact,
    releaseImpact: manifest.releaseImpact,
    chatEvaluation: {
      required: true,
      status: 'passed',
      runId: row.run_id,
      createdAt: row.created_at,
    },
  })}\n`);
}

function writeManifest() {
  const bundle = path.resolve(valueOf('--bundle'));
  const verified = verifyReleaseBundle(bundle, validSha(valueOf('--source-sha'), 'source SHA'));
  const releaseDeployedSha = validSha(
    valueOf('--release-deployed-sha'),
    'release-impact deployed SHA',
  );
  if (releaseDeployedSha !== canonicalDeployedSha()) {
    fail('release-impact deployed SHA does not match canonical protected release state');
  }
  let releaseGroups;
  try {
    releaseGroups = JSON.parse(valueOf('--release-groups-json'));
  } catch {
    fail('cumulative release groups must be valid JSON');
  }
  if (!Array.isArray(releaseGroups)) {
    fail('cumulative release groups must be a JSON array');
  }
  const normalizedReleaseGroups = [...new Set(releaseGroups)].sort();
  if (releaseGroups.some((group) => typeof group !== 'string')
      || JSON.stringify(releaseGroups) !== JSON.stringify(normalizedReleaseGroups)) {
    fail('cumulative release groups must be sorted, unique group names');
  }
  const selectionPath = valueOf('--selection');
  const selection = readJson(selectionPath, 'protected-main test selection');
  const policyFile = path.resolve(valueOf('--policy-file'));
  const policyDigest = sha256(fs.readFileSync(policyFile));
  if (selection.policyDigest !== policyDigest) {
    fail('protected-main test selection policy digest does not match the checkpoint policy');
  }
  const selectedGroups = normalizeGroups(selection);
  const partition = buildReleaseTestPartition(selection);
  const selectedSummary = selectedTestSummary(selection, valueOf('--selected-result'));

  const shardDir = path.resolve(valueOf('--shard-results'));
  const shardSummaries = [1, 2, 3, 4].map((shard) => shardSummary(
    path.join(shardDir, `vitest-results-${shard}.json`),
    shard,
  ));
  const shardFiles = verifyReleaseTestResults({
    partition,
    selectedReport: selectedSummary.report,
    shardReports: shardSummaries.map((entry) => entry.report),
  });
  const shards = shardSummaries.map((entry, index) => ({
    ...entry.manifest,
    files: shardFiles[index].length,
    inventorySha256: testInventoryDigest(shardFiles[index]),
  }));
  const partitionProof = {
    ...partition.proof,
    proofSha256: sha256(JSON.stringify({
      deterministic: partition.proof.deterministic,
      selected: partition.proof.selected,
      remaining: partition.proof.remaining,
    })),
  };
  const selectedTests = {
    ...selectedSummary.manifest,
    files: partition.proof.selected.files,
    inventorySha256: partition.proof.selected.sha256,
  };
  const pythonRequired = valueOf('--python-required') === 'true';
  const pythonStatus = valueOf('--python-status');
  const migrationRequired = valueOf('--migration-required') === 'true';
  const migrationStatus = valueOf('--migration-status');
  let migrationApprovalRequired = false;
  let governanceReviewRequired = false;
  let reviewSubject = null;
  let governanceReviewSubject = null;
  if (migrationRequired) {
    if (migrationStatus !== 'passed') fail('required migration safety result did not pass');
    const migration = readJson(valueOf('--migration-result'), 'migration result');
    if (migration.ok !== true) fail('migration safety result did not pass');
    reviewSubject = migration.requiredReviewSubject?.sha256 ?? null;
    migrationApprovalRequired = migration.authorization?.approvalRequired === true;
    governanceReviewRequired = migration.authorization?.governanceReviewRequired === true;
    const supplied = valueOf('--migration-review-sha256');
    if (migrationApprovalRequired || governanceReviewRequired) {
      if (supplied !== reviewSubject) {
        fail('migration review subject was not explicitly approved');
      }
      if (governanceReviewRequired) governanceReviewSubject = reviewSubject;
      if (!migrationApprovalRequired) reviewSubject = null;
    } else if (reviewSubject !== null || supplied) {
      fail('compatible migration result unexpectedly supplied review evidence');
    }
  } else if (migrationStatus !== 'skipped'
      || valueOf('--migration-result')
      || valueOf('--migration-review-sha256')) {
    fail('non-applicable migration safety must be explicitly skipped without evidence');
  }
  const marker = verified.marker;
  const manifest = {
    schema: RELEASE_CHECKSUM_MANIFEST_SCHEMA,
    sourceSha: marker.runtimeSha,
    version: marker.packageVersion,
    createdAt: new Date().toISOString(),
    artifact: {
      name: valueOf('--artifact-name'),
      sha256: verified.digest,
    },
    protectedMain: {
      workflow: 'ci.yml',
      runId: positiveInteger(valueOf('--protected-run-id'), 'protected-main run ID'),
      runAttempt: positiveInteger(valueOf('--protected-run-attempt'), 'protected-main run attempt'),
      docsOnly: selection.docsOnly,
      selectedTests,
    },
    releaseCheckpoint: {
      workflow: 'release-candidate-evidence.yml',
      runId: positiveInteger(valueOf('--checkpoint-run-id'), 'release-checkpoint run ID'),
      runAttempt: positiveInteger(valueOf('--checkpoint-run-attempt'), 'release-checkpoint run attempt'),
    },
    releaseImpact: {
      deployedSha: releaseDeployedSha,
      groups: releaseGroups,
    },
    testPolicySha256: policyDigest,
    selectedGroups,
    fullSuite: {
      status: 'passed',
      execution: 'protected-main-selection-plus-checkpoint-remainder',
      tests: selectedTests.tests + shards.reduce((sum, entry) => sum + entry.tests, 0),
      files: partition.proof.deterministic.files,
      inventorySha256: partition.proof.deterministic.sha256,
      partition: partitionProof,
      shards,
    },
    python: {
      required: pythonRequired,
      status: pythonStatus,
    },
    migrations: {
      required: migrationRequired,
      status: migrationStatus,
      approvalRequired: migrationApprovalRequired,
      governanceReviewRequired,
      reviewSubjectSha256: reviewSubject,
      governanceReviewSubjectSha256: governanceReviewSubject,
    },
  };
  validateManifest(manifest, { bundle });
  const output = path.resolve(valueOf('--output'));
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, manifest: output, artifact: manifest.artifact })}\n`);
}

if (command === 'write') {
  writeManifest();
} else if (command === 'verify-cache') {
  verifyCachedManifest();
} else if (command === 'preflight-chat') {
  runChatEvalPreflight();
} else if (command === 'validate') {
  const filename = path.resolve(valueOf('--manifest'));
  const manifest = readJson(filename, 'release checksum manifest');
  validateManifest(manifest, {
    bundle: valueOf('--bundle'),
    expectedSha: valueOf('--expect-source-sha'),
    expectedArtifactDigest: valueOf('--expect-artifact-digest'),
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sourceSha: manifest.sourceSha,
    version: manifest.version,
    artifact: manifest.artifact,
    releaseImpact: manifest.releaseImpact,
  })}\n`);
} else if (command === 'validate-state') {
  const manifest = validateManifest(
    readJson(valueOf('--manifest'), 'release checksum manifest'),
  );
  const role = valueOf('--role');
  const transaction = validateTransaction(
    readJson(valueOf('--state'), 'lean release transaction state'),
    manifest,
    role,
    // The promotion gate additionally requires a receipt with real predecessor
    // lineage, which a first-install bootstrap receipt does not have.
    { requirePromotable: hasFlag('--require-promotable') },
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    role: transaction.role,
    firstInstall: transaction.firstInstall === true,
    sourceSha: transaction.runtimeSha,
    artifactDigest: transaction.artifactDigest,
    transactionId: transaction.transactionId,
  })}\n`);
} else {
  fail(`unsupported release checksum manifest command: ${command}`);
}
