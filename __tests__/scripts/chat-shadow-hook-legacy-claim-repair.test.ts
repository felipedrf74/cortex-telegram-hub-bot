import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const OPERATOR = path.join(ROOT, 'scripts/chat-shadow-hook-legacy-claim-repair-operator.sh');
const REMOTE = path.join(ROOT, 'scripts/remote-chat-shadow-hook-legacy-claim-repair.sh');
const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const TRANSACTION_ID = '20260802T143331Z-8ce452d0143b';
const PLAN_DIGEST = `sha256:${'c'.repeat(64)}`;
const TOOL_SHA256 = 'd'.repeat(64);
const temporaryRoots: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  expect(source).toContain(expected);
  return source.replace(expected, replacement);
}

function createFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'legacy-shadow-repair-')));
  temporaryRoots.push(root);
  const base = path.join(root, 'staging');
  const stateRoot = path.join(root, 'state/chat-capability-flags');
  const claims = path.join(stateRoot, 'claims');
  const release = path.join(base, 'releases', `${RUNTIME_SHA}-${ARTIFACT_DIGEST.slice(0, 12)}`);
  const fakeBin = path.join(root, 'bin');
  const userLock = path.join(root, 'state/.release.lock');
  const sonarLock = path.join(root, 'root-lock/nexus-release-sonar.lock');
  const remote = path.join(root, 'remote-repair.sh');
  mkdirSync(path.join(release, 'scripts'), { recursive: true, mode: 0o700 });
  mkdirSync(claims, { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(sonarLock), { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  chmodSync(claims, 0o700);
  writeFileSync(userLock, '', { mode: 0o600 });
  writeFileSync(sonarLock, '', { mode: 0o660 });
  writeFileSync(path.join(release, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
  })}\n`, { mode: 0o600 });
  writeFileSync(
    path.join(release, 'scripts/release-artifact-manifest.mjs'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
    { mode: 0o755 },
  );
  symlinkSync(release, path.join(base, 'current'));

  const dotenv = 'UNMANAGED_SETTING=preserved\n';
  const preimageSha256 = createHash('sha256').update(dotenv).digest('hex');
  writeFileSync(path.join(base, '.env'), dotenv, { mode: 0o600 });
  writeFileSync(
    path.join(base, `.env.before-chat-capability-${TRANSACTION_ID}`),
    dotenv,
    { mode: 0o600 },
  );
  const configuredFlags = {
    AI_ROUTING_MANIFEST_CLASSIFIER: false,
    AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
    AI_ROUTING_MANIFEST_SHADOW: false,
    AI_ROUTING_MANIFEST_REGISTRY: false,
    AI_ROUTING_CLARIFY: false,
    AI_CLASSIFY_MANIFEST_PROMPT: false,
    AI_CROSS_SKILL_EXECUTION: false,
    AI_ROUTING_MANIFEST_KILL: false,
  };
  writeFileSync(path.join(claims, `staging-${TRANSACTION_ID}.shadow-hook-plan.json`), `${JSON.stringify({
    schema: 'nexus.chat-shadow-route-hook-plan.v1',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    planDigest: PLAN_DIGEST,
    desiredValue: true,
    dedicatedTenantId: 42,
    recorderBefore: { user: false, tenant: false },
  })}\n`, { mode: 0o600 });
  const claimPrivate = path.join(claims, `staging-${TRANSACTION_ID}.shadow-hook-private.json`);
  writeFileSync(claimPrivate, `${JSON.stringify({
    schema: 'nexus.chat-shadow-route-hook-private.v1',
    planDigest: PLAN_DIGEST,
    release,
    dedicatedTenantId: 42,
    environmentPrecondition: { sha256: preimageSha256 },
    pm2: {},
    configuredFlags,
    mutation: { preimageSha256, mutatedSha256: 'e'.repeat(64) },
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateRoot, 'staging.json'), `${JSON.stringify({
    schema: 'nexus.chat-shadow-route-hook-transaction.v1',
    status: 'rollback_failed',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    transactionId: TRANSACTION_ID,
    planDigest: PLAN_DIGEST,
    rollback: { status: 'rollback_failed' },
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(stateRoot, 'staging.runtime-permit.json'), `${JSON.stringify({
    schema: 'nexus.chat-capability-runtime-permit.v1',
    phase: 'rollback',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    transactionId: TRANSACTION_ID,
    planDigest: PLAN_DIGEST,
    environmentSha256: preimageSha256,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  })}\n`, { mode: 0o600 });

  writeFileSync(path.join(fakeBin, 'flock'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(fakeBin, 'stat'), `#!/bin/bash
case "\${2:-}" in
  %U:%a)
    case "\${3:-}" in
      ${shellQuote(userLock)}) printf '%s:600\\n' "$(id -un)" ;;
      *) printf '%s:700\\n' "$(id -un)" ;;
    esac
    ;;
  %U:%G:%a) printf 'root:dominguez:660\\n' ;;
  *) exec /usr/bin/stat "$@" ;;
esac
`, { mode: 0o755 });
  writeFileSync(path.join(fakeBin, 'readlink'), `#!/bin/bash
if [ "\${1:-}" = -f ]; then
  exec ${shellQuote(process.execPath)} -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$2"
