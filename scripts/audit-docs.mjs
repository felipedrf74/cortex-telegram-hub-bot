#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2));
const strict = args.has('--strict');
const json = args.has('--json');

const defaultWorkspace = path.resolve(backendRoot, '..', '..', '..', 'Nexus Hub');
const workspaceRoot = path.resolve(process.env.NEXUS_WORKSPACE_ROOT || defaultWorkspace);
const iosRoot = path.join(workspaceRoot, 'ios');
const iosSpecsRoot = path.join(workspaceRoot, 'ios-specs');

const ignoredDirs = new Set([
  '.build',
  '.claude',
  '.codex',
  '.git',
  '.local',
  '.next',
  '.venv',
  'DerivedData',
  'Pods',
  'build',
  'dist',
  'node_modules',
]);

const currentVerdictFiles = new Set([
  path.join(workspaceRoot, 'docs', 'release', 'CURRENT_RELEASE_STATE.md'),
  path.join(workspaceRoot, 'docs', 'release', 'OPEN_ITEMS.md'),
  path.join(backendRoot, 'docs', 'qa', 'QA_BACKEND_REPORT.md'),
  path.join(backendRoot, 'docs', 'release', 'CURRENT_RELEASE_STATE.md'),
  path.join(backendRoot, 'docs', 'release', 'current-release-index.md'),
  path.join(iosRoot, 'docs', 'qa', 'QA_IOS_REPORT.md'),
]);

const canonicalFiles = new Set([
  path.join(workspaceRoot, 'AGENTS.md'),
  path.join(workspaceRoot, 'CLAUDE.md'),
  path.join(workspaceRoot, 'README.md'),
  path.join(workspaceRoot, 'docs', 'DOCS_INDEX.md'),
  path.join(workspaceRoot, 'docs', 'archive', 'ARCHIVE_INDEX.md'),
  path.join(workspaceRoot, 'docs', 'release', 'CURRENT_RELEASE_STATE.md'),
  path.join(workspaceRoot, 'docs', 'release', 'OPEN_ITEMS.md'),
  path.join(workspaceRoot, 'docs', 'agent', 'OPERATING_CONTEXT.md'),
  path.join(backendRoot, 'CLAUDE.md'),
  path.join(backendRoot, 'README.md'),
  path.join(backendRoot, 'docs', 'DOCS_INDEX.md'),
  path.join(backendRoot, 'docs', 'DOCUMENTATION-MAP.md'),
  path.join(backendRoot, 'docs', 'qa', 'QA_BACKEND_REPORT.md'),
  path.join(iosRoot, 'README.md'),
  path.join(iosRoot, 'AGENTS.md'),
  path.join(iosRoot, 'CLAUDE.md'),
  path.join(iosRoot, 'docs', 'qa', 'QA_IOS_REPORT.md'),
]);

const verdictPattern =
  /(^|\n)\s*(#{1,4}\s*)?(final\s+)?(verdict|recommendation)\s*[:\-]|READY_FOR_PRODUCTION|READY_FOR_PRODUCTION_PROMOTION|DO_NOT_PROMOTE|DO_NOT_DEPLOY|DO_NOT_MERGE|GO WITH CONDITIONS|PASS WITH CONDITIONS|DO-NOT-SHIP|SHIP-WITH-FOLLOWUP/i;
const testCountPattern =
  /\b(?:\d{1,4}\s+files?\s*\/\s*)?\d{1,5}\s*\/\s*\d{1,5}\s+(?:tests?|PASS|passed)\b|\b\d{2,5}\s+tests?\b|\b\d{2,5}\s*\/\s*\d{2,5}\b/i;
const commitHashPattern = /\b[0-9a-f]{7,40}\b/gi;
const markdownLinkPattern = /\[[^\]]*]\(([^)#?]+\.md)(?:#[^)]+)?\)|`([^`]+\.md)`/g;

const issues = [];

function addIssue(severity, type, file, line, message) {
  issues.push({
    severity,
    type,
    file: path.relative(workspaceRoot, file).startsWith('..') ? file : path.relative(workspaceRoot, file),
    line,
    message,
  });
}

function existsDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function walkMarkdown(root, followSymlinks = false) {
  const files = [];
  if (!existsDir(root)) return files;

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredDirs.has(entry.name) || entry.name.startsWith('.venv')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        if (!followSymlinks) continue;
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (entry.name.toLowerCase().endsWith('.md')) files.push(full);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(full);
      }
    }
  }

  walk(root);
  return files;
}

