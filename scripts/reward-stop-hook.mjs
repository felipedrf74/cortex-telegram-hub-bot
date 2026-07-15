#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const mode = (process.env.NEXUS_AGENT_MODE ?? '').toLowerCase();
if (['planning', 'planning-only', 'read-only', 'qa-only'].includes(mode)) process.exit(0);

const git = (...args) => execFileSync('git', args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
const status = git('status', '--porcelain=v1', '--untracked-files=normal');
if (!status.trim()) process.exit(0);
const files = status.trim().split('\n').map((line) => line.slice(3));
const area = files.some((file) => file.startsWith('migrations/')) ? 'migration'
  : files.some((file) => file.startsWith('docs/') || file.endsWith('.md')) ? 'docs'
    : files.some((file) => file.includes('release') || file.startsWith('.github/')) ? 'release'
      : 'code';
const verifier = fs.readFileSync(path.join(root, 'scripts/reward-check.mjs'));
const fingerprint = createHash('sha256').update(JSON.stringify({
  head: git('rev-parse', 'HEAD').trim(),
  status,
  diff: git('diff', '--binary'),
  staged: git('diff', '--cached', '--binary'),
  area,
  verifier: createHash('sha256').update(verifier).digest('hex'),
})).digest('hex');
const cachePath = path.join(root, '.local/reward-stop-cache.json');
try {
  const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  if (cached.fingerprint === fingerprint) process.exit(0);
} catch { /* first run */ }

const result = spawnSync(process.execPath, [
  path.join(root, 'scripts/reward-check.mjs'), '--area', area, '--advisory', '--json',
], { cwd: root, encoding: 'utf8', timeout: 40_000 });
fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
fs.writeFileSync(cachePath, `${JSON.stringify({
  fingerprint,
  checkedAt: new Date().toISOString(),
  area,
  exitCode: result.status,
}, null, 2)}\n`, { mode: 0o600 });
if (result.stdout) {
  try {
    const reward = JSON.parse(result.stdout);
    process.stdout.write(`${JSON.stringify({
      verdict: reward.verdict,
      score: reward.score,
      hardFailures: reward.hardFailures,
      outputPath: reward.outputPath,
    })}\n`);
  } catch {
    process.stdout.write(JSON.stringify({ verdict: 'ERROR', reason: 'reward_output_not_json' }));
  }
}
if (result.stderr) process.stderr.write(result.stderr);
// Stop hooks are advisory. Release promotion invokes the enforcing check.
process.exit(0);
