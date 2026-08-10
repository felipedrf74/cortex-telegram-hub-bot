#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import { createReleaseNotifier, RELEASE_NOTIFICATION_KINDS } from './lib/release-notify.mjs';
import { createReleaseStateStore, RELEASE_STATUSES } from './lib/release-state-store.mjs';

/**
 * Weekly release-pipeline heartbeat.
 *
 * The pipeline is silent on success, which means a notifier that has quietly
 * broken looks exactly like a quiet week. The heartbeat is the only thing that
 * distinguishes them, so it is not decoration — it is the liveness proof for the
 * alerting path the whole recovery-first design depends on.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const store = createReleaseStateStore({
  stateDir: policy.paths.stateDir,
  receiptDir: policy.paths.receiptDir,
});
const notifier = createReleaseNotifier({ policy });

const state = store.readState();
const completedCount = state.history
  .filter((entry) => entry.status === RELEASE_STATUSES.COMPLETED).length;

const result = await notifier.send({
  kind: RELEASE_NOTIFICATION_KINDS.HEARTBEAT,
  release: {
    releaseId: state.active?.releaseId ?? null,
    status: state.active?.status ?? null,
    blocked: state.blocked?.reason ?? null,
    completedCount,
  },
});

process.stdout.write(`${JSON.stringify({
  schema: 'nexus.release-heartbeat.v1',
  delivered: result.delivered,
  reason: result.reason,
})}\n`);
process.exit(result.delivered ? 0 : 1);
