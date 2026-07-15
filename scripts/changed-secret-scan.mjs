#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const index = args.indexOf('--base');
const base = index >= 0 ? args[index + 1] : '';
if (!base) throw new Error('Usage: changed-secret-scan.mjs --base <sha>');
const diff = execFileSync('git', ['diff', '--unified=0', `${base}...HEAD`, '--'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
const patterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:api[_-]?key|secret|token|password|private[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{24,}/i,
  /\b(?:sk-ant-|sk-proj-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/,
];
if (patterns.some((pattern) => pattern.test(added))) {
  console.error('Potential secret found in added lines. Replace it with a redacted placeholder.');
  process.exit(1);
}
console.log('Changed-line secret scan passed.');
