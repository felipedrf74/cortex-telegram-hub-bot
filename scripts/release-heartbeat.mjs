#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BackupLivenessError,
  inspectBackupLiveness,
} from './lib/release-backup-liveness.mjs';
import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  createReleaseNotifier,
  RELEASE_FAILSAFE_NOTIFICATION_POLICY,
  RELEASE_NOTIFICATION_KINDS,
} from './lib/release-notify.mjs';
import { createReleaseStateStore, RELEASE_STATUSES } from './lib/release-state-store.mjs';
import {
  createReleaseBackupAlertStore,
  deliverDueReleaseBackupAlert,
  drainDueReleaseBackupAlerts,
  RELEASE_BACKUP_ALERT_SOURCES,
} from './lib/release-backup-alert-state.mjs';

/**
 * Weekly release-pipeline heartbeat.
 *
 * The pipeline is silent on success, which means a notifier that has quietly
 * broken looks exactly like a quiet week. The heartbeat also proves that the
 * hourly encrypted backup and weekly restore-verification evidence remain
 * current. A stale or unsafe recovery surface is a failure, never a healthy
 * heartbeat with an informational footnote.
 */

export const RELEASE_HEARTBEAT_SCHEMA = 'nexus.release-heartbeat.v1';
export const RELEASE_BACKUP_LIVENESS_CHECK_SCHEMA =
  'nexus.release-backup-liveness-check.v1';
export const RELEASE_BACKUP_LIVENESS_PREPARE_DUE_EXIT_CODE = 10;
export const RELEASE_BACKUP_LIVENESS_INSPECTION_EXIT_CODES = Object.freeze({
  healthy: 20,
  backup_policy_invalid: 21,
  backup_evidence_invalid: 22,
  backup_receipt_stale: 23,
  restore_verification_stale: 24,
});
const LIVENESS_VERDICTS = Object.freeze(
  Object.keys(RELEASE_BACKUP_LIVENESS_INSPECTION_EXIT_CODES),
);

export function parseReleaseHeartbeatArgv(argv) {
  if (!Array.isArray(argv)) return null;
  if (argv.length === 0) return 'weekly';
  if (argv.length === 1 && argv[0] === '--failure-only-prepare') return 'failure_only_prepare';
  if (argv.length === 1 && argv[0] === '--failure-only-force-prepare') {
    return 'failure_only_force_prepare';
  }
  if (argv.length === 1 && argv[0] === '--failure-only-inspect') return 'failure_only_inspect';
  if (argv.length === 1 && argv[0].startsWith('--failure-only-commit=')) {
    const verdict = argv[0].slice('--failure-only-commit='.length);
    return LIVENESS_VERDICTS.includes(verdict) ? `failure_only_commit:${verdict}` : null;
  }
  return null;
}

function backupFailureCode(error) {
  return error instanceof BackupLivenessError && LIVENESS_VERDICTS.includes(error.code)
    ? error.code
    : 'backup_evidence_invalid';
}

export async function runReleaseHeartbeat({
  policy,
  store,
  notifier,
  inspectLiveness = inspectBackupLiveness,
} = {}) {
  let liveness;
  try {
    liveness = inspectLiveness({ policy });
  } catch (error) {
    const failureCode = backupFailureCode(error);
    let delivery = { delivered: false, reason: 'notification_failed' };
    try {
      delivery = await notifier.send({
        kind: RELEASE_NOTIFICATION_KINDS.FAILURE,
        release: {
          releaseId: null,
          sourceSha: null,
          phase: 'backup_liveness',
          outcome: 'heartbeat_failed',
          failureCode,
          rollbackResult: 'not_applicable',
          actionRequired: 'inspect_backup_evidence',
        },
      });
    } catch {
      // The evidence failure remains primary. Notification construction or
      // transport must not turn it into a different or successful verdict.
    }
    return {
      schema: RELEASE_HEARTBEAT_SCHEMA,
      healthy: false,
      delivered: delivery.delivered,
      reason: delivery.reason,
      failureCode,
      exitCode: 1,
    };
  }

  const state = store.readState();
  const completedCount = state.history
    .filter((entry) => entry.status === RELEASE_STATUSES.COMPLETED).length;
  const release = {
    releaseId: state.active?.releaseId ?? null,
    sourceSha: state.active?.sourceSha ?? null,
    status: state.active?.status ?? null,
    blocked: state.blocked?.reason ?? null,
    completedCount,
  };
  const backupAgeSeconds = liveness.backup.ageSeconds;
  const restoreVerificationAgeSeconds = liveness.restoreVerification.ageSeconds;
  const delivery = await notifier.send({
    kind: RELEASE_NOTIFICATION_KINDS.HEARTBEAT,
    release: {
      ...release,
      backupAgeSeconds,
      restoreVerificationAgeSeconds,
    },
  });

  return {
    schema: RELEASE_HEARTBEAT_SCHEMA,
    healthy: true,
    delivered: delivery.delivered,
    reason: delivery.reason,
    backupAgeSeconds,
    restoreVerificationAgeSeconds,
    exitCode: delivery.delivered ? 0 : 1,
  };
}

function unresolvedAlertState(alertStore) {
  return alertStore.readState().events.some(
    (event) => ['open', 'dead_letter'].includes(event.lifecycle),
  );
}

export async function prepareReleaseBackupLivenessCheck({
  notifier,
  alertStore,
  force = false,
} = {}) {
  const drained = await drainDueReleaseBackupAlerts({ store: alertStore, notifier });
  const due = force || alertStore.livenessDue();
  return {
    schema: RELEASE_BACKUP_LIVENESS_CHECK_SCHEMA,
    due,
    drained: drained.length,
    unresolved: unresolvedAlertState(alertStore),
    exitCode: due
      ? RELEASE_BACKUP_LIVENESS_PREPARE_DUE_EXIT_CODE
      : (unresolvedAlertState(alertStore) ? 1 : 0),
  };
}

