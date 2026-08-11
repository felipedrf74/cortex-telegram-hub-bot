#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { canonicalJson, sha256 } from './lib/release-canonical.mjs';
import { computeReleaseControlPlaneIdentity } from './lib/release-control-plane.mjs';
import {
  buildReleaseManifestPayload,
  loadContinuousDeploymentPolicy,
  migrationVerdictDigest,
  signReleaseManifest,
  verifyReleaseManifest,
} from './lib/release-manifest.mjs';
import {
  RELEASE_MANIFEST_VERIFICATION_MODES,
  loadReleaseManifestSchemaPolicy,
} from './lib/release-manifest-schema-policy.mjs';

/**
 * Verify migration evidence or build and sign the release manifest in CI.
 *
 * This command has two deliberately separate modes. The first runs before image
 * publication with no signing key: it recomputes the complete migration verdict,
 * compares the CI artifact, and writes a hosted result plus its byte digest. The
 * second runs later with the signing key and accepts only that digest-bound hosted
 * result; it never reads the selectable runner's artifact or executes the
 * migration checker.
 *
 * The signing key arrives through the environment, never argv, so it cannot land
 * in a process listing or a CI log line.
 *
 * Verification usage (secretless):
 *   node scripts/release-manifest-build.mjs \
 *     --migration-result <path to migration-safety-check --json output> \
 *     --migration-base <full push-before SHA> \
 *     --verify-migration-only <path to hosted result>
 *
 * Signing usage:
 *   node scripts/release-manifest-build.mjs \
 *     --backend-digest sha256:... \
 *     --content-engine-digest sha256:... \
 *     --migration-base <full push-before SHA> \
 *     --hosted-migration-result <path to hosted result> \
 *     --hosted-migration-digest <digest emitted by verification> \
 *     --output <path to release-manifest.json>
 */

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(arg('--root', codeRoot));
const policy = loadContinuousDeploymentPolicy(root);

const backendDigest = arg('--backend-digest');
const contentEngineDigest = arg('--content-engine-digest');
const migrationResultPath = arg('--migration-result');
const migrationBase = arg('--migration-base');
const hostedMigrationResultPath = arg('--hosted-migration-result');
const hostedMigrationExpectedDigest = arg('--hosted-migration-digest');
const verifyMigrationOnlyOutput = arg('--verify-migration-only');
const outputPath = arg('--output', '.local/release/release-manifest.json');
const createdAt = arg('--created-at', new Date().toISOString());
const verifyMigrationOnly = Boolean(verifyMigrationOnlyOutput);

if (!migrationBase) {
  process.stderr.write('--migration-base is required\n');
  process.exit(64);
}
if (verifyMigrationOnly) {
  if (!migrationResultPath) {
    process.stderr.write('--migration-result is required in verification mode\n');
    process.exit(64);
  }
  if (hostedMigrationResultPath || hostedMigrationExpectedDigest) {
    process.stderr.write('hosted migration result flags are not accepted in verification mode\n');
    process.exit(64);
  }
  if (process.env.NEXUS_RELEASE_MANIFEST_SIGNING_KEY) {
    process.stderr.write('verification mode must not receive the release manifest signing key\n');
    process.exit(64);
  }
} else {
  for (const [flag, value] of [
    ['--backend-digest', backendDigest],
    ['--content-engine-digest', contentEngineDigest],
    ['--hosted-migration-result', hostedMigrationResultPath],
  ]) {
    if (!value) {
      process.stderr.write(`${flag} is required\n`);
      process.exit(64);
    }
  }
  if (migrationResultPath) {
    process.stderr.write('--migration-result is accepted only in secretless verification mode\n');
    process.exit(64);
  }
  if (!/^[0-9a-f]{64}$/.test(hostedMigrationExpectedDigest)) {
    process.stderr.write('--hosted-migration-digest must be a lowercase hex SHA-256\n');
    process.exit(64);
  }
}
if (!/^[0-9a-f]{40}$/.test(migrationBase)) {
  process.stderr.write('--migration-base must be a full lowercase git commit SHA\n');
  process.exit(64);
}

// The manifest asserts a repository identity the poller checks, so a build in a
// fork or a renamed repository must fail here rather than produce a manifest the
// host will silently refuse.
const actualRepository = process.env.GITHUB_REPOSITORY || policy.trust.repository;
if (actualRepository !== policy.trust.repository) {
  process.stderr.write(
    `refusing to sign: GITHUB_REPOSITORY ${actualRepository} is not the governed `
    + `repository ${policy.trust.repository}\n`,
  );
  process.exit(66);
}

