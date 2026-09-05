#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readOnlyModes = new Set(['planning', 'planning-only', 'read-only', 'qa-only']);
const git = (root, ...args) => execFileSync('git', args, {
  cwd: root, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024,
});

// Hash inputs, never persist file contents or environment values. Full proposed
// source includes untracked files and verifier dependencies, unlike git diff.
export function fingerprint(root, env = process.env) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    head: git(root, 'rev-parse', 'HEAD').trim(),
    base: (() => { try { return git(root, 'rev-parse', 'origin/main').trim(); } catch { return null; } })(),
    staged: git(root, 'diff', '--cached', '--binary'),
    node: process.version, platform: process.platform, arch: process.arch,
    controls: Object.entries(env).filter(([key]) => key.startsWith('NEXUS_REWARD_') || key === 'NODE_OPTIONS').sort(),
  }));
  const files = [...new Set(git(root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard').split('\0').filter(Boolean))].sort();
  let bytes = 0;
  for (const file of files) {
    hash.update(`${file}\0`);
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('deleted\0'); continue;
    }
    hash.update(`${stat.mode}\0`);
    if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(absolute)); continue; }
    if (!stat.isFile()) throw new Error('non_regular_input');
    bytes += stat.size;
    if (bytes > 128 * 1024 * 1024) throw new Error('fingerprint_budget');
    hash.update(fs.readFileSync(absolute));
  }
  return hash.digest('hex');
}

export function runStopHook({ root, env = process.env, verify, now = Date.now() } = {}) {
  if (readOnlyModes.has((env.NEXUS_AGENT_MODE || '').toLowerCase())) return { skipped: 'read_only' };
  root ||= git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  if (!git(root, 'status', '--porcelain=v1', '--untracked-files=all').trim()) return { skipped: 'clean' };
  let key;
  try { key = fingerprint(root, env); } catch { /* Uncacheable input still runs the verifier. */ }
  const cachePath = path.join(root, '.local/reward-stop-cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (key && cache.version === 2 && cache.fingerprint === key && cache.reusable === true
        && now >= cache.checkedAt && now - cache.checkedAt < 30 * 60_000) return { skipped: 'cached' };
  } catch { /* Missing/invalid cache is not evidence. */ }
  const result = verify ? verify() : spawnSync(process.execPath, [
    path.join(root, 'scripts/reward-check.mjs'), '--area', 'auto', '--advisory', '--json',
  ], { cwd: root, env, encoding: 'utf8', timeout: 40_000, maxBuffer: 5 * 1024 * 1024 });
  if (result.error || result.signal || result.status !== 0) return { verdict: 'ERROR', reason: result.error?.code === 'ETIMEDOUT' ? 'verifier_timeout' : 'verifier_failed' };
  let reward;
  try { reward = JSON.parse(result.stdout); } catch { return { verdict: 'ERROR', reason: 'reward_output_not_json' }; }
  if (!['PASS', 'WARN', 'FAIL', 'MANUAL_REQUIRED', 'NOT_APPLICABLE'].includes(reward.verdict)
      || !Array.isArray(reward.hardFailures) || !Array.isArray(reward.mandatoryChecks)) {
    return { verdict: 'ERROR', reason: 'reward_output_invalid' };
  }
  const reusable = ['PASS', 'WARN'].includes(reward.verdict) && reward.hardFailures.length === 0
    && reward.mandatoryChecks.every(check => !check.mandatory || check.status === 'PASS');
  if (key && reusable && fingerprint(root, env) === key) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const temp = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify({ version: 2, fingerprint: key, checkedAt: now, reusable: true })}\n`, { mode: 0o600 });
    fs.renameSync(temp, cachePath);
  }
  return { verdict: reward.verdict, score: reward.score, hardFailures: reward.hardFailures, outputPath: reward.outputPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = runStopHook(); if (!result.skipped) console.log(JSON.stringify(result)); }
  catch { console.log(JSON.stringify({ verdict: 'ERROR', reason: 'hook_failed' })); }
  // Advisory only. No hook result grants integration or production authority.
}
