import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildShadowRouteHookPlan,
  buildShadowRouteHookReceipt,
  rewriteShadowRouteHookDotenv,
} from '../../scripts/lib/chat-capability-flag-transaction.mjs';

const ROOT = path.resolve(__dirname, '../..');
const REMOTE_SOURCE = path.join(
  ROOT,
  'scripts/remote-chat-capability-flag-transaction.sh',
);
const HELPER_SOURCE = path.join(
  ROOT,
  'scripts/lib/chat-capability-flag-transaction.mjs',
);

const RUNTIME_SHA = 'a'.repeat(40);
const ARTIFACT_DIGEST = 'b'.repeat(64);
const TRANSACTION_ID = '20260802T010203Z-abcdef123456';
const NEXT_TRANSACTION_ID = '20260802T010204Z-fedcba654321';
const SHADOW_HOOK_TRANSACTION_ID = '20260730T235900Z-abcdef123456';
const temporaryRoots: string[] = [];

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function replaceRequired(source: string, expected: string, replacement: string): string {
  expect(source).toContain(expected);
  return source.replace(expected, replacement);
}

function writeExecutable(file: string, body: string): void {
  writeFileSync(file, body, { mode: 0o755 });
}

type ShellFixture = ReturnType<typeof createShellFixture>;

function createShellFixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'nexus-chat-flag-shell-')));
  temporaryRoots.push(root);
  const base = path.join(root, 'telegram-hub-bot-staging');
  const productionBase = path.join(root, 'telegram-hub-bot');
  const release = path.join(
    base,
    'releases',
    `${RUNTIME_SHA}-${ARTIFACT_DIGEST.slice(0, 12)}`,
  );
  const scripts = path.join(release, 'scripts');
  const helper = path.join(scripts, 'lib/chat-capability-flag-transaction.mjs');
  const remote = path.join(scripts, 'remote-chat-capability-flag-transaction.sh');
  const stateRoot = path.join(root, 'state/chat-capability-flags');
  const userReleaseLock = path.join(root, 'state/.release.lock');
  const rootSonarLock = path.join(root, 'root-lock/nexus-release-sonar.lock');
  const fakeBin = path.join(root, 'bin');
  const fakeNode = path.join(fakeBin, 'node');
  const fakePm2 = path.join(fakeBin, 'pm2');
  const fakeTimeout = path.join(fakeBin, 'timeout');
  const pm2Log = path.join(root, 'pm2.log');
  const backendPid = path.join(root, 'backend.pid');
  const backendUptime = path.join(root, 'backend.uptime');
  const environmentFile = path.join(base, '.env');
  const routingReportFile = path.join(root, 'routing-report.json');
  const routingHealthFile = path.join(root, 'routing-health.json');
  const actualNode = process.execPath;

  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  mkdirSync(path.join(release, 'dist/services/intent-resolution'), { recursive: true });
  mkdirSync(path.join(base, 'data'), { recursive: true });
  mkdirSync(path.join(base, 'releases'), { recursive: true });
  mkdirSync(path.dirname(userReleaseLock), { recursive: true });
  mkdirSync(path.dirname(rootSonarLock), { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(helper, readFileSync(HELPER_SOURCE, 'utf8').replace(
    "'/home/dominguez/telegram-hub-bot-staging/releases/'",
    `${JSON.stringify(`${path.join(base, 'releases')}/`)}`,
  ));
  writeFileSync(path.join(scripts, 'release-artifact-manifest.mjs'), '// fixture\n');
  writeFileSync(path.join(scripts, 'routing-divergence-report.mjs'), '// fixture\n');
  writeFileSync(
    path.join(release, 'dist/services/intent-resolution/divergence-shadow.js'),
    "exports.ROUTING_DIVERGENCE_SHADOW_VERSION = 'routing_divergence_shadow@4.0.0';\n",
  );
  writeFileSync(
    path.join(release, 'dist/services/intent-resolution/intent-resolver.js'),
    "exports.INTENT_RESOLVER_VERSION = 'manifest-intent-resolver@1.0.0';\n",
  );
  writeFileSync(path.join(base, 'data/bot.db'), 'fixture\n');
  writeFileSync(path.join(release, 'ecosystem.release.config.js'), '// fixture\n');
  writeFileSync(path.join(release, '.complete.json'), `${JSON.stringify({
    schema: 'nexus.release-bundle.v1',
    runtimeSha: RUNTIME_SHA,
    artifactDigest: ARTIFACT_DIGEST,
  })}\n`);
  symlinkSync(release, path.join(base, 'current'));
  writeFileSync(environmentFile, 'UNMANAGED_SETTING=preserved\n', { mode: 0o600 });
  chmodSync(environmentFile, 0o600);
  writeFileSync(userReleaseLock, '', { mode: 0o600 });
  writeFileSync(rootSonarLock, '', { mode: 0o660 });
  writeFileSync(backendPid, '4101\n');
  writeFileSync(backendUptime, '1000\n');

  writeExecutable(fakeNode, `#!/bin/bash
case "\${1:-}" in
  */scripts/release-artifact-manifest.mjs) exit 0 ;;
  scripts/routing-divergence-report.mjs)
    [ -f ${shellSingleQuote(routingReportFile)} ] || exit 97
    /bin/cat ${shellSingleQuote(routingReportFile)}
    exit 0
    ;;
  --env-file=*)
    if [ "\${2:-}" = - ] && [ "\${4:-}" = /health/detailed ] \
        && [ -f ${shellSingleQuote(routingHealthFile)} ]; then
      /bin/cat ${shellSingleQuote(routingHealthFile)} > "\${8:-}"
    fi
    exit 0
    ;;
esac
exec ${shellSingleQuote(actualNode)} "$@"
`);

  writeExecutable(fakeTimeout, `#!/bin/bash
if [ "\${1:-}" = --foreground ]; then shift; fi
case "\${1:-}" in *s) shift ;; esac
exec "$@"
`);

  const backendRow = {
    name: 'nexus-hub-staging',
    pid: 0,
    pm2_env: {
      status: 'online',
      pm_uptime: 0,
      pm_cwd: release,
      pm_exec_path: `${release}/dist/index.js`,
      NEXUS_RELEASE_ROLE: 'staging',
      NEXUS_RELEASE_SHA: RUNTIME_SHA,
      NEXUS_RELEASE_ARTIFACT_SHA256: ARTIFACT_DIGEST,
    },
  };
  const contentRow = {
    name: 'content-engine-staging',
    pid: 4201,
    pm2_env: {
      status: 'online',
      pm_uptime: 900,
      pm_cwd: `${release}/content-engine`,
      pm_exec_path: '/usr/bin/python3.12',
      NEXUS_RELEASE_ROLE: 'staging',
      NEXUS_RELEASE_SHA: RUNTIME_SHA,
      NEXUS_RELEASE_ARTIFACT_SHA256: ARTIFACT_DIGEST,
    },
  };
  const pm2Rows = JSON.stringify([backendRow, contentRow]);
  writeExecutable(fakePm2, `#!/bin/bash
case "\${1:-}" in
  jlist)
    ${shellSingleQuote(actualNode)} -e 'const fs=require("node:fs");const rows=JSON.parse(process.argv[1]);rows[0].pid=Number(fs.readFileSync(process.argv[2],"utf8"));rows[0].pm2_env.pm_uptime=Number(fs.readFileSync(process.argv[3],"utf8"));process.stdout.write(JSON.stringify(rows)+"\\n")' ${shellSingleQuote(pm2Rows)} ${shellSingleQuote(backendPid)} ${shellSingleQuote(backendUptime)}
    ;;
  delete)
    [ "\${2:-}" = nexus-hub-staging ] || exit 91
    printf '%s\\n' "$*" >> ${shellSingleQuote(pm2Log)}
    ;;
  start)
    [ "\${3:-}" = --only ] || exit 92
    [ "\${4:-}" = nexus-hub-staging ] || exit 93
    printf '%s\\n' "$*" >> ${shellSingleQuote(pm2Log)}
    printf '4102\\n' > ${shellSingleQuote(backendPid)}
    printf '2000\\n' > ${shellSingleQuote(backendUptime)}
    ;;
  save)
    [ "\${2:-}" = --force ] || exit 94
    printf '%s\\n' "$*" >> ${shellSingleQuote(pm2Log)}
    ;;
  *) exit 95 ;;
esac
`);

  writeExecutable(path.join(fakeBin, 'install'), `#!/bin/bash
if [ "\${1:-}" != -d ]; then exec /usr/bin/install "$@"; fi
shift
mode=700
if [ "\${1:-}" = -m ]; then mode="$2"; shift 2; fi
mkdir -p "$@"
chmod "$mode" "$@"
`);
  writeExecutable(path.join(fakeBin, 'stat'), `#!/bin/bash
if [ "\${1:-}" = -c ]; then
  case "\${2:-}" in
    %U:%a) printf '%s:600\\n' "$(id -un)" ;;
    %U:%G:%a) printf 'root:dominguez:660\\n' ;;
    *) exit 96 ;;
  esac
  exit 0
fi
exec /usr/bin/stat "$@"
`);
  writeExecutable(path.join(fakeBin, 'flock'), '#!/bin/bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'sleep'), '#!/bin/bash\nexit 0\n');
  writeExecutable(path.join(fakeBin, 'date'), `#!/bin/bash
if [ "$*" = '-u +%Y-%m-%dT%H:%M:%S.%3NZ' ]; then
  printf '2026-08-02T01:02:03.000Z\\n'
else
  exec /bin/date "$@"
fi
`);
  writeExecutable(path.join(fakeBin, 'readlink'), `#!/bin/bash
if [ "\${1:-}" = -f ]; then
  exec ${shellSingleQuote(actualNode)} -e 'process.stdout.write(require("node:fs").realpathSync(process.argv[1]))' "$2"
fi
exec /usr/bin/readlink "$@"
`);

  let remoteBody = readFileSync(REMOTE_SOURCE, 'utf8');
  remoteBody = replaceRequired(
    remoteBody,
    "readonly USER_RELEASE_LOCK='/home/dominguez/.local/state/nexus-release/.release.lock'",
    `readonly USER_RELEASE_LOCK=${shellSingleQuote(userReleaseLock)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly ROOT_SONAR_LOCK='/run/lock/nexus-release-sonar.lock'",
    `readonly ROOT_SONAR_LOCK=${shellSingleQuote(rootSonarLock)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly STATE_ROOT='/home/dominguez/.local/state/nexus-release/chat-capability-flags'",
    `readonly STATE_ROOT=${shellSingleQuote(stateRoot)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly STAGING_BASE_DIR='/home/dominguez/telegram-hub-bot-staging'",
    `readonly STAGING_BASE_DIR=${shellSingleQuote(base)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly PRODUCTION_BASE_DIR='/home/dominguez/telegram-hub-bot'",
    `readonly PRODUCTION_BASE_DIR=${shellSingleQuote(productionBase)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly PM2_BIN='/usr/local/bin/pm2'",
    `readonly PM2_BIN=${shellSingleQuote(fakePm2)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly NODE_BIN='/usr/bin/node'",
    `readonly NODE_BIN=${shellSingleQuote(fakeNode)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "readonly TIMEOUT_BIN='/usr/bin/timeout'",
    `readonly TIMEOUT_BIN=${shellSingleQuote(fakeTimeout)}`,
  );
  remoteBody = replaceRequired(
    remoteBody,
    "const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();",
    "const bootId = '11111111-1111-4111-8111-111111111111';",
  );
  remoteBody = replaceRequired(
    remoteBody,
    "const stat = fs.readFileSync(`/proc/${controllerPid}/stat`, 'utf8').trim();",
    "const stat = `${controllerPid} (fixture-controller) S`;",
  );
  remoteBody = replaceRequired(
    remoteBody,
    'const startTicks = fieldsFromState[19];',
    "const startTicks = '9001';",
  );
  remoteBody = replaceRequired(
    remoteBody,
    "[ \"$BASE_DIR\" = '/home/dominguez/telegram-hub-bot-staging' ]",
    `[ "$BASE_DIR" = ${shellSingleQuote(base)} ]`,
  );
  writeFileSync(remote, remoteBody, { mode: 0o755 });

  const environment = {
    ...process.env,
    HOME: path.join(root, 'home'),
    PATH: `${fakeBin}:/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
  };

  function run(command: string, args: string[], options: {
    input?: string;
    ownerAuthorized?: boolean;
  } = {}) {
    return spawnSync('/bin/bash', [
      remote,
      command,
      'staging',
      base,
      RUNTIME_SHA,
      ARTIFACT_DIGEST,
      ...args,
    ], {
      cwd: release,
      encoding: 'utf8',
      input: options.input ?? '',
      env: {
        ...environment,
        NEXUS_RELEASE_OWNER_AUTHORIZED: options.ownerAuthorized ? '1' : '0',
      },
    });
  }

  function seedShadowHookEnable(): void {
    const preEnableDotenv = [
      'CHAT_EVAL_DEDICATED_TENANT_ID=42',
      `CLASSIFY_SHADOW_HASH_SECRET=${'c'.repeat(64)}`,
      `CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=${'d'.repeat(64)}`,
      'AI_ROUTING_MANIFEST_CLASSIFIER=false',
      'AI_ROUTING_MANIFEST_ORCHESTRATOR=false',
      'AI_ROUTING_MANIFEST_SHADOW=false',
      'AI_ROUTING_MANIFEST_REGISTRY=false',
      'AI_ROUTING_CLARIFY=false',
      'AI_CLASSIFY_MANIFEST_PROMPT=false',
      'AI_CROSS_SKILL_EXECUTION=false',
      'AI_ROUTING_MANIFEST_KILL=false',
      'UNMANAGED_SETTING=preserved',
      '',
    ].join('\n');
    const plan = buildShadowRouteHookPlan({
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      dotenvSource: preEnableDotenv,
      dedicatedIdentityAttested: true,
      desiredValue: true,
      transitionReason: 'dedicated_eval_evidence_collection',
      previousPlanSequence: 7,
      generatedAt: '2026-07-30T23:58:00.000Z',
    });
    const receipt = buildShadowRouteHookReceipt({
      plan,
      transactionId: SHADOW_HOOK_TRANSACTION_ID,
      startedAt: '2026-07-30T23:59:00.000Z',
      completedAt: '2026-07-30T23:59:59.000Z',
      status: 'passed',
      health: { backend: 'passed', identity: 'passed', shadowHook: 'passed' },
      rollback: { status: 'not_required' },
    });
    const receiptRaw = `${JSON.stringify(receipt)}\n`;
    const postEnableDotenv = rewriteShadowRouteHookDotenv({
      source: preEnableDotenv,
      plan,
    }).contents;
    writeFileSync(environmentFile, postEnableDotenv, { mode: 0o600 });
    chmodSync(environmentFile, 0o600);

    const claimsRoot = path.join(stateRoot, 'claims');
    mkdirSync(claimsRoot, { recursive: true, mode: 0o700 });
    chmodSync(claimsRoot, 0o700);
    writeFileSync(path.join(stateRoot, 'staging.shadow-hook.sequence'), '8\n', {
      mode: 0o600,
    });
    writeFileSync(
      path.join(claimsRoot, `staging-${SHADOW_HOOK_TRANSACTION_ID}.shadow-hook-receipt.json`),
      receiptRaw,
      { mode: 0o600 },
    );
    // Publishing the same receipt prevents recovery from mistaking this complete
    // fixture transaction for an interrupted final-publication gap.
    writeFileSync(path.join(stateRoot, 'staging.json'), receiptRaw, { mode: 0o600 });

    const healthTimestamp = new Date().toISOString();
    const configuredFlags = {
      AI_ROUTING_MANIFEST_CLASSIFIER: false,
      AI_ROUTING_MANIFEST_ORCHESTRATOR: false,
      AI_ROUTING_MANIFEST_SHADOW: false,
      AI_ROUTING_MANIFEST_REGISTRY: false,
      AI_ROUTING_CLARIFY: false,
      AI_CLASSIFY_MANIFEST_PROMPT: false,
      AI_CROSS_SKILL_EXECUTION: false,
    };
    const healthRaw = `${JSON.stringify({
      status: 'healthy',
      database: 'connected',
      databaseProbe: { status: 'connected', checkedAt: healthTimestamp },
      timestamp: healthTimestamp,
      releaseAttestation: {
        schema: 'nexus.chat-capability-release-attestation.v2',
        runtimeSha: RUNTIME_SHA,
        artifactDigest: ARTIFACT_DIGEST,
        role: 'staging',
        processId: 4101,
        classifierPromptRuntimeForceDisabled: false,
        capabilityRuntimeGuard: {
          status: 'clear',
          reason: 'no_unresolved_transaction',
          transactionId: null,
          planDigest: null,
        },
        shadowPlannerEffective: {
          global: false,
          user1000014: false,
          tenant1000014: false,
          user1000016: false,
          tenant1000016: false,
          dedicatedEval: { present: true, user: false, tenant: false },
        },
        shadowRouteHookEffective: {
          global: false,
          dedicatedEval: { present: true, user: true, tenant: true },
        },
        capabilityFlags: {
          configured: configuredFlags,
          effective: configuredFlags,
          masterKill: false,
        },
      },
    })}\n`;
    writeFileSync(routingHealthFile, healthRaw, { mode: 0o600 });
    writeFileSync(
      routingReportFile,
      routingEvidence({ receipt, receiptRaw, healthRaw, healthTimestamp }),
      { mode: 0o600 },
    );
  }

  return {
    base,
    environmentFile,
    pm2Log,
    release,
    remote,
    stateRoot,
    runtimePermit: path.join(stateRoot, 'staging.runtime-permit.json'),
    run,
    pendingFlag: path.join(stateRoot, 'staging.flag.pending.json'),
    pendingFlagPrivate: path.join(stateRoot, 'staging.flag.pending.private.json'),
    flagSequence: path.join(stateRoot, 'staging.flag.sequence'),
    pendingSecrets: path.join(stateRoot, 'staging.secrets.pending.json'),
    seedShadowHookEnable,
  };
}

function inspectMasterKill(value: boolean, fixture: ShellFixture) {
  return fixture.run('inspect', [
    'AI_ROUTING_MANIFEST_KILL',
    String(value),
    value ? 'emergency_kill' : 'operator_rollback',
  ]);
}

function routingEvidence(input: {
  receipt: {
    schema: string;
    transactionId: string;
    planDigest: string;
    planSequence: number;
    completedAt: string;
    runtimeSha: string;
    artifactDigest: string;
    role: string;
    status: string;
    action: string;
    dedicatedTenantId: number;
  };
  receiptRaw: string;
  healthRaw: string;
  healthTimestamp: string;
}): string {
  const receiptSha256 = createHash('sha256').update(input.receiptRaw).digest('hex');
  const healthSha256 = createHash('sha256').update(input.healthRaw).digest('hex');
  return `${JSON.stringify({
    generatedAt: '2026-08-01T00:00:00.000Z',
    evidence: {
      window: {
        sinceInclusive: '2026-07-31T00:00:00.000Z',
        throughInclusive: '2026-07-31T23:59:59.999Z',
        untilInclusive: '2026-07-31T23:59:59.999Z',
        upperBoundSource: 'until_flag',
      },
      identity: {
        enforced: true,
        releaseIdentity: {
          runtimeSha: RUNTIME_SHA,
          artifactDigest: ARTIFACT_DIGEST,
          role: 'staging',
        },
      },
      capabilityFlagBinding: {
        enforced: true,
        selectedSurface: 'classifierKeyword',
        selectedSurfaceFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
        counts: {
          unknownFlagStateBundles: 0,
          selectedSurfaceFlagOnBundles: 0,
          masterKillEngagedBundles: 0,
          flagEligibleBundles: 200,
        },
        observedStates: [{
          state: 'classifierKeyword=off,orchestratorPrimary=off,registrySubset=off,shadowRoute=off,masterKill=off',
          bundles: 200,
        }],
      },
      shadowRecorderBinding: {
        enforced: true,
        receipt: {
          schema: input.receipt.schema,
          sha256: receiptSha256,
          transactionId: input.receipt.transactionId,
          planDigest: input.receipt.planDigest,
          planSequence: input.receipt.planSequence,
          completedAt: input.receipt.completedAt,
          runtimeSha: input.receipt.runtimeSha,
          artifactDigest: input.receipt.artifactDigest,
          role: input.receipt.role,
          status: input.receipt.status,
          action: input.receipt.action,
          dedicatedTenantId: input.receipt.dedicatedTenantId,
        },
        liveHealth: {
          sha256: healthSha256,
          checkedAt: input.healthTimestamp,
          shadowRouteHookGlobal: false,
          shadowRouteHookDedicatedUser: true,
          shadowRouteHookDedicatedTenant: true,
          shadowPlannerGlobal: false,
          shadowPlannerDedicatedUser: false,
          shadowPlannerDedicatedTenant: false,
        },
        requiredState: {
          shadowRouteHookEffective: true,
          shadowPlannerEffective: false,
        },
        counts: {
          exactRecorderStateBundles: 200,
          missingRecorderStateBundles: 0,
          dedicatedScopeMismatchBundles: 0,
          hookNotEffectiveBundles: 0,
          plannerEffectiveBundles: 0,
        },
      },
    },
    surfaceTotals: {
      classifierKeyword: { compared: 200, agreed: 200, agreementRate: 1 },
    },
    gate: {
      enabled: true,
      selectedSurface: 'classifierKeyword',
      capabilityFlag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      minimumComparisons: 200,
      minimumAgreementRate: 0.99,
      passed: true,
      failures: [],
    },
  })}\n`;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('chat capability flag remote shell wiring', () => {
  it('passes hostile-looking operator data to the helper without evaluating it', () => {
    const fixture = createShellFixture();
    const marker = path.join(path.dirname(fixture.base), 'shell-injection-marker');
    const result = fixture.run('inspect', [
      'AI_ROUTING_MANIFEST_KILL',
      'true',
      `$(touch ${marker})`,
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/transitionReason|transition reason/i);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(fixture.pendingFlag)).toBe(false);
  });

  it('never replaces an unconsumed pending inspect plan', () => {
    const fixture = createShellFixture();
    const first = inspectMasterKill(true, fixture);
    expect(first.status, first.stderr).toBe(0);
    const pendingBefore = readFileSync(fixture.pendingFlag, 'utf8');

    const replacement = fixture.run('inspect', [
      'AI_ROUTING_MANIFEST_CLASSIFIER',
      'true',
      'gate_pass',
      '2026-07-31T00:00:00.000Z',
      '2026-07-31T23:59:59.999Z',
    ]);

    expect(replacement.status).not.toBe(0);
    expect(replacement.stderr).toMatch(/pending|replace|consume/i);
    expect(readFileSync(fixture.pendingFlag, 'utf8')).toBe(pendingBefore);
  });

  it('runs the installed routing gate over one explicit fixed 200-comparison window', () => {
    const fixture = createShellFixture();
    fixture.seedShadowHookEnable();
    const result = fixture.run('inspect', [
      'AI_ROUTING_MANIFEST_CLASSIFIER',
      'true',
      'gate_pass',
      '2026-07-31T00:00:00.000Z',
      '2026-07-31T23:59:59.999Z',
    ], { input: '{"forgedCallerEvidence":true}\n' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      flag: 'AI_ROUTING_MANIFEST_CLASSIFIER',
      desiredValue: true,
      evidenceAttestation: {
        kind: 'routing_divergence',
        minimumComparisons: 200,
        comparisonCount: 200,
        agreementRate: 1,
      },
    });
  });

  it('refuses a staging environment hardlinked to the production environment', () => {
    const fixture = createShellFixture();
    const productionBase = path.join(path.dirname(fixture.base), 'telegram-hub-bot');
    mkdirSync(productionBase, { recursive: true });
    linkSync(fixture.environmentFile, path.join(productionBase, '.env'));

    const result = fixture.run('inspect', [
      'AI_ROUTING_MANIFEST_CLASSIFIER',
      'true',
      'gate_pass',
      '2026-07-31T00:00:00.000Z',
      '2026-07-31T23:59:59.999Z',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/single-link|isolat/i);
  });

  it('refuses a staging database hardlinked to the production database', () => {
    const fixture = createShellFixture();
    const productionData = path.join(
      path.dirname(fixture.base),
      'telegram-hub-bot/data',
    );
    mkdirSync(productionData, { recursive: true });
    linkSync(
      path.join(fixture.base, 'data/bot.db'),
      path.join(productionData, 'bot.db'),
    );

    const result = fixture.run('inspect', [
      'AI_ROUTING_MANIFEST_CLASSIFIER',
      'true',
      'gate_pass',
      '2026-07-31T00:00:00.000Z',
      '2026-07-31T23:59:59.999Z',
    ]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/database|isolat/i);
  });

  it('archives a pending plan whose dotenv precondition became stale before reinspecting', () => {
    const fixture = createShellFixture();
    const first = inspectMasterKill(true, fixture);
    expect(first.status, first.stderr).toBe(0);
    const firstPlan = JSON.parse(first.stdout);
    writeFileSync(
      fixture.environmentFile,
      `${readFileSync(fixture.environmentFile, 'utf8')}UNRELATED_DRIFT=preserved\n`,
      { mode: 0o600 },
    );

    const replacement = inspectMasterKill(true, fixture);
    expect(replacement.status, replacement.stderr).toBe(0);
    const replacementPlan = JSON.parse(replacement.stdout);
    expect(replacementPlan.planDigest).not.toBe(firstPlan.planDigest);
    const archived = readdirSync(path.join(fixture.stateRoot, 'expired'));
    expect(archived).toHaveLength(1);
    expect(archived.every((name) => name.includes(firstPlan.planDigest.slice(7)))).toBe(true);
  });

  it('consumes exactly one sequence and recreates only the backend process', () => {
    const fixture = createShellFixture();
    const inspect = inspectMasterKill(true, fixture);
    expect(inspect.status, inspect.stderr).toBe(0);
    const plan = JSON.parse(inspect.stdout);
    expect(plan).toMatchObject({ previousPlanSequence: 0, planSequence: 1 });

    const apply = fixture.run('apply', [
      TRANSACTION_ID,
      plan.planDigest,
    ], { ownerAuthorized: true });
    expect(apply.status, apply.stderr).toBe(0);
    expect(JSON.parse(apply.stdout)).toMatchObject({
      schema: 'nexus.chat-capability-flag-transaction.v1',
      status: 'passed',
      previousPlanSequence: 0,
      planSequence: 1,
      planDigest: plan.planDigest,
    });
    expect(readFileSync(fixture.flagSequence, 'utf8')).toBe('1\n');
    expect(existsSync(fixture.pendingFlag)).toBe(false);
    expect(existsSync(fixture.pendingFlagPrivate)).toBe(false);
    expect(existsSync(fixture.runtimePermit)).toBe(false);
    expect(readdirSync(path.join(fixture.stateRoot, 'claims')).sort()).toEqual([
      `staging-${TRANSACTION_ID}.flag-plan.json`,
      `staging-${TRANSACTION_ID}.flag-private.json`,
      `staging-${TRANSACTION_ID}.flag-receipt.json`,
    ]);

    const pm2Calls = readFileSync(fixture.pm2Log, 'utf8').trim().split('\n');
    expect(pm2Calls).toEqual([
      'delete nexus-hub-staging',
      `start ${fixture.release}/ecosystem.release.config.js --only nexus-hub-staging`,
      'save --force',
    ]);
    expect(pm2Calls.join('\n')).not.toContain('content-engine-staging');

    const nextInspect = inspectMasterKill(false, fixture);
    expect(nextInspect.status, nextInspect.stderr).toBe(0);
    const nextPlan = JSON.parse(nextInspect.stdout);
    expect(nextPlan).toMatchObject({ previousPlanSequence: 1, planSequence: 2 });
    const nextPending = readFileSync(fixture.pendingFlag, 'utf8');

    const replay = fixture.run('apply', [
      NEXT_TRANSACTION_ID,
      plan.planDigest,
    ], { ownerAuthorized: true });
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toMatch(/digest|acknowledged|consum|sequence/i);
    expect(readFileSync(fixture.flagSequence, 'utf8')).toBe('1\n');
    expect(readFileSync(fixture.pendingFlag, 'utf8')).toBe(nextPending);
    expect(readFileSync(fixture.pm2Log, 'utf8').trim().split('\n')).toEqual(pm2Calls);
  });

  it('rolls back an exact interrupted dotenv mutation before accepting another command', () => {
    const fixture = createShellFixture();
    const preimage = readFileSync(fixture.environmentFile, 'utf8');
    const inspect = inspectMasterKill(true, fixture);
    expect(inspect.status, inspect.stderr).toBe(0);
    const plan = JSON.parse(inspect.stdout);
    const applied = fixture.run('apply', [TRANSACTION_ID, plan.planDigest], {
      ownerAuthorized: true,
    });
    expect(applied.status, applied.stderr).toBe(0);
    expect(readFileSync(fixture.environmentFile, 'utf8')).not.toBe(preimage);

    writeFileSync(
      path.join(fixture.base, `.env.before-chat-capability-${TRANSACTION_ID}`),
      preimage,
      { mode: 0o600 },
    );
    rmSync(path.join(
      fixture.stateRoot,
      `claims/staging-${TRANSACTION_ID}.flag-receipt.json`,
    ));
    rmSync(path.join(fixture.stateRoot, 'staging.json'));

    const recoveredInspect = inspectMasterKill(true, fixture);
    expect(recoveredInspect.status, recoveredInspect.stderr).toBe(0);
    expect(readFileSync(fixture.environmentFile, 'utf8')).toBe(preimage);
    expect(existsSync(
      path.join(fixture.base, `.env.before-chat-capability-${TRANSACTION_ID}`),
    )).toBe(false);
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'staging.json'), 'utf8')))
      .toMatchObject({
        schema: 'nexus.chat-capability-flag-transaction.v1',
        transactionId: TRANSACTION_ID,
        status: 'rolled_back',
        rollback: { status: 'rolled_back' },
      });
  });

  it('republishes a committed internal receipt after a crash in the final publication gap', () => {
    const fixture = createShellFixture();
    const inspect = inspectMasterKill(true, fixture);
    expect(inspect.status, inspect.stderr).toBe(0);
    const plan = JSON.parse(inspect.stdout);
    const applied = fixture.run('apply', [TRANSACTION_ID, plan.planDigest], {
      ownerAuthorized: true,
    });
    expect(applied.status, applied.stderr).toBe(0);
    rmSync(path.join(fixture.stateRoot, 'staging.json'));

    const nextInspect = inspectMasterKill(false, fixture);
    expect(nextInspect.status, nextInspect.stderr).toBe(0);
    expect(JSON.parse(readFileSync(path.join(fixture.stateRoot, 'staging.json'), 'utf8')))
      .toMatchObject({
        schema: 'nexus.chat-capability-flag-transaction.v1',
        transactionId: TRANSACTION_ID,
        status: 'passed',
      });
  });

  it('inspect-secrets must produce a governed plan instead of a silent helper CLI no-op', () => {
    const fixture = createShellFixture();
    const result = fixture.run('inspect-secrets', []);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).not.toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'nexus.chat-capability-secret-plan.v1',
      role: 'staging',
      runtimeSha: RUNTIME_SHA,
      artifactDigest: ARTIFACT_DIGEST,
      previousPlanSequence: 0,
      planSequence: 1,
    });
    expect(existsSync(fixture.pendingSecrets)).toBe(true);
  });

  it('archives a stale secret plan instead of permanently deadlocking inspection', () => {
    const fixture = createShellFixture();
    const first = fixture.run('inspect-secrets', []);
    expect(first.status, first.stderr).toBe(0);
    const firstPlan = JSON.parse(first.stdout);
    writeFileSync(
      fixture.environmentFile,
      `${readFileSync(fixture.environmentFile, 'utf8')}UNRELATED_DRIFT=preserved\n`,
      { mode: 0o600 },
    );

    const replacement = fixture.run('inspect-secrets', []);
    expect(replacement.status, replacement.stderr).toBe(0);
    expect(JSON.parse(replacement.stdout).planDigest).not.toBe(firstPlan.planDigest);
    expect(readdirSync(path.join(fixture.stateRoot, 'expired'))).toContain(
      `staging.secrets.${firstPlan.planDigest.slice(7)}.json`,
    );
  });

  it('apply-secrets fails closed when no inspected pending plan exists', () => {
    const fixture = createShellFixture();
    const environmentBefore = readFileSync(fixture.environmentFile, 'utf8');
    const result = fixture.run('apply-secrets', [
      TRANSACTION_ID,
      `sha256:${'c'.repeat(64)}`,
    ], { ownerAuthorized: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/pending|plan|inspect/i);
    expect(readFileSync(fixture.environmentFile, 'utf8')).toBe(environmentBefore);
    expect(existsSync(fixture.pm2Log)).toBe(false);
  });

  it('applies an inspected secret plan without disclosing generated HMAC values', () => {
    const fixture = createShellFixture();
    const inspected = fixture.run('inspect-secrets', []);
    expect(inspected.status, inspected.stderr).toBe(0);
    const plan = JSON.parse(inspected.stdout);

    const applied = fixture.run('apply-secrets', [TRANSACTION_ID, plan.planDigest], {
      ownerAuthorized: true,
    });
    expect(applied.status, applied.stderr).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      schema: 'nexus.chat-capability-secret-transaction.v1',
      status: 'passed',
      actions: {
        CLASSIFY_SHADOW_HASH_SECRET: 'generate',
        CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET: 'generate',
      },
    });
    const dotenv = readFileSync(fixture.environmentFile, 'utf8');
    const classifier = dotenv.match(/^CLASSIFY_SHADOW_HASH_SECRET=([a-f0-9]{64})$/mu)?.[1];
    const shadow = dotenv.match(/^CHAT_CORE_V2_SHADOW_ROUTE_HMAC_SECRET=([a-f0-9]{64})$/mu)?.[1];
    expect(classifier).toBeTruthy();
    expect(shadow).toBeTruthy();
    expect(applied.stdout).not.toContain(classifier!);
    expect(applied.stdout).not.toContain(shadow!);
  });
});