const migrationsDir = path.join(root, 'migrations');
// The CI artifact is produced by the selected test runner, which may be the Pi.
// It is evidence, not a trust anchor. Re-run the complete changed-scope safety
// gate from the exact hosted checkout and the comparison base derived from
// GitHub's check-suite event. The child does not inherit the signing secret.
// Canonical equality covers every deterministic field (including append-only
// history, governance findings, changed files, eligibility, and inventory),
// not just the per-file inventory.
let hostedMigrationResult;
if (!verifyMigrationOnly) {
  let hostedBytes;
  try {
    hostedBytes = fs.readFileSync(hostedMigrationResultPath);
  } catch {
    process.stderr.write('refusing to sign: hosted migration verdict is unreadable\n');
    process.exit(65);
  }
  if (sha256(hostedBytes) !== hostedMigrationExpectedDigest) {
    process.stderr.write('refusing to sign: hosted migration verdict digest changed\n');
    process.exit(65);
  }
  try {
    hostedMigrationResult = JSON.parse(hostedBytes.toString('utf8'));
  } catch {
    hostedMigrationResult = null;
  }
} else {
  let migrationResult;
  try {
    migrationResult = JSON.parse(fs.readFileSync(migrationResultPath, 'utf8'));
  } catch {
    process.stderr.write('migration result is unreadable or not valid JSON\n');
    process.exit(65);
  }
  if (migrationResult.ok !== true) {
    process.stderr.write('migration result does not carry a passing safety verdict\n');
    process.exit(65);
  }
  if (!migrationResult.cdEligibility) {
    process.stderr.write('migration result does not carry a cdEligibility verdict\n');
    process.exit(65);
  }
  if (!Array.isArray(migrationResult.migrationInventory)
      || migrationResult.migrationInventory.length === 0) {
    process.stderr.write('migration result does not carry a migration inventory\n');
    process.exit(65);
  }
  if (!migrationResult.migrationReconciliation) {
    process.stderr.write('migration result does not carry release migration reconciliation\n');
    process.exit(65);
  }

  const hostedEnvironment = { ...process.env };
  for (const name of [
    'NEXUS_RELEASE_MANIFEST_SIGNING_KEY',
    'NEXUS_MIGRATION_REVIEW_EVIDENCE',
    'NEXUS_MIGRATION_BACKUP_EVIDENCE',
    'NEXUS_MIGRATION_REHEARSAL_EVIDENCE',
    'NEXUS_MIGRATION_FINAL_REHEARSAL_EVIDENCE',
  ]) delete hostedEnvironment[name];
  const hostedRun = spawnSync(process.execPath, [
    path.join(codeRoot, 'scripts/migration-safety-check.mjs'),
    '--root', root,
    '--base', migrationBase,
    '--changed-only',
    '--approval-mode', 'scan',
    '--emit-inventory',
    '--json',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: hostedEnvironment,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  });
  try {
    hostedMigrationResult = JSON.parse(hostedRun.stdout || '');
  } catch {
    hostedMigrationResult = null;
  }
  if (hostedRun.error || hostedRun.status !== 0 || hostedMigrationResult?.ok !== true) {
    const reasons = Array.isArray(hostedMigrationResult?.errors)
      ? hostedMigrationResult.errors.slice(0, 8).join(', ')
      : 'migration safety process failed';
    process.stderr.write(
      `refusing to sign: hosted migration verdict did not pass (${reasons})\n`,
    );
    process.exit(65);
  }

  function deterministicVerdict(result) {
    const { generatedAt: _generatedAt, ...verdict } = result;
    return verdict;
  }

  if (canonicalJson(deterministicVerdict(migrationResult))
      !== canonicalJson(deterministicVerdict(hostedMigrationResult))) {
    process.stderr.write(
      'refusing to sign: CI migration verdict does not match the hosted checkout recomputation\n',
    );
    process.exit(65);
  }
}

if (hostedMigrationResult?.ok !== true) {
  const reasons = Array.isArray(hostedMigrationResult?.errors)
    ? hostedMigrationResult.errors.slice(0, 8).join(', ')
    : 'migration safety process failed';
  process.stderr.write(
    `refusing to sign: hosted migration verdict did not pass (${reasons})\n`,
  );
  process.exit(65);
}
if (hostedMigrationResult.comparisonBase !== migrationBase) {
  process.stderr.write(
    'refusing to sign: hosted migration verdict resolved a different comparison base\n',
  );
  process.exit(65);
}
if (!hostedMigrationResult.cdEligibility
    || !Array.isArray(hostedMigrationResult.migrationInventory)
    || hostedMigrationResult.migrationInventory.length === 0
    || !hostedMigrationResult.migrationReconciliation) {
  process.stderr.write('refusing to sign: hosted migration verdict is incomplete\n');
  process.exit(65);
}

