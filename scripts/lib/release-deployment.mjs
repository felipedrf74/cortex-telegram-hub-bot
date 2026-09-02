import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson, fail, sha256 } from './release-canonical.mjs';
import { assertReleaseControlPlaneShape } from './release-control-plane.mjs';
import { assertLockHeld } from './release-lock.mjs';
import {
  parseReleaseManifestBytes,
  releaseIdFor,
  verifyComposeBytes,
  verifyReleaseManifest,
} from './release-manifest.mjs';
import {
  RELEASE_MANIFEST_VERIFICATION_MODES,
} from './release-manifest-schema-policy.mjs';
import {
  BLOCK_REASONS,
  LEGACY_RELEASE_RECEIPT_SCHEMA,
  RELEASE_RECEIPT_SCHEMA,
  RELEASE_STATUSES,
  assertBackupEvidenceShape,
  releaseEvidenceDigest,
  resolveEffectiveRelease,
  sanitizeDetail,
} from './release-state-store.mjs';
import {
  migrationSafetyGovernanceReason,
} from './migration-safety-policy-classifier.mjs';
import { RELEASE_NOTIFICATION_KINDS } from './release-notify.mjs';
import { reconcileMigrationLedger } from './migration-cd-eligibility.mjs';
import {
  releaseMigrationReconciliationDigest,
} from './production-migration-lineage.mjs';
import { PROTECTED_HEAD_RESULTS } from './release-protected-head.mjs';

/**
 * One unattended release attempt.
 *
 * The shape of this function is the safety argument:
 *
 *   discover -> verify -> refuse-or-accept -> stage -> re-check supersession
 *            -> back up -> migrate -> switch production -> observe
 *            -> complete or roll back -> receipt -> mirror -> notify
 *
 * Two orderings are load-bearing and must not be rearranged.
 *
 * 1. **Write-ahead.** `production_observing` is persisted *before* production
 *    containers are switched. If the poller dies during the switch, the state on
 *    disk already admits that production may have been mutated, so recovery
 *    cannot mistake it for "nothing happened".
 * 2. **Backup before migrate before switch.** A rollback restores images, never
 *    a database, so the backup is the only artifact that can undo a migration.
 *    It must therefore exist before any schema change, and a backup failure stops
 *    the release while the predecessor is still the thing serving traffic.
 *
 * Everything external is injected, so every failure branch below — staging
 * failure, observation failure, rollback, rollback failure, invalid signature,
 * ineligible migration, audit-mirror failure — is reachable in tests without a
 * Docker daemon, a registry, or a real 60-second wait.
 */

export const DEPLOYMENT_OUTCOMES = Object.freeze({
  NOOP: 'noop',
  DEFERRED: 'deferred',
  HALTED: 'halted',
  REFUSED: 'refused',
  SUPERSEDED: 'superseded',
  BLOCKED: 'blocked',
  STAGING_FAILED: 'staging_failed',
  COMPLETED: 'completed',
  ROLLED_BACK: 'rolled_back',
  ROLLBACK_FAILED: 'rollback_failed',
});

export const FAILURE_CODES = Object.freeze({
  MIGRATION_NOT_ELIGIBLE: 'migration not cd eligible',
  STAGING_MIGRATOR: 'staging migrator failed',
  STAGING_UNHEALTHY: 'staging unhealthy',
  STAGING_SMOKE: 'staging smoke failed',
  COMPOSE_INVALID: 'compose configuration invalid',
  BACKUP_FAILED: 'pre-migration backup failed',
  PRODUCTION_MIGRATOR: 'production migrator failed',
  PRODUCTION_UNHEALTHY: 'production unhealthy',
  OBSERVATION_FAILED: 'production observation failed',
  PRODUCTION_IDENTITY: 'production containers do not run the signed images',
  NO_PREDECESSOR: 'no predecessor image pair to restore',
  ROLLBACK_UNHEALTHY: 'predecessor did not recover',
  ROLLBACK_DEADLINE: 'predecessor recovered after the rollback objective',
  ROLLBACK_PREDECESSOR_TOPOLOGY: 'predecessor topology could not be verified',
  ROLLBACK_COMPOSE: 'predecessor compose start failed',
  ROLLBACK_IDENTITY: 'restored containers do not run the predecessor images',
  DATABASE_INTEGRITY: 'production database integrity check failed',
  LEDGER_UNREADABLE: 'production migration ledger could not be read',
  PENDING_NOT_COMPATIBLE: 'a pending migration is not predecessor compatible',
  GOVERNANCE_AUTHORIZATION_CHANGED: 'governance_evidence_changed',
  CRASH_RECOVERY: 'interrupted release has no terminal receipt',
  BOOTSTRAP_BASELINE_CHANGED: 'bootstrap baseline changed before production',
  PROTECTED_HEAD_CHANGED: 'protected main advanced before production',
  PREPRODUCTION_TEARDOWN: 'stale pre-production staging teardown failed',
});

function emptyPhase() {
  return { result: 'skipped', checks: [], durationMs: 0 };
}

function phase(result, checks, durationMs) {
  return {
    result,
    checks: checks.map((check) => ({
      name: check.name,
      result: check.result,
      durationMs: Math.max(0, Math.round(check.durationMs ?? 0)),
      detail: check.detail ?? null,
    })),
    durationMs: Math.max(0, Math.round(durationMs)),
  };
}

function classifyMigratorFailure(result) {
  const diagnostic = `${result?.stderr ?? ''}\n${result?.stdout ?? ''}`;
  const rules = [
    ['sqlite contention', /\bSQLITE_(?:BUSY|LOCKED)\b|database (?:is )?locked/iu],
    ['sqlite readonly', /\bSQLITE_READONLY\b|read-only (?:database|file system)/iu],
    ['sqlite storage', /\bSQLITE_(?:FULL|IOERR)\b|disk I\/O error|no space left/iu],
    [
      'migration admission',
      /release migration plan|signed (?:plan|byte digest)|does not authorize|packaged migration/iu,
    ],
    [
      'schema precondition',
      /no such (?:table|column)|duplicate column|constraint failed|foreign key|syntax error/iu,
    ],
    [
      'data maintenance',
      /release data maintenance|owner bootstrap|plaintext migration|encryption configured/iu,
    ],
  ];
  const matched = rules.find(([, pattern]) => pattern.test(diagnostic));
  if (matched) return matched[0];
  if ([124, 137, 143].includes(result?.status)) return 'process terminated';
  return 'exit nonzero';
}

const RELEASE_ID_RE = /^[0-9a-f]{32}$/u;
const GOVERNANCE_REASON_SEPARATOR = ':irreversible:';

/**
 * Validate the deliberately narrow post-bootstrap authorization path.
 *
 * This path authorizes review-sensitive release-controller/packaging changes;
 * it never authorizes a contract/destructive SQL migration. The one-shot
 * operator command names the exact signed release id and the resulting digest
 * is retained in the staging receipt. Production still passes the ordinary
 * signed-ledger reconciliation, fresh backup, protected-head, health,
 * observation, image-identity, and automatic rollback gates below.
 */
export function evaluateGovernanceOnlyReleaseAuthorization({
  authorizedReleaseId,
  ownerAuthorized,
  releaseId,
  predecessorReleaseId,
  releasePayloadDigest,
  manifestDigest,
  migrations,
  productionLedgerDigest,
  productionReconciliation,
}) {
  if (authorizedReleaseId === null || authorizedReleaseId === undefined) {
    return { requested: false, authorized: false, reason: null, digest: null };
  }
  if (ownerAuthorized !== true) {
    return {
      requested: true,
      authorized: false,
      reason: 'owner_authorization_signal_required',
      digest: null,
    };
  }
  if (!RELEASE_ID_RE.test(authorizedReleaseId) || authorizedReleaseId !== releaseId) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_release_mismatch',
      digest: null,
    };
  }
  if (!RELEASE_ID_RE.test(predecessorReleaseId ?? '')) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_requires_predecessor',
      digest: null,
    };
  }
  if (migrations.cdEligibility.eligible === true) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_not_required',
      digest: null,
    };
  }
  if (!productionReconciliation?.admitted) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_pending_inventory_not_compatible',
      digest: null,
      core: null,
    };
  }
  const reasons = migrations.cdEligibility.reasons;
  const governed = reasons.length > 0 && reasons.every((reason) => {
    const separator = reason.indexOf(GOVERNANCE_REASON_SEPARATOR);
    if (separator <= 0) return false;
    const file = reason.slice(0, separator);
    const policyReason = reason.slice(separator + GOVERNANCE_REASON_SEPARATOR.length);
    return migrationSafetyGovernanceReason(file) === policyReason;
  });
  if (!governed) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_reason_not_governed',
      digest: null,
      core: null,
    };
  }
  if (!/^[0-9a-f]{64}$/u.test(productionLedgerDigest ?? '')) {
    return {
      requested: true,
      authorized: false,
      reason: 'governance_only_authorization_ledger_unprovable',
      digest: null,
      core: null,
    };
  }
  const core = {
    releaseId,
    predecessorReleaseId,
    releasePayloadDigest,
    manifestDigest,
    migrationDigest: migrations.digest,
    reasons,
    productionLedgerDigest,
    pendingFiles: productionReconciliation.pending,
  };
  return {
    requested: true,
    authorized: true,
    reason: null,
    digest: sha256(canonicalJson(core)),
    core,
  };
}

function isGovernanceOnlyReasonSet(migrations) {
  if (migrations.cdEligibility.eligible === true) return false;
  const reasons = migrations.cdEligibility.reasons;
  return reasons.length > 0 && reasons.every((reason) => {
    const separator = reason.indexOf(GOVERNANCE_REASON_SEPARATOR);
    if (separator <= 0) return false;
    const file = reason.slice(0, separator);
    const policyReason = reason.slice(separator + GOVERNANCE_REASON_SEPARATOR.length);
    return migrationSafetyGovernanceReason(file) === policyReason;
  });
}

function governanceAuthorizationMatchesCore(authorization, core) {
  const {
    schema: _schema,
    authorizedAt: _authorizedAt,
    authorizationDigest: _authorizationDigest,
    ...storedCore
  } = authorization;
  return canonicalJson(storedCore) === canonicalJson(core);
}

function projectBackupEvidence(verification) {
  const evidence = {
    artifact: verification.artifact,
    artifactPath: verification.artifactPath,
    encryptedSha256: verification.encryptedSha256,
    encryptedSizeBytes: verification.encryptedSizeBytes,
    database: verification.database,
    startedAt: verification.startedAt,
    completedAt: verification.completedAt,
  };
  return assertBackupEvidenceShape(evidence);
}

