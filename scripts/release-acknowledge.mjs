#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  createReleaseStateStore,
  resolveEffectiveRelease,
} from './lib/release-state-store.mjs';

/**
 * Acknowledge a halted release pipeline.
 *
 * A fired rollback, a failed rollback, a failed backup, or an ineligible
 * migration all halt continuous deployment. Clearing that block is the one
 * remaining human step in the release path, and it is deliberate: the alternative
 * is a 30-second timer stacking releases on a state somebody already knows is
 * bad.
 *
 * The acknowledgement names the exact blocked release id, so acknowledging one
 * incident cannot silently clear a different one that arrived in the meantime.
 *
 * Usage:
 *   node scripts/release-acknowledge.mjs --confirm <releaseId>
 *   node scripts/release-acknowledge.mjs --show
 */

const args = process.argv.slice(2);
function arg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] ?? fallback;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policy = loadContinuousDeploymentPolicy(root);
const store = createReleaseStateStore({
  stateDir: policy.paths.stateDir,
  receiptDir: policy.paths.receiptDir,
});

const state = store.readState();

if (args.includes('--show') || args.length === 0) {
  process.stdout.write(`${JSON.stringify({
    schema: 'nexus.release-block-status.v1',
    blocked: state.blocked,
    active: state.active
      ? {
        releaseId: state.active.releaseId,
        status: state.active.status,
        backupArtifact: state.active.backupArtifact,
        rollbackTarget: state.active.rollbackTarget,
      }
      : null,
    predecessor: state.predecessor
      ? { releaseId: state.predecessor.releaseId, sourceSha: state.predecessor.sourceSha }
      : null,
  }, null, 2)}\n`);
  process.exit(state.blocked ? 78 : 0);
}

const confirm = arg('--confirm');
if (!confirm) {
  process.stderr.write('--confirm <releaseId> is required to acknowledge a block\n');
  process.exit(64);
}
if (!state.blocked) {
  process.stderr.write('there is no blocked release to acknowledge\n');
  process.exit(1);
}
if (state.blocked.releaseId !== confirm) {
  process.stderr.write(
    `refusing to acknowledge: the blocked release is ${state.blocked.releaseId}, not ${confirm}\n`,
  );
  process.exit(1);
}
const effective = resolveEffectiveRelease({ state, readReceipt: store.readReceipt });
if (!effective.provable) {
  process.stderr.write(
    'refusing to acknowledge an unprovable active release; run the locked poller to recover it first\n',
  );
  process.exit(1);
}

const next = store.acknowledgeBlock();
process.stdout.write(`${JSON.stringify({
  schema: 'nexus.release-block-acknowledged.v1',
  acknowledged: confirm,
  updatedAt: next.updatedAt,
})}\n`);