fi
exec /usr/bin/readlink "$@"
`, { mode: 0o755 });

  let source = readFileSync(REMOTE, 'utf8');
  source = replaceRequired(source, "readonly BASE_DIR='/home/dominguez/telegram-hub-bot-staging'", `readonly BASE_DIR=${shellQuote(base)}`);
  source = replaceRequired(source, "readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'", `readonly STATE_ROOT=${shellQuote(stateRoot)}`);
  source = replaceRequired(source, "readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'", `readonly USER_RELEASE_LOCK=${shellQuote(userLock)}`);
  source = replaceRequired(source, "readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'", `readonly ROOT_SONAR_LOCK=${shellQuote(sonarLock)}`);
  source = replaceRequired(source, "readonly NODE_BIN='/usr/bin/node'", `readonly NODE_BIN=${shellQuote(process.execPath)}`);
  writeFileSync(remote, source, { mode: 0o755 });

  const run = (command: 'inspect' | 'apply', ack = '') => spawnSync('/bin/bash', [
    remote,
    command,
    RUNTIME_SHA,
    ARTIFACT_DIGEST,
    TRANSACTION_ID,
    TOOL_SHA256,
    ack,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      NEXUS_RELEASE_OWNER_AUTHORIZED: command === 'apply' ? '1' : '0',
    },
  });
  return { claimPrivate, configuredFlags, run, stateRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy shadow-hook claim repair', () => {
  it('ships a separate owner-gated inspect/apply operator for the pre-install deadlock', () => {
    expect(existsSync(OPERATOR)).toBe(true);
    expect(existsSync(REMOTE)).toBe(true);

    const operator = readFileSync(OPERATOR, 'utf8');
    const remote = readFileSync(REMOTE, 'utf8');
    expect(operator).toContain('inspect');
    expect(operator).toContain('apply');
    expect(operator).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED=1');
    expect(operator).toContain('clean protected-main checkout');
    expect(operator).toContain('TOOL_SNAPSHOT');
    expect(operator).toContain('hash-object');
    expect(operator).toContain('< "$TOOL_SNAPSHOT"');
    expect(operator).not.toContain('< "$REMOTE_TOOL"');
    expect(remote).toContain('nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1');
    expect(remote).toContain('nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1');
    expect(remote).toContain('.env.before-chat-capability-');
    expect(remote).toContain('effectiveFlags');
    expect(remote).toContain('flock -n 9');
    expect(remote).toContain('flock -n 8');
  });

  it('repairs only the missing deterministic effective state after exact inspect and acknowledgement', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    expect(plan).toMatchObject({
      schema: 'nexus.chat-shadow-route-hook-legacy-claim-repair-plan.v1',
      action: 'add_effective_flags_master_kill_projection',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      transactionId: TRANSACTION_ID,
    });

    const applied = fixture.run('apply', plan.repairPlanDigest);
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      schema: 'nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1',
      status: 'claim_repaired',
      repairPlanDigest: plan.repairPlanDigest,
    });
    const repaired = JSON.parse(readFileSync(fixture.claimPrivate, 'utf8'));
    expect(repaired.schema).toBe('nexus.chat-shadow-route-hook-private.v1');
    expect(repaired.effectiveFlags).toEqual(fixture.configuredFlags);

    const replay = fixture.run('apply', plan.repairPlanDigest);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).repairPlanDigest).toBe(plan.repairPlanDigest);
  });

  it('fails closed when the private claim drifts after inspection', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    const privateState = JSON.parse(readFileSync(fixture.claimPrivate, 'utf8'));
    writeFileSync(fixture.claimPrivate, `${JSON.stringify({ ...privateState, unexpected: true })}\n`, {
      mode: 0o600,
    });

    const applied = fixture.run('apply', plan.repairPlanDigest);
    expect(applied.status).not.toBe(0);
    expect(JSON.parse(readFileSync(fixture.claimPrivate, 'utf8'))).not.toHaveProperty(
      'effectiveFlags',
    );
  });

  it('resumes after the exact repair plan is committed but before the claim changes', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    writeFileSync(
      path.join(
        fixture.stateRoot,
        `claims/staging-${TRANSACTION_ID}.legacy-shadow-repair-plan.json`,
      ),
      inspected.stdout,
      { mode: 0o600 },
    );

    const resumed = fixture.run('apply', plan.repairPlanDigest);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(readFileSync(fixture.claimPrivate, 'utf8')).effectiveFlags)
      .toEqual(fixture.configuredFlags);
  });

  it('finishes both receipt publications and pending-plan cleanup on replay', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    const applied = fixture.run('apply', plan.repairPlanDigest);
    expect(applied.status, applied.stderr).toBe(0);

    const pending = path.join(
      fixture.stateRoot,
      'staging.legacy-shadow-repair.pending.json',
    );
    const externalReceipt = path.join(
      fixture.stateRoot,
      'staging.legacy-shadow-repair.json',
    );
    writeFileSync(pending, inspected.stdout, { mode: 0o600 });
    rmSync(externalReceipt);

    const replay = fixture.run('apply', plan.repairPlanDigest);
    expect(replay.status, replay.stderr).toBe(0);
    expect(existsSync(pending)).toBe(false);
    expect(JSON.parse(readFileSync(externalReceipt, 'utf8'))).toMatchObject({
      schema: 'nexus.chat-shadow-route-hook-legacy-claim-repair-receipt.v1',
      status: 'claim_repaired',
      repairPlanDigest: plan.repairPlanDigest,
    });
  });

  it('rejects an orphan external repair receipt before changing the claim', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    writeFileSync(
      path.join(fixture.stateRoot, 'staging.legacy-shadow-repair.json'),
      `${JSON.stringify({
        status: 'claim_repaired',
        repairPlanDigest: plan.repairPlanDigest,
      })}\n`,
      { mode: 0o600 },
    );

    const applied = fixture.run('apply', plan.repairPlanDigest);
    expect(applied.status).not.toBe(0);
    expect(JSON.parse(readFileSync(fixture.claimPrivate, 'utf8')))
      .not.toHaveProperty('effectiveFlags');
  });
});
