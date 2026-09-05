#!/usr/bin/env node
// Cooperative local ownership, not a security boundary against hostile agents.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fingerprint } from './reward-stop-hook.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 }).trim();
const idOK = id => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(id);
const inside = (a, b) => b === a || b.startsWith(`${a}${path.sep}`);
const overlaps = (a, b) => a === '.' || b === '.' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
const cleanPath = p => typeof p === 'string' && (p === '.' || (!p.startsWith('-') && !path.isAbsolute(p) && p.split('/').every(x => x && x !== '.' && x !== '..') && !/[\n\r\\]/.test(p)));

function store(root) {
  const common = fs.realpathSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  const dir = path.join(common, 'nexus-agent-tasks');
  if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) throw new Error('Unsafe task store');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
function atomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, file);
}
function locked(root, fn) {
  const dir = store(root), lock = path.join(dir, 'lock');
  try { fs.mkdirSync(lock); } catch { throw new Error('Task ledger busy; do not steal an existing lock'); }
  try { return fn(dir); } finally { fs.rmdirSync(lock); }
}
function records(dir) { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); }
function get(dir, id, owner) {
  if (!idOK(id)) throw new Error('Invalid task id');
  const value = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  if (owner !== value.owner) throw new Error('Task owner mismatch');
  return value;
}
const save = (dir, record) => atomic(path.join(dir, `${record.id}.json`), record);
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Unsafe process id');
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
  if (result.status === 1 && !result.stdout?.trim() && !result.stderr?.trim()) return null;
  if (result.status !== 0 || !result.stdout?.trim()) throw new Error('Cannot prove process identity');
  return hash(result.stdout.trim());
}

