#!/usr/bin/env node
import { checkGuidance } from './development-guidance.mjs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  DOCUMENTATION_POLICY_PATH,
  gitHistoryOnlyDocumentationIssues,
  resolveDocumentationInventory,
} from './lib/documentation-policy.mjs';
import { releaseStateDocumentationIssues } from './lib/docs-release-state-audit.mjs';
import { missingCanonicalRegistryMarkdownPaths } from './lib/docs-audit-paths.mjs';

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
const lineCount = (source) => source.length === 0
  ? 0
  : source.replace(/\r?\n$/, '').split(/\r?\n/).length;

if (markdown.length > 200) add('markdown-count-limit', '.', `${markdown.length} tracked Markdown files exceeds 200`);
const markdownBytes = markdown.reduce((sum, file) => sum + fs.statSync(path.join(root, file)).size, 0);
if (markdownBytes > 2 * 1024 * 1024) add('markdown-size-limit', '.', `${markdownBytes} Markdown bytes exceeds 2 MiB`);
for (const file of markdown.filter((entry) => !entry.includes('/') && !rootAllowlist.has(entry))) {
  add('root-markdown-not-allowlisted', file, 'Root Markdown is limited to README, AGENTS, CLAUDE, and CHANGELOG.');
}
for (const file of tracked.filter((entry) => entry.startsWith('docs/')
  && /docs\/_workspace-mirror|(?:^|\/)handoffs?\/|(?:^|\/)(?:[^/]*handoff|qa-report|test-report|audit-report|worktree-recovery|release-narrative)[^/]*\.md$|smoke-evidence|testflight-evidence/.test(entry))) {
  add('prohibited-doc-artifact', file, 'Mirrors, handoffs, and evidence belong in .local or CI artifacts.');
}

for (const [file, maximumLines, issueType] of [
  ['AGENTS.md', 100, 'agent-bootloader-too-long'],
  ['CLAUDE.md', 200, 'claude-bootloader-too-long'],
  ['docs/release/CURRENT_RELEASE_STATE.md', 100, 'release-summary-too-long'],
]) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    add(issueType, file, 'Required compact documentation surface is missing.');
    continue;
  }
  const lines = lineCount(fs.readFileSync(absolute, 'utf8'));
  if (lines > maximumLines) add(issueType, file, `${lines} lines exceeds ${maximumLines}`);
}

if (fs.existsSync(path.join(root, 'CLAUDE.md'))) {
  const firstInstruction = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0);
  if (firstInstruction !== '@AGENTS.md') {
    add('claude-bootloader-not-shared', 'CLAUDE.md', 'CLAUDE.md must begin with @AGENTS.md.');
  }
}

if (tracked.includes('.claude/settings.local.json')) {
  add(
    'claude-local-settings-tracked',
    '.claude/settings.local.json',
    'Machine-local Claude permissions must remain ignored and untracked.',
  );
}
const claudeSettingsPath = path.join(root, '.claude/settings.json');
if (!fs.existsSync(claudeSettingsPath)) {
  add('claude-settings-missing', '.claude/settings.json', 'Safe project settings are required.');
} else {
  try {
    const settings = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf8'));
    const topLevelKeys = Object.keys(settings).sort();
    const hookKeys = Object.keys(settings.hooks ?? {}).sort();
    const stopEntries = settings.hooks?.Stop;
    const hookEntries = Array.isArray(stopEntries)
      ? stopEntries.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : [])
      : [];
    const safeHook = hookEntries.length === 1
      && hookEntries[0]?.type === 'command'
      && hookEntries[0]?.command === 'node "$(git rev-parse --show-toplevel)/scripts/reward-stop-hook.mjs"'
      && Number.isInteger(hookEntries[0]?.timeout)
      && hookEntries[0].timeout > 0
      && hookEntries[0].timeout <= 45;
    if (topLevelKeys.join(',') !== '$schema,hooks'
        || hookKeys.join(',') !== 'Stop'
        || !Array.isArray(stopEntries)
        || stopEntries.length !== 1
        || !safeHook) {
      add(
        'claude-settings-not-safe-allowlist',
        '.claude/settings.json',
        'Project settings may contain only the bounded advisory reward Stop hook.',
      );
    }
  } catch (error) {
    add(
      'claude-settings-invalid',
      '.claude/settings.json',
      error instanceof Error ? error.message : String(error),
    );
  }
}

for (const deprecatedSkill of ['ios-development', 'nexus-hub-engineer', 'deploy-babysitter']) {
  if (tracked.some((file) => file.startsWith(`.agents/skills/${deprecatedSkill}/`)
      || file.startsWith(`.claude/skills/${deprecatedSkill}/`))) {
    add(
      'deprecated-repository-skill',
      deprecatedSkill,
      'Deprecated or merged skills must not return to repository scope.',
    );
  }
}

