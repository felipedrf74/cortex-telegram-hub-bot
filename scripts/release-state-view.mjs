#!/usr/bin/env node
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildReleaseStateView, writeReleaseStateView } from './lib/release-deployment.mjs';
import { canonicalJson } from './lib/release-canonical.mjs';
import { loadContinuousDeploymentPolicy } from './lib/release-manifest.mjs';
import {
  RELEASE_RECEIPT_SCHEMA,
  RELEASE_STATE_SCHEMA,
  createReleaseStateStore,
  resolveEffectiveRelease,
} from './lib/release-state-store.mjs';

/**
 * Generate the non-gating operational view of release state.
 *
 * `docs/release/release-state.json` used to be canonical, and gating on it is
 * what produced the whole bot-PR reconciliation subsystem. It is now a generated
 * projection: refreshed on demand, clearly labelled non-authoritative, and read
 * by nothing in the deployment path. Observable receipts and runtime evidence
 * outrank it, always.
 *
 * Usage:
 *   node scripts/release-state-view.mjs --output docs/release/release-state.json
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
let activeReceiptRead = false;
let activeReceipt = null;
const readActiveReceipt = (releaseId) => {
  if (!activeReceiptRead) {
    activeReceipt = store.readReceipt(releaseId);
    activeReceiptRead = true;
  }
  return activeReceipt;
};
const effective = resolveEffectiveRelease({ state, readReceipt: readActiveReceipt });
const receipts = [];
for (const releaseId of store.listReceiptIds().reverse()) {
  // Keep the active receipt read identical to the one used for effective-state
  // resolution. If it did not exist at that instant, a concurrently published
  // receipt is deliberately left for the next observer call rather than mixed
  // into one contradictory snapshot.
  const receipt = state.active?.releaseId === releaseId && activeReceiptRead
    ? activeReceipt
    : store.readReceipt(releaseId);
  if (receipt) receipts.push(receipt);
  if (receipts.length >= 10) break;
}
receipts.sort((left, right) => right.completedAt.localeCompare(left.completedAt));

const stateAfter = store.readState();
if (canonicalJson(stateAfter) !== canonicalJson(state)) {
  process.stderr.write('release state changed during the read-only evidence snapshot; retry\n');
  process.exit(75);
}

const projected = buildReleaseStateView({ state, receipts });
const view = {
  ...projected,
  schema: 'nexus.release-state-view.v2',
  capturedAt: new Date().toISOString(),
  sourceSchemas: {
    state: RELEASE_STATE_SCHEMA,
    receipt: RELEASE_RECEIPT_SCHEMA,
  },
  active: state.active
    ? {
      ...projected.active,
      releasePayloadDigest: state.active.payload.digest,
    }
    : null,
  effective: {
    source: effective.source,
    status: effective.status ?? null,
    releaseId: effective.releaseId ?? null,
    provable: effective.provable,
    stateStatus: effective.stateStatus ?? state.active?.status ?? null,
    staleProjection: effective.staleProjection ?? false,
    releasePayloadDigest: effective.releasePayloadDigest ?? null,
  },
  activeReceipt: activeReceipt
    ? {
      schema: activeReceipt.schema,
      releaseId: activeReceipt.releaseId,
      sourceSha: activeReceipt.sourceSha,
      outcome: activeReceipt.outcome,
      completedAt: activeReceipt.completedAt,
      releasePayloadDigest: activeReceipt.identity.releasePayloadDigest,
    }
    : null,
};
const output = arg('--output');
if (output) {
  writeReleaseStateView({ view, outputPath: output });
  process.stdout.write(`${JSON.stringify({ output, authoritative: false })}\n`);
} else {
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
}
