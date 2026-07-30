import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const CHAT_EVAL_LOCAL = join(ROOT, 'scripts', 'chat-eval-local.sh');
const PROMOTE = join(ROOT, 'scripts', 'promote-exact-release.sh');
const MANIFEST_TOOL = join(ROOT, 'scripts', 'release-checksum-manifest.mjs');
const CHAT_EVAL_COMPOSE = join(ROOT, 'docker-compose.chat-eval-local.yml');
const LOCAL_UP = join(ROOT, 'scripts', 'local-up.sh');

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
    expect(result.stdout).toContain('NEXUS_LOCAL_ALLOW_MODEL_CALLS=1');
    expect(result.stdout).toContain('NEXUS_MODEL_FIXTURE_MODE=0');
    expect(result.stdout).toContain('Ollama-only zero-cloud profile');
    expect(result.stdout).toContain('attest Ollama-only zero-cloud runtime profile');
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

  it('refuses a dirty or untracked checkout before booting Docker or writing evidence', () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), 'chat-eval-local-dirty-'));
    const bootMarker = join(isolatedRoot, 'local-up-invoked');
    try {
      mkdirSync(join(isolatedRoot, 'scripts'), { recursive: true });
      copyFileSync(CHAT_EVAL_LOCAL, join(isolatedRoot, 'scripts', 'chat-eval-local.sh'));
      chmodSync(join(isolatedRoot, 'scripts', 'chat-eval-local.sh'), 0o755);
      writeFileSync(join(isolatedRoot, 'scripts', 'local-up.sh'), `#!/usr/bin/env bash\nprintf invoked > '${bootMarker}'\n`, { mode: 0o755 });
      writeFileSync(join(isolatedRoot, '.gitignore'), '.env.local\n.local/\n');
      writeFileSync(join(isolatedRoot, '.env.local'), 'DATABASE_PATH=/app/data/local.db\n');
      const gitEnv = { ...process.env };
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_COMMON_DIR']) delete gitEnv[key];
      spawnSync('git', ['init', '--initial-branch=main'], { cwd: isolatedRoot, env: gitEnv });
      spawnSync('git', ['config', 'user.name', 'Eval Fixture'], { cwd: isolatedRoot, env: gitEnv });
      spawnSync('git', ['config', 'user.email', 'eval@example.invalid'], { cwd: isolatedRoot, env: gitEnv });
      spawnSync('git', ['add', '.'], { cwd: isolatedRoot, env: gitEnv });
      const commit = spawnSync('git', ['commit', '-m', 'fixture'], { cwd: isolatedRoot, encoding: 'utf8', env: gitEnv });
      expect(commit.status, commit.stderr).toBe(0);
      writeFileSync(join(isolatedRoot, 'untracked.txt'), 'dirty\n');

      const result = spawnSync('bash', [join(isolatedRoot, 'scripts', 'chat-eval-local.sh')], {
        cwd: isolatedRoot,
        encoding: 'utf8',
        env: { ...gitEnv, NEXUS_CHAT_EVAL_LOCAL_DISABLED: '0' },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('clean checkout');
      expect(result.stderr).toContain('untracked');
      expect(() => readFileSync(bootMarker, 'utf8')).toThrow();
    } finally {
      rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it('forces Ollama-only routing into both local containers and attests before eval', () => {
    const script = readFileSync(CHAT_EVAL_LOCAL, 'utf8');
    const compose = readFileSync(CHAT_EVAL_COMPOSE, 'utf8');
    const localUp = readFileSync(LOCAL_UP, 'utf8');
    const boot = script.indexOf('./scripts/local-up.sh');
    const attestation = script.indexOf('attest_zero_cloud_profile', boot);
    const evalRun = script.indexOf('scripts/run-chat-eval-live.ts', attestation);

    expect(script).toContain('export NEXUS_LOCAL_ALLOW_MODEL_CALLS=1');
    expect(script).toContain('export NEXUS_MODEL_FIXTURE_MODE=0');
    expect(script).toContain('export NEXUS_CHAT_EVAL_ZERO_CLOUD_PROFILE=1');
    expect(compose.match(/^\s+NEXUS_LOCAL_ALLOW_MODEL_CALLS:/gm)).toHaveLength(2);
    expect(compose).toContain('NEXUS_MODEL_FIXTURE_MODE: "0"');
    expect(compose).toContain('NEXUS_CHAT_EVAL_ALLOW_DOCKER_GATEWAY: "1"');
    expect(compose).toContain('LOCAL_LLM_EVALUATION_MODE: "true"');
    expect(compose).toContain('CONTENT_ENGINE_FIXTURE_MODE: "0"');
    expect(compose).toContain('OLLAMA_ENABLED: "true"');
    expect(compose).toContain('OLLAMA_BASE_URL:');
    expect(compose.match(/^\s+AI_(?:CLASSIFY|CHAT|TOOL_USE)_PRIMARY: "ollama"/gm)).toHaveLength(3);
    expect(compose.match(/^\s+AI_(?:CLASSIFY|CHAT|TOOL_USE)_FALLBACK: "none"/gm)).toHaveLength(3);
    expect(compose.match(/^\s+(?:ANTHROPIC|GEMINI|GOOGLE|OPENAI)_API_KEY: ""/gm)).toHaveLength(8);
    expect(script).toContain('curl -fsS "${OLLAMA_BASE_URL%/}/api/tags"');
    expect(script).toContain('[ "${NEXUS_CHAT_EVAL_ALLOW_DOCKER_GATEWAY:-}" = "1" ]');
    expect(script).toContain('[ "${LOCAL_LLM_EVALUATION_MODE:-}" = "true" ]');
    expect(localUp).toContain('NEXUS_CHAT_EVAL_ZERO_CLOUD_PROFILE');
    expect(localUp).toContain('COMPOSE_ARGS+=(-f docker-compose.chat-eval-local.yml)');
    expect(boot).toBeGreaterThan(-1);
    expect(attestation).toBeGreaterThan(boot);
    expect(evalRun).toBeGreaterThan(attestation);
  });

  it('seeds the bind-mounted SQLite database only while nexus-hub is stopped', () => {
    const script = readFileSync(CHAT_EVAL_LOCAL, 'utf8');
    const boot = script.indexOf('echo "chat-eval-local: [1/5]');
    const attestation = script.indexOf('\nattest_zero_cloud_profile', boot);
    const stopForSeed = script.indexOf('\nstop_nexus_hub_for_evidence_seed', attestation);
    const seed = script.indexOf('scripts/chatv2-seed-local-evidence.ts', stopForSeed);
    const restartAfterSeed = script.indexOf('\nrestart_nexus_hub_after_evidence_seed', seed);
    const postRestartAttestation = script.indexOf('\nattest_zero_cloud_profile', restartAfterSeed);
    const authMint = script.indexOf('scripts/local-ios-debug-auth.mjs', postRestartAttestation);

    expect(script).toContain('docker compose "${COMPOSE_ARGS[@]}" stop nexus-hub');
    expect(script).toContain('docker compose "${COMPOSE_ARGS[@]}" start nexus-hub');
    expect(script).toContain('restore_nexus_hub_on_exit');
    expect(attestation).toBeGreaterThan(boot);
    expect(stopForSeed).toBeGreaterThan(attestation);
    expect(seed).toBeGreaterThan(stopForSeed);
    expect(restartAfterSeed).toBeGreaterThan(seed);
    expect(postRestartAttestation).toBeGreaterThan(restartAfterSeed);
    expect(authMint).toBeGreaterThan(postRestartAttestation);
  });
});

describe('promote-exact-release chat-eval gate', () => {
  it('gates on the latest local_engine run before the durable server transaction', () => {
    const raw = readFileSync(PROMOTE, 'utf8');
    const gateRaw = readFileSync(MANIFEST_TOOL, 'utf8');
    const gate = raw.indexOf('chat-eval gate');
    const submit = raw.indexOf('ssh "$SERVER" systemd-run --user');

    expect(raw).toContain('preflight-chat');
    expect(submit).toBeGreaterThan(-1);
    expect(raw.indexOf('preflight-chat')).toBeLessThan(submit);
    // Insertion recency, immune to report-clock rollbacks.
    expect(gateRaw).toContain('WHERE mode = ? AND git_commit = ?');
    expect(gateRaw).toContain('ORDER BY created_at DESC, id DESC LIMIT 1');
    expect(gateRaw).not.toContain('ORDER BY generated_at DESC, id DESC LIMIT 1');
    expect(gateRaw).toContain('scripts/chat-eval-local.sh');
    expect(gateRaw).toContain("manifest.releaseImpact.groups.includes('chat-secretary')");
    expect(gate).toBe(-1);
  });

  it('refuses stale runs recorded on a different SHA than the one being promoted', () => {
    const raw = readFileSync(PROMOTE, 'utf8');
    const gateRaw = readFileSync(MANIFEST_TOOL, 'utf8');

    // The gate selects git_commit and receives RUNTIME_SHA as an argument.
    expect(gateRaw).toContain(
      "'SELECT id, run_id, passed, git_commit, generated_at, created_at '",
    );
    expect(gateRaw).toContain(").get('local_engine', manifest.sourceSha)");
    expect(gateRaw).toContain('recordedCommit !== manifest.sourceSha');
    expect(gateRaw).toContain('scripts/chat-eval-local.sh');
  });

  it('works from any cwd and explains split-brain CHAT_EVAL_DB_PATH on a missing DB', () => {
    const raw = readFileSync(MANIFEST_TOOL, 'utf8');

    expect(raw).toContain("require('node:sqlite')");
    expect(raw).toContain('CHAT_EVAL_DB_PATH');
    expect(raw).toContain('.env.local-configured');
    expect(raw).toContain('split-brain');
  });

  it('has no bypass and skips automatically only when cumulative impact excludes chat', () => {
    const raw = readFileSync(PROMOTE, 'utf8');
    const gateRaw = readFileSync(MANIFEST_TOOL, 'utf8');

    expect(raw).not.toContain('NEXUS_PROMOTE_SKIP_CHAT_EVAL');
    expect(gateRaw).not.toContain('NEXUS_PROMOTE_SKIP_CHAT_EVAL');
    expect(gateRaw).toContain(
      'cumulative release impact does not include chat-secretary',
    );
    expect(raw.indexOf('release-checksum-manifest.mjs" preflight-chat')).toBeLessThan(
      raw.indexOf('ssh "$SERVER" systemd-run --user'),
    );
  });
});
