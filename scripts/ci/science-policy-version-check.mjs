#!/usr/bin/env node
// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Science policy version check — CI gate for slice A1b.
 *
 * Ensures that when training-principles.json content changes, the
 * sciencePolicyVersion field is bumped. This is the reproducibility
 * invariant: every plan + every adaptation-ledger row carries a
 * sciencePolicyVersion stamp, so old plans must remain replayable
 * under the exact policy version they were generated against.
 *
 * Usage:
 *   node scripts/ci/science-policy-version-check.mjs              # verify (default, fail-closed)
 *   node scripts/ci/science-policy-version-check.mjs --update     # accept new hash (after version bump)
 *   node scripts/ci/science-policy-version-check.mjs --bootstrap  # FIRST-RUN ONLY: create pin
 *
 * Modes:
 *   verify (default)    Compares the current JSON content hash against the
 *                       pinned hash. Exits 0 on match, 1 on drift, 1 if
 *                       the pin file is missing (R3 P2 fail-closed).
 *
 *   --update            After bumping `sciencePolicyVersion` in the JSON,
 *                       writes a new pin matching the current content.
 *                       Refuses if the version has not been bumped relative
 *                       to the existing pin's recorded version.
 *
 *   --bootstrap         Initial-deploy escape hatch. Creates a fresh pin
 *                       file without requiring a prior pin to exist. Use
 *                       once, then commit the resulting .science-policy-hash
 *                       to git so subsequent verifies have something to
 *                       compare against. CI should NEVER pass --bootstrap.
 *
 * The pinned hash file at
 *   src/services/coach-kernel/knowledge/entities/.science-policy-hash
 * IS tracked in git (NOT gitignored). Deleting it is intentionally
 * a CI failure — that is the entire point of fail-closed.
 *
 * When the content hash drifts from the pinned hash, this script:
 *   - exits 1 with an explanation if --update is NOT passed
 *   - rewrites the pinned hash if --update IS passed (after the
 *     developer has bumped sciencePolicyVersion)
 *
 * Exit codes:
 *   0  hash matches pinned (no content change since last bump)
 *   1  hash drifted; developer must bump version AND rerun with --update
 *   2  config error (file missing, JSON parse failure)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const JSON_PATH = resolve(
  REPO_ROOT,
  'src/services/coach-kernel/knowledge/entities/training-principles.json',
);
const PINNED_PATH = resolve(
  REPO_ROOT,
  'src/services/coach-kernel/knowledge/entities/.science-policy-hash',
);

function fail(msg, code = 1) {
  console.error(`[science-policy-version-check] ${msg}`);
  process.exit(code);
}

function loadJson() {
  if (!existsSync(JSON_PATH)) {
    fail(`training-principles.json not found at ${JSON_PATH}`, 2);
  }
  try {
    return JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  } catch (err) {
    fail(`failed to parse training-principles.json: ${err.message}`, 2);
  }
}

function computeContentHash(principles) {
  // Exclude sciencePolicyVersion from the hash — otherwise every
  // version bump would itself change the hash, defeating the check.
  const { sciencePolicyVersion: _v, ...rest } = principles;
  // Canonicalize recursively (array-replacer drops nested values).
  const stable = JSON.stringify(canonicalize(rest));
  return createHash('sha256').update(stable).digest('hex');
}

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const k of Object.keys(value).sort()) {
    out[k] = canonicalize(value[k]);
  }
  return out;
}

function readPinnedHash() {
  if (!existsSync(PINNED_PATH)) return null;
  return readFileSync(PINNED_PATH, 'utf8').trim();
}

function writePinnedHash(hash, version) {
  const content = `${hash}\n${version}\n`;
  writeFileSync(PINNED_PATH, content);
  console.log(`[science-policy-version-check] pinned hash updated → ${hash.slice(0, 16)}… (version ${version})`);
}

const args = process.argv.slice(2);
const updateMode = args.includes('--update');
// Codex R2 P2 fix — fail-closed when the pin is absent. Bootstrap
// is now an explicit opt-in (`--bootstrap`); default verify mode
// refuses to silently create a pin so deleting the file no longer
// launders a JSON change.
const bootstrapMode = args.includes('--bootstrap');

const principles = loadJson();
const version = principles.sciencePolicyVersion;
if (typeof version !== 'string' || version.length === 0) {
  fail(`training-principles.json is missing 'sciencePolicyVersion' (string).`);
}

const currentHash = computeContentHash(principles);
const pinned = readPinnedHash();
const pinnedHash = pinned ? pinned.split('\n')[0] : null;
const pinnedVersion = pinned ? pinned.split('\n')[1] : null;

if (updateMode) {
  if (pinnedHash === currentHash) {
    console.log(`[science-policy-version-check] hash unchanged; no update needed.`);
    process.exit(0);
  }
  if (pinnedVersion === version) {
    fail(
      `--update was requested but sciencePolicyVersion (${version}) has NOT ` +
      `been bumped since the last pinned hash. Bump the version first, ` +
      `then rerun with --update.`,
    );
  }
  writePinnedHash(currentHash, version);
  process.exit(0);
}

// Default mode: verify.
if (pinnedHash === null) {
  // Codex R2 P2 fix — fail-closed when the pin is missing. The
  // previous behavior silently created the pin, which meant deleting
  // the .science-policy-hash file laundered any JSON change. Bootstrap
  // is now an explicit opt-in via `--bootstrap`.
  if (bootstrapMode) {
    writePinnedHash(currentHash, version);
    console.log(`[science-policy-version-check] bootstrap — pinned ${version} → ${currentHash.slice(0, 16)}…`);
    process.exit(0);
  }
  fail(
    `pinned hash file is missing at ${PINNED_PATH}.\n` +
    `This script refuses to bootstrap implicitly because deleting the pin would otherwise\n` +
    `let any JSON change pass without a version bump. If you intend to create the pin\n` +
    `for the FIRST time, rerun with --bootstrap. Otherwise, restore the file from git.`,
  );
}

if (pinnedHash === currentHash) {
  console.log(
    `[science-policy-version-check] OK — sciencePolicyVersion ${version} ` +
    `content matches pin (${currentHash.slice(0, 16)}…).`,
  );
  process.exit(0);
}

// Drift detected.
const explanation = [
  `training-principles.json content has changed but the pinned hash hasn't been updated.`,
  ``,
  `   pinned:  ${pinnedHash.slice(0, 32)}…  (version ${pinnedVersion})`,
  `   current: ${currentHash.slice(0, 32)}…  (version ${version})`,
  ``,
  `If the change is intentional, you MUST:`,
  `  1) Bump sciencePolicyVersion in training-principles.json`,
  `     (current: ${version} → next: e.g., ${bumpPatch(version)})`,
  `  2) Run:  node scripts/ci/science-policy-version-check.mjs --update`,
  ``,
  `If the change is unintentional, revert your edit to`,
  `  ${JSON_PATH}`,
  ``,
  `Why this matters:`,
  `  Every training plan + every adaptation-ledger row carries the active`,
  `  sciencePolicyVersion as a stamp. Replaying an old plan must reproduce`,
  `  exactly the prescription the policy version generated. Silently mutating`,
  `  policy content under the same version breaks that contract.`,
];
fail(explanation.join('\n'));

function bumpPatch(v) {
  const parts = v.split('.');
  const last = Number.parseInt(parts[parts.length - 1] ?? '0', 10);
  parts[parts.length - 1] = String((Number.isFinite(last) ? last : 0) + 1);
  return parts.join('.');
}
