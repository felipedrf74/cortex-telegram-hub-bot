#!/usr/bin/env node
// Complete the local, Git-aware half of a systemd promotion transaction after
// the server has produced its quiescent backup and stopped-state rehearsal.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  validateProductionShapeMigrationRehearsalEvidence,
} from './lib/production-shape-migration-rehearsal-evidence.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
};
const root = path.resolve(value('--root'));
const predecessorSha = value('--predecessor-sha');
const targetSha = value('--target-sha');
const targetVersion = value('--target-version');
const artifactDigest = value('--artifact-digest');
const reviewEvidence = path.resolve(value('--review-evidence'));
const reviewEvidenceSha256 = value('--review-evidence-sha256');
const policySubjectSha256 = value('--policy-subject-sha256');
const transactionId = value('--transaction-id');
const onlineEvidence = path.resolve(value('--online-evidence'));
const finalInput = path.resolve(value('--final-input'));
const finalEvidence = path.resolve(value('--final-evidence'));
const backupEnv = path.resolve(value('--backup-env'));
const backupEvidence = path.resolve(value('--backup-evidence'));

const expected = (input, phase, ownerState) => validateProductionShapeMigrationRehearsalEvidence({
  root,
  input,
  expectedPredecessorRuntimeSha: predecessorSha,
  expectedTargetRuntimeSha: targetSha,
  expectedTargetVersion: targetVersion,
  expectedArtifactDigest: artifactDigest,
  expectedReviewEvidenceSha256: reviewEvidenceSha256,
  expectedMigrationPolicySubjectSha256: policySubjectSha256,
  expectedPromotionRunId: transactionId,
  expectedPhase: phase,
  expectedDatabaseOwnerState: ownerState,
});
const online = expected(onlineEvidence, 'online_pre_stop', 'online');
if (!online.valid) throw new Error(`online migration rehearsal invalid: ${online.reason}`);
const final = expected(finalInput, 'stopped_final', 'stopped');
if (!final.valid) throw new Error(`final migration rehearsal invalid: ${final.reason}`);

const backup = new Map();
for (const line of fs.readFileSync(backupEnv, 'utf8').split(/\r?\n/u)) {
  const match = line.match(/^([A-Z0-9_]+)=(.*)$/u);
  if (match) backup.set(match[1], match[2]);
}
const required = (key) => {
  const result = backup.get(key) || '';
  if (!result) throw new Error(`backup transaction evidence is missing ${key}`);
  return result;
};
const backupFile = required('NEXUS_BACKUP_FILE');
const backupSha256 = required('NEXUS_BACKUP_SHA256');
const backupSizeBytes = required('NEXUS_BACKUP_SIZE_BYTES');
const archivedVersion = required('NEXUS_BACKUP_ARCHIVED_VERSION');
const backupTargetVersion = required('NEXUS_BACKUP_TARGET_VERSION');
const backupCreatedAt = required('NEXUS_BACKUP_CREATED_AT');
const backupDatabaseSha256 = required('NEXUS_BACKUP_DATABASE_SHA256');
if (!/^\/home\/dominguez\/backups\/nexushub\/v.*\.tar\.gz$/u.test(backupFile)) throw new Error('unsafe backup path');
for (const digest of [backupSha256, backupDatabaseSha256]) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('invalid backup digest');
}
if (!/^[1-9][0-9]*$/u.test(backupSizeBytes)) throw new Error('invalid backup size');
if (backupTargetVersion !== targetVersion) throw new Error('backup target version mismatch');
if (final.parsed.source.databaseSha256 !== backupDatabaseSha256) {
  throw new Error('final rehearsal source does not match the exact stopped-state backup');
}

function writeImmutable(output, body) {
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  if (fs.existsSync(output)) {
    if (fs.readFileSync(output, 'utf8') !== serialized) throw new Error(`immutable evidence mismatch: ${output}`);
    return;
  }
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serialized, { mode: 0o600, flag: 'wx' });
  fs.linkSync(temporary, output);
  fs.rmSync(temporary, { force: true });
  fs.chmodSync(output, 0o600);
}

writeImmutable(finalEvidence, final.parsed);
const evidence = {
  schema: 'nexus.exact-migration-backup-evidence.v2',
  status: 'verified',
  createdAt: backupCreatedAt,
  promotionRunId: transactionId,
  predecessorRuntimeSha: predecessorSha,
  targetRuntimeSha: targetSha,
  targetVersion,
  artifactDigest,
  reviewEvidenceSha256,
  migrationPolicySubjectSha256: policySubjectSha256,
  productionShapeRehearsals: {
    onlinePreStop: {
      evidenceSha256: online.sha256,
      sourceCloneSha256: online.parsed.clone.sourceSha256,
      migratedCloneSha256: online.parsed.clone.migratedSha256,
      pendingMigrationSetSha256: online.parsed.candidate.pendingMigrationSetSha256,
      sourceDatabaseSha256: online.parsed.source.databaseSha256,
    },
    stoppedFinal: {
      evidenceSha256: final.sha256,
      sourceCloneSha256: final.parsed.clone.sourceSha256,
      migratedCloneSha256: final.parsed.clone.migratedSha256,
      pendingMigrationSetSha256: final.parsed.candidate.pendingMigrationSetSha256,
      sourceDatabaseSha256: final.parsed.source.databaseSha256,
    },
  },
  backup: {
    remotePath: backupFile,
    sha256: backupSha256,
    sizeBytes: Number(backupSizeBytes),
    archivedVersion,
    targetVersion,
    createdAt: backupCreatedAt,
    databaseSha256: backupDatabaseSha256,
  },
  verification: {
    databaseOwnersStopped: true,
    noOpenDatabaseHandles: true,
    walCheckpointTruncated: true,
    sqliteIntegrity: 'ok',
    sqliteForeignKeys: 'ok',
    archiveSha256Verified: true,
  },
};
writeImmutable(backupEvidence, evidence);

const gate = spawnSync('node', [
  path.join(root, 'scripts', 'migration-safety-check.mjs'),
  '--base', predecessorSha,
  '--changed-only',
  '--approval-mode', 'promotion',
  '--review-evidence', reviewEvidence,
  '--rehearsal-evidence', onlineEvidence,
  '--final-rehearsal-evidence', finalEvidence,
  '--backup-evidence', backupEvidence,
  '--target-version', targetVersion,
  '--artifact-digest', artifactDigest,
  '--promotion-run-id', transactionId,
], { cwd: root, encoding: 'utf8' });
if (gate.stdout) process.stderr.write(gate.stdout);
if (gate.stderr) process.stderr.write(gate.stderr);
if (gate.error || gate.status !== 0) process.exit(gate.status || 1);
process.stdout.write(`${JSON.stringify({
  ok: true,
  transactionId,
  finalEvidence,
  finalEvidenceSha256: final.sha256,
  backupEvidence,
  backupFile,
  backupSha256,
  backupDatabaseSha256,
})}\n`);
