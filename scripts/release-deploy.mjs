#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createReleaseAuditMirror } from './lib/release-audit-mirror.mjs';
import { createReleaseBackup } from './lib/release-backup.mjs';
import { computeReleaseControlPlaneIdentity } from './lib/release-control-plane.mjs';
import {
  verifyReleaseBootstrapBaseline,
  verifyReleaseBootstrapProductionBaseline,
} from './lib/release-bootstrap.mjs';
import { createReleaseDatabaseProbe } from './lib/release-database.mjs';
import {
  createReleaseDiscoveryAlertStore,
  releaseDeploymentResultProvesDiscovery,
} from './lib/release-discovery-alert-state.mjs';
import { runReleaseDeployment } from './lib/release-deployment.mjs';
import { createReleaseHealth } from './lib/release-health.mjs';
import {
  verifyInstalledReleaseBackupInterface,
} from './lib/release-installed-backup-interface.mjs';
import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  createReleaseNotifier,
  drainReleaseDeploymentAbort,
  reportReleaseDeploymentAbort,
  resolveReleaseDeploymentAbort,
} from './lib/release-notify.mjs';
import { createReleaseRegistry } from './lib/release-registry.mjs';
import { createProtectedHeadVerifier } from './lib/release-protected-head.mjs';
import { createReleaseStateStore } from './lib/release-state-store.mjs';
import {
  ReleaseDeployArgumentError,
  parseReleaseDeployArguments,
} from './lib/release-deploy-arguments.mjs';

/**
 * One unattended release attempt, wired to the real host.
 *
 * Must be launched through `scripts/release-poll.sh`, which holds the kernel
 * flock. Running this file directly is refused by `assertLockHeld`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliArgs = process.argv.slice(2);
let deployArguments;
try {
  deployArguments = parseReleaseDeployArguments({ argv: cliArgs, env: process.env });
} catch (error) {
  if (!(error instanceof ReleaseDeployArgumentError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode);
}
const {
  allowFirstContainerBootstrap,
  governanceOnlyReleaseId,
  ownerAuthorized,
} = deployArguments;
const retirementJournal = '/var/lib/nexus-release/state/pm2-fallback-retirement.json';
const retiredTombstone = '/var/lib/nexus-release/state/pm2-fallback-retired.json';
function retirementGatePresent(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
if (retirementGatePresent(retirementJournal)) {
  process.stderr.write('release refused while PM2 fallback retirement is in progress\n');
  process.exit(75);
}
if (allowFirstContainerBootstrap && retirementGatePresent(retiredTombstone)) {
  process.stderr.write('first-container bootstrap is permanently barred after PM2 retirement\n');
  process.exit(75);
}
const policy = loadContinuousDeploymentPolicy(root);
const controlPlane = computeReleaseControlPlaneIdentity(root);

function log(message) {
  process.stdout.write(`${JSON.stringify({
    at: new Date().toISOString(),
    component: 'release-deploy',
    message,
  })}\n`);
}

const store = createReleaseStateStore({
  stateDir: policy.paths.stateDir,
  receiptDir: policy.paths.receiptDir,
});
const registry = createReleaseRegistry({ policy });
const protectedHead = createProtectedHeadVerifier({ policy });
const health = createReleaseHealth({});
const notifier = createReleaseNotifier({ policy, log });
const mirror = createReleaseAuditMirror({ policy, log });
const backup = createReleaseBackup({ policy, log });
const installedBackupInterface = {
  verify: () => verifyInstalledReleaseBackupInterface({ root }),
};
const databaseProbe = createReleaseDatabaseProbe({ policy });
let discoveryAlerts = null;
try {
  discoveryAlerts = createReleaseDiscoveryAlertStore({
    stateDirectory: policy.paths.stateDir,
    lockFile: policy.paths.lockFile,
  });
} catch {
  // Notification durability is fail-closed for paging but never release
  // authority. A bad alert store suppresses direct sends without blocking an
  // otherwise-valid deployment or replacing its original failure verdict.
  log('release discovery alert store is unavailable');
}

try {
  await drainReleaseDeploymentAbort({ alertStore: discoveryAlerts, notifier, log });
  const result = await runReleaseDeployment({
    policy, controlPlane, store, registry, protectedHead, health, notifier, mirror, backup,
    installedBackupInterface, databaseProbe, log,
    bootstrap: {
      verify: (input) => verifyReleaseBootstrapBaseline({ ...input, root }),
      verifyProduction: (input) => verifyReleaseBootstrapProductionBaseline({ ...input, root }),
    },
    allowFirstContainerBootstrap,
    governanceOnlyReleaseId,
    ownerAuthorized,
  });
  if (releaseDeploymentResultProvesDiscovery(result)) {
    await resolveReleaseDeploymentAbort({
      alertStore: discoveryAlerts,
      notifier,
      log,
    });
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-deploy-result.v1',
    outcome: result.outcome,
    releaseId: result.releaseId ?? null,
    reason: result.reason ?? null,
  })}\n`);
  // A quiet halt on an already-recorded block, a refused replay, or a
  // superseded candidate is a correct poll outcome. A rollback is an incident
  // even when recovery succeeded: it leaves a durable acknowledgement block and
  // must not be reported to systemd as a successful release attempt.
  const failed = ['rolled_back', 'rollback_failed', 'staging_failed', 'blocked']
    .includes(result.outcome);
  process.exit(failed ? 1 : 0);
} catch (error) {
  await reportReleaseDeploymentAbort({
    notifier,
    alertStore: discoveryAlerts,
    error,
    log,
  });
  process.exit(1);
}