export function inspectReleaseBackupLiveness({
  policy,
  inspectLiveness = inspectBackupLiveness,
} = {}) {
  let failureCode = null;
  try {
    inspectLiveness({ policy });
  } catch (error) {
    failureCode = backupFailureCode(error);
  }
  const verdict = failureCode ?? 'healthy';
  return {
    schema: RELEASE_BACKUP_LIVENESS_CHECK_SCHEMA,
    verdict,
    healthy: failureCode === null,
    failureCode,
    exitCode: RELEASE_BACKUP_LIVENESS_INSPECTION_EXIT_CODES[verdict],
  };
}

export async function commitReleaseBackupLivenessCheck({
  verdict,
  notifier,
  alertStore,
} = {}) {
  if (!LIVENESS_VERDICTS.includes(verdict)) {
    throw new Error('backup liveness commit verdict is not governed');
  }
  const failureCode = verdict === 'healthy' ? null : verdict;
  let delivered = false;
  let reason = 'healthy';
  if (failureCode === null) {
    alertStore.resolveSource(RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS);
  } else {
    const opened = alertStore.openFailure({
      source: RELEASE_BACKUP_ALERT_SOURCES.BACKUP_LIVENESS,
      failureCode,
    });
    if (opened.deduped) {
      delivered = true;
      reason = 'deduped';
    } else if (opened.due) {
      const delivery = await deliverDueReleaseBackupAlert({
        store: alertStore,
        event: opened.event,
        notifier,
      });
      delivered = delivery.delivered;
      reason = delivery.reason;
    } else {
      reason = opened.event.lifecycle === 'dead_letter' ? 'dead_letter' : 'retry_pending';
    }
  }
  alertStore.markLivenessChecked();
  const unresolved = unresolvedAlertState(alertStore);
  return {
    schema: RELEASE_BACKUP_LIVENESS_CHECK_SCHEMA,
    healthy: failureCode === null,
    delivered,
    reason,
    failureCode,
    exitCode: failureCode === null && !unresolved ? 0 : 1,
  };
}

export async function runReleaseBackupLivenessCheck({
  policy,
  notifier,
  alertStore,
  inspectLiveness = inspectBackupLiveness,
  force = false,
} = {}) {
  const prepared = await prepareReleaseBackupLivenessCheck({ notifier, alertStore, force });
  if (!prepared.due) {
    return {
      ...prepared,
      inspected: false,
      healthy: null,
    };
  }
  const inspection = inspectReleaseBackupLiveness({ policy, inspectLiveness });
  const committed = await commitReleaseBackupLivenessCheck({
    verdict: inspection.verdict,
    notifier,
    alertStore,
  });
  return {
    ...committed,
    inspected: true,
    drained: prepared.drained,
  };
}

export async function runReleaseHeartbeatCli({
  argv = process.argv.slice(2),
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  loadPolicy = loadContinuousDeploymentPolicy,
  createNotifier = createReleaseNotifier,
  createAlertStore = createReleaseBackupAlertStore,
  createStateStore = createReleaseStateStore,
  inspectLiveness = inspectBackupLiveness,
} = {}) {
  const mode = parseReleaseHeartbeatArgv(argv);
  if (!mode) {
    return {
      schema: RELEASE_HEARTBEAT_SCHEMA,
      accepted: false,
      reason: 'invalid_arguments',
      exitCode: 64,
    };
  }
  const alertStore = ['failure_only_prepare', 'failure_only_force_prepare', 'failure_only_commit']
    .some((prefix) => mode.startsWith(prefix))
    ? createAlertStore()
    : null;
  let policy;
  let policyInvalid = false;
  try {
    policy = loadPolicy(root);
  } catch {
    policy = RELEASE_FAILSAFE_NOTIFICATION_POLICY;
    policyInvalid = true;
  }
  let result;
  if (mode === 'failure_only_inspect') {
    result = inspectReleaseBackupLiveness({
      policy,
      inspectLiveness: policyInvalid
        ? () => { throw new BackupLivenessError('backup_policy_invalid', 'policy invalid'); }
        : inspectLiveness,
    });
  } else if (mode === 'failure_only_prepare' || mode === 'failure_only_force_prepare') {
    const notifier = createNotifier({ policy });
    result = await prepareReleaseBackupLivenessCheck({
      notifier,
      alertStore,
      force: mode === 'failure_only_force_prepare',
    });
  } else if (mode.startsWith('failure_only_commit:')) {
    const notifier = createNotifier({ policy });
    result = await commitReleaseBackupLivenessCheck({
      verdict: mode.slice('failure_only_commit:'.length),
      notifier,
      alertStore,
    });
  } else {
    const notifier = createNotifier({ policy });
    if (policyInvalid) {
      result = await runReleaseHeartbeat({
        policy,
        store: null,
        notifier,
        inspectLiveness: () => {
          throw new BackupLivenessError('backup_policy_invalid', 'policy invalid');
        },
      });
    } else {
      const store = createStateStore({
        stateDir: policy.paths.stateDir,
        receiptDir: policy.paths.receiptDir,
      });
      result = await runReleaseHeartbeat({ policy, store, notifier, inspectLiveness });
    }
  }
  return result;
}

async function main() {
  const result = await runReleaseHeartbeatCli();
  const { exitCode, ...output } = result;
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exitCode = exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch {
    process.stdout.write(`${JSON.stringify({
      schema: RELEASE_HEARTBEAT_SCHEMA,
      accepted: false,
      reason: 'heartbeat_helper_failed',
    })}\n`);
    process.exitCode = 1;
  }
}
