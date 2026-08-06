#!/usr/bin/env node
// Host-side source/image attestation for in-container Training evidence writers.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTrainingE2ERunFreshness } from './lib/training-e2e-run-freshness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const latestEnvPath = path.join(root, '.local', 'training-e2e', 'latest.env');
if (!fs.existsSync(latestEnvPath)) {
  throw new Error(`No Training E2E run metadata found at ${latestEnvPath}`);
}

const env = {};
for (const line of fs.readFileSync(latestEnvPath, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^export\s+([A-Z0-9_]+)='(.*)'$/);
  if (match) env[match[1]] = match[2];
}
const stateDir = path.resolve(String(env.NEXUS_TRAINING_E2E_ROOT || ''));
const expectedParent = path.join(root, '.local', 'training-e2e');
if (!stateDir.startsWith(`${expectedParent}${path.sep}`)) {
  throw new Error(`Training E2E state resolves outside ${expectedParent}`);
}
const metadata = JSON.parse(fs.readFileSync(path.join(stateDir, 'metadata.json'), 'utf8'));
const provenance = assertTrainingE2ERunFreshness({
  metadata,
  repoRoot: root,
  gitDir: env.NEXUS_TRAINING_E2E_GIT_DIR,
});
process.stdout.write(`${JSON.stringify({
  ok: true,
  runId: metadata.runId,
  verifiedAt: provenance.verifiedAt,
  dirtyTreeDiffSha256: provenance.git.dirtyTreeDiffSha256,
}, null, 2)}\n`);