if (verifyMigrationOnly) {
  const verifiedBytes = Buffer.from(`${JSON.stringify(hostedMigrationResult, null, 2)}\n`);
  fs.mkdirSync(path.dirname(verifyMigrationOnlyOutput), { recursive: true, mode: 0o700 });
  fs.writeFileSync(verifyMigrationOnlyOutput, verifiedBytes, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-hosted-migration-verification.v1',
    output: verifyMigrationOnlyOutput,
    digest: sha256(verifiedBytes),
    cdEligible: hostedMigrationResult.cdEligibility.eligible,
  })}\n`);
  process.exit(0);
}

// From this point on, the self-hosted artifact is deliberately out of scope.
// Only the hosted recomputation can influence signed manifest fields.
const schemaPolicy = loadReleaseManifestSchemaPolicy(root);
const trustedMigrationResult = hostedMigrationResult;
const hostedMigrationInventory = trustedMigrationResult.migrationInventory;

const signingKey = process.env.NEXUS_RELEASE_MANIFEST_SIGNING_KEY || '';
if (!signingKey) {
  process.stderr.write('NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required to sign a release manifest\n');
  process.exit(64);
}

const upFileCount = fs.readdirSync(migrationsDir)
  .filter((file) => /^\d{3}_.*\.sql$/.test(file)).length;
const downFileCount = fs.existsSync(path.join(migrationsDir, 'down'))
  ? fs.readdirSync(path.join(migrationsDir, 'down')).filter((file) => file.endsWith('.sql')).length
  : 0;

const composePath = path.join(root, policy.compose.file);
const composeDigest = sha256(fs.readFileSync(composePath));

// Computed from exactly the fields the manifest carries, so the deployment host
// recomputes and verifies the same value instead of trusting it blindly.
const migrationDigest = migrationVerdictDigest(
  trustedMigrationResult.cdEligibility,
  hostedMigrationInventory,
  trustedMigrationResult.migrationReconciliation,
);
let controlPlane;
try {
  controlPlane = computeReleaseControlPlaneIdentity(root);
} catch (error) {
  process.stderr.write(
    'refusing to sign: governed release control-plane identity could not be computed: '
    + `${error instanceof Error ? error.message : 'unknown error'}\n`,
  );
  process.exit(65);
}

const payload = buildReleaseManifestPayload({
  createdAt,
  source: {
    repository: process.env.GITHUB_REPOSITORY || policy.trust.repository,
    ref: process.env.GITHUB_REF || policy.trust.protectedRef,
    sha: process.env.GITHUB_SHA || '',
    workflow: process.env.GITHUB_WORKFLOW || policy.trust.workflow,
    runId: process.env.GITHUB_RUN_ID || '',
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || '',
  },
  images: {
    backend: { repository: policy.registry.backendImage, digest: backendDigest },
    contentEngine: { repository: policy.registry.contentEngineImage, digest: contentEngineDigest },
  },
  compose: { path: policy.compose.file, digest: composeDigest },
  controlPlane,
  migrations: {
    digest: migrationDigest,
    upFileCount,
    downFileCount,
    cdEligibility: {
      eligible: trustedMigrationResult.cdEligibility.eligible,
      predecessorCompatible: trustedMigrationResult.cdEligibility.predecessorCompatible,
      reasons: trustedMigrationResult.cdEligibility.reasons,
    },
    inventory: hostedMigrationInventory,
    reconciliation: trustedMigrationResult.migrationReconciliation,
  },
  policy,
  schemaPolicy,
});

const envelope = signReleaseManifest({
  payload,
  privateKeyPem: signingKey,
  keyId: policy.trust.signingKeyId,
  policy,
  schemaPolicy,
});

// Verify what we just signed against the governed pinned public key, in CI,
// before publishing. This is a hard gate, not a warning: a manifest the
// deployment host cannot verify halts the pipeline for a reason invisible from
// CI, and a signing key that has drifted from the pin is exactly the case that
// must never reach GHCR. Absent, unreadable, or mismatched all fail here.
const publicKeyPath = arg(
  '--public-key',
  path.join(root, 'docs/release/evidence/release-manifest-public-key.pem'),
);
let pinnedKeyBytes;
try {
  const stat = fs.lstatSync(publicKeyPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error('pinned public key is not a regular non-empty file');
  }
  pinnedKeyBytes = fs.readFileSync(publicKeyPath, 'utf8');
} catch (error) {
  process.stderr.write(
    `pinned release public key ${publicKeyPath} is missing or unreadable: `
    + `${error instanceof Error ? error.message : 'unknown error'}\n`
    + 'Run `npm run release:cd:keygen` and commit the public key before releasing.\n',
  );
  process.exit(66);
}
if (!/-----BEGIN PUBLIC KEY-----/.test(pinnedKeyBytes)) {
  process.stderr.write(`pinned release public key ${publicKeyPath} is not a PEM public key\n`);
  process.exit(66);
}
try {
  verifyReleaseManifest({
    envelope,
    policy,
    schemaPolicy,
    publicKeyPath,
    nowMs: Date.parse(createdAt),
    verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
  });
} catch (error) {
  process.stderr.write(
    'the signed manifest does not verify against the governed pinned public key: '
    + `${error instanceof Error ? error.message : 'unknown error'}\n`
    + 'The signing secret and the committed pin have drifted; refusing to publish.\n',
  );
  process.exit(67);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  schema: 'nexus.release-manifest-build.v1',
  output: outputPath,
  sourceSha: payload.source.sha,
  manifestDigest: sha256(canonicalJson(envelope)),
  controlPlaneDigest: controlPlane.digest,
  composeDigest,
  migrationDigest,
  migrationComparisonBase: trustedMigrationResult.comparisonBase,
  cdEligible: payload.migrations.cdEligibility.eligible,
  upFileCount,
  downFileCount,
  inventoryEntries: payload.migrations.inventory.length,
})}\n`);
