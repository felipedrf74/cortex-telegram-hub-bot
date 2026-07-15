#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const SIGNING_ENVIRONMENT = 'release-signing';
const SIGNING_SECRET = 'NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM';

function readArg(name, fallback = '') {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  return args[index + 1] || fallback;
}

function hasArg(name) {
  return args.includes(name);
}

function fail(message, exitCode = 1) {
  console.error(message);
  process.exit(exitCode);
}

if (args.some((arg) => arg === '--private-key' || arg.startsWith('--private-key='))) {
  fail('Private-key file output is forbidden; rotation stores the key only in the release-signing environment.', 64);
}

const root = path.resolve(readArg('--root', process.cwd()));
const publicPath = path.resolve(
  root,
  readArg('--public-key', 'docs/release/evidence/release-evidence-public-key.pem'),
);
const force = hasArg('--force');
const rootPrefix = `${root}${path.sep}`;

if (publicPath === root || !publicPath.startsWith(rootPrefix)) {
  fail('Public verifier path must stay inside the repository root.', 64);
}
if (fs.existsSync(publicPath)) {
  const existing = fs.lstatSync(publicPath);
  if (!existing.isFile() || existing.isSymbolicLink()) {
    fail(`Public verifier must be a regular repository file: ${publicPath}`, 64);
  }
}
if (fs.existsSync(publicPath) && !force) {
  fail(`Refusing to overwrite existing public verifier: ${publicPath}\nPass --force only when rotating the release-signing environment key intentionally.`);
}

function gh(commandArgs, options = {}) {
  const stdio = options.stdio
    ?? (options.input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']);
  return execFileSync('gh', commandArgs, {
    cwd: root,
    encoding: options.encoding ?? 'utf8',
    input: options.input,
    stdio,
  });
}

try {
  gh(['auth', 'status']);
} catch {
  fail('GitHub CLI authentication is required to rotate release-signing evidence.');
}

let repository = readArg('--repo', '');
if (!repository) {
  try {
    repository = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']).trim();
  } catch {
    fail('Unable to resolve the GitHub repository; pass --repo owner/name.');
  }
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
  fail('GitHub repository must use the owner/name form.', 64);
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' }));
const stagedPublicPath = `${publicPath}.next-${process.pid}`;
let environmentUpdated = false;

try {
  fs.mkdirSync(path.dirname(publicPath), { recursive: true });
  fs.writeFileSync(stagedPublicPath, publicPem, { mode: 0o644, flag: 'wx' });

  gh([
    'secret',
    'set',
    SIGNING_SECRET,
    '--env',
    SIGNING_ENVIRONMENT,
    '--repo',
    repository,
  ], { input: privatePem, encoding: 'buffer' });
  environmentUpdated = true;

  fs.renameSync(stagedPublicPath, publicPath);
  fs.chmodSync(publicPath, 0o644);
} catch (error) {
  if (!environmentUpdated) {
    fs.rmSync(stagedPublicPath, { force: true });
  } else {
    console.error(`The environment secret was rotated, but the public verifier rename failed.`);
    console.error(`Recover by moving this non-secret staged verifier into place: ${stagedPublicPath}`);
  }
  const detail = error instanceof Error ? error.message : String(error);
  fail(`Release-signing key rotation failed: ${detail}`);
} finally {
  privatePem.fill(0);
}

console.log(`Release-signing environment secret rotated for ${repository}.`);
console.log(`Public verifier written: ${publicPath}`);
console.log('No private signing key was persisted locally.');
