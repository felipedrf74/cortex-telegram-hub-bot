import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.resolve('scripts', file)).href);
const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-development-test-')); roots.push(dir); return dir; }
function git(root: string, ...args: string[]) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function repo() {
  const root = temp();
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.email', 'fixture@example.invalid'); git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, '.gitignore'), '.local/\nnode_modules/\ndist/\n.cache/\n');
  fs.writeFileSync(path.join(root, 'source.txt'), 'baseline');
  git(root, 'add', '.'); git(root, 'commit', '-m', 'fixture'); git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  return root;
}
function tree(root: string) { const dir = path.join(temp(), 'work'); git(root, 'worktree', 'add', '-b', `task-${roots.length}`, dir); return dir; }
const spec = (id: string, mode = 'write', paths = ['src']) => ({ id, owner: 'fixture-owner', mode, paths });
const passed = () => ({ status: 0, stdout: JSON.stringify({ verdict: 'PASS', hardFailures: [], mandatoryChecks: [{ mandatory: true, status: 'PASS' }] }) });
afterEach(() => { for (const root of roots.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true }); });

describe('development hook contract', () => {
  it('invalidates cached checks for untracked edits and verifier dependencies', async () => {
    const { runStopHook } = await load('reward-stop-hook.mjs'); const root = repo();
    fs.writeFileSync(path.join(root, 'new.txt'), 'first'); let calls = 0;
    const run = () => runStopHook({ root, env: {}, verify: () => { calls++; return passed(); } });
    expect(run().verdict).toBe('PASS'); expect(run().skipped).toBe('cached');
    fs.writeFileSync(path.join(root, 'new.txt'), 'second'); expect(run().verdict).toBe('PASS');
    fs.mkdirSync(path.join(root, 'scripts')); fs.writeFileSync(path.join(root, 'scripts', 'dependency.mjs'), 'changed');
    expect(run().verdict).toBe('PASS'); expect(calls).toBe(3);
  });
  it('does not cache timeout, invalid output, failure or missing mandatory evidence', async () => {
    const { runStopHook } = await load('reward-stop-hook.mjs'); const root = repo(); fs.writeFileSync(path.join(root, 'new.txt'), 'x');
    for (const result of [
      { status: null, error: { code: 'ETIMEDOUT' } }, { status: 0, stdout: '{}' }, { status: 0, stdout: 'invalid' },
      { status: 64, stdout: '' },
      { status: 0, stdout: JSON.stringify({ verdict: 'WARN', hardFailures: [], mandatoryChecks: [{ mandatory: true, status: 'SKIPPED' }] }) },
      { status: 0, stdout: JSON.stringify({ verdict: 'FAIL', hardFailures: ['failure'], mandatoryChecks: [] }) },
    ]) {
      let count = 0; const run = () => runStopHook({ root, env: {}, verify: () => { count++; return result; } });
      run(); run(); expect(count).toBe(2);
    }
  });
  it('uses checker auto selection for ordinary code, migrations and mixed changes', async () => {
    const { runStopHook } = await load('reward-stop-hook.mjs'); const root = repo();
    fs.mkdirSync(path.join(root, 'scripts')); fs.mkdirSync(path.join(root, 'migrations'));
    fs.writeFileSync(path.join(root, 'migrations', '001.sql'), 'select 1;'); fs.writeFileSync(path.join(root, 'notes.md'), 'docs');
    fs.writeFileSync(path.join(root, 'scripts', 'reward-check.mjs'), `if(process.argv[process.argv.indexOf('--area')+1]!=='auto')process.exit(64);console.log(JSON.stringify({verdict:'PASS',hardFailures:[],mandatoryChecks:[]}))`);
    expect(runStopHook({ root, env: process.env }).verdict).toBe('PASS');
  });
  it('skips read-only modes without running checks or writing a cache', async () => {
    const { runStopHook } = await load('reward-stop-hook.mjs');
    expect(runStopHook({ root: '/not-needed', env: { NEXUS_AGENT_MODE: 'planning' }, verify: () => { throw Error('unexpected'); } }).skipped).toBe('read_only');
  });
});

describe('portable guidance', () => {
  it('works without home-directory access and detects local/source drift', async () => {
    const { syncGuidance, checkGuidance } = await load('development-guidance.mjs');
    const root = repo(), source = repo();
    fs.mkdirSync(path.join(source, 'docs/agents'), { recursive: true });
    for (const file of ['docs/agents/DEVELOPMENT_PROCESS.md', 'docs/agents/MODEL_GUIDANCE.md', 'docs/NEXUS_HUB_PRODUCT_BRIEF.md']) fs.writeFileSync(path.join(source, file), '# Portable\n');
    fs.mkdirSync(path.join(source, 'scripts')); fs.copyFileSync('scripts/development-guidance.mjs', path.join(source, 'scripts/development-guidance.mjs'));
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '[Policy](docs/agents/DEVELOPMENT_PROCESS.md)'); fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md');
    syncGuidance(source, root); expect(checkGuidance(root)).toEqual([]);
    fs.appendFileSync(path.join(source, 'docs/agents/MODEL_GUIDANCE.md'), 'change'); expect(checkGuidance(root, source).join()).toContain('Source revision drift');
    fs.appendFileSync(path.join(root, 'docs/agents/DEVELOPMENT_PROCESS.md'), 'change'); expect(checkGuidance(root).join()).toContain('Generated copy drift');
    fs.appendFileSync(path.join(root, 'AGENTS.md'), '\n[Missing](/Users/missing/policy.md)'); expect(checkGuidance(root).join()).toContain('Unavailable local link');
  });
});

