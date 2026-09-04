#!/usr/bin/env node
/**
 * write-release-stamp.mjs — write `dist/release-stamp.json` at build time.
 *
 * The running backend has no git on the production host, so the identity of
 * the deployed build is captured here, during `npm run build`, and shipped
 * inside `dist/`. `src/services/release-info.ts` reads it for `/api/release`
 * and `/health`.
 *
 * Every field is DETERMINISTIC for a given commit + worktree state: no
 * wall-clock build time. `scripts/release-artifact-manifest.mjs` digests
 * `dist/` after build and again before rsync, and the two digests must match.
 *
 * Usage: node scripts/write-release-stamp.mjs [--root <repo>] [--out <file>]
 * Env:   RELEASE_GIT_SHA / RELEASE_GIT_BRANCH override git lookups (containers).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function readArg(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] || fallback);
}

const root = path.resolve(readArg('--root', process.cwd()));
const out = path.resolve(readArg('--out', path.join(root, 'dist', 'release-stamp.json')));

function gitValue(commandArgs) {
  try {
    return execFileSync('git', commandArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function buildReleaseStamp({ rootDir = root, env = process.env } = {}) {
  const pkgPath = path.join(rootDir, 'package.json');
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? null;
  } catch {
    version = null;
  }

  const gitSha = env.RELEASE_GIT_SHA || gitValue(['rev-parse', 'HEAD']) || null;
  const branch = env.RELEASE_GIT_BRANCH || gitValue(['branch', '--show-current']) || null;
  const commitTime = gitSha && !env.RELEASE_GIT_SHA
    ? (gitValue(['show', '-s', '--format=%cI', 'HEAD']) || null)
    : null;
  const status = env.RELEASE_GIT_SHA ? null : gitValue(['status', '--short']);
  const dirty = status === null ? null : status.length > 0;

  let migrationCount = null;
  try {
    migrationCount = fs.readdirSync(path.join(rootDir, 'migrations')).filter((f) => f.endsWith('.sql')).length;
  } catch {
    migrationCount = null;
  }

  return {
    stampVersion: 1,
    version,
    gitSha,
    gitShortSha: gitSha ? gitSha.slice(0, 8) : null,
    branch,
    commitTime,
    dirty,
    migrationCount,
  };
}

const invokedDirectly = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const stamp = buildReleaseStamp({ rootDir: root });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(stamp, null, 2)}\n`);
  if (!args.includes('--quiet')) {
    console.log(`release stamp written: ${path.relative(root, out)} (${stamp.gitShortSha ?? 'no-git'} v${stamp.version ?? '?'})`);
  }
}
