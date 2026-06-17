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
const defaultIosSpecsRoot = path.resolve(workspaceRoot, '..', 'Nexus Hub IOS', 'specs');
const iosSpecsRoot = path.resolve(process.env.NEXUS_IOS_SPECS_ROOT || defaultIosSpecsRoot);

const ignoredDirs = new Set([
  '.build',
  '.claude',
  '.codex',
  '.git',
  '.local',
  '.next',
  '.pytest_cache',
  '.venv',
  'DerivedData',
  'Pods',
  'build',
  'dist',
  'node_modules',
  // Git worktrees (added 2026-05-03 release-pipeline-risk-based-optimization).
  // Each worktree is a parallel checkout that contains its OWN copy of every
  // markdown file. Walking them inflates the issue count by hundreds and
  // confuses drift detection: the same SHA may be reachable from one
  // worktree's branch but not from main. Worktrees are ALWAYS evidence of
  // in-progress parallel work, never canonical.
  'worktrees',
]);

const currentVerdictFiles = new Set([
  path.join(workspaceRoot, 'docs', 'release', 'CURRENT_RELEASE_STATE.md'),
  path.join(workspaceRoot, 'docs', 'release', 'OPEN_ITEMS.md'),
  path.join(backendRoot, 'docs', 'qa', 'QA_BACKEND_REPORT.md'),
  // Phases 0-15 QA artifacts are intentionally current while this registry
  // verification branch is active. Keep the allowlist exact so ad-hoc QA
  // reports still have to move to archive or a canonical report surface.
  path.join(backendRoot, 'docs', 'qa', 'PHASES_0_15_CODEX_QA_PROMPT.md'),
  path.join(backendRoot, 'docs', 'qa', 'PHASES_0_15_QA_REPORT.md'),
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
  path.join(workspaceRoot, 'docs', 'agent', 'AGENT_PROCESS_STANDARD.md'),
  // Added 2026-05-04: cross-repo technical onboarding pack. Lives next to
  // OPERATING_CONTEXT and AGENT_PROCESS_STANDARD because it teaches the
  // workspace's full technical surface to new Claude/Codex sessions.
  // Registered in `docs/DOCS_INDEX.md` and
  // `engine/docs/engineering/ENGINEERING_STANDARDS_INDEX.md`.
  path.join(workspaceRoot, 'docs', 'agent', 'AGENT_TECHNICAL_MASTERY.md'),
  path.join(backendRoot, 'CLAUDE.md'),
  path.join(backendRoot, 'AGENTS.md'),
  path.join(backendRoot, 'README.md'),
  // Root docs registered in docs/DOCUMENTATION-MAP.md as canonical live or
  // active supporting docs. Keep this exact instead of allowing every root
  // Markdown file, because TASK-* files are explicitly historical.
  path.join(backendRoot, 'BRANCHING.md'),
  path.join(backendRoot, 'CHANGELOG.md'),
  path.join(backendRoot, 'DEPLOY.md'),
  path.join(backendRoot, 'DOCUMENTATION.md'),
  path.join(backendRoot, 'STAGING.md'),
  path.join(backendRoot, 'content-engine', 'README.md'),
  path.join(backendRoot, 'docs', 'DOCS_INDEX.md'),
  path.join(backendRoot, 'docs', 'agents', 'VERIFIABLE_REWARD_PROTOCOL.md'),
  path.join(backendRoot, 'docs', 'DOCUMENTATION-MAP.md'),
  path.join(backendRoot, 'docs', 'qa', 'QA_BACKEND_REPORT.md'),
  path.join(backendRoot, 'docs', 'qa', 'PHASES_0_15_CODEX_QA_PROMPT.md'),
  path.join(backendRoot, 'docs', 'qa', 'PHASES_0_15_IOS_CONTRACT_FIXTURES.md'),
  path.join(backendRoot, 'docs', 'qa', 'PHASES_0_15_QA_REPORT.md'),
  path.join(iosRoot, 'README.md'),
  path.join(iosRoot, 'AGENTS.md'),
  path.join(iosRoot, 'CLAUDE.md'),
  path.join(iosRoot, 'docs', 'DOCS_INDEX.md'),
  path.join(iosRoot, 'docs', 'qa', 'QA_IOS_REPORT.md'),
]);