describe('task ownership and safe closeout', () => {
  it('blocks overlapping writers, permits readers and supports explicit handover', async () => {
    const m = await load('agent-task.mjs'), root = repo();
    m.startTask(root, spec('first')); expect(() => m.startTask(root, spec('second', 'write', ['src/api']))).toThrow('Overlapping');
    m.startTask(root, spec('reader', 'read')); m.releaseTask(root, 'first', 'fixture-owner');
    m.startTask(root, spec('second')); expect(() => m.resumeTask(root, 'first', 'fixture-owner')).toThrow('Overlapping');
    expect(() => m.releaseTask(root, 'second', 'wrong')).toThrow('owner mismatch');
  });
  it('requires integration and preserves unmerged or dirty work', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('feature')); fs.appendFileSync(path.join(work, 'source.txt'), 'changed'); m.releaseTask(root, 'feature', 'fixture-owner');
    expect(() => m.closeoutTask(root, 'feature', 'fixture-owner')).toThrow('Dirty');
    git(work, 'add', '.'); git(work, 'commit', '-m', 'unmerged'); expect(() => m.closeoutTask(root, 'feature', 'fixture-owner')).toThrow('Integration');
    expect(fs.existsSync(work)).toBe(true);
  });
  it('requires successful current checks and retains unknown ignored evidence', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('fix')); m.releaseTask(root, 'fix', 'fixture-owner');
    expect(() => m.closeoutTask(root, 'fix', 'fixture-owner')).toThrow('verification');
    m.resumeTask(root, 'fix', 'fixture-owner'); m.checkTask(root, 'fix', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']); m.releaseTask(root, 'fix', 'fixture-owner');
    fs.mkdirSync(path.join(work, '.local'), { recursive: true }); fs.writeFileSync(path.join(work, '.local', 'release-receipt.json'), '{}');
    expect(() => m.closeoutTask(root, 'fix', 'fixture-owner', { apply: true })).toThrow('Unregistered'); expect(fs.existsSync(work)).toBe(true);
  });
  it('previews then removes only clean integrated task work and preserves verification/quarantine', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('done')); fs.mkdirSync(path.join(work, 'node_modules')); fs.writeFileSync(path.join(work, 'node_modules', 'scratch'), 'owned');
    m.checkTask(root, 'done', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']); m.releaseTask(root, 'done', 'fixture-owner');
    expect(m.closeoutTask(root, 'done', 'fixture-owner').status).toBe('preview'); expect(fs.existsSync(work)).toBe(true);
    const result = m.closeoutTask(root, 'done', 'fixture-owner', { apply: true, census: () => {} });
    expect(result.status).toBe('closed'); expect(fs.existsSync(work)).toBe(false);
    expect(fs.existsSync(path.join(result.evidenceDir, 'verification.json'))).toBe(true);
    expect(fs.readFileSync(path.join(result.quarantine, 'node_modules', 'scratch'), 'utf8')).toBe('owned');
    expect(m.closeoutTask(root, 'done', 'fixture-owner', { apply: true }).status).toBe('closed');
  });
  it('blocks active sessions, dependencies and unavailable process census', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('active')); expect(() => m.closeoutTask(root, 'active', 'fixture-owner')).toThrow('active session');
    m.checkTask(root, 'active', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']); m.releaseTask(root, 'active', 'fixture-owner');
    expect(() => m.closeoutTask(root, 'active', 'fixture-owner', { apply: true, census: () => { throw Error('unavailable process census'); } })).toThrow('census');
    m.startTask(root, { ...spec('dependent', 'read'), dependencies: ['active'] });
    expect(() => m.closeoutTask(root, 'active', 'fixture-owner')).toThrow('depends'); expect(fs.existsSync(work)).toBe(true);
  });
  it('completes primary and shared-checkout tasks without retiring their checkout', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(root, spec('primary', 'read')); expect(m.completeTask(root, 'primary', 'fixture-owner').status).toBe('complete');
    expect(fs.existsSync(root)).toBe(true);
    m.startTask(work, spec('one', 'write', ['src/a'])); m.startTask(work, spec('two', 'write', ['src/b']));
    m.checkTask(root, 'one', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']);
    m.completeTask(root, 'one', 'fixture-owner'); m.completeTask(root, 'two', 'fixture-owner');
    expect(m.closeoutTask(root, 'one', 'fixture-owner', { apply: true, census: () => {} }).status).toBe('closed');
    expect(m.closeoutTask(root, 'two', 'fixture-owner').status).toBe('closed');
  });
  it('retains completed peer resources needed by another task', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('one', 'write', ['src/a'])); m.startTask(work, spec('two', 'write', ['src/b']));
    m.completeTask(root, 'one', 'fixture-owner'); m.completeTask(root, 'two', 'fixture-owner');
    m.startTask(root, { ...spec('dependent', 'read'), dependencies: ['two'] });
    expect(() => m.closeoutTask(root, 'one', 'fixture-owner', { apply: true })).toThrow('depends');
    expect(fs.existsSync(work)).toBe(true);
  });
  it('retains a retiring branch reused in a replacement checkout', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('retry')); m.completeTask(root, 'retry', 'fixture-owner');
    const recordPath = path.join(root, '.git/nexus-agent-tasks/retry.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    record.retirement = { head: git(work, 'rev-parse', 'HEAD') }; fs.writeFileSync(recordPath, JSON.stringify(record));
    git(root, 'worktree', 'remove', work);
    const replacement = path.join(temp(), 'replacement'); git(root, 'worktree', 'add', replacement, record.branch);
    expect(() => m.closeoutTask(root, 'retry', 'fixture-owner', { apply: true })).toThrow('checked out');
    expect(git(replacement, 'rev-parse', 'HEAD')).toBe(record.retirement.head);
  });
  it('retains resources when a completed peer has current failed verification', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('pass', 'write', ['src/a'])); m.startTask(work, spec('fail', 'write', ['src/b']));
    m.checkTask(root, 'pass', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']);
    m.checkTask(root, 'fail', 'fixture-owner', [process.execPath, '-e', 'process.exit(1)']);
    m.completeTask(root, 'pass', 'fixture-owner'); m.completeTask(root, 'fail', 'fixture-owner');
    expect(() => m.closeoutTask(root, 'pass', 'fixture-owner', { apply: true })).toThrow('verification');
    expect(fs.existsSync(work)).toBe(true);
  });
  it('retires actual integrated feature commits with a stale caller main', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('integrated')); fs.appendFileSync(path.join(work, 'source.txt'), 'feature');
    git(work, 'add', '.'); git(work, 'commit', '-m', 'feature'); git(root, 'update-ref', 'refs/remotes/origin/main', git(work, 'rev-parse', 'HEAD'));
    m.checkTask(root, 'integrated', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']); m.completeTask(root, 'integrated', 'fixture-owner');
    expect(m.closeoutTask(root, 'integrated', 'fixture-owner', { apply: true, census: () => {} }).status).toBe('closed');
  });
  it('accepts exact tree-equivalent squash integration and resumes interrupted finalization', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root);
    m.startTask(work, spec('squashed')); fs.appendFileSync(path.join(work, 'source.txt'), 'feature'); git(work, 'add', '.'); git(work, 'commit', '-m', 'feature');
    const head = git(work, 'rev-parse', 'HEAD');
    const squash = git(root, 'commit-tree', git(work, 'rev-parse', 'HEAD^{tree}'), '-p', git(root, 'rev-parse', 'HEAD'), '-m', 'squash');
    git(root, 'update-ref', 'refs/remotes/origin/main', squash);
    m.checkTask(root, 'squashed', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']); m.completeTask(root, 'squashed', 'fixture-owner');
    m.closeoutTask(root, 'squashed', 'fixture-owner', { apply: true, census: () => {} });
    const recordPath = path.join(root, '.git/nexus-agent-tasks/squashed.json');
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')); expect(record.retirement.head).toBe(head);
    // Simulate crash after branch deletion but before persisting the closed state.
    record.status = 'complete'; fs.writeFileSync(recordPath, JSON.stringify(record));
    expect(m.closeoutTask(root, 'squashed', 'fixture-owner', { apply: true }).status).toBe('closed');
  });
  it('preserves symlinked disposable resources and registered live processes until safe cleanup', async () => {
    const m = await load('agent-task.mjs'), root = repo(), work = tree(root), outside = temp();
    m.startTask(work, spec('process')); m.checkTask(root, 'process', 'fixture-owner', [process.execPath, '-e', 'process.exit(0)']);
    const child = await m.launchTask(root, 'process', 'fixture-owner', [process.execPath, '-e', 'setInterval(()=>{},1000)']);
    try {
      fs.symlinkSync(outside, path.join(work, 'node_modules')); m.completeTask(root, 'process', 'fixture-owner');
      expect(() => m.closeoutTask(root, 'process', 'fixture-owner', { apply: true, census: () => {} })).toThrow(/Symlink|Dirty or untracked/);
      process.kill(child.pid, 0); expect(fs.existsSync(work)).toBe(true);
    } finally { try { process.kill(child.pid, 'SIGTERM'); } catch {} }
  });

});
