import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_FULL_VITEST_MAX_AGE_SECONDS,
  createLocalFullVitestSnapshot,
  receiptPaths,
  recordLocalFullVitestReceipt,
  verifyExactPushedCandidate,
  verifyLocalFullVitestReceipt,
} from '../../scripts/local-full-vitest-receipt.mjs';

const roots: string[] = [];
const runnerFiles = [
  '.husky/pre-commit',
  '.husky/pre-push',
  '.nvmrc',
  '__tests__/setup.ts',
  'package.json',
  'scripts/build-migrated-test-database-template.ts',
  'scripts/lib/migrated-test-database-template-runner.mjs',
  'scripts/lib/test-policy.mjs',
  'scripts/local-full-vitest-receipt.mjs',
  'scripts/risk-gate.sh',
  'scripts/run-test-tier.mjs',
  'src/testing/migrated-test-database-template.ts',
  'tsconfig.json',
  'vitest.config.ts',
];

function write(root: string, relative: string, body: string): void {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vitest-receipt-'));
  roots.push(root);
  write(root, '.gitignore', '.local/\nnode_modules/\n.env\n.env.*\n');
  for (const file of runnerFiles) write(root, file, `fixture:${file}\n`);
  write(root, '__tests__/sample.test.ts', 'export const sample = true;\n');
  write(root, 'filter-target.txt', 'safe\n');
  write(root, 'config/test-policy.json', JSON.stringify({
    version: 'fixture',
    dispositionRules: [{
      pattern: '__tests__/**/*.test.ts',
      disposition: 'keep',
      reason: 'fixture deterministic test',
    }],
  }));
  write(root, 'package-lock.json', '{"lockfileVersion":3}\n');
  write(root, 'content-engine/requirements.txt', 'pytest==1.0.0\n');
  write(root, 'node_modules/.package-lock.json', '{"lockfileVersion":3}\n');
  write(root, 'node_modules/vitest/package.json', '{"name":"vitest","version":"4.1.8"}\n');
  write(root, 'node_modules/vitest/vitest.mjs', 'export const fixture = true;\n');
  git(root, 'init', '--quiet');
  git(root, 'config', 'user.email', 'fixture@example.test');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'fixture baseline');
  fs.appendFileSync(path.join(root, 'src/testing/migrated-test-database-template.ts'), 'candidate\n');
  git(root, 'add', 'src/testing/migrated-test-database-template.ts');
  return root;
}

function writePassingReport(root: string, names = ['__tests__/sample.test.ts']): void {
  const paths = receiptPaths(root);
  fs.mkdirSync(paths.directory, { recursive: true });
  fs.writeFileSync(paths.report, JSON.stringify({
    success: true,
    numTotalTests: names.length,
    numFailedTests: 0,
    numFailedTestSuites: 0,
    testResults: names.map((name) => ({
      name: path.isAbsolute(name) ? name : path.join(root, name),
      assertionResults: [{ status: 'passed' }],
    })),
  }));
}