const approvedCurrentFiles = new Set([
  // Backend CLAUDE.md treats this as the cross-agent backend handoff.
  // Approve the location without promoting the stale handoff body into
  // current-like broken-link scanning; archival cleanup remains tracked.
  path.join(backendRoot, 'docs', 'agents', 'claude', 'handoff.md'),
  // Batch 19 P2: one-off but current security audit for the content-reference
  // owner-scope boundary. Approve the exact file rather than all
  // docs/security/** so future security notes still need DOCS_INDEX routing.
  path.join(backendRoot, 'docs', 'security', 'content-references-scope-audit.md'),
  // Security hardening baseline docs are current only when individually
  // registered here and routed through docs/DOCS_INDEX.md.
  path.join(backendRoot, 'docs', 'security', 'nexus-security-threat-model.md'),
  path.join(backendRoot, 'docs', 'security', 'security-control-matrix.md'),
  path.join(backendRoot, 'docs', 'security', 'security-operations-runbook.md'),
  path.join(backendRoot, 'docs', 'security', 'security-hardening-implementation-status.md'),
  path.join(backendRoot, 'docs', 'security', 'security-hardening-claude-qa-prompt.md'),
]);

const verdictPattern =
  /(^|\n)\s*(#{1,4}\s*)?(final\s+)?(verdict|recommendation)\s*[:\-]|READY_FOR_PRODUCTION|READY_FOR_PRODUCTION_PROMOTION|DO_NOT_PROMOTE|DO_NOT_DEPLOY|DO_NOT_MERGE|GO WITH CONDITIONS|PASS WITH CONDITIONS|DO-NOT-SHIP|SHIP-WITH-FOLLOWUP/i;
const testCountPattern =
  /\b(?:\d{1,4}\s+files?\s*\/\s*)?\d{1,5}\s*\/\s*\d{1,5}\s+(?:tests?|PASS|passed)\b|\b\d{2,5}\s+tests?\b|\b\d{2,5}\s*\/\s*\d{2,5}\b/i;
const commitHashPattern = /\b[0-9a-f]{7,40}\b/gi;
const markdownLinkPattern = /\[[^\]]*]\(([^)#?]+\.md)(?:#[^)]+)?\)|`([^`]+\.md)`/g;
const requiredEngineeringFrontmatter = [
  /^Status:\s*\S+/im,
  /^Owner:\s*\S+/im,
  /^Last verified:\s*\d{4}-\d{2}-\d{2}/im,
  /^Update policy:\s*\S+/im,
];

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
    || normalized.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
    || normalized.includes(`${path.sep}src${path.sep}skills${path.sep}`)
    || normalized.includes(`${path.sep}src${path.sep}services${path.sep}coach-kernel${path.sep}knowledge${path.sep}`)
    || normalized.includes(`${path.sep}knowledge${path.sep}skills${path.sep}`);
}

function isApprovedCurrentOrArchive(file) {
  const normalized = normalize(file);
  if (canonicalFiles.has(normalized) || approvedCurrentFiles.has(normalized) || isArchive(normalized) || isProductMarkdownAsset(normalized)) {
    return true;
  }
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'agent') + path.sep)) return true;
  // OPERATING_CONTEXT requires end-of-session agent handoffs here. Approve the
  // directory so required handoffs do not appear as scattered-doc warnings.
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'agents', 'handoffs') + path.sep)) return true;
  if (normalized.startsWith(path.join(backendRoot, 'docs', 'agents', 'handoffs') + path.sep)) return true;
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'release') + path.sep)) return true;
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'runbooks') + path.sep)) return true;
  // Engineering-excellence enrichment (2026-05-04): canonical engineering
  // standards live under workspace `docs/engineering/`, backend
  // `engine/docs/engineering/`, and iOS `ios/docs/engineering/`.
  if (normalized.startsWith(path.join(workspaceRoot, 'docs', 'engineering') + path.sep)) return true;
  if (normalized.startsWith(path.join(backendRoot, 'docs', 'engineering') + path.sep)) return true;
  if (normalized.startsWith(path.join(iosRoot, 'docs', 'engineering') + path.sep)) return true;
  // ENG-EXC-O8 (2026-05-04): the workspace docs mirror inside engine/.
  if (normalized.startsWith(path.join(backendRoot, 'docs', '_workspace-mirror') + path.sep)) return true;
  if (normalized.startsWith(path.join(backendRoot, 'docs', 'release') + path.sep)) return true;
  // Local-dev sandbox runbook (2026-05-14): docs/local-dev/ is a known
  // taxonomy for Docker-based local development. Same allowlist pattern
  // as docs/runbooks, docs/release, docs/engineering above.
  if (normalized.startsWith(path.join(backendRoot, 'docs', 'local-dev') + path.sep)) return true;
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
    || normalized.startsWith(path.join(backendRoot, 'docs', 'qa') + path.sep)
    // ENG-EXC-O9 (closed-beta-auth-hardening, 2026-05-04): outbound
    // markdown link resolution over `engineering/` paths. Engineering
    // standards reference each other heavily; a renamed standard
    // would break a link silently. Treating engineering paths as
    // current-like means broken-link warnings fire on them.
    || normalized.startsWith(path.join(workspaceRoot, 'docs', 'engineering') + path.sep)
    || normalized.startsWith(path.join(backendRoot, 'docs', 'engineering') + path.sep)
    || normalized.startsWith(path.join(iosRoot, 'docs', 'engineering') + path.sep);
}

