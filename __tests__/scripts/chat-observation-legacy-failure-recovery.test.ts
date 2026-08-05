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
const OPERATOR = path.join(
  ROOT,
  'scripts/chat-observation-legacy-failure-recovery-operator.sh',
);
const REMOTE = path.join(
  ROOT,
  'scripts/remote-chat-observation-legacy-failure-recovery.sh',
);
const RELEASE_TRANSACTION = path.join(ROOT, 'scripts/remote-user-release-transaction.sh');
const RECORDER_OFF_OPERATOR = path.join(
  ROOT,
  'scripts/chat-shadow-hook-installed-predecessor-off-operator.sh',
);
const RUNTIME_SHA = '39965e357d19a1a44ecb167d213c6ffcf361a21b';
const ARTIFACT_DIGEST = 'e368f1e15c3b2a84cfb798ad12621932a61fd766db6161259a7bd364cbac1535';
const TRANSACTION_ID = '20260805T163302Z-2522779e6416';
const FLAG = 'AI_ROUTING_MANIFEST_CLASSIFIER';
const OBSERVATION_PLAN_DIGEST =
  'sha256:3a3076c133922d08b941d1853f12c82c7408e7265001dd433b51548c2a4c6130';
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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'observation-recovery-')));
  temporaryRoots.push(root);
  const base = path.join(root, 'staging');
  const stateRoot = path.join(root, 'state/chat-capability-flags');
  const observations = path.join(stateRoot, 'observations');
  const smokeRoot = path.join(base, '.local/release/smoke-evidence');
  const release = path.join(base, 'releases', `${RUNTIME_SHA}-${ARTIFACT_DIGEST.slice(0, 12)}`);
  const userLock = path.join(root, 'state/.release.lock');
  const sonarLock = path.join(root, 'root-lock/nexus-release-sonar.lock');
  const fakeBin = path.join(root, 'bin');
  const remote = path.join(root, 'remote-recovery.sh');
  mkdirSync(path.join(release, 'scripts'), { recursive: true, mode: 0o700 });
  mkdirSync(observations, { recursive: true, mode: 0o700 });
  mkdirSync(smokeRoot, { recursive: true, mode: 0o700 });
  mkdirSync(path.dirname(sonarLock), { recursive: true, mode: 0o700 });
  mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
  chmodSync(stateRoot, 0o700);
  chmodSync(observations, 0o700);
  chmodSync(smokeRoot, 0o700);
  writeFileSync(userLock, '', { mode: 0o600 });
  writeFileSync(sonarLock, '', { mode: 0o660 });
  writeFileSync(path.join(release, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1', runtimeSha: RUNTIME_SHA, artifactDigest: ARTIFACT_DIGEST,
  })}\n`, { mode: 0o600 });
  writeFileSync(path.join(base, '.env'), 'UNMANAGED_SETTING=preserved\n', { mode: 0o600 });
  writeFileSync(
    path.join(release, 'scripts/release-artifact-manifest.mjs'),
    '#!/usr/bin/env node\nprocess.exit(0);\n',
    { mode: 0o755 },
  );
  symlinkSync(release, path.join(base, 'current'));

  const plan = {
    schema: 'nexus.chat-capability-observation-plan.v1',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: FLAG,
    observationSequence: 1,
    previousObservationSequence: 0,
    planDigest: OBSERVATION_PLAN_DIGEST,
    generatedAt: '2026-08-05T16:32:49.621Z',
    expiresAt: '2026-08-05T17:32:49.621Z',
  };
  const observationPlan = path.join(
    observations,
    `staging-${TRANSACTION_ID}.observation-plan.json`,
  );
  writeFileSync(observationPlan, `${JSON.stringify(plan)}\n`, { mode: 0o600 });
  const smoke = path.join(
    smokeRoot,
    `chat-capability-${TRANSACTION_ID}-staging-smoke.json`,
  );
  writeFileSync(smoke, '{"status":"passed"}\n', { mode: 0o600 });
  writeFileSync(path.join(stateRoot, 'staging.observation.sequence'), '1\n', { mode: 0o600 });
  const offReceipt = path.join(stateRoot, 'staging.json');
  writeFileSync(offReceipt, `${JSON.stringify({
    schema: 'nexus.chat-capability-flag-transaction.v1',
    status: 'passed',
    role: 'staging',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
    flag: FLAG,
    desiredValue: false,
    transactionId: '20260805T164117Z-915145e25b19',
    completedAt: '2026-08-05T18:41:28.061Z',
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

  let source = readFileSync(REMOTE, 'utf8');
  source = replaceRequired(
    source,
    "readonly BASE_DIR='/home/dominguez/telegram-hub-bot-staging'",
    `readonly BASE_DIR=${shellQuote(base)}`,
  );
  source = replaceRequired(
    source,
    "readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'",
    `readonly STATE_ROOT=${shellQuote(stateRoot)}`,
  );
  source = replaceRequired(
    source,
    "readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'",
    `readonly USER_RELEASE_LOCK=${shellQuote(userLock)}`,
  );
  source = replaceRequired(
    source,
    "readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'",
    `readonly ROOT_SONAR_LOCK=${shellQuote(sonarLock)}`,
  );
  source = replaceRequired(
    source,
    "readonly NODE_BIN='/usr/bin/node'",
    `readonly NODE_BIN=${shellQuote(process.execPath)}`,
  );
  writeFileSync(remote, source, { mode: 0o755 });

  const run = (command: 'inspect' | 'apply', ack = '') => spawnSync('/bin/bash', [
    remote, command, RUNTIME_SHA, ARTIFACT_DIGEST, TRANSACTION_ID, TOOL_SHA256, ack,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
      NEXUS_RELEASE_OWNER_AUTHORIZED: command === 'apply' ? '1' : '0',
    },
  });
  return { offReceipt, observations, run, smokeRoot, stateRoot };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('legacy failed staging observation recovery', () => {
  it('ships a protected-main owner-gated inspect/apply operator and release guard support', () => {
    expect(existsSync(OPERATOR)).toBe(true);
    expect(existsSync(REMOTE)).toBe(true);
    const operator = readFileSync(OPERATOR, 'utf8');
    const remote = readFileSync(REMOTE, 'utf8');
    const release = readFileSync(RELEASE_TRANSACTION, 'utf8');
    expect(operator).toContain('clean protected-main checkout');
    expect(operator).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED=1');
    expect(operator).toContain('TOOL_SNAPSHOT');
    expect(remote).toContain('flock -n 9');
    expect(remote).toContain('flock -n 8');
    expect(remote).toContain('nexus.chat-capability-observation-failure-recovery-plan.v1');
    expect(remote).toContain('nexus.chat-capability-observation-failure-recovery-receipt.v1');
    expect(release).toContain('*.observation-recovery-receipt.json');
    expect(release).toContain('failure_acknowledged');
    expect(release).toContain('staging-observation-recovery.json');
  });

  it('ships a narrow protected-main wrapper for the installed predecessor recorder rollback', () => {
    expect(existsSync(RECORDER_OFF_OPERATOR)).toBe(true);
    const operator = readFileSync(RECORDER_OFF_OPERATOR, 'utf8');
    expect(operator).toContain('clean protected-main checkout');
    expect(operator).toContain(RUNTIME_SHA);
    expect(operator).toContain(ARTIFACT_DIGEST);
    expect(operator).toContain('inspect-shadow-hook');
    expect(operator).toContain('apply-shadow-hook');
    expect(operator).toContain('operator_rollback');
    expect(operator).toContain('NEXUS_RELEASE_OWNER_AUTHORIZED=1');
    expect(operator).toContain('--verify-installed-source');
    expect(operator).not.toContain('dedicated_eval_evidence_collection');
  });

  it('publishes only an immutable failure acknowledgement after exact inspect and apply', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    expect(plan).toMatchObject({
      schema: 'nexus.chat-capability-observation-failure-recovery-plan.v1',
      action: 'acknowledge_failed_observation_without_receipt',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      transactionId: TRANSACTION_ID,
      observationPlanDigest: OBSERVATION_PLAN_DIGEST,
    });

    const applied = fixture.run('apply', plan.recoveryPlanDigest);
    expect(applied.status, applied.stderr).toBe(0);
    const receipt = JSON.parse(applied.stdout);
    expect(receipt).toMatchObject({
      schema: 'nexus.chat-capability-observation-failure-recovery-receipt.v1',
      status: 'failure_acknowledged',
      recoveryPlanDigest: plan.recoveryPlanDigest,
    });
    const stateReceipt = path.join(
      fixture.observations,
      `staging-${TRANSACTION_ID}.observation-recovery-receipt.json`,
    );
    const sidecar = path.join(
      fixture.smokeRoot,
      `chat-capability-${TRANSACTION_ID}-staging-observation-recovery.json`,
    );
    expect(readFileSync(stateReceipt, 'utf8')).toBe(readFileSync(sidecar, 'utf8'));

    const replay = fixture.run('apply', plan.recoveryPlanDigest);
    expect(replay.status, replay.stderr).toBe(0);
    expect(JSON.parse(replay.stdout).recoveryPlanDigest).toBe(plan.recoveryPlanDigest);
  });

  it('fails closed if the OFF receipt changes after inspection', () => {
    const fixture = createFixture();
    const inspected = fixture.run('inspect');
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);
    const changed = JSON.parse(readFileSync(fixture.offReceipt, 'utf8'));
    writeFileSync(fixture.offReceipt, `${JSON.stringify({ ...changed, unexpected: true })}\n`, {
      mode: 0o600,
    });

    const applied = fixture.run('apply', plan.recoveryPlanDigest);
    expect(applied.status).not.toBe(0);
    expect(existsSync(path.join(
      fixture.observations,
      `staging-${TRANSACTION_ID}.observation-recovery-receipt.json`,
    ))).toBe(false);
  });
});
