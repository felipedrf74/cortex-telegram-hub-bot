#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const json = process.argv.includes('--json');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .trim().split('\n').filter(Boolean)
  // `git ls-files --cached` includes tracked files deleted in an unstaged
  // cleanup. Audit the proposed filesystem, not the pre-cleanup index image.
  .filter((file) => fs.existsSync(path.join(root, file)));
const markdown = tracked.filter((file) => file.endsWith('.md'));
const issues = [];
const add = (type, file, message) => issues.push({ severity: 'error', type, file, message });
const rootAllowlist = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md']);

if (markdown.length > 200) add('markdown-count-limit', '.', `${markdown.length} tracked Markdown files exceeds 200`);
const markdownBytes = markdown.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
if (markdownBytes > 2 * 1024 * 1024) add('markdown-size-limit', '.', `${markdownBytes} Markdown bytes exceeds 2 MiB`);
for (const file of markdown.filter((entry) => !entry.includes('/') && !rootAllowlist.has(entry))) {
  add('root-markdown-not-allowlisted', file, 'Root Markdown is limited to README, AGENTS, CLAUDE, and CHANGELOG.');
}
for (const file of tracked.filter((entry) => entry.startsWith('docs/')
  && /docs\/_workspace-mirror|(?:^|\/)handoffs?\/|smoke-evidence|testflight-evidence/.test(entry))) {
  add('prohibited-doc-artifact', file, 'Mirrors, handoffs, and evidence belong in .local or CI artifacts.');
}

const digestToFile = new Map();
for (const file of markdown) {
  if (fs.lstatSync(path.join(root, file)).isSymbolicLink()) continue;
  const digest = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
  if (digestToFile.has(digest)) add('exact-duplicate', file, `Exact duplicate of ${digestToFile.get(digest)}`);
  else digestToFile.set(digest, file);
}

const linkPattern = /\[[^\]]*\]\((?!https?:|mailto:|#)([^)#?]+\.md)(?:#[^)]+)?\)/g;
for (const file of markdown) {
  const content = fs.readFileSync(path.join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const match of content.matchAll(linkPattern)) {
    const target = path.resolve(path.dirname(path.join(root, file)), match[1]);
    if (!fs.existsSync(target)) add('broken-active-reference', file, `Missing ${match[1]}`);
  }
}

for (const required of ['docs/project-map.json', 'docs/release/release-state.json']) {
  if (!fs.existsSync(path.join(root, required))) add('generated-map-missing', required, 'Required machine-readable map is missing.');
}
const state = JSON.parse(fs.readFileSync(path.join(root, 'docs/release/release-state.json'), 'utf8'));
const releaseSummary = fs.readFileSync(path.join(root, 'docs/release/CURRENT_RELEASE_STATE.md'), 'utf8');
for (const value of [state.backend.version, state.backend.runtimeSha, state.backend.artifactDigest]) {
  if (!releaseSummary.includes(value)) add('release-summary-drift', 'docs/release/CURRENT_RELEASE_STATE.md', `Missing release-state value ${value}`);
}
for (const skill of tracked.filter((file) => file.startsWith('.agents/skills/') && file.endsWith('/SKILL.md'))) {
  const name = skill.split('/')[2];
  const claude = path.join(root, '.claude/skills', name, 'SKILL.md');
  if (!fs.existsSync(claude) || !fs.lstatSync(claude).isSymbolicLink()) {
    add('claude-skill-not-symlinked', skill, `Claude skill ${name} must symlink to the canonical body.`);
  }
}

const result = { summary: { markdownFiles: markdown.length, markdownBytes, issueCount: issues.length }, issues };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Docs audit: ${markdown.length} Markdown files, ${markdownBytes} bytes, ${issues.length} issue(s).`);
  for (const issue of issues) console.log(`- ${issue.type}: ${issue.file}: ${issue.message}`);
}
if (strict && issues.length > 0) process.exitCode = 1;
