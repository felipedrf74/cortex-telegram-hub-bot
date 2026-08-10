#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertOwnerExpectedBootstrapTarget,
  createReleaseBootstrapBaseline,
  resolveReleaseBootstrapBaselineOutputPolicy,
  writeReleaseBootstrapBaseline,
} from './lib/release-bootstrap.mjs';
import {
  loadContinuousDeploymentPolicy,
  parseReleaseManifestBytes,
  verifyComposeBytes,
  verifyReleaseManifest,
} from './lib/release-manifest.mjs';
import { createReleaseRegistry } from './lib/release-registry.mjs';

const args = process.argv.slice(2);
function arg(name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

const allowed = new Set([
  '--accept-current-history-as-baseline',
  '--expected-release-id',
  '--expected-release-payload-digest',
  '--output-candidate',
  '--production-source-sha',
  '--staging-source-sha',
]);
for (let index = 0; index < args.length; index += 1) {
  const value = args[index];
  if (!allowed.has(value)) {
    process.stderr.write(`unknown bootstrap-baseline argument: ${value}\n`);
    process.exit(64);
  }
  if (!['--accept-current-history-as-baseline', '--output-candidate'].includes(value)) {
    index += 1;
  }
}
if (!args.includes('--accept-current-history-as-baseline')) {
  process.stderr.write(
    'refusing to create a legacy migration baseline without '
      + '--accept-current-history-as-baseline\n',
  );
  process.exit(64);
}

const productionSourceSha = arg('--production-source-sha');
const stagingSourceSha = arg('--staging-source-sha');
const expectedReleaseId = arg('--expected-release-id');
const expectedReleasePayloadDigest = arg('--expected-release-payload-digest');
if (!productionSourceSha || !stagingSourceSha
    || !expectedReleaseId || !expectedReleasePayloadDigest) {
  process.stderr.write(
    '--production-source-sha, --staging-source-sha, --expected-release-id, '
      + 'and --expected-release-payload-digest are required\n',
  );
  process.exit(64);
}
assertOwnerExpectedBootstrapTarget({
  expectedReleaseId,
  expectedReleasePayloadDigest,
  observedReleaseId: expectedReleaseId,
  observedReleasePayloadDigest: expectedReleasePayloadDigest,
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const outputPolicy = resolveReleaseBootstrapBaselineOutputPolicy({
  policy,
  expectedReleaseId,
  candidate: args.includes('--output-candidate'),
});
const registry = createReleaseRegistry({ policy });
const releaseRef = `${policy.registry.releaseImage}:${policy.registry.releaseTag}`;
registry.pull(releaseRef);
const releasePayloadDigest = registry.resolveDigest(releaseRef);
if (releasePayloadDigest !== expectedReleasePayloadDigest) {
  process.stderr.write(
    'resolved bootstrap target does not match owner-expected release payload digest\n',
  );
  process.exit(65);
}
const pinnedReleaseRef = `${policy.registry.releaseImage}@${releasePayloadDigest}`;
const targetDir = path.join(
  policy.paths.workDir,
  `bootstrap-target-${releasePayloadDigest.replace('sha256:', '')}`,
);
const extracted = registry.extractReleasePayload({
  reference: pinnedReleaseRef,
  destinationDir: targetDir,
});
const envelope = parseReleaseManifestBytes({ bytes: extracted.manifestBytes, policy });
const verified = verifyReleaseManifest({ envelope, policy, nowMs: Date.now() });
verifyComposeBytes({ payload: verified.payload, bytes: extracted.composeBytes, policy });
assertOwnerExpectedBootstrapTarget({
  expectedReleaseId,
  expectedReleasePayloadDigest,
  observedReleaseId: verified.releaseId,
  observedReleasePayloadDigest: releasePayloadDigest,
});
const target = {
  releaseId: verified.releaseId,
  sourceSha: verified.payload.source.sha,
  releasePayloadDigest,
  manifestDigest: verified.manifestDigest,
};
const baseline = createReleaseBootstrapBaseline({
  policy,
  root,
  manifestPayload: verified.payload,
  productionSourceSha,
  stagingSourceSha,
  target,
});
let publishedBaseline = baseline;
let publication;
const output = writeReleaseBootstrapBaseline({
  policy: outputPolicy,
  baseline,
  candidateOutput: args.includes('--output-candidate'),
  onPublication: ({ baseline: effectiveBaseline, ...report }) => {
    publishedBaseline = effectiveBaseline;
    publication = report;
  },
});
process.stdout.write(`${JSON.stringify({
  schema: 'nexus.release-bootstrap-baseline-result.v1',
  output,
  publication,
  createdAt: publishedBaseline.createdAt,
  migrationInventoryDigest: publishedBaseline.migrationInventoryDigest,
  migrationReconciliationDigest: publishedBaseline.migrationReconciliationDigest,
  target: publishedBaseline.target,
  productionSchemaDigest: publishedBaseline.databases.production.schemaDigest,
  stagingSchemaDigest: publishedBaseline.databases.staging.schemaDigest,
  convergedSchemaDigest: publishedBaseline.schemaProof.convergedSchemaDigest,
  preservedStagingFixture: publishedBaseline.schemaProof.staging.preservedFixture,
})}\n`);
