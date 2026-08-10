#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createReleaseAuditMirror } from './lib/release-audit-mirror.mjs';
import { createReleaseBackup } from './lib/release-backup.mjs';
import {
  verifyReleaseBootstrapBaseline,
  verifyReleaseBootstrapProductionBaseline,
} from './lib/release-bootstrap.mjs';
import { createReleaseDatabaseProbe } from './lib/release-database.mjs';
import { runReleaseDeployment } from './lib/release-deployment.mjs';
import { createReleaseHealth } from './lib/release-health.mjs';
import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  createReleaseNotifier,
  reportReleaseDeploymentAbort,
} from './lib/release-notify.mjs';
import { createReleaseRegistry } from './lib/release-registry.mjs';
import { createProtectedHeadVerifier } from './lib/release-protected-head.mjs';
import { createReleaseStateStore } from './lib/release-state-store.mjs';

/**
 * One unattended release attempt, wired to the real host.
 *
 * Must be launched through `scripts/release-poll.sh`, which holds the kernel
 * flock. Running this file directly is refused by `assertLockHeld`.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const cliArgs = process.argv.slice(2);
const bootstrapFlag = '--allow-first-container-bootstrap';
if (cliArgs.some((argument) => argument !== bootstrapFlag)
    || cliArgs.filter((argument) => argument === bootstrapFlag).length > 1) {
  process.stderr.write(`the only supported release-deploy argument is ${bootstrapFlag}\n`);
  process.exit(64);
}
const allowFirstContainerBootstrap = cliArgs.includes(bootstrapFlag);

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
const databaseProbe = createReleaseDatabaseProbe({ policy });

try {
  const result = await runReleaseDeployment({
    policy, store, registry, protectedHead, health, notifier, mirror, backup, databaseProbe, log,
    bootstrap: {
      verify: (input) => verifyReleaseBootstrapBaseline({ ...input, root }),
      verifyProduction: (input) => verifyReleaseBootstrapProductionBaseline({ ...input, root }),
    },
    allowFirstContainerBootstrap,
  });
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
  await reportReleaseDeploymentAbort({ notifier, error, log });
  process.exit(1);
}