export function startTask(root, spec) {
  root = fs.realpathSync(git(root, 'rev-parse', '--show-toplevel'));
  return locked(root, dir => {
    if (!idOK(spec.id) || typeof spec.owner !== 'string' || !spec.owner.trim() || !['read', 'write'].includes(spec.mode)
        || !Array.isArray(spec.paths) || !spec.paths.length || !spec.paths.every(cleanPath)
        || !Array.isArray(spec.dependencies || [])) throw new Error('Invalid task specification');
    const all = records(dir);
    if (all.some(t => t.id === spec.id)) throw new Error('Task already registered; resume it instead');
    for (const dependency of spec.dependencies || []) if (!idOK(dependency) || !all.some(t => t.id === dependency)) throw new Error('Unknown dependency');
    if (spec.mode === 'write' && all.some(t => t.active && t.mode === 'write' && t.paths.some(a => spec.paths.some(b => overlaps(a, b))))) throw new Error('Overlapping active writer');
    const scratch = `.local/tasks/${spec.id}/scratch`;
    const disposable = [scratch, 'node_modules', 'dist', '.cache'].filter(p => !fs.existsSync(path.join(root, p)));
    const record = { schema: 'nexus.agent-task.v1', id: spec.id, owner: spec.owner, mode: spec.mode, paths: spec.paths,
      dependencies: spec.dependencies || [], root, branch: git(root, 'branch', '--show-current'),
      base: git(root, 'rev-parse', 'HEAD'), active: true, status: 'active', createdAt: new Date().toISOString(),
      disposable, processes: [], checks: [], model: spec.model ?? null, effort: spec.effort ?? null };
    save(dir, record); return record;
  });
}
export function releaseTask(root, id, owner) {
  return locked(root, dir => { const t = get(dir, id, owner); t.active = false; t.status = 'paused'; save(dir, t); return t; });
}
export function completeTask(root, id, owner) {
  return locked(root, dir => {
    const t = get(dir, id, owner);
    if (t.retirement || t.status === 'closed') throw new Error('Task is already retiring or closed');
    t.active = false; t.status = 'complete'; t.completedAt = new Date().toISOString();
    save(dir, t); return t; // Ownership completion is not a claim of tests, integration or cleanup.
  });
}
function deleteIntegratedBranch(root, branch, expected) {
  if (git(root, 'worktree', 'list', '--porcelain').split('\n').includes(`branch refs/heads/${branch}`)) throw new Error('Retiring branch is checked out; retained');
  const result = spawnSync('git', ['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: root, encoding: 'utf8' });
  if (result.status === 128) return; // Already removed after the persisted retirement proof.
  if (result.status !== 0 || result.stdout.trim() !== expected) throw new Error('Retiring branch changed');
  git(root, 'update-ref', '-d', `refs/heads/${branch}`, expected);
}
export function resumeTask(root, id, owner) {
  return locked(root, dir => {
    const t = get(dir, id, owner);
    if (t.status === 'closed' || t.retirement) throw new Error('Task is already retiring or closed');
    if (t.mode === 'write' && records(dir).some(x => x.id !== id && x.active && x.mode === 'write' && x.paths.some(a => t.paths.some(b => overlaps(a, b))))) throw new Error('Overlapping active writer');
    t.active = true; t.status = 'active'; save(dir, t); return t;
  });
}
export function checkTask(root, id, owner, command) {
  if (!command.length) throw new Error('Missing verification command');
  let t;
  locked(root, dir => { t = get(dir, id, owner); if (!t.active) throw new Error('Resume before verification'); });
  const before = fingerprint(t.root);
  const started = Date.now();
  // Output is streamed to the operator, not copied into a potentially sensitive ledger.
  const result = spawnSync(command[0], command.slice(1), { cwd: t.root, stdio: 'inherit' });
  const after = fingerprint(t.root);
  return locked(root, dir => {
    t = get(dir, id, owner);
    const check = { command: path.basename(command[0]), commandHash: hash(JSON.stringify(command)),
      exitCode: result.status, durationMs: Date.now() - started, sourceDigest: after,
      stableInputs: before === after, head: git(t.root, 'rev-parse', 'HEAD'), at: new Date().toISOString() };
    t.checks.push(check); save(dir, t); return check;
  });
}
export async function launchTask(root, id, owner, command) {
  if (!command.length) throw new Error('Missing process command');
  // Keep registration synchronous with the ownership lock; no user-supplied PID.
  return locked(root, dir => {
    const t = get(dir, id, owner); if (!t.active) throw new Error('Resume before launching a process');
    const child = spawn(command[0], command.slice(1), { cwd: t.root, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    if (!child.pid) throw new Error('Process failed to launch');
    try {
      const start = identity(child.pid);
      if (!start) throw new Error('Process exited before registration');
      t.processes.push({ pid: child.pid, identity: start }); save(dir, t); child.unref();
    } catch (error) { child.kill('SIGTERM'); throw error; }
    return { pid: child.pid };
  });
}
function worktrees(root) {
  return git(root, 'worktree', 'list', '--porcelain').split('\n\n').map(block => {
    const lines = block.split('\n'); return { root: lines.find(l => l.startsWith('worktree '))?.slice(9), locked: lines.some(l => l.startsWith('locked')) };
  }).filter(t => t.root);
}
function noOpenHandles(root) {
  const result = spawnSync('lsof', ['-t', '+D', root], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.signal || result.stderr?.trim() || result.status !== 1 || result.stdout?.trim()) throw new Error('Open handles or unavailable process census; worktree retained');
}
function safeDisposable(root, relative) {
  const destination = path.join(root, relative);
  for (let p = destination; p !== root; p = path.dirname(p)) if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Error('Symlink in disposable path');
  return destination;
}
export function closeoutTask(root, id, owner, { apply = false, census = noOpenHandles } = {}) {
  return locked(root, dir => {
    const t = get(dir, id, owner);
    if (t.status === 'closed') return { status: 'closed', id };
    if (t.active) throw new Error('Release the active session before closeout');
    const all = records(dir);
    const related = all.filter(x => x.root === t.root && (x.id === id || x.status === 'complete'));
    const retiringIds = new Set(related.map(x => x.id));
    if (all.some(x => !retiringIds.has(x.id) && !['closed', 'complete'].includes(x.status) && (x.dependencies.some(dependency => retiringIds.has(dependency)) || x.root === t.root))) throw new Error('Another task depends on these resources');
    const evidenceDir = path.join(dir, 'evidence', id);
    if (t.retirement && !fs.existsSync(t.root)) {
      if (apply) { deleteIntegratedBranch(root, t.branch, t.retirement.head); for (const item of related) { item.status = 'closed'; save(dir, item); } }
      return { status: apply ? 'closed' : 'preview', id, remaining: 'local_branch' };
    }
    if (git(t.root, 'status', '--porcelain=v1', '--untracked-files=all')) throw new Error('Dirty or untracked work; retained');
    if (git(t.root, 'branch', '--show-current') !== t.branch) throw new Error('Task branch changed');
    const trees = worktrees(root), target = trees.find(x => path.resolve(x.root) === t.root);
    if (!target || target.locked || path.resolve(trees[0].root) === t.root || ['main', 'master', ''].includes(t.branch)) throw new Error('Primary, locked, detached or unknown worktree; retained');
    if (inside(t.root, fs.realpathSync(root))) throw new Error('Run closeout from a different checkout');
    const head = git(t.root, 'rev-parse', 'HEAD'), base = git(root, 'rev-parse', 'refs/remotes/origin/main');
    const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', head, base], { cwd: root });
    if (ancestor.status !== 0 && git(root, 'rev-parse', `${head}^{tree}`) !== git(root, 'rev-parse', `${base}^{tree}`)) throw new Error('Integration into origin/main not proven; retained');
    const digest = fingerprint(t.root);
    const relatedChecks = related.flatMap(x => x.checks);
    if (!relatedChecks.some(c => c.exitCode === 0 && c.stableInputs && c.sourceDigest === digest)
        || relatedChecks.some(c => c.sourceDigest === digest && (c.exitCode !== 0 || !c.stableInputs))) throw new Error('Current successful verification evidence missing');
    const disposablePaths = [...new Set(related.flatMap(x => x.disposable))];
    const processes = related.flatMap(x => x.processes);
    const ignored = git(t.root, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z').split('\0').filter(Boolean);
    for (const file of ignored) if (!disposablePaths.some(p => file === p || file.startsWith(`${p}/`))) throw new Error('Unregistered ignored artifacts/evidence; retained');
    const disposables = disposablePaths.map(p => safeDisposable(t.root, p)).filter(p => fs.existsSync(p));
    for (const p of processes) { const current = identity(p.pid); if (current && current !== p.identity) throw new Error('Process identity changed; retained'); }
    const preview = { status: 'preview', id, worktree: t.root, branch: t.branch, processes: processes.length, disposablePaths: disposables, integrationBase: base };
    if (!apply) return preview;
    // Persist evidence BEFORE any destructive step. Unknown ignored files block above.
    fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
    atomic(path.join(evidenceDir, 'verification.json'), { id, head, base, tasks: related.map(x => ({ id: x.id, checks: x.checks })) });
    for (const p of processes) if (identity(p.pid) === p.identity) process.kill(p.pid, 'SIGTERM');
    // Never guess descendant ownership. A surviving process/handle blocks retirement.
    census(t.root);
    const quarantine = path.join(dir, 'quarantine', id); fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
    for (const p of disposables) {
      const relative = path.relative(t.root, p), dest = path.join(quarantine, relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(p, dest);
    }
    const retirement = { head, base, evidenceDir, quarantine, at: new Date().toISOString() };
    for (const item of related) { item.retirement = retirement; save(dir, item); }
    git(root, 'worktree', 'remove', '--', t.root);
    deleteIntegratedBranch(root, t.branch, head);
    for (const item of related) { item.status = 'closed'; save(dir, item); }
    return { status: 'closed', id, evidenceDir, quarantine };
  });
}

const help = `Usage: node scripts/agent-task.mjs <command> [--repo <checkout>]
  start --spec <json>       {id, owner, mode: read|write, paths: [...], dependencies?: [...], model?, effort?}
  status                   Read cooperative task ownership and check durations
  resume|release|complete --id <id> --owner <owner>
  check --id <id> --owner <owner> -- <verification command>
  launch --id <id> --owner <owner> -- <task-owned process>
  closeout --id <id> --owner <owner> [--apply]
Closeout previews by default. Apply only under the approved cleanup policy.
Run it from another checkout after integration and explicit ownership release.
Unknown ignored files, dependencies, live handles or uncertain evidence block.
Quarantine and verification records remain outside removed worktrees.`;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), command = args[0];
    const option = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
    const root = path.resolve(option('--repo') || process.cwd()), id = option('--id'), owner = option('--owner');
    let result;
    if (args.includes('--help') || !command) { console.log(help); }
    else {
      if (command === 'start') result = startTask(root, JSON.parse(fs.readFileSync(option('--spec'), 'utf8')));
      else if (command === 'status') result = records(store(root));
      else if (command === 'resume') result = resumeTask(root, id, owner);
      else if (command === 'complete') result = completeTask(root, id, owner);
      else if (command === 'release') result = releaseTask(root, id, owner);
      else if (command === 'check' || command === 'launch') {
        const i = args.indexOf('--'); if (i < 0) throw new Error('Use -- before the command');
        result = command === 'check' ? checkTask(root, id, owner, args.slice(i + 1)) : await launchTask(root, id, owner, args.slice(i + 1));
        if (command === 'check' && result.exitCode !== 0) process.exitCode = 1;
      } else if (command === 'closeout') result = closeoutTask(root, id, owner, { apply: args.includes('--apply') });
      else throw new Error('Unknown task command');
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