function recordPassingReceipt(root: string, start = Date.parse('2026-07-26T10:00:00Z')): void {
  createLocalFullVitestSnapshot({ rootDir: root, nowMs: start });
  writePassingReport(root);
  recordLocalFullVitestReceipt({ rootDir: root, nowMs: start + 1_000 });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('exact local full Vitest receipt', () => {
  it('records private atomic evidence and reuses it for the exact staged tree', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);

    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 2_000,
    })).not.toThrow();
    expect(fs.statSync(receiptPaths(root).receipt).mode & 0o777).toBe(0o600);
    expect(fs.statSync(receiptPaths(root).directory).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(receiptPaths(root).directory).some((name) => name.endsWith('.tmp'))).toBe(false);

    fs.appendFileSync(receiptPaths(root).report, '\n');
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 3_000,
    })).toThrow(/does not match its receipt/);
  });

  it('binds pre-push reuse to the one exact committed SHA and its tree', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);
    git(root, 'commit', '--quiet', '-m', 'candidate');
    const pushedSha = git(root, 'rev-parse', 'HEAD');

    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-push',
      pushedSha,
      nowMs: now + 2_000,
    })).not.toThrow();
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-push',
      pushedSha: git(root, 'rev-parse', 'HEAD^'),
      nowMs: now + 2_000,
    })).toThrow(/exact pushed commit tree/);
  });

  it('rejects stale evidence and every policy or candidate-tree drift', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);

    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + (LOCAL_FULL_VITEST_MAX_AGE_SECONDS + 2) * 1_000,
    })).toThrow(/stale/);

    fs.appendFileSync(path.join(root, 'config/test-policy.json'), '\n');
    git(root, 'add', 'config/test-policy.json');
    fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 2_000,
    })).toThrow(/current candidate/);
  });

  it('binds test-impact environment options without persisting their values', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = '--trace-warnings';
    try {
      expect(() => verifyLocalFullVitestReceipt({
        rootDir: root,
        context: 'pre-commit',
        nowMs: now + 2_000,
      })).toThrow(/code-injection environment/);
      const receipt = fs.readFileSync(receiptPaths(root).receipt, 'utf8');
      expect(receipt).not.toContain('--trace-warnings');
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previous;
    }

    write(root, '.env', 'SECRET_FIXTURE_VALUE=not-real\n');
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 3_000,
    })).toThrow(/current candidate/);
    expect(fs.readFileSync(receiptPaths(root).receipt, 'utf8'))
      .not.toContain('SECRET_FIXTURE_VALUE');

    const gitRoot = fixture();
    recordPassingReceipt(gitRoot, now);
    const previousGitExecPath = process.env.GIT_EXEC_PATH;
    process.env.GIT_EXEC_PATH = '/private/tmp/untrusted-git-exec-path';
    try {
      expect(() => verifyLocalFullVitestReceipt({
        rootDir: gitRoot,
        context: 'pre-commit',
        nowMs: now + 4_000,
      })).toThrow(/current candidate/);
    } finally {
      if (previousGitExecPath === undefined) delete process.env.GIT_EXEC_PATH;
      else process.env.GIT_EXEC_PATH = previousGitExecPath;
    }
  });

  it('binds the ignored installed dependency bytes and symlink target', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);

    write(root, 'node_modules/.vite/vitest/results.json', '{"mutable":"cache"}\n');
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 1_000,
    })).not.toThrow();

    fs.appendFileSync(path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'drift\n');

    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-commit',
      nowMs: now + 2_000,
    })).toThrow(/current candidate/);

    const linkedRoot = fixture();
    const externalPackage = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vitest-external-pkg-'));
    roots.push(externalPackage);
    write(externalPackage, 'index.js', 'export default true;\n');
    fs.symlinkSync(externalPackage, path.join(linkedRoot, 'node_modules', 'external-package'));
    expect(() => createLocalFullVitestSnapshot({ rootDir: linkedRoot }))
      .toThrow(/symlink escapes node_modules/);
  });

  it('refuses to record an incomplete or non-governed JSON report', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    createLocalFullVitestSnapshot({ rootDir: root, nowMs: now });
    writePassingReport(root, []);

    expect(() => recordLocalFullVitestReceipt({
      rootDir: root,
      nowMs: now + 1_000,
    })).toThrow(/no test files|governed deterministic file set/);
    expect(fs.existsSync(receiptPaths(root).receipt)).toBe(false);

    const foreignRoot = fixture();
    createLocalFullVitestSnapshot({ rootDir: foreignRoot, nowMs: now });
    writePassingReport(foreignRoot, [
      path.join(os.tmpdir(), 'foreign-repository/__tests__/sample.test.ts'),
    ]);
    expect(() => recordLocalFullVitestReceipt({
      rootDir: foreignRoot,
      nowMs: now + 1_000,
    })).toThrow(/escapes the repository/);
  });

  it('requires a clean working tree with all nonignored files in the index', () => {
    const untrackedRoot = fixture();
    write(untrackedRoot, 'untracked.ts', 'not staged\n');
    expect(() => createLocalFullVitestSnapshot({ rootDir: untrackedRoot }))
      .toThrow(/untracked nonignored/);

    const unstagedRoot = fixture();
    fs.appendFileSync(path.join(unstagedRoot, 'package.json'), 'unstaged\n');
    expect(() => createLocalFullVitestSnapshot({ rootDir: unstagedRoot }))
      .toThrow(/bytes differ from the staged index/);

    for (const flag of ['--assume-unchanged', '--skip-worktree']) {
      const hiddenRoot = fixture();
      git(hiddenRoot, 'update-index', flag, 'package.json');
      fs.appendFileSync(path.join(hiddenRoot, 'package.json'), 'hidden change\n');
      expect(() => createLocalFullVitestSnapshot({ rootDir: hiddenRoot }))
        .toThrow(/assume-unchanged or skip-worktree/);
    }

    const filteredRoot = fixture();
    write(filteredRoot, '.git/info/attributes', 'filter-target.txt filter=forcebad\n');
    git(filteredRoot, 'config', 'filter.forcebad.clean', 'sed s/safe/bad/');
    git(filteredRoot, 'add', '--renormalize', 'filter-target.txt');
    expect(() => createLocalFullVitestSnapshot({ rootDir: filteredRoot }))
      .toThrow(/bytes differ from the staged index/);
  });

  it('refuses a symlinked private receipt directory', () => {
    const root = fixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-vitest-receipt-outside-'));
    roots.push(outside);
    fs.mkdirSync(path.join(root, '.local'));
    fs.symlinkSync(outside, path.join(root, '.local', 'risk-gate'));

    expect(() => createLocalFullVitestSnapshot({ rootDir: root }))
      .toThrow(/must not be a symlink/);

    const recordedRoot = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(recordedRoot, now);
    const paths = receiptPaths(recordedRoot);
    const moved = path.join(recordedRoot, '.local', 'risk-gate-real');
    fs.renameSync(paths.directory, moved);
    fs.symlinkSync(moved, paths.directory);
    expect(() => verifyLocalFullVitestReceipt({
      rootDir: recordedRoot,
      context: 'pre-commit',
      nowMs: now + 2_000,
    })).toThrow(/must not be a symlink/);
  });

  it('does not let a Git replacement object disguise the pushed commit tree', () => {
    const root = fixture();
    const now = Date.parse('2026-07-26T10:00:00Z');
    recordPassingReceipt(root, now);
    git(root, 'commit', '--quiet', '-m', 'tested candidate');
    const testedCommit = git(root, 'rev-parse', 'HEAD');

    fs.appendFileSync(path.join(root, 'package.json'), 'different pushed tree\n');
    git(root, 'add', 'package.json');
    git(root, 'commit', '--quiet', '-m', 'different candidate');
    const pushedSha = git(root, 'rev-parse', 'HEAD');
    git(root, 'replace', pushedSha, testedCommit);
    git(root, 'read-tree', `${testedCommit}^{tree}`);
    git(root, 'checkout-index', '-a', '-f');

    expect(() => verifyLocalFullVitestReceipt({
      rootDir: root,
      context: 'pre-push',
      pushedSha,
      nowMs: now + 2_000,
    })).toThrow(/exact pushed commit tree/);
    expect(() => verifyExactPushedCandidate({ rootDir: root, pushedSha }))
      .toThrow(/exact pushed HEAD/);
  });

  it('wires hooks without a generic Vitest skip override', () => {
    const preCommit = fs.readFileSync('.husky/pre-commit', 'utf8');
    const prePush = fs.readFileSync('.husky/pre-push', 'utf8');
    const riskGate = fs.readFileSync('scripts/risk-gate.sh', 'utf8');

    expect(preCommit).toContain('--local-reuse-context pre-commit');
    expect(preCommit).toContain('ARGS=(--staged');
    expect(preCommit).toContain('--diff-filter=ACMRTD');
    expect(preCommit).toContain('--no-renames');
    expect(prePush).toContain('NON_DELETE_PUSH_SHAS');
    expect(prePush).toContain('PUSH_UPDATE_COUNT');
    expect(prePush).toContain('No ref updates — push is already up to date');
    expect(prePush).toContain('[ "$PUSH_UPDATE_COUNT" -eq 1 ]');
    expect(prePush).toContain('check-pushed-candidate');
    expect(prePush).toContain('requires exactly one well-formed non-delete ref update');
    expect(prePush).toContain('refs/tags/*:tag|refs/tags/*:commit');
    expect(prePush).toContain('[ "$PUSH_REMOTE_REF" = "refs/heads/main" ]');
    expect(prePush).toContain('ARGS+=(--skip-typecheck)');
    expect(prePush).toContain('--local-reuse-context pre-push');
    expect(prePush).toContain('--local-pushed-sha');
    expect(prePush).not.toContain('NEXUS_PREPUSH_SKIP_VITEST');
    expect(riskGate).toContain('Full Vitest reused from the exact local candidate receipt');
    expect(riskGate).toContain('[ "$REPORTER" = "dot" ]');
    expect(riskGate).toContain('tier_args+=(--no-cache)');
    expect(riskGate).toContain("grep '^GIT_'");
    expect(riskGate).toContain('export GIT_NO_REPLACE_OBJECTS=1');
    expect(riskGate).toContain('LOCAL_RECEIPT_ENV_SAFE=false');
    expect(riskGate).toContain('receipt disabled by test environment');
    expect(riskGate).toContain('LOCAL_RECEIPT_CI');
    expect(riskGate).toContain('node "$LOCAL_RECEIPT_HELPER" record');
    expect(riskGate).toContain('receipt rechecked after all non-Vitest gates');
    expect(riskGate.indexOf('npx tsc --noEmit'))
      .toBeLessThan(riskGate.indexOf('Full Vitest reused from the exact local candidate receipt'));
  });

  it('refuses direct receipt commands in CI', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/local-full-vitest-receipt.mjs', 'snapshot'],
      {
        encoding: 'utf8',
        env: { ...process.env, CI: '1' },
      },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('receipts are disabled in CI');
  });
});