function writeRuntimeMigrationPlan({ payloadDir, plan }) {
  if (typeof payloadDir !== 'string'
      || !path.isAbsolute(payloadDir)
      || path.normalize(payloadDir) !== payloadDir) {
    fail('release payload has no normalized absolute materialization directory');
  }
  let payloadStat;
  try {
    payloadStat = fs.lstatSync(payloadDir);
  } catch {
    fail('release payload materialization directory is absent');
  }
  if (!payloadStat.isDirectory() || payloadStat.isSymbolicLink()
      || fs.realpathSync(payloadDir) !== payloadDir) {
    fail('release payload materialization directory is unsafe');
  }

  const planDir = path.join(payloadDir, 'runtime-plan');
  try {
    fs.mkdirSync(planDir, { mode: 0o755 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const planDirStat = fs.lstatSync(planDir);
  if (!planDirStat.isDirectory() || planDirStat.isSymbolicLink()
      || fs.realpathSync(planDir) !== planDir) {
    fail('release runtime plan directory is unsafe');
  }
  // systemd runs the poller with UMask=0077. Explicit chmod is therefore part of
  // admission: UID 10001 receives this directory as the direct read-only bind.
  fs.chmodSync(planDir, 0o755);

  const planPath = path.join(planDir, 'migration-plan.json');
  const temporaryPath = path.join(planDir, `.migration-plan.next-${process.pid}`);
  fs.rmSync(temporaryPath, { force: true });
  const descriptor = fs.openSync(temporaryPath, 'wx', 0o644);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(plan, null, 2)}\n`);
    fs.fchmodSync(descriptor, 0o644);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, planPath);
  const planStat = fs.lstatSync(planPath);
  if (!planStat.isFile() || planStat.isSymbolicLink()
      || planStat.nlink !== 1 || (planStat.mode & 0o777) !== 0o644) {
    fail('release runtime migration plan is unsafe');
  }
  const directoryDescriptor = fs.openSync(planDir, 'r');
  try {
    fs.fsyncSync(directoryDescriptor);
  } finally {
    fs.closeSync(directoryDescriptor);
  }
  return planDir;
}

function materializeMigrationPlan({ payload, releaseId, payloadDir }) {
  return writeRuntimeMigrationPlan({
    payloadDir,
    plan: {
      schema: 'nexus.release-migration-plan.v2',
      releaseId,
      sourceSha: payload.source.sha,
      backendImageDigest: payload.images.backend.digest,
      inventory: payload.migrations.inventory,
      reconciliation: payload.migrations.reconciliation,
      reconciliationDigest: releaseMigrationReconciliationDigest(
        payload.migrations.reconciliation,
      ),
    },
  });
}

function rollbackForwardAppliedRows({ predecessorPayload, successorPayload, appliedFiles }) {
  const predecessorInventory = predecessorPayload.migrations.inventory;
  const successorInventory = successorPayload.migrations.inventory;
  if (predecessorInventory.length > successorInventory.length
      || predecessorInventory.some((entry, index) => (
        canonicalJson(entry) !== canonicalJson(successorInventory[index])
      ))) {
    fail('successor migration inventory is not an exact append-only extension of predecessor');
  }
  const suffix = successorInventory.slice(predecessorInventory.length);
  if (suffix.some((entry) => entry.predecessorCompatible !== true)) {
    fail('rollback successor suffix is not predecessor compatible');
  }
  if (!Array.isArray(appliedFiles)
      || appliedFiles.some((file) => typeof file !== 'string')
      || new Set(appliedFiles).size !== appliedFiles.length) {
    fail('rollback migration ledger is invalid');
  }
  const applied = new Set(appliedFiles);
  const successorFiles = new Set(successorInventory.map((entry) => entry.file));
  const legacyFiles = predecessorPayload.migrations.reconciliation
    .environments.production.legacyRows.map((entry) => entry.file);
  const legacySet = new Set(legacyFiles);
  const unexpected = appliedFiles.filter((file) => (
    !successorFiles.has(file) && !legacySet.has(file)
  ));
  const missingLegacy = legacyFiles.filter((file) => !applied.has(file));
  const missingPredecessor = predecessorInventory
    .map((entry) => entry.file)
    .filter((file) => !applied.has(file));
  if (unexpected.length > 0 || missingLegacy.length > 0 || missingPredecessor.length > 0) {
    fail('rollback migration ledger is outside the signed predecessor/successor boundary');
  }
  const forwardApplied = suffix.filter((entry) => applied.has(entry.file));
  if (forwardApplied.some((entry, index) => canonicalJson(entry) !== canonicalJson(suffix[index]))) {
    fail('rollback forward-applied migrations are not an ordered signed suffix prefix');
  }
  return forwardApplied.map((entry) => ({ file: entry.file, sha256: entry.sha256 }));
}

function materializeRollbackMigrationPlan({
  predecessorPayload,
  predecessorReleaseId,
  successor,
  appliedFiles,
  payloadDir,
}) {
  const forwardApplied = rollbackForwardAppliedRows({
    predecessorPayload,
    successorPayload: successor.payload,
    appliedFiles,
  });
  return writeRuntimeMigrationPlan({
    payloadDir,
    plan: {
      schema: 'nexus.release-migration-plan.v3',
      releaseId: predecessorReleaseId,
      sourceSha: predecessorPayload.source.sha,
      backendImageDigest: predecessorPayload.images.backend.digest,
      inventory: predecessorPayload.migrations.inventory,
      reconciliation: predecessorPayload.migrations.reconciliation,
      reconciliationDigest: releaseMigrationReconciliationDigest(
        predecessorPayload.migrations.reconciliation,
      ),
      rollback: {
        successor: {
          releaseId: successor.releaseId,
          sourceSha: successor.payload.source.sha,
          backendImageDigest: successor.payload.images.backend.digest,
          releasePayloadDigest: successor.payloadDigest,
          manifestDigest: successor.manifestDigest,
        },
        forwardApplied,
      },
    },
  });
}

function verifyRetainedReleasePayload({
  extracted, policy, expected, rollbackSuccessor = null,
}) {
  const envelope = parseReleaseManifestBytes({ bytes: extracted.manifestBytes, policy });
  const retained = verifyReleaseManifest({
    envelope,
    policy,
    // Freshness governed first acceptance. A retained immutable predecessor is
    // reverified at its signed creation time so expiry cannot disable rollback.
    nowMs: Date.parse(envelope.payload.createdAt),
    verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED,
  });
  verifyComposeBytes({ payload: retained.payload, bytes: extracted.composeBytes, policy });
  if (retained.releaseId !== expected.releaseId
      || retained.payload.source.sha !== expected.sourceSha
      || retained.payload.compose.digest !== expected.payload.composeDigest
      || !imagePairMatches(retained.payload.images, expected.images)) {
    fail('retained predecessor payload does not match recorded release identity');
  }
  if (!extracted.payloadDir) fail('retained predecessor payload has no materialization directory');
  const planDir = rollbackSuccessor
    ? materializeRollbackMigrationPlan({
      predecessorPayload: retained.payload,
      predecessorReleaseId: retained.releaseId,
      successor: rollbackSuccessor,
      appliedFiles: rollbackSuccessor.appliedFiles,
      payloadDir: extracted.payloadDir,
    })
    : materializeMigrationPlan({
      payload: retained.payload,
      releaseId: retained.releaseId,
      payloadDir: extracted.payloadDir,
    });
  return { retained, planDir };
}

function predecessorTopologyFailure(error) {
  if (error instanceof Error
      && error.message === 'release Compose file digest does not match the signed manifest') {
    return 'predecessor compose digest mismatch';
  }
  return 'predecessor signed payload identity mismatch';
}

/**
 * Re-run the descriptor-bound backup verifier against the exact identity that
 * fresh admission or write-ahead state already persisted. A matching basename
 * alone is not proof that the same encrypted bytes and database still exist,
 * and the mutable last-success pointer is never a recovery input.
 */
function reverifyBackupEvidence({ backup, expected, requiredArtifact = null }) {
  let verification;
  try {
    verification = backup.verifyBackupEvidence({
      environment: 'production',
      evidence: expected,
    });
  } catch {
    return { ok: false, detail: 'backup verification threw' };
  }
  if (!verification?.ok) {
    return { ok: false, detail: verification?.detail ?? 'backup verification failed' };
  }
  let evidence;
  try {
    evidence = projectBackupEvidence(verification);
  } catch {
    return { ok: false, detail: 'backup verification evidence is incomplete' };
  }
  if ((requiredArtifact !== null && evidence.artifact !== requiredArtifact)
      || canonicalJson(evidence) !== canonicalJson(expected)) {
    return { ok: false, detail: 'backup verification evidence changed' };
  }
  return { ok: true, evidence, detail: null };
}

function buildReceipt({
  payload,
  releaseId,
  releasePayloadDigest,
  verified,
  createdAt,
  completedAt,
  staging,
  production,
  backup,
  rollback,
  outcome,
  failureCode,
  policy,
}) {
  const controlPlane = payload.controlPlane
    ? { ...payload.controlPlane }
    : null;
  const evidenceDigest = releaseEvidenceDigest({
    manifestPayload: payload,
    manifestDigest: verified.manifestDigest,
    keyId: policy.trust.signingKeyId,
    releasePayloadDigest,
  });
  return {
    // Newly admitted candidates are manifest v3 and always produce receipt v3.
    // Only crash recovery of an already-active, verified manifest v2 payload
    // may finish the legacy receipt shape without inventing a signed identity.
    schema: controlPlane ? RELEASE_RECEIPT_SCHEMA : LEGACY_RELEASE_RECEIPT_SCHEMA,
    releaseId,
    sourceSha: payload.source.sha,
    createdAt,
    completedAt,
    evidenceDigest,
    identity: {
      repository: payload.source.repository,
      ref: payload.source.ref,
      workflow: payload.source.workflow,
      runId: payload.source.runId,
      runAttempt: payload.source.runAttempt,
      manifestDigest: verified.manifestDigest,
      keyId: policy.trust.signingKeyId,
      // This is the content-addressed OCI artifact the poller extracted, not
      // the canonical JSON digest returned by manifest verification. Binding it
      // into terminal evidence prevents an unrelated state pointer from using
      // this receipt to authorize the quiet exact-payload fast path.
      releasePayloadDigest,
    },
    images: {
      backend: { ...payload.images.backend },
      contentEngine: { ...payload.images.contentEngine },
    },
    compose: { ...payload.compose },
    ...(controlPlane ? { controlPlane } : {}),
    migrations: {
      digest: payload.migrations.digest,
      reconciliationDigest: releaseMigrationReconciliationDigest(
        payload.migrations.reconciliation,
      ),
      upFileCount: payload.migrations.upFileCount,
      downFileCount: payload.migrations.downFileCount,
      eligible: payload.migrations.cdEligibility.eligible,
      predecessorCompatible: payload.migrations.cdEligibility.predecessorCompatible,
      reasons: payload.migrations.cdEligibility.reasons,
    },
    staging,
    production,
    // Projected, not passed through: the backup module also returns a `detail`
    // field, and the receipt schema is an exact-keys contract on purpose.
    backup: { result: backup.result, artifact: backup.artifact ?? null },
    rollback,
    outcome,
    failureCode: failureCode ? sanitizeDetail(failureCode) : null,
  };
}

function imagePairMatches(left, right) {
  return Boolean(left && right)
    && left.backend?.repository === right.backend?.repository
    && left.backend?.digest === right.backend?.digest
    && left.contentEngine?.repository === right.contentEngine?.repository
    && left.contentEngine?.digest === right.contentEngine?.digest;
}

function controllerOnlyTransitionContextMatches({
  payload,
  installedControlPlane,
  state,
  effective,
  completedReceipt,
}) {
  if (payload?.migrations?.cdEligibility?.eligible !== false
      || effective?.provable !== true
      || effective.source !== 'receipt'
      || effective.status !== RELEASE_STATUSES.COMPLETED
      || completedReceipt?.outcome !== 'completed'
      || effective.releaseId !== completedReceipt.releaseId
      || state?.active?.releaseId !== completedReceipt.releaseId
      || state.active.status !== RELEASE_STATUSES.COMPLETED
      || state?.predecessor?.releaseId !== completedReceipt.releaseId
      || completedReceipt.sourceSha !== state.active.sourceSha
      || completedReceipt.sourceSha !== state.predecessor.sourceSha
      || completedReceipt.identity?.releasePayloadDigest !== state.active.payload?.digest
      || completedReceipt.compose?.digest !== state.active.payload?.composeDigest
      || completedReceipt.compose?.digest !== state.predecessor.payload?.composeDigest
      || completedReceipt.evidenceDigest !== state.active.evidenceDigest
      || !imagePairMatches(completedReceipt.images, state.active.images)
      || !imagePairMatches(completedReceipt.images, state.predecessor.images)
      || state.blocked !== null
      || state.unresolvedContractMigrations !== null) {
    return false;
  }
  try {
    assertReleaseControlPlaneShape(
      installedControlPlane,
      'installed release control plane',
    );
    assertReleaseControlPlaneShape(
      payload.controlPlane,
      'controller-only candidate controlPlane',
    );
  } catch {
    return false;
  }
  return canonicalJson(payload.controlPlane) === canonicalJson(installedControlPlane)
    && (!completedReceipt.controlPlane
      || canonicalJson(payload.controlPlane) !== canonicalJson(completedReceipt.controlPlane));
}

/**
 * The first controller-bound publication may inherit the completed release's
 * summary-ineligible migration verdict even though it changes no application
 * or migration bytes. The verdict itself and `migrations.digest` necessarily
 * differ because the digest binds the classifier result. Admit the transition
 * only after reopening the retained signed payload and proving its deployable
 * inventory, reconciliation, image, and Compose bytes are exactly unchanged.
 */
export function isControllerOnlyReleaseTransition({
  payload,
  installedControlPlane,
  state,
  effective,
  completedReceipt,
  retainedPayload,
}) {
  if (!controllerOnlyTransitionContextMatches({
    payload,
    installedControlPlane,
    state,
    effective,
    completedReceipt,
  }) || !retainedPayload) {
    return false;
  }
  if (retainedPayload.controlPlane
      && canonicalJson(payload.controlPlane) === canonicalJson(retainedPayload.controlPlane)) {
    return false;
  }
  return imagePairMatches(payload.images, completedReceipt.images)
    && imagePairMatches(payload.images, state.active.images)
    && imagePairMatches(payload.images, state.predecessor.images)
    && imagePairMatches(payload.images, retainedPayload.images)
    && canonicalJson(payload.compose) === canonicalJson(completedReceipt.compose)
    && canonicalJson(payload.compose) === canonicalJson(retainedPayload.compose)
    && payload.compose.digest === state.active.payload.composeDigest
    && payload.compose.digest === state.predecessor.payload.composeDigest
    && payload.migrations.upFileCount === retainedPayload.migrations?.upFileCount
    && payload.migrations.downFileCount === retainedPayload.migrations?.downFileCount
    && canonicalJson(payload.migrations.inventory)
      === canonicalJson(retainedPayload.migrations?.inventory)
    && canonicalJson(payload.migrations.reconciliation)
      === canonicalJson(retainedPayload.migrations?.reconciliation);
}

function verifyControllerOnlyRetainedPayload({
  policy,
  registry,
  state,
  completedReceipt,
}) {
  const active = state.active;
  const activeRef = `${policy.registry.releaseImage}@${active.payload.digest}`;
  registry.pull(activeRef);
  const activeDir = path.join(
    policy.paths.workDir,
    active.payload.digest.replace('sha256:', ''),
  );
  const extracted = registry.extractReleasePayload({
    reference: activeRef,
    destinationDir: activeDir,
  });
  const envelope = parseReleaseManifestBytes({ bytes: extracted.manifestBytes, policy });
  const retained = verifyReleaseManifest({
    envelope,
    policy,
    nowMs: Date.parse(active.startedAt),
    verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED,
  });
  verifyComposeBytes({ payload: retained.payload, bytes: extracted.composeBytes, policy });
  const evidenceDigest = releaseEvidenceDigest({
    manifestPayload: retained.payload,
    manifestDigest: retained.manifestDigest,
    keyId: policy.trust.signingKeyId,
    releasePayloadDigest: active.payload.digest,
  });
  const receiptHasControlPlane = Object.hasOwn(completedReceipt, 'controlPlane');
  const payloadHasControlPlane = Object.hasOwn(retained.payload, 'controlPlane');
  if (retained.releaseId !== active.releaseId
      || retained.releaseId !== completedReceipt.releaseId
      || retained.payload.source.sha !== active.sourceSha
      || retained.payload.source.sha !== completedReceipt.sourceSha
      || !imagePairMatches(retained.payload.images, active.images)
      || !imagePairMatches(retained.payload.images, completedReceipt.images)
      || canonicalJson(retained.payload.compose) !== canonicalJson(completedReceipt.compose)
      || retained.payload.compose.digest !== active.payload.composeDigest
      || completedReceipt.identity.manifestDigest !== retained.manifestDigest
      || completedReceipt.identity.keyId !== policy.trust.signingKeyId
      || completedReceipt.identity.releasePayloadDigest !== active.payload.digest
      || completedReceipt.evidenceDigest !== evidenceDigest
      || active.evidenceDigest !== evidenceDigest
      || receiptHasControlPlane !== payloadHasControlPlane
      || (receiptHasControlPlane
        && canonicalJson(completedReceipt.controlPlane)
          !== canonicalJson(retained.payload.controlPlane))) {
    fail('retained active payload does not match completed receipt and state identity');
  }
  return retained.payload;
}

/**
 * Prove both governed Compose services are healthy and run the exact immutable
 * image digests expected by the caller. HTTP health alone cannot distinguish a
 * newly promoted candidate from a stale container still answering the same port.
 */
function verifyRunningImagePair({
  registry,
  policy,
  composeFile,
  planDir,
  images,
  releaseIdentity,
  checkPrefix,
  timeoutMs,
}) {
  const expected = [
    [policy.compose.backendService, images.backend],
    [policy.compose.contentEngineService, images.contentEngine],
  ];
  let observed = {};
  if (timeoutMs === undefined || timeoutMs > 0) {
    try {
      observed = registry.composeRunningImages({
        composeFile,
        planDir,
        environment: 'production',
        images,
        releaseIdentity,
        services: expected.map(([service]) => service),
        timeoutMs,
      });
    } catch {
      observed = {};
    }
  }

  let passed = true;
  const checks = expected.map(([service, identity]) => {
    const seen = observed[service];
    const matches = Boolean(seen?.healthy)
      && registry.imageMatchesDigest(seen?.image, identity.repository, identity.digest);
    passed = passed && matches;
    return {
      name: `${checkPrefix}_${service}`,
      result: matches ? 'passed' : 'failed',
      durationMs: 0,
      detail: matches ? null : sanitizeDetail(`expected ${identity.digest.slice(0, 19)}`),
    };
  });
  return { passed, checks };
}

/**
 * Recover a release whose write-ahead state admits a production mutation but
 * whose terminal receipt is absent.
 *
 * The recovery is deliberately driven only by identities already persisted
 * before the mutation: the interrupted release payload, the outgoing rollback
 * target, and the verified pre-migration backup artifact. Nothing is inferred
 * from the moving release tag or from whichever containers happen to answer a
 * port. The database is checked read-only and is never restored automatically.
 */
async function recoverUnprovableActiveRelease({
  policy,
  state,
  store,
  registry,
  health,
  notifier,
  mirror,
  backup,
  databaseProbe,
  clock,
  log,
}) {
  const active = state.active;
  if (!active) {
    return { outcome: DEPLOYMENT_OUTCOMES.BLOCKED, reason: 'unprovable_active_release' };
  }

  // This is the incident clock, not the narrower predecessor-switch objective.
  // Start it before persisting the recovery block, paging, or reopening evidence
  // so those potentially slow steps cannot disappear from the reported outage.
  let incidentRecoveryStartedAt = clock();
  const objectiveSeconds = policy.timing.rollbackObjectiveSeconds;
  const recoveryTimingAt = (predecessorSwitchDurationMs = 0) => ({
    incidentRecoveryDurationMs: Math.max(
      Math.round(predecessorSwitchDurationMs),
      Math.max(0, Math.round(clock() - incidentRecoveryStartedAt)),
    ),
    predecessorSwitchDurationMs: Math.max(0, Math.round(predecessorSwitchDurationMs)),
    predecessorSwitchObjectiveSeconds: objectiveSeconds,
  });

  // Persist the incident before touching production. If this recovery process
  // itself dies, the next poll re-enters this branch instead of reporting a
  // successful timer run forever.
  const recoveryBlockState = store.block({
    releaseId: active.releaseId,
    reason: BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE,
  });
  // `block()` preserves `since` when the exact recovery block already exists.
  // Reuse that durable start after a second poller crash so the incident clock
  // cannot silently reset on every recovery attempt.
  const persistedRecoveryStartedAt = Date.parse(recoveryBlockState.blocked?.since ?? '');
  if (Number.isFinite(persistedRecoveryStartedAt)) {
    incidentRecoveryStartedAt = Math.min(
      incidentRecoveryStartedAt,
      persistedRecoveryStartedAt,
    );
  }
  await notifier.send({
    kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
    release: {
      releaseId: active.releaseId,
      sourceSha: active.sourceSha,
      phase: 'crash_recovery',
      outcome: 'interrupted',
      failureCode: FAILURE_CODES.CRASH_RECOVERY,
      rollbackResult: 'pending',
      actionRequired: 'automatic predecessor recovery started',
      predecessorSwitchObjectiveSeconds: objectiveSeconds,
    },
  });

  const failWithoutReceipt = async (failureCode, actionRequired) => {
    const recoveryTiming = recoveryTimingAt();
    log(`release ${active.releaseId} crash recovery stopped: ${failureCode}`);
    await notifier.send({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: {
        releaseId: active.releaseId,
        sourceSha: active.sourceSha,
        phase: 'crash_recovery',
        outcome: 'blocked',
        failureCode,
        rollbackResult: 'not_attempted',
        actionRequired,
        incidentRecoverySeconds: recoveryTiming.incidentRecoveryDurationMs / 1000,
        predecessorSwitchSeconds: 0,
        predecessorSwitchObjectiveSeconds: objectiveSeconds,
      },
    });
    return {
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      reason: 'unprovable_active_release',
      releaseId: active.releaseId,
    };
  };

  if (!active.backupEvidence || !active.backupArtifact) {
    return failWithoutReceipt(
      'pre-migration backup identity is missing',
      'inspect the backup receipt and recover production manually',
    );
  }

  // The encrypted artifact is operator recovery evidence for whatever the
  // interrupted migrator may have changed. Re-open and hash it again before
  // recovery can publish any terminal receipt that says the backup passed. Use
  // only the exact identity persisted in write-ahead state: last-success.json is
  // a mutable admission pointer and may now describe a later hourly backup.
  const recoveredBackup = reverifyBackupEvidence({
    backup,
    expected: active.backupEvidence,
    requiredArtifact: active.backupArtifact,
  });
  if (!recoveredBackup.ok) {
    return failWithoutReceipt(
      'pre-migration backup evidence could not be reverified',
      'restore the exact verified backup artifact before recovery',
    );
  }

  // Re-open the exact interrupted payload, not the moving :main pointer. Verify
  // its signature at the persisted acceptance time, then bind every identity
  // back to state before using it to author a recovery receipt.
  let verified;
  let payload;
  try {
    const activeRef = `${policy.registry.releaseImage}@${active.payload.digest}`;
    registry.pull(activeRef);
    const activeDir = path.join(
      policy.paths.workDir,
      active.payload.digest.replace('sha256:', ''),
    );
    const extracted = registry.extractReleasePayload({
      reference: activeRef,
      destinationDir: activeDir,
    });
    const envelope = parseReleaseManifestBytes({ bytes: extracted.manifestBytes, policy });
    verified = verifyReleaseManifest({
      envelope,
      policy,
      nowMs: Date.parse(active.startedAt),
      verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED,
    });
    payload = verified.payload;
    verifyComposeBytes({ payload, bytes: extracted.composeBytes, policy });
    if (verified.releaseId !== active.releaseId
        || payload.source.sha !== active.sourceSha
        || payload.compose.digest !== active.payload.composeDigest
        || !imagePairMatches(payload.images, active.images)
        || releaseEvidenceDigest({
          manifestPayload: payload,
          manifestDigest: verified.manifestDigest,
          keyId: policy.trust.signingKeyId,
          releasePayloadDigest: active.payload.digest,
        }) !== active.evidenceDigest) {
      throw new Error('interrupted payload does not match write-ahead state');
    }
  } catch {
    return failWithoutReceipt(
      'interrupted payload identity could not be verified',
      'restore the exact signed payload evidence before recovery',
    );
  }

  let recoveryGovernanceAuthorization = null;
  if (active.rollbackTarget && isGovernanceOnlyReasonSet(payload.migrations)) {
    try {
      const authorization = store.readGovernanceOnlyAuthorization(active.releaseId);
      if (!authorization
          || authorization.releaseId !== active.releaseId
          || authorization.predecessorReleaseId !== active.rollbackTarget.releaseId
          || authorization.releasePayloadDigest !== active.payload.digest
          || authorization.manifestDigest !== verified.manifestDigest
          || authorization.migrationDigest !== payload.migrations.digest
          || canonicalJson(authorization.reasons)
            !== canonicalJson(payload.migrations.cdEligibility.reasons)) {
        throw new Error('governance-only authorization does not match interrupted release');
      }
      recoveryGovernanceAuthorization = authorization;
    } catch {
      return failWithoutReceipt(
        'governance-only authorization evidence could not be reverified',
        'restore the exact root-owned authorization before recovery',
      );
    }
  }

  const checks = [{
    name: 'crash_recovery_detected',
    result: 'failed',
    durationMs: 0,
    detail: sanitizeDetail(FAILURE_CODES.CRASH_RECOVERY),
  }];
  const integrity = databaseProbe.checkIntegrity({ environment: 'production' });
  checks.push(integrity);

  const persist = async ({
    outcome,
    status,
    blockReason,
    failureCode,
    rollback,
    notifyRelease,
    restoredPredecessor = undefined,
  }) => {
    const recoveryStagingChecks = [{
      name: 'crash_recovery_write_ahead',
      result: 'passed',
      durationMs: 0,
      detail: null,
    }];
    if (recoveryGovernanceAuthorization) {
      recoveryStagingChecks.push({
        name: 'owner_governance_only_authorization',
        result: 'passed',
        durationMs: 0,
        detail: `sha256:${recoveryGovernanceAuthorization.authorizationDigest}`,
      });
    }
    const receipt = buildReceipt({
      payload,
      releaseId: active.releaseId,
      releasePayloadDigest: active.payload.digest,
      verified,
      createdAt: active.startedAt,
      completedAt: new Date(clock()).toISOString(),
      staging: phase('passed', recoveryStagingChecks, 0),
      production: phase('failed', checks, rollback.incidentRecoveryDurationMs),
      backup: { result: 'passed', artifact: active.backupArtifact },
      rollback,
      outcome,
      failureCode,
      policy,
    });

    // Publish the terminal evidence before replacing the recovery block. A
    // crash after this write is provable from the receipt; a crash before it
    // leaves UNPROVABLE_ACTIVE_RELEASE in place and retries this exact recovery.
    let written;
    try {
      written = store.writeReceipt(receipt);
    } catch (error) {
      store.block({
        releaseId: active.releaseId,
        reason: BLOCK_REASONS.RECEIPT_UNWRITABLE,
      });
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId: active.releaseId,
          sourceSha: active.sourceSha,
          phase: 'receipt',
          outcome: 'receipt_unwritable',
          failureCode: sanitizeDetail(error instanceof Error ? error.message : 'receipt write failed'),
          rollbackResult: rollback.result,
          actionRequired: 'deployment halted; crash recovery has no durable receipt',
          incidentRecoverySeconds: rollback.incidentRecoveryDurationMs / 1000,
          predecessorSwitchSeconds: rollback.predecessorSwitchDurationMs / 1000,
          predecessorSwitchObjectiveSeconds: rollback.predecessorSwitchObjectiveSeconds,
        },
      });
      return {
        outcome,
        releaseId: active.releaseId,
        receiptDigest: null,
        receiptPath: null,
        receiptWriteFailed: true,
      };
    }

    store.completeRelease({
      releaseId: active.releaseId,
      status,
      restoredPredecessor,
      recoveryTiming: {
        incidentRecoveryDurationMs: receipt.rollback.incidentRecoveryDurationMs,
        predecessorSwitchDurationMs: receipt.rollback.predecessorSwitchDurationMs,
        predecessorSwitchObjectiveSeconds:
          receipt.rollback.predecessorSwitchObjectiveSeconds,
      },
    });
    store.block({ releaseId: active.releaseId, reason: blockReason });
    store.reject({ releaseId: active.releaseId, reason: outcome });

    const mirrored = mirror.mirrorReceipt({
      receiptPath: written.path,
      releaseId: active.releaseId,
    });
    if (mirrored.result === 'failed') {
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId: active.releaseId,
          sourceSha: active.sourceSha,
          phase: 'audit_mirror',
          outcome: 'mirror_failed',
          failureCode: mirrored.detail,
          rollbackResult: 'not_applicable',
          actionRequired: 'investigate the audit mirror; the recovery verdict stands',
        },
      });
    }
    await notifier.send({
      kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      release: {
        ...notifyRelease,
        incidentRecoverySeconds: receipt.rollback.incidentRecoveryDurationMs / 1000,
        predecessorSwitchSeconds: receipt.rollback.predecessorSwitchDurationMs / 1000,
        predecessorSwitchObjectiveSeconds:
          receipt.rollback.predecessorSwitchObjectiveSeconds,
      },
    });
    return {
      outcome,
      releaseId: active.releaseId,
      receiptDigest: written.digest,
      receiptPath: written.path,
      mirrored,
    };
  };

  if (integrity.result !== 'passed') {
    const recoveryTiming = recoveryTimingAt();
    return persist({
      outcome: DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
      status: RELEASE_STATUSES.ROLLBACK_FAILED,
      blockReason: BLOCK_REASONS.DATABASE_INTEGRITY,
      failureCode: FAILURE_CODES.DATABASE_INTEGRITY,
      rollback: {
        result: 'not_attempted',
        restored: null,
        ...recoveryTiming,
      },
      notifyRelease: {
        releaseId: active.releaseId,
        sourceSha: active.sourceSha,
        phase: 'database_integrity',
        outcome: 'rollback_failed',
        failureCode: FAILURE_CODES.DATABASE_INTEGRITY,
        rollbackResult: 'not_attempted',
        actionRequired: `do not roll back; recover from backup ${active.backupArtifact}`,
      },
    });
  }

  const predecessor = active.rollbackTarget;
  if (!predecessor) {
    const recoveryTiming = recoveryTimingAt();
    return persist({
      outcome: DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
      status: RELEASE_STATUSES.ROLLBACK_FAILED,
      blockReason: BLOCK_REASONS.ROLLBACK_FAILED,
      failureCode: FAILURE_CODES.NO_PREDECESSOR,
      rollback: {
        result: 'failed',
        restored: null,
        ...recoveryTiming,
      },
      notifyRelease: {
        releaseId: active.releaseId,
        sourceSha: active.sourceSha,
        phase: 'crash_recovery',
        outcome: 'rollback_failed',
        failureCode: FAILURE_CODES.NO_PREDECESSOR,
        rollbackResult: 'failed',
        actionRequired: 'manual recovery required; deployment is halted',
      },
    });
  }

  const predecessorReleaseIdentity = {
    releaseId: predecessor.releaseId,
    sourceSha: predecessor.sourceSha,
    backendImageDigest: predecessor.images.backend.digest,
  };

  // The 120-second service objective starts only when predecessor switching is
  // ready to begin. Evidence revalidation is part of the full incident metric,
  // but cannot consume or obscure this independent switch objective.
  const predecessorSwitchStartedAt = clock();
  const rollbackDeadline = predecessorSwitchStartedAt + objectiveSeconds * 1000;
  const remainingRollbackMs = () => Math.max(0, rollbackDeadline - clock());
  let rollbackDeadlineExhausted = false;
  const predecessorRef = `${policy.registry.releaseImage}@${predecessor.payload.digest}`;
  let rollbackComposeFile = null;
  let rollbackPlanDir = null;
  let topologyError = null;
  const rollbackLedger = databaseProbe.readAppliedMigrations({ environment: 'production' });
  if (!rollbackLedger.ok) {
    topologyError = 'production migration ledger is unavailable for rollback topology';
  }
  try {
    if (topologyError) throw new Error(topologyError);
    if (remainingRollbackMs() <= 0) {
      rollbackDeadlineExhausted = true;
      throw new Error('rollback objective expired before predecessor pull');
    }
    registry.pull(predecessorRef, { timeoutMs: remainingRollbackMs() });
    if (remainingRollbackMs() <= 0) {
      rollbackDeadlineExhausted = true;
      throw new Error('rollback objective expired before predecessor extraction');
    }
    const predecessorDir = path.join(
      policy.paths.workDir,
      predecessor.payload.digest.replace('sha256:', ''),
    );
    const extracted = registry.extractReleasePayload({
      reference: predecessorRef,
      destinationDir: predecessorDir,
      timeoutMs: remainingRollbackMs(),
    });
    try {
      const retained = verifyRetainedReleasePayload({
        extracted,
        policy,
        expected: predecessor,
        rollbackSuccessor: {
          payload,
          releaseId: active.releaseId,
          payloadDigest: active.payload.digest,
          manifestDigest: verified.manifestDigest,
          appliedFiles: rollbackLedger.applied,
        },
      });
      rollbackComposeFile = extracted.composePath;
      rollbackPlanDir = retained.planDir;
    } catch (error) {
      topologyError ??= predecessorTopologyFailure(error);
    }
  } catch {
    topologyError ??= 'predecessor payload unavailable';
  }
  checks.push({
    name: 'rollback_predecessor_topology',
    result: topologyError ? 'failed' : 'passed',
    durationMs: 0,
    detail: topologyError ? sanitizeDetail(topologyError) : null,
  });

  if (!topologyError && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  const rollbackUp = topologyError || rollbackDeadlineExhausted ? { status: 1 } : registry.composeUp({
    composeFile: rollbackComposeFile,
    planDir: rollbackPlanDir,
    environment: 'production',
    images: predecessor.images,
    releaseIdentity: predecessorReleaseIdentity,
    timeoutMs: remainingRollbackMs(),
  });
  if (!topologyError && remainingRollbackMs() <= 0 && rollbackUp.status !== 0) {
    rollbackDeadlineExhausted = true;
  }
  const restored = topologyError || remainingRollbackMs() <= 0
    ? { healthy: false, checks: [] }
    : await health.waitUntilHealthy({
      backendPort: policy.environments.production.backendPort,
      contentEnginePort: policy.environments.production.contentEnginePort,
      budgetSeconds: Math.min(
        policy.timing.healthBudgetSeconds,
        remainingRollbackMs() / 1000,
      ),
    });
  if (!topologyError && !restored.healthy && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  checks.push(...restored.checks);

  const identity = topologyError
    ? { passed: false, checks: [] }
    : verifyRunningImagePair({
      registry,
      policy,
      composeFile: rollbackComposeFile,
      planDir: rollbackPlanDir,
      images: predecessor.images,
      releaseIdentity: predecessorReleaseIdentity,
      checkPrefix: 'rollback_identity',
      timeoutMs: remainingRollbackMs(),
    });
  const identityOk = identity.passed;
  checks.push(...identity.checks);
  if (!topologyError && !identityOk && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }

  const predecessorSwitchDurationMs = Math.max(
    0,
    Math.round(clock() - predecessorSwitchStartedAt),
  );
  const recoveryTiming = recoveryTimingAt(predecessorSwitchDurationMs);
  const composeOk = rollbackUp.status === 0;
  checks.push({
    name: 'rollback_compose_start',
    result: composeOk ? 'passed' : 'failed',
    durationMs: 0,
    detail: composeOk ? null : sanitizeDetail(`compose exit ${rollbackUp.status}`),
  });
  const withinObjective = predecessorSwitchDurationMs <= objectiveSeconds * 1000
    && !rollbackDeadlineExhausted;
  const rollbackOk = composeOk && restored.healthy && identityOk && withinObjective;
  const rollbackFailureCode = topologyError
    ? (rollbackDeadlineExhausted
      ? FAILURE_CODES.ROLLBACK_DEADLINE
      : FAILURE_CODES.ROLLBACK_PREDECESSOR_TOPOLOGY)
    : (!withinObjective
      ? FAILURE_CODES.ROLLBACK_DEADLINE
      : (!composeOk
        ? FAILURE_CODES.ROLLBACK_COMPOSE
        : (!restored.healthy
          ? FAILURE_CODES.ROLLBACK_UNHEALTHY
          : FAILURE_CODES.ROLLBACK_IDENTITY)));

  const result = await persist({
    outcome: rollbackOk ? DEPLOYMENT_OUTCOMES.ROLLED_BACK : DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
    status: rollbackOk ? RELEASE_STATUSES.ROLLED_BACK : RELEASE_STATUSES.ROLLBACK_FAILED,
    blockReason: rollbackOk ? BLOCK_REASONS.ROLLBACK_FIRED : BLOCK_REASONS.ROLLBACK_FAILED,
    failureCode: rollbackOk ? FAILURE_CODES.CRASH_RECOVERY : rollbackFailureCode,
    rollback: {
      result: rollbackOk ? 'restored' : 'failed',
      restored: rollbackOk ? predecessor.images : null,
      ...recoveryTiming,
    },
    notifyRelease: {
      releaseId: active.releaseId,
      sourceSha: active.sourceSha,
      phase: 'crash_recovery',
      outcome: rollbackOk ? 'rolled_back' : 'rollback_failed',
      failureCode: rollbackOk ? FAILURE_CODES.CRASH_RECOVERY : rollbackFailureCode,
      rollbackResult: rollbackOk ? 'restored' : 'failed',
      actionRequired: rollbackOk
        ? 'predecessor restored; acknowledge the block to resume deployments'
        : 'manual recovery required; deployment is halted',
    },
    restoredPredecessor: rollbackOk ? predecessor : undefined,
  });

  if (rollbackOk && !result.receiptWriteFailed) {
    await notifier.send({
      kind: RELEASE_NOTIFICATION_KINDS.RECOVERY,
      release: {
        releaseId: active.releaseId,
        sourceSha: active.sourceSha,
        restored: predecessor.images,
        incidentRecoverySeconds: recoveryTiming.incidentRecoveryDurationMs / 1000,
        predecessorSwitchSeconds: recoveryTiming.predecessorSwitchDurationMs / 1000,
        predecessorSwitchObjectiveSeconds:
          recoveryTiming.predecessorSwitchObjectiveSeconds,
      },
    });
  }
  return result;
}

export async function runReleaseDeployment({
  policy,
  controlPlane,
  store,
  registry,
  health,
  notifier: notificationDelivery,
  mirror: mirrorDelivery,
  backup,
  installedBackupInterface,
  databaseProbe,
  bootstrap = null,
  protectedHead,
  allowFirstContainerBootstrap = false,
  governanceOnlyReleaseId = null,
  ownerAuthorized = false,
  clock = () => Date.now(),
  log = () => {},
  env = process.env,
  requireLock = true,
  schemaPolicy,
}) {
  if (requireLock) assertLockHeld(env);
  if (!protectedHead || typeof protectedHead.verify !== 'function') {
    fail('protected-head verifier is required');
  }
  assertReleaseControlPlaneShape(controlPlane, 'installed release control plane');
  const proveInstalledBackupInterface = () => {
    if (!installedBackupInterface || typeof installedBackupInterface.verify !== 'function') {
      fail('installed backup-interface verifier is required');
    }
    const proof = installedBackupInterface.verify();
    if (!proof || proof.passed !== true) {
      fail('installed backup interface does not match the governed control plane');
    }
    return proof;
  };

  const iso = () => new Date(clock()).toISOString();
  const startedAt = iso();
  // Notification and audit transports report evidence; they never decide the
  // deployment verdict. Keep that boundary at the orchestrator too, so an
  // unexpected injected formatter/transport exception cannot abort rollback.
  const notifier = {
    send: async (message) => {
      try {
        return await notificationDelivery.send(message);
      } catch {
        log('release notification failed; deployment verdict is unchanged');
        return { delivered: false, reason: 'notification_failed' };
      }
    },
  };
  const mirror = {
    reconcileReceipts: () => {
      if (typeof mirrorDelivery.reconcileReceipts !== 'function') {
        return {
          examined: 0, enqueued: 0, queued: 0, delivered: 0, exhausted: 0, invalid: 0,
        };
      }
      return mirrorDelivery.reconcileReceipts();
    },
    drainQueue: () => mirrorDelivery.drainQueue(),
    mirrorReceipt: (input) => {
      try {
        return mirrorDelivery.mirrorReceipt(input);
      } catch {
        log('release audit mirror failed unexpectedly; deployment verdict is unchanged');
        return { result: 'failed', detail: 'audit mirror unavailable' };
      }
    },
  };

  // Receipt publication and mirror enqueue are separate durable operations. A
  // crash between them is repaired from immutable receipts before queue drain;
  // both reconciliation and delivery remain non-gating by construction.
  try {
    const reconciled = mirror.reconcileReceipts();
    if (reconciled.enqueued > 0) {
      log(`audit mirror reconciled ${reconciled.enqueued} missing receipt obligations`);
    }
    if (reconciled.invalid > 0) {
      log(`audit mirror refused ${reconciled.invalid} invalid local receipts`);
    }
  } catch {
    log('audit mirror reconciliation failed; continuing (mirroring is non-gating)');
  }

  // Drain any receipts a previous poll could not deliver. Non-gating by
  // construction: the result is logged and never consulted below.
  try {
    const drained = mirror.drainQueue();
    if (drained.attempted > 0) {
      log(`audit mirror drained ${drained.delivered}/${drained.attempted} queued receipts`);
    }
    for (const releaseId of drained.exhausted) {
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: null,
          phase: 'audit_mirror',
          outcome: 'mirror_exhausted',
          failureCode: 'audit mirror retries exhausted',
          rollbackResult: 'not_applicable',
          actionRequired: 'investigate the audit host; release verdicts are unaffected',
        },
      });
    }
  } catch {
    log('audit mirror drain failed; continuing (mirroring is non-gating)');
  }

  const state = store.readState();
  const effective = resolveEffectiveRelease({ state, readReceipt: store.readReceipt });

  // A recovery receipt may have reached disk immediately before the process
  // died, while the write-ahead recovery block is still projected in state.
  // Reconcile that narrow window from the immutable receipt instead of running
  // the rollback again or leaving an acknowledge-resistant block forever.
  if (state.blocked?.reason === BLOCK_REASONS.UNPROVABLE_ACTIVE_RELEASE
      && effective.provable
      && effective.source === 'receipt') {
    const receipt = store.readReceipt(effective.releaseId);
    if (receipt?.outcome === 'rolled_back' || receipt?.outcome === 'rollback_failed') {
      const status = receipt.outcome === 'rolled_back'
        ? RELEASE_STATUSES.ROLLED_BACK
        : RELEASE_STATUSES.ROLLBACK_FAILED;
      const recoveryTimingRecorded = state.history.some((entry) => (
        entry.releaseId === effective.releaseId
        && entry.status === status
        && entry.recoveryTiming !== null
        && entry.recoveryTiming !== undefined
      ));
      if (state.active?.status !== status || !recoveryTimingRecorded) {
        store.completeRelease({
          releaseId: effective.releaseId,
          status,
          restoredPredecessor: receipt.outcome === 'rolled_back'
            ? state.active?.rollbackTarget
            : undefined,
          recoveryTiming: {
            incidentRecoveryDurationMs: receipt.rollback.incidentRecoveryDurationMs,
            predecessorSwitchDurationMs: receipt.rollback.predecessorSwitchDurationMs,
            predecessorSwitchObjectiveSeconds:
              receipt.rollback.predecessorSwitchObjectiveSeconds,
          },
        });
      }
      const reason = receipt.outcome === 'rolled_back'
        ? BLOCK_REASONS.ROLLBACK_FIRED
        : (receipt.rollback.result === 'not_attempted'
          ? BLOCK_REASONS.DATABASE_INTEGRITY
          : BLOCK_REASONS.ROLLBACK_FAILED);
      store.block({ releaseId: effective.releaseId, reason });
      store.reject({ releaseId: effective.releaseId, reason: receipt.outcome });
      mirror.mirrorReceipt({
        receiptPath: store.receiptPath(effective.releaseId),
        releaseId: effective.releaseId,
      });
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId: effective.releaseId,
          sourceSha: receipt.sourceSha,
          phase: 'crash_recovery',
          outcome: receipt.outcome,
          failureCode: receipt.failureCode,
          rollbackResult: receipt.rollback.result,
          actionRequired: receipt.outcome === 'rolled_back'
            ? 'predecessor restored; acknowledge the block to resume deployments'
            : 'manual recovery required; deployment is halted',
          incidentRecoverySeconds: receipt.rollback.incidentRecoveryDurationMs / 1000,
          predecessorSwitchSeconds: receipt.rollback.predecessorSwitchDurationMs / 1000,
          predecessorSwitchObjectiveSeconds:
            receipt.rollback.predecessorSwitchObjectiveSeconds,
        },
      });
      if (receipt.outcome === 'rolled_back') {
        await notifier.send({
          kind: RELEASE_NOTIFICATION_KINDS.RECOVERY,
          release: {
            releaseId: effective.releaseId,
            sourceSha: receipt.sourceSha,
            restored: receipt.rollback.restored,
            incidentRecoverySeconds: receipt.rollback.incidentRecoveryDurationMs / 1000,
            predecessorSwitchSeconds: receipt.rollback.predecessorSwitchDurationMs / 1000,
            predecessorSwitchObjectiveSeconds:
              receipt.rollback.predecessorSwitchObjectiveSeconds,
          },
        });
      }
      return {
        outcome: receipt.outcome === 'rolled_back'
          ? DEPLOYMENT_OUTCOMES.ROLLED_BACK
          : DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
        reason: 'reconciled_crash_recovery_receipt',
        releaseId: effective.releaseId,
      };
    }
  }

  if (!effective.provable) {
    // A projected ordinary block is not terminal evidence. The process may have
    // died after writing rollback_fired, rollback_failed, database_integrity, or
    // receipt_unwritable but before the immutable receipt. Every receiptless
    // mutation-admitting state therefore enters the same exact-evidence recovery;
    // recoverUnprovableActiveRelease replaces the older block with the deliberately
    // unacknowledgeable recovery block before touching production.
    return recoverUnprovableActiveRelease({
      policy,
      state,
      store,
      registry,
      health,
      notifier,
      mirror,
      backup,
      databaseProbe,
      clock,
      log,
    });
  }

  if (state.blocked) {
    // A fired rollback, a failed rollback, or an ineligible migration all halt
    // continuous deployment until a human acknowledges it. Without this, the
    // 30-second timer would stack releases on a known-bad state.
    log(`release deployment halted: ${state.blocked.reason}`);
    return {
      outcome: DEPLOYMENT_OUTCOMES.HALTED,
      reason: state.blocked.reason,
      releaseId: state.blocked.releaseId,
    };
  }

  // Crash recovery and durable blocks are resolved before this gate because
  // neither path starts the installed backup producer. Every ordinary candidate
  // (including a quiet no-op) must prove that live root backup authority exactly
  // matches this immutable controller before registry discovery can proceed.
  proveInstalledBackupInterface();

  const resumingAcceptedPreProduction = effective.source === 'state'
    && [RELEASE_STATUSES.ELIGIBLE, RELEASE_STATUSES.STAGING_HEALTHY]
      .includes(effective.status)
    && state.active?.releaseId === effective.releaseId
    && Boolean(state.active?.payload?.digest);
  const releaseRef = `${policy.registry.releaseImage}:${policy.registry.releaseTag}`;
  let payloadDigest;
  if (resumingAcceptedPreProduction) {
    // The moving tag may have been republished with new CI metadata while keeping
    // the same deployable release id. Resume only the exact OCI payload and signed
    // evidence already accepted into pre-production state. Latest-green is still
    // rechecked after staging; a genuinely different release then supersedes this
    // one, while a same-content publication is deliberately non-superseding.
    payloadDigest = state.active.payload.digest;
    registry.pull(`${policy.registry.releaseImage}@${payloadDigest}`);
  } else {
    registry.pull(releaseRef);
    payloadDigest = registry.resolveDigest(releaseRef);
  }
  const pinnedPayloadRef = `${policy.registry.releaseImage}@${payloadDigest}`;
  const protectedPayloadDigests = [...new Set([
    payloadDigest,
    state.active?.payload?.digest,
    state.predecessor?.payload?.digest,
    // In a settled state `predecessor` names the completed current release so it
    // can become the next candidate's rollback target. The actual outgoing
    // release remains snapshotted on the active release; quiet NOOP polls must
    // protect that payload too instead of spending the spare retention slot on
    // whichever unrelated digest Docker lists first.
    state.active?.rollbackTarget?.payload?.digest,
  ].filter(Boolean))];

  const prunePayloadDiscoveryArtifacts = () => {
    registry.pruneImages({
      repository: policy.registry.releaseImage,
      keepDigests: protectedPayloadDigests,
    });
    registry.pruneWorkDirs({
      keepDirs: protectedPayloadDigests.map((digest) => (
        path.join(policy.paths.workDir, digest.replace('sha256:', ''))
      )),
    });
  };

  // Manifest freshness gates first acceptance, not quiet observation of an
  // already-settled release. The immutable receipt proves the active release,
  // and the moving tag resolved to the exact payload digest persisted with it,
  // so re-verifying an expired manifest would only turn every quiet poll into a
  // false incident. A different payload still takes the full freshness path.
  if (effective.source === 'receipt'
      && effective.status === RELEASE_STATUSES.COMPLETED
      && state.active?.releaseId === effective.releaseId
      && effective.releasePayloadDigest === payloadDigest
      && state.active?.payload?.digest === payloadDigest) {
    // Quiet exact-payload polls do not reopen the manifest, but must still keep
    // the bounded discovery cache healthy.
    prunePayloadDiscoveryArtifacts();
    return {
      outcome: DEPLOYMENT_OUTCOMES.NOOP,
      reason: 'already_completed_payload',
      releaseId: effective.releaseId,
    };
  }

  const workDir = path.join(policy.paths.workDir, payloadDigest.replace('sha256:', ''));
  const extracted = registry.extractReleasePayload({
    reference: pinnedPayloadRef,
    destinationDir: workDir,
  });

  const envelope = parseReleaseManifestBytes({ bytes: extracted.manifestBytes, policy });
  const resumingAcceptedPayload = resumingAcceptedPreProduction
    && state.active.payload.digest === payloadDigest;
  const verified = verifyReleaseManifest({
    envelope,
    policy,
    schemaPolicy,
    // This exact content-addressed payload already passed freshness before its
    // pre-production write-ahead state was persisted. Re-check its signature at
    // the immutable first-acceptance time; later retries may advance updatedAt,
    // but a different payload still uses the current clock.
    nowMs: resumingAcceptedPayload ? Date.parse(state.active.startedAt) : clock(),
    verificationMode: resumingAcceptedPayload
      ? RELEASE_MANIFEST_VERIFICATION_MODES.RETAINED
      : RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
  });
  const payload = verified.payload;
  const releaseId = verified.releaseId;
  if (resumingAcceptedPayload
      && (releaseId !== state.active.releaseId
        || payload.source.sha !== state.active.sourceSha
        || payload.compose.digest !== state.active.payload.composeDigest
        || !imagePairMatches(payload.images, state.active.images)
        || releaseEvidenceDigest({
          manifestPayload: payload,
          manifestDigest: verified.manifestDigest,
          keyId: policy.trust.signingKeyId,
          releasePayloadDigest: payloadDigest,
        }) !== state.active.evidenceDigest)) {
    fail('resumed payload does not match accepted pre-production state');
  }
  const verifyProtectedHeadFor = (expectedSha) => {
    try {
      const result = protectedHead.verify({ expectedSha });
      if (!result || !Object.values(PROTECTED_HEAD_RESULTS).includes(result.result)) {
        return { result: PROTECTED_HEAD_RESULTS.UNAVAILABLE, headSha: null };
      }
      return result;
    } catch {
      return { result: PROTECTED_HEAD_RESULTS.UNAVAILABLE, headSha: null };
    }
  };
  async function retireAcceptedPreProduction({
    composeFile,
    planDir,
    images,
    releaseIdentity,
    blockReason = null,
  }) {
    const latest = store.readState();
    const accepted = latest.active?.releaseId === releaseId
      && [RELEASE_STATUSES.ELIGIBLE, RELEASE_STATUSES.STAGING_HEALTHY]
        .includes(latest.active.status);
    if (!accepted) return { accepted: false, result: null };

    let teardown;
    try {
      teardown = registry.composeDown({
        composeFile,
        planDir,
        environment: 'staging',
        images,
        releaseIdentity,
      });
    } catch {
      teardown = { status: 1 };
    }
    if (!teardown || teardown.status !== 0) {
      store.block({
        releaseId,
        reason: BLOCK_REASONS.PREPRODUCTION_TEARDOWN_FAILED,
      });
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'preproduction_teardown',
          outcome: 'blocked',
          failureCode: FAILURE_CODES.PREPRODUCTION_TEARDOWN,
          rollbackResult: 'not_required',
          actionRequired: 'inspect and remove the exact staging project before resuming',
        },
      });
      return {
        accepted: true,
        result: {
          outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
          reason: 'preproduction_teardown_failed',
          releaseId,
        },
      };
    }
    store.retirePreProduction({ releaseId, blockReason });
    return { accepted: true, result: null };
  }
  const controlPlaneMatches = canonicalJson(payload.controlPlane) === canonicalJson(controlPlane);
  if (!controlPlaneMatches && resumingAcceptedPayload && state.predecessor !== null) {
    // An accepted pre-production candidate can outlive the controller that
    // admitted it. A newer installed controller must not deploy that candidate,
    // but it also must not wedge behind it forever after protected main advances.
    // Retirement is allowed only when three independent facts agree: the old
    // signed payload is the exact accepted state, public protected main differs,
    // and the moving pointer is a different, fresh signed payload for that exact
    // head whose control-plane identity matches this installed controller.
    const retainedHead = verifyProtectedHeadFor(payload.source.sha);
    if (retainedHead.result === PROTECTED_HEAD_RESULTS.UNAVAILABLE) {
      log(`release ${releaseId} protected-head supersession proof is unavailable; deferring`);
      return {
        outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
        reason: 'protected_head_unavailable',
        releaseId,
      };
    }
    if (retainedHead.result === PROTECTED_HEAD_RESULTS.CURRENT) {
      log(`release ${releaseId} remains protected main and requires its matching controller; deferring`);
      return {
        outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
        reason: 'control_plane_mismatch',
        releaseId,
      };
    }

    let superseding;
    try {
      registry.pull(releaseRef);
      const supersedingDigest = registry.resolveDigest(releaseRef);
      if (supersedingDigest === payloadDigest) {
        fail('moving release pointer still resolves to the accepted payload');
      }
      const supersedingRef = `${policy.registry.releaseImage}@${supersedingDigest}`;
      const supersedingDir = path.join(
        policy.paths.workDir,
        supersedingDigest.replace('sha256:', ''),
      );
      const extractedSuperseding = registry.extractReleasePayload({
        reference: supersedingRef,
        destinationDir: supersedingDir,
      });
      const supersedingEnvelope = parseReleaseManifestBytes({
        bytes: extractedSuperseding.manifestBytes,
        policy,
      });
      const verifiedSuperseding = verifyReleaseManifest({
        envelope: supersedingEnvelope,
        policy,
        schemaPolicy,
        nowMs: clock(),
        verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
      });
      if (!state.lastAcceptedRunId
          || BigInt(verifiedSuperseding.payload.source.runId)
            <= BigInt(state.lastAcceptedRunId)
          || verifiedSuperseding.payload.source.sha !== retainedHead.headSha
          || verifiedSuperseding.releaseId === releaseId
          || canonicalJson(verifiedSuperseding.payload.controlPlane)
            !== canonicalJson(controlPlane)) {
        fail('moving release pointer is not the installed protected-head successor');
      }
      verifyComposeBytes({
        payload: verifiedSuperseding.payload,
        bytes: extractedSuperseding.composeBytes,
        policy,
      });
      superseding = {
        digest: supersedingDigest,
        releaseId: verifiedSuperseding.releaseId,
        sourceSha: verifiedSuperseding.payload.source.sha,
      };
    } catch {
      log(`release ${releaseId} has no verified installed-controller successor; deferring`);
      return {
        outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
        reason: 'protected_head_supersession_unavailable',
        releaseId,
      };
    }

    // Only the exact accepted staging project may be touched here. Production
    // has not entered a mutation-admitting state, so no backup, migration, image
    // switch, or rollback is permitted on this controller-transition path.
    verifyComposeBytes({ payload, bytes: extracted.composeBytes, policy });
    if (typeof extracted.payloadDir !== 'string' || extracted.payloadDir !== workDir) {
      fail('release payload materialization directory does not match its immutable digest root');
    }
    const retainedPlanDir = materializeMigrationPlan({
      payload,
      releaseId,
      payloadDir: extracted.payloadDir,
    });
    const retainedImages = {
      backend: { ...payload.images.backend },
      contentEngine: { ...payload.images.contentEngine },
    };
    const retainedReleaseIdentity = {
      releaseId,
      sourceSha: payload.source.sha,
      backendImageDigest: retainedImages.backend.digest,
    };
    const successorHead = verifyProtectedHeadFor(superseding.sourceSha);
    if (successorHead.result !== PROTECTED_HEAD_RESULTS.CURRENT
        || successorHead.headSha !== superseding.sourceSha) {
      log(`release ${releaseId} successor no longer matches protected main; deferring`);
      return {
        outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
        reason: 'protected_head_supersession_unavailable',
        releaseId,
      };
    }
    const retired = await retireAcceptedPreProduction({
      composeFile: extracted.composePath,
      planDir: retainedPlanDir,
      images: retainedImages,
      releaseIdentity: retainedReleaseIdentity,
    });
    if (retired.result) return retired.result;
    if (!retired.accepted) {
      return {
        outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
        reason: 'accepted_preproduction_state_changed',
        releaseId,
      };
    }
    return {
      outcome: DEPLOYMENT_OUTCOMES.SUPERSEDED,
      reason: 'signed_current_pointer_superseded_incompatible_candidate',
      releaseId,
      supersededBy: superseding.releaseId,
    };
  }
  if (!controlPlaneMatches) {
    log(`release ${releaseId} requires an attended control-plane upgrade; deferring`);
    return {
      outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
      reason: 'control_plane_mismatch',
      releaseId,
    };
  }
  // A controller-incompatible publication may be discovered and signature
  // checked, but it cannot mutate deployment state, Compose, application image
  // retention, or remove existing cache entries. Only the immutable discovery
  // payload needed to read the signature has been materialized at this point.
  verifyComposeBytes({ payload, bytes: extracted.composeBytes, policy });
  let controllerOnlyAuthorized = false;
  if (!payload.migrations.cdEligibility.eligible) {
    let completedReceipt = null;
    try {
      completedReceipt = effective.source === 'receipt' && effective.releaseId
        ? store.readReceipt(effective.releaseId)
        : null;
    } catch {
      completedReceipt = null;
    }
    if (controllerOnlyTransitionContextMatches({
      payload,
      installedControlPlane: controlPlane,
      state,
      effective,
      completedReceipt,
    })) {
      try {
        const retainedPayload = verifyControllerOnlyRetainedPayload({
          policy,
          registry,
          state,
          completedReceipt,
        });
        controllerOnlyAuthorized = isControllerOnlyReleaseTransition({
          payload,
          installedControlPlane: controlPlane,
          state,
          effective,
          completedReceipt,
          retainedPayload,
        });
      } catch {
        log(`release ${releaseId} retained active payload could not authorize a controller-only transition`);
      }
    }
  }
  // Controller-only proof may materialize the exact retained active payload,
  // but no deployment state, application image, or Compose operation occurs
  // until that signed comparison has finished.
  prunePayloadDiscoveryArtifacts();
  const composeFile = extracted.composePath;
  if (typeof extracted.payloadDir !== 'string' || extracted.payloadDir !== workDir) {
    fail('release payload materialization directory does not match its immutable digest root');
  }
  const planDir = materializeMigrationPlan({
    payload,
    releaseId: verified.releaseId,
    payloadDir: extracted.payloadDir,
  });
  const images = {
    backend: { ...payload.images.backend },
    contentEngine: { ...payload.images.contentEngine },
  };
  const candidateReleaseIdentity = {
    releaseId,
    sourceSha: payload.source.sha,
    backendImageDigest: images.backend.digest,
  };

  function verifyProtectedHead() {
    return verifyProtectedHeadFor(payload.source.sha);
  }

  async function abandonPreProduction({ bootstrapTarget, supersededBy = null, reason }) {
    const retired = await retireAcceptedPreProduction({
      composeFile,
      planDir,
      images,
      releaseIdentity: candidateReleaseIdentity,
      blockReason: bootstrapTarget ? BLOCK_REASONS.BOOTSTRAP_TARGET_ABANDONED : null,
    });
    if (retired.result) return retired.result;
    if (!retired.accepted && bootstrapTarget) {
      // A one-shot owner authorization that is stale or unverifiable must not
      // silently become authorization for a later head. Bind a durable owner
      // action even when first acceptance has not yet written active state.
      store.block({ releaseId, reason: BLOCK_REASONS.BOOTSTRAP_TARGET_ABANDONED });
    }

    if (bootstrapTarget) {
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'bootstrap_revalidation',
          outcome: 'blocked',
          failureCode: reason,
          rollbackResult: 'not_required',
          actionRequired: 're-quiesce both databases and create a baseline for the current protected head',
        },
      });
      return {
        outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
        reason: 'bootstrap_target_abandoned',
        releaseId,
      };
    }
    return {
      outcome: DEPLOYMENT_OUTCOMES.SUPERSEDED,
      reason,
      releaseId,
      ...(supersededBy ? { supersededBy } : {}),
    };
  }

  // There is no container predecessor before the first successful cutover.
  // Unattended production mutation is therefore impossible to recover with the
  // normal image-pair rollback. The timer stops here. A one-shot owner command
  // must opt in explicitly and present a fresh root-owned baseline proving both
  // quiesced databases, their complete filename+byte inventory, and their exact
  // pre-cutover identity. This authorization never applies after a predecessor
  // exists and never becomes a persistent environment toggle.
  const firstContainerCutover = state.predecessor === null;
  let bootstrapAuthorized = false;
  let bootstrapBaselineDigest = null;
  let bootstrapProductionRevalidated = false;
  if (firstContainerCutover && !allowFirstContainerBootstrap) {
    log('first container release requires an owner-authorized bootstrap baseline');
    return {
      outcome: DEPLOYMENT_OUTCOMES.HALTED,
      reason: 'first_container_bootstrap_authorization_required',
      releaseId,
    };
  }

  // The signed source SHA is admissible only while it is the exact public
  // protected-main head. A cancelled older publisher may push :main after a
  // newer workflow, so registry tag order is discovery, never freshness proof.
  const initialHead = verifyProtectedHead();
  if (initialHead.result === PROTECTED_HEAD_RESULTS.UNAVAILABLE) {
    log(`release ${releaseId} protected-head verification is unavailable; deferring`);
    return {
      outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
      reason: 'protected_head_unavailable',
      releaseId,
    };
  }
  if (initialHead.result === PROTECTED_HEAD_RESULTS.MISMATCH) {
    log(`release ${releaseId} is not the current protected-main head`);
    if (resumingAcceptedPayload || firstContainerCutover) {
      return abandonPreProduction({
        bootstrapTarget: firstContainerCutover,
        supersededBy: initialHead.headSha,
        reason: 'protected_head_changed',
      });
    }
    return {
      outcome: DEPLOYMENT_OUTCOMES.SUPERSEDED,
      reason: 'protected_head_changed',
      releaseId,
      supersededBy: initialHead.headSha,
    };
  }

  let governanceOnlyAuthorization = {
    requested: false,
    authorized: false,
    reason: null,
    digest: null,
    core: null,
    record: null,
  };
  const governanceOnlyReasonSet = isGovernanceOnlyReasonSet(payload.migrations);
  if (governanceOnlyReleaseId !== null && !governanceOnlyReasonSet) {
    const reason = payload.migrations.cdEligibility.eligible
      ? 'governance_only_authorization_not_required'
      : 'governance_only_authorization_reason_not_governed';
    log(`release ${releaseId} governance-only authorization refused: ${reason}`);
    return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason, releaseId };
  }
  let governancePreflight = null;
  if (governanceOnlyReasonSet
      && (!firstContainerCutover || governanceOnlyReleaseId !== null)) {
    const ledger = databaseProbe.readAppliedMigrations({ environment: 'production' });
    if (!ledger.ok) {
      const reason = 'governance_only_authorization_ledger_unreadable';
      log(`release ${releaseId} governance-only preflight refused: ${reason}`);
      return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason, releaseId };
    }
    governancePreflight = reconcileMigrationLedger({
      inventory: payload.migrations.inventory,
      appliedFiles: ledger.applied,
      legacyRows: payload.migrations.reconciliation.environments.production.legacyRows,
    });
    if (governancePreflight.admitted) {
      const productionLedgerDigest = sha256(canonicalJson({
        schema: 'nexus.release-governance-production-ledger.v1',
        appliedFiles: [...ledger.applied].sort(),
        reconciliation: governancePreflight,
      }));
      const evaluated = evaluateGovernanceOnlyReleaseAuthorization({
        authorizedReleaseId: governanceOnlyReleaseId ?? releaseId,
        ownerAuthorized: governanceOnlyReleaseId === null ? true : ownerAuthorized,
        releaseId,
        predecessorReleaseId: state.predecessor?.releaseId ?? null,
        releasePayloadDigest: payloadDigest,
        manifestDigest: verified.manifestDigest,
        migrations: payload.migrations,
        productionLedgerDigest,
        productionReconciliation: governancePreflight,
      });
      if (!evaluated.authorized) {
        log(
          `release ${releaseId} governance-only authorization refused: ${evaluated.reason}`,
        );
        return {
          outcome: DEPLOYMENT_OUTCOMES.HALTED,
          reason: evaluated.reason,
          releaseId,
        };
      }
      let record;
      if (governanceOnlyReleaseId !== null) {
        record = store.writeGovernanceOnlyAuthorization(evaluated.core);
      } else {
        record = store.readGovernanceOnlyAuthorization(releaseId);
        if (record === null) {
          const reason = 'governance_only_authorization_required';
          log(`release ${releaseId} awaits exact owner governance-only authorization`);
          return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason, releaseId };
        }
      }
      if (!governanceAuthorizationMatchesCore(record, evaluated.core)) {
        const reason = 'governance_only_authorization_evidence_mismatch';
        log(`release ${releaseId} governance-only authorization refused: ${reason}`);
        return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason, releaseId };
      }
      governanceOnlyAuthorization = {
        ...evaluated,
        digest: record.authorizationDigest,
        record,
      };
    } else if (governanceOnlyReleaseId !== null) {
      const reason = 'governance_only_authorization_pending_inventory_not_compatible';
      log(`release ${releaseId} governance-only authorization refused: ${reason}`);
      return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason, releaseId };
    }
  }

  if (firstContainerCutover) {
    try {
      const verifier = resumingAcceptedPayload
        ? bootstrap?.verifyProduction
        : bootstrap?.verify;
      const result = verifier?.({
        policy,
        manifestPayload: payload,
        releaseId,
        releasePayloadDigest: payloadDigest,
        manifestDigest: verified.manifestDigest,
        now: clock,
      });
      const calculatedBaselineDigest = result?.baseline
        ? sha256(canonicalJson(result.baseline))
        : null;
      if (!result || result.passed !== true
          || !/^[0-9a-f]{64}$/.test(String(result.baselineDigest ?? ''))
          || result.baselineDigest !== calculatedBaselineDigest
          || result.baseline?.target?.releaseId !== releaseId
          || result.baseline?.target?.sourceSha !== payload.source.sha
          || result.baseline?.target?.releasePayloadDigest !== payloadDigest
          || result.baseline?.target?.manifestDigest !== verified.manifestDigest) {
        throw new Error('bootstrap baseline verification did not pass');
      }
      bootstrapAuthorized = true;
      bootstrapBaselineDigest = result.baselineDigest;
      log(`release ${releaseId} admitted as an owner-authorized first-container bootstrap`);
    } catch {
      log('first container bootstrap baseline verification failed');
      return abandonPreProduction({
        bootstrapTarget: true,
        reason: 'first_container_bootstrap_baseline_invalid',
      });
    }
  }

  if (store.isRejected(releaseId)) {
    // Failed digests stay blocked. Retrying the identical release unattended
    // would just re-run a known failure every 30 seconds.
    log(`release ${releaseId} was already rejected; refusing to retry the same digests`);
    return { outcome: DEPLOYMENT_OUTCOMES.REFUSED, reason: 'previously_failed_digests', releaseId };
  }

  // A settled receipt for THIS candidate is proof it already ran, whatever the
  // currently active release is. Checking only the active release's receipt let a
  // still-fresh signed manifest for an earlier release be replayed after a newer
  // one completed.
  let historicalReceipt = null;
  try {
    historicalReceipt = store.readReceipt(releaseId);
  } catch {
    log(`release ${releaseId} has an unreadable receipt; refusing to act on it`);
    return { outcome: DEPLOYMENT_OUTCOMES.HALTED, reason: 'unreadable_candidate_receipt', releaseId };
  }
  if (historicalReceipt) {
    log(`release ${releaseId} already has a settled receipt (${historicalReceipt.outcome})`);
    return {
      outcome: DEPLOYMENT_OUTCOMES.REFUSED,
      reason: `already_settled_${historicalReceipt.outcome}`,
      releaseId,
    };
  }

  // Durable monotonic source ordering. Run ids increase per repository, so a
  // manifest at or below the last accepted run is a replay or an out-of-order
  // publish. This refuses before any image pull or environment call.
  const resumablePreProduction = effective.releaseId === releaseId
    && [RELEASE_STATUSES.ELIGIBLE, RELEASE_STATUSES.STAGING_HEALTHY]
      .includes(effective.status)
    && state.lastAcceptedRunId === payload.source.runId;
  if (store.isStaleRunId(payload.source.runId) && !resumablePreProduction) {
    log(`release ${releaseId} carries a non-monotonic run id; refusing`);
    return { outcome: DEPLOYMENT_OUTCOMES.REFUSED, reason: 'non_monotonic_source_order', releaseId };
  }

  if (effective.releaseId === releaseId && effective.status === RELEASE_STATUSES.COMPLETED) {
    return { outcome: DEPLOYMENT_OUTCOMES.NOOP, reason: 'already_completed', releaseId };
  }

  async function finish({
    outcome,
    failureCode,
    staging,
    production,
    backupResult,
    rollbackResult,
    notifyKind,
    notifyRelease,
  }) {
    const recoveryNotificationTiming = rollbackResult
      && rollbackResult.result !== 'not_required'
      ? {
        incidentRecoverySeconds: rollbackResult.incidentRecoveryDurationMs / 1000,
        predecessorSwitchSeconds: rollbackResult.predecessorSwitchDurationMs / 1000,
        predecessorSwitchObjectiveSeconds:
          rollbackResult.predecessorSwitchObjectiveSeconds,
      }
      : {};
    const receipt = buildReceipt({
      payload,
      releaseId,
      releasePayloadDigest: payloadDigest,
      verified,
      createdAt: startedAt,
      completedAt: iso(),
      staging,
      production,
      backup: backupResult,
      rollback: rollbackResult,
      outcome,
      failureCode,
      policy,
    });
    // The receipt is written after production may already have been mutated, so a
    // write failure must not escape as an exception: that would abort the poller
    // with production in a state no receipt describes. Block instead, and alert.
    let written;
    try {
      written = store.writeReceipt(receipt);
    } catch (error) {
      log(`release ${releaseId} receipt could not be written; halting deployments`);
      try {
        store.block({ releaseId, reason: BLOCK_REASONS.RECEIPT_UNWRITABLE });
      } catch {
        // state is already unwritable; the notification is the only channel left
      }
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'receipt',
          outcome: 'receipt_unwritable',
          failureCode: sanitizeDetail(error instanceof Error ? error.message : 'receipt write failed'),
          rollbackResult: rollbackResult?.result ?? 'unknown',
          actionRequired: 'deployment halted; the release outcome has no durable receipt',
          ...recoveryNotificationTiming,
        },
      });
      return {
        outcome,
        releaseId,
        receiptDigest: null,
        receiptPath: null,
        receiptWriteFailed: true,
      };
    }

    // The mirror runs after the receipt exists and can never change the verdict.
    const mirrored = mirror.mirrorReceipt({ receiptPath: written.path, releaseId });
    // `deferred` means queued for retry, which is not an incident. Only an
    // exhausted queue entry — a receipt that will never reach the audit host
    // without intervention — raises an alert.
    if (mirrored.result === 'failed') {
      log('release audit mirror failed; deployment verdict is unchanged');
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'audit_mirror',
          outcome: 'mirror_failed',
          failureCode: mirrored.detail,
          rollbackResult: 'not_applicable',
          actionRequired: 'investigate the audit mirror; the release verdict stands',
        },
      });
    }

    if (notifyKind) {
      await notifier.send({
        kind: notifyKind,
        release: { ...notifyRelease, ...recoveryNotificationTiming },
      });
    }
    return { outcome, releaseId, receiptDigest: written.digest, receiptPath: written.path, mirrored };
  }

  if (!payload.migrations.cdEligibility.eligible
      && !bootstrapAuthorized
      && !controllerOnlyAuthorized
      && !governanceOnlyAuthorization.authorized) {
    // Contract and destructive migrations require a separate owner-authorized
    // maintenance transaction. That container transaction is intentionally not
    // implemented until its authority, drain, and database-restore policy is
    // approved; blocking here keeps every existing path from becoming a bypass.
    //
    // Record the incompatible files as unresolved *before* blocking. Acknowledging
    // the block clears the incident, not the pending migration, so a later
    // unrelated release cannot inherit a clean slate.
    const incompatible = payload.migrations.inventory
      .filter((entry) => !entry.predecessorCompatible)
      .map((entry) => entry.file);
    if (incompatible.length > 0) {
      store.recordUnresolvedContractMigrations({ releaseId, files: incompatible });
    }
    store.block({ releaseId, reason: BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.MIGRATION_NOT_ELIGIBLE,
      staging: emptyPhase(),
      production: emptyPhase(),
      backupResult: { result: 'skipped', artifact: null },
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'eligibility',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.MIGRATION_NOT_ELIGIBLE,
        rollbackResult: 'not_required',
        actionRequired: 'owner decision required; the container maintenance path is not implemented',
      },
    });
  }
  if (!payload.migrations.cdEligibility.eligible && bootstrapAuthorized) {
    // The fresh owner baseline binds the exact environment-specific legacy
    // rows, proves every pending inventory byte predecessor-compatible under
    // the digest-scoped policy, applies those bytes to descriptor snapshots in
    // memory, and proves production/staging semantic convergence while retaining
    // staging fixture data. No other summary-ineligible release can use this
    // one-shot first-cutover exception.
    log(`release ${releaseId} owner bootstrap authorizes the semantically rehearsed pending inventory`);
  }
  if (controllerOnlyAuthorized) {
    log(
      `release ${releaseId} controller-only transition authorized by exact retained signed `
      + 'image, Compose, migration inventory, reconciliation, and count equality',
    );
  }
  if (governanceOnlyAuthorization.authorized) {
    log(
      `release ${releaseId} admitted by exact one-shot governance-only authorization `
      + `sha256:${governanceOnlyAuthorization.digest}`,
    );
  }

  // Once eligibility has been proved, bound application images for every
  // recovery-relevant role before accepting the attempt into release state.
  registry.pruneImages({
    repository: payload.images.backend.repository,
    keepDigests: [...new Set([
      payload.images.backend.digest,
      state.active?.images?.backend?.digest,
      state.predecessor?.images?.backend?.digest,
      state.active?.rollbackTarget?.images?.backend?.digest,
    ].filter(Boolean))],
  });
  registry.pruneImages({
    repository: payload.images.contentEngine.repository,
    keepDigests: [...new Set([
      payload.images.contentEngine.digest,
      state.active?.images?.contentEngine?.digest,
      state.predecessor?.images?.contentEngine?.digest,
      state.active?.rollbackTarget?.images?.contentEngine?.digest,
    ].filter(Boolean))],
  });

  store.beginAttempt({
    manifestPayload: payload,
    releaseId,
    payloadDigest,
    manifestDigest: verified.manifestDigest,
    keyId: policy.trust.signingKeyId,
  });
  store.recordAcceptedRunId(payload.source.runId);

  registry.pull(`${images.backend.repository}@${images.backend.digest}`);
  registry.pull(`${images.contentEngine.repository}@${images.contentEngine.digest}`);

  const composeCheck = registry.composeConfigValid({
    composeFile,
    planDir,
    environment: 'staging',
    images,
    releaseIdentity: candidateReleaseIdentity,
  });
  if (!composeCheck.ok) {
    store.reject({ releaseId, reason: 'compose_invalid' });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.STAGING_FAILED,
      failureCode: FAILURE_CODES.COMPOSE_INVALID,
      staging: phase('failed', [], 0),
      production: emptyPhase(),
      backupResult: { result: 'skipped', artifact: null },
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'staging',
        outcome: 'failed',
        failureCode: FAILURE_CODES.COMPOSE_INVALID,
        rollbackResult: 'not_required',
      },
    });
  }

  // ── staging ────────────────────────────────────────────────────────────────
  const stagingStart = clock();
  const stagingChecks = [];
  if (controllerOnlyAuthorized) {
    stagingChecks.push({
      name: 'controller_only_transition',
      result: 'passed',
      durationMs: 0,
      detail: 'controller_only_transition',
    });
  }
  if (bootstrapAuthorized) {
    stagingChecks.push({
      name: 'owner_bootstrap_baseline',
      result: 'passed',
      durationMs: 0,
      detail: `sha256:${bootstrapBaselineDigest}`,
    });
  }
  if (governanceOnlyAuthorization.authorized) {
    stagingChecks.push({
      name: 'owner_governance_only_authorization',
      result: 'passed',
      durationMs: 0,
      detail: `sha256:${governanceOnlyAuthorization.digest}`,
    });
  }

  const stagingMigrator = registry.composeRunMigrator({
    composeFile,
    planDir,
    environment: 'staging',
    images,
    releaseIdentity: candidateReleaseIdentity,
    timeoutMs: policy.timing.migratorTimeoutSeconds * 1000,
  });
  stagingChecks.push({
    name: 'staging_migrator',
    result: stagingMigrator.status === 0 ? 'passed' : 'failed',
    durationMs: clock() - stagingStart,
    detail: stagingMigrator.status === 0 ? null : sanitizeDetail(`exit ${stagingMigrator.status}`),
  });

  let stagingFailure = stagingMigrator.status === 0 ? null : FAILURE_CODES.STAGING_MIGRATOR;

  if (!stagingFailure) {
    const up = registry.composeUp({
      composeFile,
      planDir,
      environment: 'staging',
      images,
      releaseIdentity: candidateReleaseIdentity,
      timeoutMs: policy.timing.stagingHealthBudgetSeconds * 1000,
    });
    const healthy = await health.waitUntilHealthy({
      backendPort: policy.environments.staging.backendPort,
      contentEnginePort: policy.environments.staging.contentEnginePort,
      budgetSeconds: policy.timing.stagingHealthBudgetSeconds,
    });
    stagingChecks.push(...healthy.checks);
    if (up.status !== 0 || !healthy.healthy) stagingFailure = FAILURE_CODES.STAGING_UNHEALTHY;
  }

  if (!stagingFailure) {
    const smoke = await health.apiSmoke({ port: policy.environments.staging.backendPort });
    const publicStatus = await health.backendPublicStatus({
      port: policy.environments.staging.backendPort,
    });
    stagingChecks.push(smoke, publicStatus);
    if (smoke.result !== 'passed' || publicStatus.result !== 'passed') {
      stagingFailure = FAILURE_CODES.STAGING_SMOKE;
    }
  }

  if (stagingFailure) {
    // A staging failure can never reach production. The staging stack is torn
    // down so the next candidate starts from a clean rehearsal.
    let teardown;
    try {
      teardown = registry.composeDown({
        composeFile,
        planDir,
        environment: 'staging',
        images,
        releaseIdentity: candidateReleaseIdentity,
      });
    } catch {
      teardown = { status: 1 };
    }
    if (!teardown || teardown.status !== 0) {
      store.block({
        releaseId,
        reason: BLOCK_REASONS.PREPRODUCTION_TEARDOWN_FAILED,
      });
      await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'preproduction_teardown',
          outcome: 'blocked',
          failureCode: FAILURE_CODES.PREPRODUCTION_TEARDOWN,
          rollbackResult: 'not_required',
          actionRequired: 'inspect and remove the exact staging project before resuming',
        },
      });
      return {
        outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
        reason: 'preproduction_teardown_failed',
        releaseId,
      };
    }
    store.reject({ releaseId, reason: 'staging_failed' });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.STAGING_FAILED,
      failureCode: stagingFailure,
      staging: phase('failed', stagingChecks, clock() - stagingStart),
      production: emptyPhase(),
      backupResult: { result: 'skipped', artifact: null },
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'staging',
        outcome: 'failed',
        failureCode: stagingFailure,
        rollbackResult: 'not_required',
      },
    });
  }

  const stagingPhase = phase('passed', stagingChecks, clock() - stagingStart);
  store.recordStatus({
    manifestPayload: payload,
    releaseId,
    payloadDigest,
    manifestDigest: verified.manifestDigest,
    keyId: policy.trust.signingKeyId,
    status: RELEASE_STATUSES.STAGING_HEALTHY,
    evidence: 'staging healthy',
  });

  // ── protected-head pre-production boundary ────────────────────────────────
  // Cancellation cannot atomically stop a losing workflow from pushing the
  // moving registry tag. Re-resolve the public protected ref after staging and
  // retire this exact candidate before any backup or production mutation when
  // its signed source SHA is no longer current.
  const promotionHead = verifyProtectedHead();
  if (promotionHead.result === PROTECTED_HEAD_RESULTS.UNAVAILABLE) {
    log('protected-head verification failed before promotion; deferring promotion');
    return {
      outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
      reason: 'protected_head_unavailable',
      releaseId,
    };
  }
  if (promotionHead.result === PROTECTED_HEAD_RESULTS.MISMATCH) {
    log(`release ${releaseId} protected head advanced before production promotion`);
    return abandonPreProduction({
      bootstrapTarget: bootstrapAuthorized,
      supersededBy: promotionHead.headSha,
      reason: 'protected_head_changed',
    });
  }

  if (bootstrapAuthorized) {
    log(`release ${releaseId} remains the exact owner-authorized protected-head target`);
  } else {
    // The tag is now only an optional same-head publication hint. If a cancelled
    // older workflow overwrote it, its signed source SHA differs from the public
    // head and is ignored. The already-pulled, already-verified candidate remains
    // sufficient when tag refresh is unavailable.
    try {
      registry.pull(releaseRef);
      const recheckDigest = registry.resolveDigest(releaseRef);
      if (recheckDigest !== payloadDigest) {
        const pointer = registry.extractReleasePayload({
          reference: `${policy.registry.releaseImage}@${recheckDigest}`,
          destinationDir: path.join(policy.paths.workDir, recheckDigest.replace('sha256:', '')),
        });
        const pointerEnvelope = parseReleaseManifestBytes({
          bytes: pointer.manifestBytes,
          policy,
        });
        const pointerVerified = verifyReleaseManifest({
          envelope: pointerEnvelope,
          policy,
          schemaPolicy,
          nowMs: clock(),
          verificationMode: RELEASE_MANIFEST_VERIFICATION_MODES.CANDIDATE,
        });
        if (pointerVerified.payload.source.sha !== promotionHead.headSha) {
          log('ignoring moving release pointer whose signed source is not protected-main head');
        } else if (releaseIdFor(pointerVerified.payload) !== releaseId) {
          log(`release ${releaseId} superseded by a same-head publication before production`);
          return abandonPreProduction({
            bootstrapTarget: false,
            supersededBy: pointerVerified.releaseId,
            reason: 'same_head_publication_changed',
          });
        } else {
          log(`release ${releaseId} remains current after a same-content publication`);
        }
      }
    } catch {
      log('moving release pointer is unavailable or invalid; exact protected-head candidate remains admitted');
    }
  }

  // Staging can take long enough for an accidentally restarted PM2 process or
  // another SQLite handle to invalidate the owner's quiesced first-cutover
  // boundary. Recheck the legacy and target production snapshots immediately
  // before backup/migration. The baseline digest must be the same authorization
  // admitted before staging; a fresh or substituted file cannot widen it.
  if (bootstrapAuthorized) {
    try {
      const revalidated = bootstrap?.verifyProduction({
        policy,
        manifestPayload: payload,
        releaseId,
        releasePayloadDigest: payloadDigest,
        manifestDigest: verified.manifestDigest,
        now: clock,
      });
      const calculatedBaselineDigest = revalidated?.baseline
        ? sha256(canonicalJson(revalidated.baseline))
        : null;
      if (!revalidated || revalidated.passed !== true
          || revalidated.baselineDigest !== bootstrapBaselineDigest
          || revalidated.baselineDigest !== calculatedBaselineDigest) {
        throw new Error('bootstrap production boundary changed');
      }
      bootstrapProductionRevalidated = true;
    } catch {
      // The baseline authorized only this exact quiesced boundary. Tear staging
      // down and retire the target atomically with an owner-action block. If the
      // teardown itself fails, retain active state and hard-block instead.
      return abandonPreProduction({
        bootstrapTarget: true,
        reason: 'first_container_bootstrap_baseline_changed',
      });
    }
  }

  // ── production ─────────────────────────────────────────────────────────────
  // The environment names which database the receipt must cover.
  // Re-prove after staging so a stale reload or replaced installed unit cannot
  // enter the backup/production boundary on the strength of an earlier check.
  proveInstalledBackupInterface();
  const backupResult = backup.createPreMigrationBackup({ environment: 'production' });
  let verifiedBackup = backupResult.result === 'passed' && backupResult.evidence
    ? reverifyBackupEvidence({
      backup,
      expected: backupResult.evidence,
      requiredArtifact: backupResult.artifact,
    })
    : { ok: false, evidence: null, detail: backupResult.detail };
  if (backupResult.result !== 'passed' || !verifiedBackup.ok) {
    // Nothing in production has been touched yet, so this is a clean stop.
    store.block({ releaseId, reason: BLOCK_REASONS.DATABASE_INTEGRITY });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.BACKUP_FAILED,
      staging: stagingPhase,
      production: emptyPhase(),
      backupResult: { result: 'failed', artifact: null },
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'backup',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.BACKUP_FAILED,
        rollbackResult: 'not_required',
        actionRequired: 'production was not modified; fix the backup unit before releasing',
      },
    });
  }

  // Persist the complete verified identity immediately, not only its basename
  // and not only immediately before the migrator. Any later clean stop or crash
  // therefore retains exactly which recovery artifact this attempt accepted.
  store.recordStatus({
    manifestPayload: payload,
    releaseId,
    payloadDigest,
    manifestDigest: verified.manifestDigest,
    keyId: policy.trust.signingKeyId,
    status: RELEASE_STATUSES.STAGING_HEALTHY,
    evidence: 'production backup verified',
    backupEvidence: verifiedBackup.evidence,
  });

  const productionStart = clock();
  const productionChecks = [];
  if (bootstrapProductionRevalidated) {
    productionChecks.push({
      name: 'bootstrap_production_revalidation',
      result: 'passed',
      durationMs: 0,
      detail: `sha256:${bootstrapBaselineDigest}`,
    });
  }

  // ── reconcile the signed inventory with the production ledger ─────────────
  // Eligibility computed from a Git delta answers "what did this release
  // change?". The migrator applies "what has the ledger not recorded?". Those
  // sets differ whenever an earlier release was blocked, so this reconciliation
  // is the gate that stops an unrelated release from carrying a previously
  // blocked contract migration into production.
  const ledger = databaseProbe.readAppliedMigrations({ environment: 'production' });
  if (!ledger.ok) {
    store.block({ releaseId, reason: BLOCK_REASONS.DATABASE_INTEGRITY });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.LEDGER_UNREADABLE,
      staging: stagingPhase,
      production: phase('failed', [{
        name: 'production_ledger_read', result: 'failed', durationMs: 0, detail: ledger.detail,
      }], clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'not_required', restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'ledger_reconciliation',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.LEDGER_UNREADABLE,
        rollbackResult: 'not_required',
        actionRequired: 'production was not modified; investigate the database ledger',
      },
    });
  }

  const reconciliation = reconcileMigrationLedger({
    inventory: payload.migrations.inventory,
    appliedFiles: ledger.applied,
    legacyRows: payload.migrations.reconciliation.environments.production.legacyRows,
  });
  productionChecks.push({
    name: 'production_ledger_reconciliation',
    result: reconciliation.admitted ? 'passed' : 'failed',
    durationMs: 0,
    detail: reconciliation.admitted
      ? sanitizeDetail(`${reconciliation.pending.length} pending, all predecessor compatible`)
      : sanitizeDetail(reconciliation.reasons[0] ?? 'reconciliation refused'),
  });

  if (governanceOnlyAuthorization.authorized) {
    const currentLedgerDigest = sha256(canonicalJson({
      schema: 'nexus.release-governance-production-ledger.v1',
      appliedFiles: [...ledger.applied].sort(),
      reconciliation,
    }));
    const authorizationStillExact = reconciliation.admitted
      && currentLedgerDigest === governanceOnlyAuthorization.record.productionLedgerDigest
      && canonicalJson(reconciliation.pending)
        === canonicalJson(governanceOnlyAuthorization.record.pendingFiles);
    productionChecks.push({
      name: 'governance_only_authorization_revalidation',
      result: authorizationStillExact ? 'passed' : 'failed',
      durationMs: 0,
      detail: authorizationStillExact
        ? `sha256:${governanceOnlyAuthorization.digest}`
        : sanitizeDetail(FAILURE_CODES.GOVERNANCE_AUTHORIZATION_CHANGED),
    });
    if (!authorizationStillExact) {
      store.block({ releaseId, reason: BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE });
      return finish({
        outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
        failureCode: FAILURE_CODES.GOVERNANCE_AUTHORIZATION_CHANGED,
        staging: stagingPhase,
        production: phase('failed', productionChecks, clock() - productionStart),
        backupResult,
        rollbackResult: {
          result: 'not_required', restored: null,
          incidentRecoveryDurationMs: 0,
          predecessorSwitchDurationMs: 0,
          predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
        },
        notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        notifyRelease: {
          releaseId,
          sourceSha: payload.source.sha,
          phase: 'ledger_reconciliation',
          outcome: 'blocked',
          failureCode: FAILURE_CODES.GOVERNANCE_AUTHORIZATION_CHANGED,
          rollbackResult: 'not_required',
          actionRequired: 'production was not modified; inspect and reauthorize the exact release',
        },
      });
    }
  }

  if (!reconciliation.admitted) {
    // Recorded on state so an acknowledgement of the block cannot erase the fact
    // that an incompatible migration is still pending. A refusal caused only by an
    // unknown *applied* migration has no pending contract files to record — the
    // ledger is ahead of the release, which is a different problem.
    if (reconciliation.blocking.length > 0) {
      store.recordUnresolvedContractMigrations({
        releaseId,
        files: reconciliation.blocking.map((entry) => entry.file),
      });
    }
    store.block({ releaseId, reason: BLOCK_REASONS.MIGRATION_NOT_CD_ELIGIBLE });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.PENDING_NOT_COMPATIBLE,
      staging: stagingPhase,
      production: phase('failed', productionChecks, clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'not_required', restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'ledger_reconciliation',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.PENDING_NOT_COMPATIBLE,
        rollbackResult: 'not_required',
        actionRequired: 'owner decision required; the container maintenance path is not implemented',
      },
    });
  }

  // Ledger reconciliation can take time after fresh admission. Re-open the
  // exact carried artifact once more immediately before mutation-admitting
  // write-ahead; never reconstruct this decision from the moving receipt
  // pointer, and never begin migration if those exact bytes disappeared.
  const writeAheadBackup = reverifyBackupEvidence({
    backup,
    expected: verifiedBackup.evidence,
    requiredArtifact: backupResult.artifact,
  });
  if (!writeAheadBackup.ok) {
    store.block({ releaseId, reason: BLOCK_REASONS.DATABASE_INTEGRITY });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.BACKUP_FAILED,
      staging: stagingPhase,
      production: phase('failed', productionChecks, clock() - productionStart),
      backupResult: { result: 'failed', artifact: null },
      rollbackResult: {
        result: 'not_required', restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'backup',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.BACKUP_FAILED,
        rollbackResult: 'not_required',
        actionRequired: 'production was not modified; restore the exact admitted backup artifact',
      },
    });
  }
  verifiedBackup = writeAheadBackup;

  // Backup production and reconciling its ledger can consume most of the
  // promotion budget. Rebind the signed source to the public protected head at
  // the last non-mutating boundary: the next durable write admits that the
  // migrator may have changed production. A lookup outage remains a clean
  // deferred staging state; a changed head retires this exact staging target.
  const mutationHead = verifyProtectedHead();
  if (mutationHead.result === PROTECTED_HEAD_RESULTS.UNAVAILABLE) {
    log('protected-head verification failed before production mutation; deferring promotion');
    return {
      outcome: DEPLOYMENT_OUTCOMES.DEFERRED,
      reason: 'protected_head_unavailable',
      releaseId,
    };
  }
  if (mutationHead.result === PROTECTED_HEAD_RESULTS.MISMATCH) {
    log(`release ${releaseId} protected head advanced before production mutation`);
    return abandonPreProduction({
      bootstrapTarget: bootstrapAuthorized,
      supersededBy: mutationHead.headSha,
      reason: 'protected_head_changed',
    });
  }

  // Write-ahead: the migrator mutates the database, so mutation-admitting state
  // must be durable before it starts — not after. A crash between this write and
  // a completed migration must look like "production may have been mutated".
  store.recordStatus({
    manifestPayload: payload,
    releaseId,
    payloadDigest,
    manifestDigest: verified.manifestDigest,
    keyId: policy.trust.signingKeyId,
    status: RELEASE_STATUSES.PRODUCTION_OBSERVING,
    evidence: 'production migration starting',
    backupEvidence: verifiedBackup.evidence,
  });

  const productionMigrator = registry.composeRunMigrator({
    composeFile,
    planDir,
    environment: 'production',
    images,
    releaseIdentity: candidateReleaseIdentity,
    timeoutMs: policy.timing.migratorTimeoutSeconds * 1000,
  });
  productionChecks.push({
    name: 'production_migrator',
    result: productionMigrator.status === 0 ? 'passed' : 'failed',
    durationMs: clock() - productionStart,
    detail: productionMigrator.status === 0
      ? null
      : sanitizeDetail(
        `exit ${productionMigrator.status}; class ${classifyMigratorFailure(productionMigrator)}`,
      ),
  });
  if (productionMigrator.status !== 0) {
    // A failed migrator may have applied part of the schema. That is a hard
    // stop: rollback restores images, not the database, so an automatic retry
    // could compound a partially-migrated schema.
    store.block({ releaseId, reason: BLOCK_REASONS.DATABASE_INTEGRITY });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.BLOCKED,
      failureCode: FAILURE_CODES.PRODUCTION_MIGRATOR,
      staging: stagingPhase,
      production: phase('failed', productionChecks, clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'migration',
        outcome: 'blocked',
        failureCode: FAILURE_CODES.PRODUCTION_MIGRATOR,
        rollbackResult: 'not_required',
        actionRequired: `restore from backup ${backupResult.artifact ?? 'unknown'} before retrying`,
      },
    });
  }

  const productionUp = registry.composeUp({
    composeFile,
    planDir,
    environment: 'production',
    images,
    releaseIdentity: candidateReleaseIdentity,
    timeoutMs: policy.timing.healthBudgetSeconds * 1000,
  });
  const productionHealthy = await health.waitUntilHealthy({
    backendPort: policy.environments.production.backendPort,
    contentEnginePort: policy.environments.production.contentEnginePort,
    budgetSeconds: policy.timing.healthBudgetSeconds,
  });
  productionChecks.push(...productionHealthy.checks);

  let productionFailure = (productionUp.status !== 0 || !productionHealthy.healthy)
    ? FAILURE_CODES.PRODUCTION_UNHEALTHY
    : null;

  if (!productionFailure) {
    const observation = await health.observe({
      backendPort: policy.environments.production.backendPort,
      contentEnginePort: policy.environments.production.contentEnginePort,
      observationSeconds: policy.timing.observationSeconds,
      containerHealth: () => registry.composeServiceHealth({
        composeFile,
        planDir,
        environment: 'production',
        images,
        releaseIdentity: candidateReleaseIdentity,
        service: policy.compose.backendService,
      }),
    });
    productionChecks.push(...observation.checks);
    if (!observation.passed) productionFailure = FAILURE_CODES.OBSERVATION_FAILED;
  }

  if (!productionFailure) {
    const identity = verifyRunningImagePair({
      registry,
      policy,
      composeFile,
      planDir,
      images,
      releaseIdentity: candidateReleaseIdentity,
      checkPrefix: 'production_identity',
      timeoutMs: policy.timing.healthBudgetSeconds * 1000,
    });
    productionChecks.push(...identity.checks);
    if (!identity.passed) productionFailure = FAILURE_CODES.PRODUCTION_IDENTITY;
  }

  if (!productionFailure) {
    // Capture the outgoing predecessor BEFORE recording completion. Completion
    // makes this release the new rollback target, so reading `predecessor` after
    // it would return this very release — which used to make retention keep the
    // current digest twice and delete the genuine predecessor pair.
    const outgoing = store.readState().predecessor;
    store.completeRelease({ releaseId, status: RELEASE_STATUSES.COMPLETED });
    // Nothing incompatible is pending any more, and that is observed evidence
    // rather than an acknowledgement, so the unresolved marker can be cleared.
    store.clearUnresolvedContractMigrations();
    registry.pruneImages({
      repository: images.backend.repository,
      keepDigests: [images.backend.digest, outgoing?.images?.backend?.digest],
    });
    registry.pruneImages({
      repository: images.contentEngine.repository,
      keepDigests: [images.contentEngine.digest, outgoing?.images?.contentEngine?.digest],
    });
    registry.pruneImages({
      repository: policy.registry.releaseImage,
      keepDigests: [payloadDigest, outgoing?.payload?.digest],
    });
    // Bound the extracted payloads too; images are not the only thing that grows.
    // Keep the predecessor's payload too: it is the topology a rollback restores,
    // so pruning it would leave the next failure with nothing correct to roll
    // back to.
    registry.pruneWorkDirs({
      keepDirs: [
        workDir,
        outgoing?.payload?.digest
          ? path.join(policy.paths.workDir, outgoing.payload.digest.replace('sha256:', ''))
          : null,
      ],
    });
    log(`release ${releaseId} completed`);
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.COMPLETED,
      failureCode: null,
      staging: stagingPhase,
      production: phase('passed', productionChecks, clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'not_required',
        restored: null,
        incidentRecoveryDurationMs: 0,
        predecessorSwitchDurationMs: 0,
        predecessorSwitchObjectiveSeconds: policy.timing.rollbackObjectiveSeconds,
      },
      notifyKind: null,
      notifyRelease: null,
    });
  }

  // ── rollback ───────────────────────────────────────────────────────────────
  const objectiveSeconds = policy.timing.rollbackObjectiveSeconds;
  // Full incident recovery begins when the candidate failure has settled. The
  // narrower 120-second predecessor-switch clock starts later, immediately
  // before the exact predecessor pull.
  const incidentRecoveryStartedAt = clock();

  // Check the database before deciding to roll back. Rollback swaps images and
  // deliberately leaves the database alone, so it cannot repair a corrupt one —
  // it would just put older code in front of a damaged file and keep serving.
  // A corrupt database is therefore a hard stop with an alert, and recovery is
  // an operator decision made against the pre-migration backup.
  const integrity = databaseProbe.checkIntegrity({ environment: 'production' });
  productionChecks.push(integrity);
  if (integrity.result !== 'passed') {
    const recoveryTiming = {
      incidentRecoveryDurationMs: Math.max(0, Math.round(clock() - incidentRecoveryStartedAt)),
      predecessorSwitchDurationMs: 0,
      predecessorSwitchObjectiveSeconds: objectiveSeconds,
    };
    store.completeRelease({
      releaseId,
      status: RELEASE_STATUSES.ROLLBACK_FAILED,
      recoveryTiming,
    });
    store.block({ releaseId, reason: BLOCK_REASONS.DATABASE_INTEGRITY });
    store.reject({ releaseId, reason: 'database_integrity_failed' });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
      failureCode: FAILURE_CODES.DATABASE_INTEGRITY,
      staging: stagingPhase,
      production: phase('failed', productionChecks, clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'not_attempted', restored: null, ...recoveryTiming,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'database_integrity',
        outcome: 'rollback_failed',
        failureCode: FAILURE_CODES.DATABASE_INTEGRITY,
        rollbackResult: 'not_attempted',
        actionRequired: `do not roll back; recover from backup ${backupResult.artifact ?? 'unknown'}`,
      },
    });
  }

  const predecessor = store.readState().predecessor;
  if (!predecessor) {
    const recoveryTiming = {
      incidentRecoveryDurationMs: Math.max(0, Math.round(clock() - incidentRecoveryStartedAt)),
      predecessorSwitchDurationMs: 0,
      predecessorSwitchObjectiveSeconds: objectiveSeconds,
    };
    store.completeRelease({
      releaseId,
      status: RELEASE_STATUSES.ROLLBACK_FAILED,
      recoveryTiming,
    });
    store.block({ releaseId, reason: BLOCK_REASONS.ROLLBACK_FAILED });
    return finish({
      outcome: DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
      failureCode: FAILURE_CODES.NO_PREDECESSOR,
      staging: stagingPhase,
      production: phase('failed', productionChecks, clock() - productionStart),
      backupResult,
      rollbackResult: {
        result: 'failed', restored: null, ...recoveryTiming,
      },
      notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
      notifyRelease: {
        releaseId,
        sourceSha: payload.source.sha,
        phase: 'rollback',
        outcome: 'rollback_failed',
        failureCode: FAILURE_CODES.NO_PREDECESSOR,
        rollbackResult: 'failed',
        actionRequired: 'manual recovery required; deployment is halted',
      },
    });
  }

  const predecessorReleaseIdentity = {
    releaseId: predecessor.releaseId,
    sourceSha: predecessor.sourceSha,
    backendImageDigest: predecessor.images.backend.digest,
  };

  // Restore the predecessor's own immutable payload, not the failed candidate's
  // Compose file with older image digests substituted in. The two topologies can
  // differ in services, published ports, mounts or the migrator command, and
  // running the candidate's topology is not a rollback — it is a third,
  // never-tested configuration.
  //
  // The extracted Compose bytes are verified against the Compose digest recorded
  // when the predecessor completed, so a tampered or wrong payload fails closed
  // rather than being deployed as "the predecessor".
  const rollbackStart = clock();
  const rollbackDeadline = rollbackStart + objectiveSeconds * 1000;
  const remainingRollbackMs = () => Math.max(0, rollbackDeadline - clock());
  let rollbackDeadlineExhausted = false;
  let rollbackComposeFile = null;
  let rollbackPlanDir = null;
  let predecessorTopologyError = null;
  const rollbackLedger = databaseProbe.readAppliedMigrations({ environment: 'production' });
  if (!rollbackLedger.ok) {
    predecessorTopologyError = 'production migration ledger is unavailable for rollback topology';
  }
  try {
    if (predecessorTopologyError) throw new Error(predecessorTopologyError);
    const predecessorRef = `${policy.registry.releaseImage}@${predecessor.payload.digest}`;
    // Extraction uses a no-implicit-pull registry primitive. Pull the exact
    // immutable predecessor payload inside the recovery budget so rollback also
    // works after local payload pruning or a host restart.
    if (remainingRollbackMs() <= 0) {
      rollbackDeadlineExhausted = true;
      throw new Error('rollback objective expired before predecessor pull');
    }
    registry.pull(predecessorRef, { timeoutMs: remainingRollbackMs() });
    if (remainingRollbackMs() <= 0) {
      rollbackDeadlineExhausted = true;
      throw new Error('rollback objective expired before predecessor extraction');
    }
    const predecessorPayload = registry.extractReleasePayload({
      reference: predecessorRef,
      destinationDir: path.join(
        policy.paths.workDir,
        predecessor.payload.digest.replace('sha256:', ''),
      ),
      timeoutMs: remainingRollbackMs(),
    });
    try {
      const retained = verifyRetainedReleasePayload({
        extracted: predecessorPayload,
        policy,
        expected: predecessor,
        rollbackSuccessor: {
          payload,
          releaseId,
          payloadDigest,
          manifestDigest: verified.manifestDigest,
          appliedFiles: rollbackLedger.applied,
        },
      });
      rollbackComposeFile = predecessorPayload.composePath;
      rollbackPlanDir = retained.planDir;
    } catch (error) {
      predecessorTopologyError ??= predecessorTopologyFailure(error);
    }
  } catch {
    predecessorTopologyError ??= 'predecessor payload unavailable';
  }

  // Surface the topology outcome. Without this a digest mismatch — a tampered
  // predecessor payload — is indistinguishable from an ordinary compose start
  // failure, and the operator is told "compose exit 1".
  productionChecks.push({
    name: 'rollback_predecessor_topology',
    result: predecessorTopologyError ? 'failed' : 'passed',
    durationMs: 0,
    detail: predecessorTopologyError ? sanitizeDetail(predecessorTopologyError) : null,
  });

  if (!predecessorTopologyError && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  const rollbackUp = predecessorTopologyError || rollbackDeadlineExhausted
    ? { status: 1 }
    : registry.composeUp({
      composeFile: rollbackComposeFile,
      planDir: rollbackPlanDir,
      environment: 'production',
      images: predecessor.images,
      releaseIdentity: predecessorReleaseIdentity,
      timeoutMs: remainingRollbackMs(),
    });
  if (!predecessorTopologyError && rollbackUp.status !== 0 && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  const restored = predecessorTopologyError || remainingRollbackMs() <= 0
    ? { healthy: false, checks: [] }
    : await health.waitUntilHealthy({
      backendPort: policy.environments.production.backendPort,
      contentEnginePort: policy.environments.production.contentEnginePort,
      budgetSeconds: Math.min(
        policy.timing.healthBudgetSeconds,
        remainingRollbackMs() / 1000,
      ),
    });
  if (!predecessorTopologyError && !restored.healthy && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  productionChecks.push(...restored.checks);

  // Health on a generic port proves *something* is answering, not that the
  // predecessor is. If the failed candidate is still up it will answer happily,
  // so verify the running containers are the predecessor's exact image digests
  // before recording a restoration.
  // Query through the predecessor's own Compose file, the same one the bring-up
  // used. Reading through the candidate's file contradicts the reason this fix
  // exists: if the predecessor defines a service the candidate's file does not,
  // `compose ps <service>` errors and reports a false identity failure.
  const identity = predecessorTopologyError
    ? { passed: false, checks: [] }
    : verifyRunningImagePair({
      registry,
      policy,
      composeFile: rollbackComposeFile,
      planDir: rollbackPlanDir,
      images: predecessor.images,
      releaseIdentity: predecessorReleaseIdentity,
      checkPrefix: 'rollback_identity',
      timeoutMs: remainingRollbackMs(),
    });
  const identityOk = identity.passed;
  productionChecks.push(...identity.checks);
  if (!predecessorTopologyError && !identityOk && remainingRollbackMs() <= 0) {
    rollbackDeadlineExhausted = true;
  }
  // The objective settles only after topology, health, and exact running-image
  // identity have all been observed. Sampling before the identity commands would
  // let a multi-minute `docker compose ps` report a fictitious 120-second restore.
  const predecessorSwitchDurationMs = Math.max(0, Math.round(clock() - rollbackStart));
  const recoveryTiming = {
    incidentRecoveryDurationMs: Math.max(
      predecessorSwitchDurationMs,
      Math.max(0, Math.round(clock() - incidentRecoveryStartedAt)),
    ),
    predecessorSwitchDurationMs,
    predecessorSwitchObjectiveSeconds: objectiveSeconds,
  };

  const composeOk = rollbackUp.status === 0;
  productionChecks.push({
    name: 'rollback_compose_start',
    result: composeOk ? 'passed' : 'failed',
    durationMs: 0,
    detail: composeOk ? null : sanitizeDetail(`compose exit ${rollbackUp.status}`),
  });

  const withinObjective = predecessorSwitchDurationMs <= objectiveSeconds * 1000
    && !rollbackDeadlineExhausted;
  const rollbackOk = composeOk && restored.healthy && identityOk && withinObjective;
  // A topology failure is named distinctly: "we could not prove this is the
  // predecessor" is a different incident from "the predecessor did not start".
  const rollbackFailureCode = predecessorTopologyError
    ? (rollbackDeadlineExhausted
      ? FAILURE_CODES.ROLLBACK_DEADLINE
      : FAILURE_CODES.ROLLBACK_PREDECESSOR_TOPOLOGY)
    : !withinObjective
      ? FAILURE_CODES.ROLLBACK_DEADLINE
      : !composeOk
        ? FAILURE_CODES.ROLLBACK_COMPOSE
        : (!restored.healthy
          ? FAILURE_CODES.ROLLBACK_UNHEALTHY
          : FAILURE_CODES.ROLLBACK_IDENTITY);

  store.completeRelease({
    releaseId,
    status: rollbackOk ? RELEASE_STATUSES.ROLLED_BACK : RELEASE_STATUSES.ROLLBACK_FAILED,
    recoveryTiming,
  });
  store.block({
    releaseId,
    reason: rollbackOk ? BLOCK_REASONS.ROLLBACK_FIRED : BLOCK_REASONS.ROLLBACK_FAILED,
  });
  store.reject({ releaseId, reason: rollbackOk ? 'rolled_back' : 'rollback_failed' });

  const result = await finish({
    outcome: rollbackOk ? DEPLOYMENT_OUTCOMES.ROLLED_BACK : DEPLOYMENT_OUTCOMES.ROLLBACK_FAILED,
    failureCode: rollbackOk ? productionFailure : rollbackFailureCode,
    staging: stagingPhase,
    production: phase('failed', productionChecks, clock() - productionStart),
    backupResult,
    rollbackResult: {
      result: rollbackOk ? 'restored' : 'failed',
      restored: rollbackOk ? predecessor.images : null,
      ...recoveryTiming,
    },
    notifyKind: RELEASE_NOTIFICATION_KINDS.FAILURE,
    notifyRelease: {
      releaseId,
      sourceSha: payload.source.sha,
      phase: 'production',
      outcome: rollbackOk ? 'rolled_back' : 'rollback_failed',
      failureCode: rollbackOk ? productionFailure : rollbackFailureCode,
      rollbackResult: rollbackOk ? 'restored' : 'failed',
      actionRequired: rollbackOk
        ? 'predecessor restored; acknowledge the block to resume deployments'
        : 'manual recovery required; deployment is halted',
    },
  });

  if (rollbackOk) {
    await notifier.send({
      kind: RELEASE_NOTIFICATION_KINDS.RECOVERY,
      release: {
        releaseId,
        sourceSha: payload.source.sha,
        restored: predecessor.images,
        incidentRecoverySeconds: recoveryTiming.incidentRecoveryDurationMs / 1000,
        predecessorSwitchSeconds: recoveryTiming.predecessorSwitchDurationMs / 1000,
        predecessorSwitchObjectiveSeconds:
          recoveryTiming.predecessorSwitchObjectiveSeconds,
      },
    });
  }
  return result;
}

/**
 * Materialize the non-gating operational view of release state.
 *
 * This is a projection for humans and dashboards. It is explicitly not release
 * truth: observable receipts and runtime evidence outrank it, and nothing in the
 * deployment path reads it back.
 */
export function buildReleaseStateView({ state, receipts }) {
  const lastRecovery = state.history.find((entry) => entry.recoveryTiming !== null
    && entry.recoveryTiming !== undefined) ?? null;
  return {
    schema: 'nexus.release-state-view.v1',
    generated: true,
    authoritative: false,
    note: 'Generated projection of VPS release state. Receipts and runtime evidence outrank this file.',
    generatedAt: state.updatedAt,
    active: state.active
      ? {
        releaseId: state.active.releaseId,
        sourceSha: state.active.sourceSha,
        status: state.active.status,
        images: state.active.images,
        startedAt: state.active.startedAt,
        updatedAt: state.active.updatedAt,
        attempts: state.active.attempts,
        backupArtifact: state.active.backupArtifact,
        backupEvidence: state.active.backupEvidence,
        rollbackTarget: state.active.rollbackTarget,
      }
      : null,
    predecessor: state.predecessor,
    blocked: state.blocked,
    lastRecovery: lastRecovery
      ? {
        releaseId: lastRecovery.releaseId,
        status: lastRecovery.status,
        completedAt: lastRecovery.completedAt,
        ...lastRecovery.recoveryTiming,
      }
      : null,
    recent: receipts.slice(0, 10).map((receipt) => ({
      releaseId: receipt.releaseId,
      sourceSha: receipt.sourceSha,
      outcome: receipt.outcome,
      completedAt: receipt.completedAt,
      recoveryTiming: {
        incidentRecoveryDurationMs: receipt.rollback.incidentRecoveryDurationMs,
        predecessorSwitchDurationMs: receipt.rollback.predecessorSwitchDurationMs,
        predecessorSwitchObjectiveSeconds:
          receipt.rollback.predecessorSwitchObjectiveSeconds,
      },
    })),
  };
}

export function writeReleaseStateView({ view, outputPath }) {
  if (!outputPath) fail('release state view requires an output path');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(view, null, 2)}\n`);
  return outputPath;
}