function normalize(file) {
  return path.resolve(file);
}

function isArchive(file) {
  const normalized = normalize(file);
  return normalized.includes(`${path.sep}docs${path.sep}archive${path.sep}`)
    || normalized.includes(`${path.sep}docs${path.sep}release${path.sep}archive${path.sep}`)
    || normalized.includes(`${path.sep}archive${path.sep}`);
}

function isProductMarkdownAsset(file) {
  const normalized = normalize(file);
  return normalized.includes(`${path.sep}prompts${path.sep}`)
    || normalized.includes(`${path.sep}src${path.sep}skills${path.sep}`)
    || normalized.includes(`${path.sep}src${path.sep}services${path.sep}coach-kernel${path.sep}knowledge${path.sep}`)
    || normalized.includes(`${path.sep}knowledge${path.sep}skills${path.sep}`);
}

function isApprovedCurrentOrArchive(file) {
  const normalized = normalize(file);
  if (canonicalFiles.has(normalized) || isArchive(normalized) || isProductMarkdownAsset(normalized)) {
    return true;
  }
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'agent') + path.sep)) return true;
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'release') + path.sep)) return true;
  if (normalized.startsWith(path.join(backendRoot, 'docs', 'release') + path.sep)) return true;
  if (normalized.startsWith(path.join(backendRoot, 'docs') + path.sep) && path.dirname(normalized) === path.join(backendRoot, 'docs')) return true;
  if (normalized.startsWith(iosSpecsRoot + path.sep)) return true;
  return false;
}

function isCurrentLike(file) {
  const normalized = normalize(file);
  return canonicalFiles.has(normalized)
    || currentVerdictFiles.has(normalized)
    || normalized.startsWith(path.join(workspaceRoot, 'docs') + path.sep)
    || normalized.startsWith(path.join(backendRoot, 'docs', 'release') + path.sep)
    || normalized.startsWith(path.join(backendRoot, 'docs', 'qa') + path.sep);
}

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

function gitRootFor(file) {
  const normalized = normalize(file);
  if (normalized.startsWith(backendRoot + path.sep)) return backendRoot;
  if (normalized.startsWith(normalize(iosRoot) + path.sep)) return normalize(iosRoot);
  return null;
}

