#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import path from 'node:path';
import {
  validateProductionShapeMigrationRehearsalEvidence,
} from './lib/production-shape-migration-rehearsal-evidence.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? '' : args[index + 1] || '';
};

const result = validateProductionShapeMigrationRehearsalEvidence({
  root: path.resolve(value('--root') || process.cwd()),
  input: value('--evidence'),
  expectedPredecessorRuntimeSha: value('--predecessor-runtime-sha'),
  expectedTargetRuntimeSha: value('--target-runtime-sha'),
  expectedTargetVersion: value('--target-version'),
  expectedArtifactDigest: value('--artifact-digest'),
  expectedReviewEvidenceSha256: value('--review-evidence-sha256'),
  expectedMigrationPolicySubjectSha256: value('--migration-policy-subject-sha256'),
  expectedPromotionRunId: value('--promotion-run-id'),
  expectedPhase: value('--phase'),
  expectedDatabaseOwnerState: value('--database-owner-state'),
});

if (!result.valid) {
  process.stderr.write(`production_shape_migration_rehearsal_evidence_invalid:${result.reason}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({
  ok: true,
  schema: result.parsed.schema,
  evidenceSha256: result.sha256,
  cloneSha256: result.parsed.clone.sourceSha256,
  migratedCloneSha256: result.parsed.clone.migratedSha256,
  pendingMigrationSetSha256: result.parsed.candidate.pendingMigrationSetSha256,
  sourceDatabaseSha256: result.parsed.source.databaseSha256,
})}\n`);
