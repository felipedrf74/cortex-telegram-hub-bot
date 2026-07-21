import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const CHAT_EVAL_LOCAL = join(ROOT, 'scripts', 'chat-eval-local.sh');
const PROMOTE = join(ROOT, 'scripts', 'promote-exact-release.sh');

function runScript(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bash', [CHAT_EVAL_LOCAL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NEXUS_CHAT_EVAL_LOCAL_DISABLED: '0', ...env },
  });
}

describe('chat-eval-local dry run', () => {
  it('prints the full local_engine plan without touching Docker and exits 0', () => {
    const result = runScript(['--dry-run']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry run');
    expect(result.stdout).toContain('./scripts/local-up.sh');
    expect(result.stdout).toContain('chatv2-seed-local-evidence.ts --write --replace');
    expect(result.stdout).toContain('local-ios-debug-auth.mjs');
    expect(result.stdout).toContain('run-chat-eval-live.ts --mode local_engine');
    expect(result.stdout).toContain('--auth-token-env');
    expect(result.stdout).toContain('--persist-db');
    // Tokens must never be printed, even in plans.
    expect(result.stdout).toContain('value never printed');
  });

  it('defaults teardown to leaving the sandbox up and honors --teardown', () => {
    const defaultPlan = runScript(['--dry-run']);
    const teardownPlan = runScript(['--dry-run', '--teardown']);

    expect(defaultPlan.status).toBe(0);
    expect(defaultPlan.stdout).toContain('none (sandbox stays up)');
    expect(teardownPlan.status).toBe(0);
    expect(teardownPlan.stdout).toContain('./scripts/local-down.sh');
  });

  it('refuses to run when the kill switch is engaged', () => {
    const result = runScript(['--dry-run'], { NEXUS_CHAT_EVAL_LOCAL_DISABLED: '1' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('kill switch engaged');
  });

  it('honors the kill switch when it is set via .env.local (re-checked after sourcing)', () => {
    // Copy the script into an isolated root so we can plant a .env.local
    // without touching the repository checkout.
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'chat-eval-local-killswitch-'));
    try {
      mkdirSync(join(isolatedRoot, 'scripts'), { recursive: true });
      copyFileSync(CHAT_EVAL_LOCAL, join(isolatedRoot, 'scripts', 'chat-eval-local.sh'));
      writeFileSync(join(isolatedRoot, '.env.local'), 'NEXUS_CHAT_EVAL_LOCAL_DISABLED=1\n');

      const result = spawnSync('bash', [join(isolatedRoot, 'scripts', 'chat-eval-local.sh'), '--dry-run'], {
        cwd: isolatedRoot,
        encoding: 'utf8',
        env: { ...process.env, NEXUS_CHAT_EVAL_LOCAL_DISABLED: '0' },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('kill switch engaged');
      expect(result.stderr).toContain('.env.local');
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('rejects unknown arguments with exit 64', () => {
    const result = runScript(['--definitely-not-a-flag']);

    expect(result.status).toBe(64);
    expect(result.stderr).toContain('unknown argument');
  });
});

describe('promote-exact-release chat-eval gate', () => {
  it('gates on the latest local_engine run before any lock or SSH work', () => {
    const raw = readFileSync(PROMOTE, 'utf8');
    const gate = raw.indexOf('chat-eval gate');
    const localLock = raw.indexOf('release_acquire_local_lock');
    const remoteLock = raw.indexOf('release_acquire_remote_lock');
    const cleanTree = raw.indexOf('release_require_clean_tree');

    expect(gate).toBeGreaterThan(-1);
    expect(cleanTree).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(cleanTree);
    expect(gate).toBeLessThan(localLock);
    expect(gate).toBeLessThan(remoteLock);
    // Insertion recency, immune to report-clock rollbacks.
    expect(raw).toContain('WHERE mode = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(raw).not.toContain('ORDER BY generated_at DESC, id DESC LIMIT 1');
    expect(raw).toContain('scripts/chat-eval-local.sh');
  });

  it('refuses stale runs recorded on a different SHA than the one being promoted', () => {
    const raw = readFileSync(PROMOTE, 'utf8');

    // The gate selects git_commit and receives RUNTIME_SHA as an argument.
    expect(raw).toContain('SELECT id, run_id, passed, git_commit, generated_at, created_at FROM chat_eval_runs');
    expect(raw).toContain('"$CHAT_EVAL_GATE_DB" "$RUNTIME_SHA"');
    // Prefix comparison: run-chat-eval-live.ts records a --short=12 SHA.
    expect(raw).toContain('runtimeSha.startsWith(recordedCommit)');
    expect(raw).toContain('re-run ./scripts/chat-eval-local.sh');
  });

  it('works from any cwd and explains split-brain CHAT_EVAL_DB_PATH on a missing DB', () => {
    const raw = readFileSync(PROMOTE, 'utf8');

    expect(raw).toContain('NODE_PATH="$ROOT/node_modules" node -e');
    expect(raw).toContain('CHAT_EVAL_DB_PATH');
    expect(raw).toContain('.env.local-configured');
    expect(raw).toContain('split-brain');
  });

  it('requires a loud explicit override env to skip the gate', () => {
    const raw = readFileSync(PROMOTE, 'utf8');

    expect(raw).toContain('NEXUS_PROMOTE_SKIP_CHAT_EVAL');
    expect(raw).toContain('SKIPPING the local_engine chat-eval promote gate');
    expect(raw).toContain('local_engine chat-eval gate refused promotion');
  });
});