function isEngineeringStandard(file) {
  const normalized = normalize(file);
  return normalized.startsWith(path.join(workspaceRoot, 'docs', 'engineering') + path.sep)
    || normalized.startsWith(path.join(backendRoot, 'docs', 'engineering') + path.sep)
    || normalized.startsWith(path.join(iosRoot, 'docs', 'engineering') + path.sep)
    || normalized === path.join(workspaceRoot, 'docs', 'agent', 'AGENT_PROCESS_STANDARD.md');
}

// Engineering-excellence enrichment (2026-05-04, ENG-EXC-O8): the workspace
// `docs/` folder is not git-tracked. The mirror at
// engine/docs/_workspace-mirror/ is a one-way snapshot; drift between the
// workspace source and the mirror is a durability bug. This check warns
// once if the mirror is stale relative to the workspace.
const WORKSPACE_MIRROR_ROOT = path.join(backendRoot, 'docs', '_workspace-mirror');
const WORKSPACE_MIRROR_SOURCES = [
  { rel: 'CLAUDE.md', src: path.join(workspaceRoot, 'CLAUDE.md') },
  { rel: 'AGENTS.md', src: path.join(workspaceRoot, 'AGENTS.md') },
  { rel: 'README.md', src: path.join(workspaceRoot, 'README.md') },
];

function checkWorkspaceMirrorDrift() {
  // Walk every doc under workspace docs/ that the mirror is supposed to track.
  const sources = [...WORKSPACE_MIRROR_SOURCES];
  const docsRoot = path.join(workspaceRoot, 'docs');
  if (existsDir(docsRoot)) {
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'archive' || entry.name === '.git') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()
          && (entry.name.toLowerCase().endsWith('.md')
            || entry.name === 'release-identity.json')) {
          const rel = path.relative(workspaceRoot, full);
          sources.push({ rel, src: full });
        }
      }
    }
    walk(docsRoot);
  }
  for (const { rel, src } of sources) {
    if (!fs.existsSync(src)) continue;
    const mirror = path.join(WORKSPACE_MIRROR_ROOT, rel);
    if (!fs.existsSync(mirror)) {
      addIssue(
        'warn',
        'workspace-mirror-missing',
        src,
        1,
        `Workspace doc has no mirror at engine/docs/_workspace-mirror/${rel}. Run engine/scripts/workspace-docs-mirror.sh.`,
      );
      continue;
    }
    try {
      const a = fs.readFileSync(src);
      const b = fs.readFileSync(mirror);
      if (!a.equals(b)) {
        addIssue(
          'warn',
          'workspace-mirror-stale',
          src,
          1,
          `Workspace doc differs from mirror at engine/docs/_workspace-mirror/${rel}. Run engine/scripts/workspace-docs-mirror.sh.`,
        );
      }
    } catch {
      // Read errors are non-fatal here; the mirror script is the source of truth.
    }
  }
}