function commitExists(gitRoot, hash) {
  try {
    execFileSync('git', ['cat-file', '-e', `${hash}^{commit}`], {
      cwd: gitRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function resolveMarkdownRef(file, ref) {
  if (!ref || /^[a-z]+:/i.test(ref)) return null;
  const withoutAnchor = ref.split('#')[0];
  if (withoutAnchor.includes('*') || withoutAnchor.startsWith('~')) return null;
  if (!withoutAnchor.endsWith('.md')) return null;
  if (path.isAbsolute(withoutAnchor)) return withoutAnchor;
  const local = path.resolve(path.dirname(file), withoutAnchor);
  if (fs.existsSync(local)) return local;
  const backendRelative = path.resolve(backendRoot, withoutAnchor);
  if (fs.existsSync(backendRelative)) return backendRelative;
  const workspaceRelative = path.resolve(workspaceRoot, withoutAnchor);
  if (fs.existsSync(workspaceRelative)) return workspaceRelative;
  return local;
}

const roots = [
  { name: 'workspace', root: workspaceRoot, followSymlinks: false },
  { name: 'backend', root: backendRoot, followSymlinks: false },
  { name: 'ios', root: normalize(iosRoot), followSymlinks: false },
  { name: 'ios-specs', root: normalize(iosSpecsRoot), followSymlinks: false },
];

const markdownFiles = [...new Set(roots.flatMap((entry) => walkMarkdown(entry.root, entry.followSymlinks).map(normalize)))].sort();

for (const file of markdownFiles) {
  const content = fs.readFileSync(file, 'utf8');

  if (!isApprovedCurrentOrArchive(file)) {
    addIssue(
      'warn',
      'markdown-outside-approved-current-or-archive-location',
      file,
      1,
      'Move to an approved current doc, archive it, or document why this file is canonical.',
    );
  }

  if (!isArchive(file) && verdictPattern.test(content) && !currentVerdictFiles.has(file)) {
    const match = content.match(verdictPattern);
    addIssue(
      'warn',
      'duplicate-or-scattered-current-verdict',
      file,
      match?.index == null ? 1 : lineNumber(content, match.index),
      'Verdict-like language outside the approved current verdict docs can create drift.',
    );
  }

  if (!isArchive(file) && testCountPattern.test(content) && !currentVerdictFiles.has(file)) {
    const match = content.match(testCountPattern);
    addIssue(
      'warn',
      'test-count-literal-outside-current-report',
      file,
      match?.index == null ? 1 : lineNumber(content, match.index),
      'Literal test counts drift quickly; keep active counts in current release/QA docs or generated artifacts.',
    );
  }

  const gitRoot = gitRootFor(file);
  if (gitRoot && !isArchive(file)) {
    const hashes = [...new Set(content.match(commitHashPattern) || [])].filter((hash) => hash.length >= 7);
    for (const hash of hashes) {
      if (!commitExists(gitRoot, hash)) {
        const index = content.indexOf(hash);
        addIssue(
          'warn',
          'commit-hash-not-found-in-own-repo',
          file,
          index === -1 ? 1 : lineNumber(content, index),
          `Commit hash ${hash} was not found in ${path.basename(gitRoot)}; verify it is not stale or cross-repo.`,
        );
      }
    }
  }

  if (!isArchive(file) && isCurrentLike(file)) {
    for (const match of content.matchAll(markdownLinkPattern)) {
      const ref = match[1] || match[2];
      const resolved = resolveMarkdownRef(file, ref);
      if (resolved && !fs.existsSync(resolved)) {
        addIssue(
          'warn',
          'broken-markdown-reference',
          file,
          lineNumber(content, match.index ?? 0),
          `Referenced markdown file does not exist: ${ref}`,
        );
      }
    }
  }
}

const summary = {
  workspaceRoot,
  backendRoot,
  iosRoot: normalize(iosRoot),
  markdownFiles: markdownFiles.length,
  issueCount: issues.length,
  issuesByType: issues.reduce((acc, issue) => {
    acc[issue.type] = (acc[issue.type] || 0) + 1;
    return acc;
  }, {}),
};

if (json) {
  console.log(JSON.stringify({ summary, issues }, null, 2));
} else {
  console.log('# Nexus Hub docs audit');
  console.log('');
  console.log(`- workspace: ${summary.workspaceRoot}`);
  console.log(`- markdown files scanned: ${summary.markdownFiles}`);
  console.log(`- issues flagged: ${summary.issueCount}`);
  console.log('');
  for (const [type, count] of Object.entries(summary.issuesByType).sort()) {
    console.log(`- ${type}: ${count}`);
  }
  console.log('');

  const maxIssues = Number(process.env.DOCS_AUDIT_MAX_ISSUES || 80);
  for (const issue of issues.slice(0, maxIssues)) {
    console.log(`- [${issue.severity}] ${issue.type}: ${issue.file}:${issue.line}`);
    console.log(`  ${issue.message}`);
  }
  if (issues.length > maxIssues) {
    console.log(`- ... ${issues.length - maxIssues} more issues omitted. Use --json for the full list.`);
  }
}

if (strict && issues.length > 0) {
  process.exitCode = 1;
}