for (const file of markdown.filter((entry) => (
  entry !== 'docs/release/CURRENT_RELEASE_STATE.md'
  && /(?:^|\/)(?:current[-_ ]?release|release[-_ ]?state|[^/]*verdict[^/]*)\.md$/i.test(entry)
))) {
  add(
    'competing-current-verdict',
    file,
    'Checked-in release projection is limited to release-state.json and CURRENT_RELEASE_STATE.md; live host state and immutable receipts remain authoritative.',
  );
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

let governance = null;
try {
  governance = resolveDocumentationInventory({ repoRoot: root, files: markdown });
  for (const issue of governance.issues) add(issue.type, issue.file, issue.message);
  for (const issue of gitHistoryOnlyDocumentationIssues(governance.records)) {
    add(issue.type, issue.file, issue.message);
  }
} catch (error) {
  add(
    'documentation-policy-invalid',
    DOCUMENTATION_POLICY_PATH,
    error instanceof Error ? error.message : String(error),
  );
}

if (governance) {
  // A count is a same-line prose claim. Do not join a shell exit status such
  // as `return 1` to the next command named `test` across a newline.
  const staleTestCountPattern = /(?:\b[0-9][0-9,]*[ \t]+(?:test(?:s| files?)?|cases?)\b|(?:test(?:s| files?)?|cases?)[ \t]*[:=][ \t]*[0-9][0-9,]*)/i;
  for (const record of governance.records.filter((entry) => entry.active && entry.status !== 'generated')) {
    const content = fs.readFileSync(path.join(root, record.path), 'utf8');
    if (staleTestCountPattern.test(content)) {
      add(
        'embedded-test-count',
        record.path,
        'Active documentation must reference governed test paths or tiers, not drift-prone case counts.',
      );
    }
  }
}

// Markdown links are already checked above. Canonical indexes intentionally
// use inline-code paths because they are compact boot registries, so validate
// those focused registries too instead of letting deleted docs remain listed.
for (const file of [
  'docs/DOCS_INDEX.md',
  'docs/engineering/ENGINEERING_STANDARDS_INDEX.md',
]) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    add('canonical-path-registry-missing', file, 'Canonical path registry is missing.');
    continue;
  }
  const source = fs.readFileSync(absolute, 'utf8');
  for (const missing of missingCanonicalRegistryMarkdownPaths({
    registryFile: file,
    source,
    repoRoot: root,
  })) {
    add('broken-canonical-registry-path', file, `Missing inline-code path ${missing.reference}`);
  }
}

for (const required of ['docs/project-map.json', 'docs/release/release-state.json']) {
  if (!fs.existsSync(path.join(root, required))) add('generated-map-missing', required, 'Required machine-readable map is missing.');
}
if (fs.existsSync(path.join(root, 'docs/project-map.json'))) {
  const projectMapCheck = spawnSync(
    process.execPath,
    ['scripts/generate-project-map.mjs', '--check'],
    { cwd: root, encoding: 'utf8' },
  );
  if (projectMapCheck.status !== 0) {
    const output = `${projectMapCheck.stdout || ''}\n${projectMapCheck.stderr || ''}`.trim();
    // Only genuine drift is drift; a crashed checker (missing node_modules,
    // ERR_MODULE_NOT_FOUND, git warnings) must say so instead of masquerading
    // as drift — the nightly lane spent weeks reporting a dependency error as
    // "project-map-drift: node:internal/modules/package_json_reader".
    const driftLine = output.split('\n').find((line) => line.includes('Project map drift'));
    if (driftLine) {
      add('project-map-drift', 'docs/project-map.json', driftLine);
    } else {
      const firstLine = output.split('\n').filter(Boolean)[0] || 'Project map freshness check failed.';
      add('project-map-check-error', 'docs/project-map.json',
        `Checker exited ${projectMapCheck.status} without reporting drift: ${firstLine}`);
    }
  }
}
const state = JSON.parse(fs.readFileSync(path.join(root, 'docs/release/release-state.json'), 'utf8'));
const releaseSummary = fs.readFileSync(path.join(root, 'docs/release/CURRENT_RELEASE_STATE.md'), 'utf8');
for (const issue of releaseStateDocumentationIssues({ state, releaseSummary })) {
  add(issue.type, 'docs/release/CURRENT_RELEASE_STATE.md', issue.message);
}
for (const skill of tracked.filter((file) => file.startsWith('.agents/skills/') && file.endsWith('/SKILL.md'))) {
  const name = skill.split('/')[2];
  const claude = path.join(root, '.claude/skills', name);
  if (!fs.existsSync(claude) || !fs.lstatSync(claude).isSymbolicLink()
      || fs.realpathSync(claude) !== fs.realpathSync(path.join(root, '.agents/skills', name))) {
    add('claude-skill-not-symlinked', skill, `Claude skill ${name} must directory-symlink to its canonical skill.`);
  }
}

for (const error of checkGuidance(root, root)) add('development-guidance', 'AGENTS.md', error);

const result = { summary: { markdownFiles: markdown.length, markdownBytes, issueCount: issues.length }, issues };
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`Docs audit: ${markdown.length} Markdown files, ${markdownBytes} bytes, ${issues.length} issue(s).`);
  for (const issue of issues) console.log(`- ${issue.type}: ${issue.file}: ${issue.message}`);
}
if (strict && issues.length > 0) process.exitCode = 1;