function validateEngineeringFrontmatter(file, content) {
  if (!isEngineeringStandard(file)) return;

  const header = content.split('\n').slice(0, 16).join('\n');
  const missing = requiredEngineeringFrontmatter
    .filter((pattern) => !pattern.test(header))
    .map((pattern) => {
      if (String(pattern).includes('Status')) return 'Status';
      if (String(pattern).includes('Owner')) return 'Owner';
      if (String(pattern).includes('Last verified')) return 'Last verified';
      return 'Update policy';
    });

  if (missing.length > 0) {
    addIssue(
      'warn',
      'engineering-standard-frontmatter-missing',
      file,
      1,
      `Engineering standard is missing required frontmatter: ${missing.join(', ')}.`,
    );
  }
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

function isLikelyCommitHash(hash) {
  // The broad hex regex also sees dates (20260429), device identifiers
  // (00008150), numeric placeholders, and other non-commit operational IDs.
  // Real Git SHAs can technically be all digits, but in practice treating
  // numeric-only tokens as non-commit text removes much more audit noise than
  // signal. Full hashes and normal short SHAs with a-f letters still count.
  return /[a-f]/i.test(hash) && !/^20\d{6}$/.test(hash);
}

function commitExistsInKnownRepo(hash) {
  const rootsToCheck = [backendRoot, normalize(iosRoot)].filter((root) => existsDir(path.join(root, '.git')));
  return rootsToCheck.some((root) => commitExists(root, hash));
}

function resolveMarkdownRef(file, ref) {
  if (!ref || /^[a-z]+:/i.test(ref)) return null;
  const withoutAnchor = ref.split('#')[0];
  if (withoutAnchor.includes('*')
    || withoutAnchor.startsWith('~')
    || /[<>{}]/.test(withoutAnchor)) return null;
  if (!withoutAnchor.endsWith('.md')) return null;
  if (path.isAbsolute(withoutAnchor)) return withoutAnchor;
  const local = path.resolve(path.dirname(file), withoutAnchor);
  if (fs.existsSync(local)) return local;
  const backendRelative = path.resolve(backendRoot, withoutAnchor);
  if (fs.existsSync(backendRelative)) return backendRelative;
  const iosRelative = path.resolve(normalize(iosRoot), withoutAnchor);
  if (fs.existsSync(iosRelative)) return iosRelative;
  const workspaceRelative = path.resolve(workspaceRoot, withoutAnchor);
  if (fs.existsSync(workspaceRelative)) return workspaceRelative;
  if (withoutAnchor.startsWith('Nexus Hub IOS/specs/')) {
    const iosSpec = path.resolve(iosSpecsRoot, withoutAnchor.replace(/^Nexus Hub IOS\/specs\//, ''));
    if (fs.existsSync(iosSpec)) return iosSpec;
  }
  if (/^\d{2}-[^/]+\.md$/.test(withoutAnchor)) {
    const iosSpec = path.resolve(iosSpecsRoot, withoutAnchor);
    if (fs.existsSync(iosSpec)) return iosSpec;
  }
  return local;
}

function maskFencedCodeBlocks(content) {
  return content.replace(/```[\s\S]*?```/g, (match) => '\n'.repeat(match.split('\n').length - 1));
}

function maskOperationalIds(content) {
  return content
    // Simulator/device destinations and UUIDs are hex-like, but they are not
    // Git commits. Preserve line count while avoiding stale-SHA noise.
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{8,}\b/gi, (match) => 'X'.repeat(match.length));
}

const roots = [
  { name: 'workspace', root: workspaceRoot, followSymlinks: false },
  { name: 'backend', root: backendRoot, followSymlinks: false },
  { name: 'ios', root: normalize(iosRoot), followSymlinks: false },
  { name: 'ios-specs', root: normalize(iosSpecsRoot), followSymlinks: false },
];

const markdownFiles = [...new Set(roots.flatMap((entry) => walkMarkdown(entry.root, entry.followSymlinks).map(normalize)))].sort();

// Run the workspace-mirror drift check once before per-file iteration so
// the warnings appear at workspace path locations (not mirror paths).
checkWorkspaceMirrorDrift();

// ENG-EXC-O8 (2026-05-04): the workspace-mirror at engine/docs/_workspace-mirror/
// is a one-way snapshot of workspace docs. Per-file lints already run on the
// workspace source; running them again on the mirror produces duplicate
// warnings. Skip mirrored files from the per-file iteration; the drift check
// above is the only audit signal that matters for the mirror.
function isWorkspaceMirror(file) {
  return normalize(file).startsWith(WORKSPACE_MIRROR_ROOT + path.sep);
}

const auditedMarkdownFiles = markdownFiles.filter((file) => !isWorkspaceMirror(file));

for (const file of auditedMarkdownFiles) {
  const content = fs.readFileSync(file, 'utf8');
  const scannableContent = maskOperationalIds(maskFencedCodeBlocks(content));

  validateEngineeringFrontmatter(file, content);

  if (!isApprovedCurrentOrArchive(file)) {
    addIssue(
      'warn',
      'markdown-outside-approved-current-or-archive-location',
      file,
      1,
      'Move to an approved current doc, archive it, or document why this file is canonical.',
    );
  }

  if (!isArchive(file) && verdictPattern.test(scannableContent) && !currentVerdictFiles.has(file)) {
    const match = scannableContent.match(verdictPattern);
    addIssue(
      'warn',
      'duplicate-or-scattered-current-verdict',
      file,
      match?.index == null ? 1 : lineNumber(scannableContent, match.index),
      'Verdict-like language outside the approved current verdict docs can create drift.',
    );
  }

  if (!isArchive(file) && testCountPattern.test(scannableContent) && !currentVerdictFiles.has(file)) {
    const match = scannableContent.match(testCountPattern);
    addIssue(
      'warn',
      'test-count-literal-outside-current-report',
      file,
      match?.index == null ? 1 : lineNumber(scannableContent, match.index),
      'Literal test counts drift quickly; keep active counts in current release/QA docs or generated artifacts.',
    );
  }

  const gitRoot = gitRootFor(file);
  if (gitRoot && !isArchive(file)) {
    const hashes = [...new Set(scannableContent.match(commitHashPattern) || [])]
      .filter((hash) => hash.length >= 7 && isLikelyCommitHash(hash));
    for (const hash of hashes) {
      if (!commitExists(gitRoot, hash) && !commitExistsInKnownRepo(hash)) {
        const index = scannableContent.indexOf(hash);
        addIssue(
          'warn',
          'commit-hash-not-found-in-own-repo',
          file,
          index === -1 ? 1 : lineNumber(scannableContent, index),
          `Commit hash ${hash} was not found in ${path.basename(gitRoot)}; verify it is not stale or cross-repo.`,
        );
      }
    }
  }

  if (!isArchive(file) && isCurrentLike(file)) {
    for (const match of scannableContent.matchAll(markdownLinkPattern)) {
      const ref = match[1] || match[2];
      const resolved = resolveMarkdownRef(file, ref);
      if (resolved && !fs.existsSync(resolved)) {
        addIssue(
          'warn',
          'broken-markdown-reference',
          file,
          lineNumber(scannableContent, match.index ?? 0),
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
  markdownFiles: auditedMarkdownFiles.length,
  totalMarkdownFilesDiscovered: markdownFiles.length,
  skippedWorkspaceMirrorFiles: markdownFiles.length - auditedMarkdownFiles.length,
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
  console.log(`- markdown files audited: ${summary.markdownFiles}`);
  if (summary.skippedWorkspaceMirrorFiles > 0) {
    console.log(`- workspace mirror files skipped: ${summary.skippedWorkspaceMirrorFiles}`);
  }
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
