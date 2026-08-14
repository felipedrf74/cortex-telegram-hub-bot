import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import {
  buildFinalizationPlan,
  executeOllamaFinalization,
  OLLAMA_DELETE_MODELS,
  OLLAMA_DROP_IN,
  OLLAMA_RETAINED_MODEL,
  validateFinalizationSnapshot,
  validateOllamaInventory,
  validateReleasePair,
} from '../../scripts/ollama-lean-finalize.mjs';
import { parseAndValidateOllamaEnvelope } from '../../scripts/lib/ollama-service-envelope.mjs';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const runtimeSha = 'a'.repeat(40);
const artifactDigest = 'b'.repeat(64);

function release(role: 'staging' | 'production') {
  const base = role === 'staging'
    ? '/home/dominguez/telegram-hub-bot-staging'
    : '/home/dominguez/telegram-hub-bot';
  const releaseDir = `${base}/releases/${runtimeSha}-${artifactDigest.slice(0, 12)}`;
  return {
    statePath: `/home/dominguez/.local/state/nexus-release/${role}.json`,
    stateSha256: (role === 'staging' ? 'c' : 'd').repeat(64),
    currentTarget: releaseDir,
    state: {
      schema: 'nexus.lean-release-transaction.v1',
      role,
      transactionId: `20260727T120000Z-${role === 'staging' ? '1' : '2'}23456789ab`,
      runtimeSha,
      artifactDigest,
      releaseDir,
      predecessor: `${base}/releases/${'0'.repeat(40)}-${'1'.repeat(12)}`,
      phase: 'completed',
      status: 'passed',
      completedAt: '2026-07-27T12:02:00.000Z',
      healthResult: 'passed',
      rollbackResult: 'not_required',
      stabilitySeconds: 60,
      soakStartedAt: '2026-07-27T12:00:30.000Z',
      soakCompletedAt: '2026-07-27T12:01:30.000Z',
      checks: {
        artifactParity: 'passed',
        migrationStartup: 'passed',
        authenticatedSmoke: 'passed',
        databaseIntegrity: 'passed',
        prePromotionBackup: role === 'production' ? 'passed' : 'skipped',
        rollbackReadiness: 'passed',
      },
    },
  };
}

function pm2Rows() {
  const stagingDir = release('staging').state.releaseDir;
  const productionDir = release('production').state.releaseDir;
  return [
    ['nexus-hub-staging', stagingDir],
    ['content-engine-staging', `${stagingDir}/content-engine`],
    ['nexus-hub', productionDir],
    ['content-engine', `${productionDir}/content-engine`],
  ].map(([name, cwd]) => ({
    name,
    pm2_env: {
      status: 'online',
      pm_cwd: cwd,
      NEXUS_RELEASE_SHA: runtimeSha,
      GIT_COMMIT: runtimeSha,
    },
  }));
}

function inventory(includeDelete = true) {
  return (includeDelete
    ? [OLLAMA_RETAINED_MODEL, ...OLLAMA_DELETE_MODELS]
    : [OLLAMA_RETAINED_MODEL])
    .map(({ tag, digest }) => ({ name: tag, model: tag, digest: `sha256:${digest}` }));
}

function receiptPaths() {
  return {
    result: '/var/lib/nexus-release/ollama-finalize/result.json',
    predecessorDropIn: '/var/lib/nexus-release/ollama-finalize/predecessor',
    legacyZeroSwap: '/var/lib/nexus-release/ollama-finalize/legacy',
  };
}

function snapshot({
  final = false,
  candidate = false,
  loaded = [],
}: {
  final?: boolean;
  candidate?: boolean;
  loaded?: Array<{ tag: string; digest: string }>;
} = {}) {
  const bytes = Buffer.from(candidate ? OLLAMA_DROP_IN : '[Service]\nMemorySwapMax=512M\n');
  return {
    releases: {
      staging: release('staging'),
      production: release('production'),
    },
    pm2: pm2Rows(),
    ollama: {
      inventory: inventory(!final),
      loaded: loaded.map(({ tag, digest }) => ({
        name: tag,
        model: tag,
        digest: `sha256:${digest}`,
      })),
    },
    dropIn: {
      path: '/etc/systemd/system/ollama.service.d/override.conf',
      exists: true,
      bytes,
      sha256: sha256(bytes),
      mode: 0o644,
      uid: 0,
      gid: 0,
    },
    legacyZeroSwap: {
      path: '/etc/systemd/system/ollama.service.d/zz-nexus-zero-swap.conf',
      exists: false,
      bytes: null,
      sha256: null,
      mode: null,
      uid: null,
      gid: null,
    },
  };
}

function platformFor(snapshots: ReturnType<typeof snapshot>[], restartError?: Error) {
  const writes: unknown[] = [];
  const platform = {
    snapshot: vi.fn(async () => {
      const next = snapshots.shift();
      if (!next) throw new Error('unexpected snapshot');
      return next;
    }),
    prepareReceipt: vi.fn(async () => undefined),
    writeReceipt: vi.fn(async (_path: string, value: unknown) => {
      writes.push(value);
    }),
    installEnvelope: vi.fn(async () => undefined),
    restartAndValidateEnvelope: vi.fn(async () => {
      if (restartError) throw restartError;
      return { memorySwapMaxBytes: 0, listeners: ['127.0.0.1:11434'] };
    }),
    readEffectiveEnvelope: vi.fn(async () => ({
      memorySwapMaxBytes: 0,
      listeners: ['127.0.0.1:11434'],
    })),
    smokeRetainedModel: vi.fn(async () => ({
      model: OLLAMA_RETAINED_MODEL.tag,
      done: true,
      responsePresent: true,
    })),
    restorePredecessor: vi.fn(async () => ({
      status: 'restored',
      dropInSha256: snapshot().dropIn.sha256,
    })),
    removeModels: vi.fn(async (tags: string[]) => ({ removedTags: tags })),
  };
  return { platform, writes };
}

describe('lean Ollama finalization', () => {
  it('binds one passing staging and production release to the same SHA and digest', () => {
    const releases = validateReleasePair({
      staging: release('staging'),
      production: release('production'),
    });
    expect(releases.production.runtimeSha).toBe(runtimeSha);

    const mismatched = release('production');
    mismatched.state.artifactDigest = 'e'.repeat(64);
    expect(() => validateReleasePair({
      staging: release('staging'),
      production: mismatched,
    })).toThrow('current symlink');
  });

  it('accepts only the audited four full digests and no loaded deletion target', () => {
    expect(validateOllamaInventory({
      inventory: inventory(),
      loaded: [],
    }).inventory).toHaveLength(4);
    expect(() => validateOllamaInventory({
      inventory: inventory(),
      loaded: inventory().filter(({ name }) => name === OLLAMA_DELETE_MODELS[0].tag),
    })).toThrow('deletion target is still loaded');
  });

  it('makes the dry-run plan deterministic without mutating', async () => {
    const first = validateFinalizationSnapshot(snapshot());
    const paths = receiptPaths();
    expect(buildFinalizationPlan(first, paths).ackPlan)
      .toBe(buildFinalizationPlan(first, paths).ackPlan);

    const { platform } = platformFor([snapshot()]);
    const plan = await executeOllamaFinalization({ mode: 'dry-run' }, platform);
    expect(plan).toMatchObject({ mode: 'dry-run', mutationAttempted: false });
    expect(platform.installEnvelope).not.toHaveBeenCalled();
  });

  it('applies once, verifies before deletion, and leaves only the retained model', async () => {
    const planner = platformFor([snapshot()]);
    const plan = await executeOllamaFinalization({ mode: 'dry-run' }, planner.platform);
    const loaded3b = [OLLAMA_RETAINED_MODEL];
    const apply = platformFor([
      snapshot(),
      snapshot(),
      snapshot({ candidate: true, loaded: loaded3b }),
      snapshot({ final: true, candidate: true, loaded: loaded3b }),
    ]);
    const result = await executeOllamaFinalization({
      mode: 'apply',
      ownerAuthorized: true,
      ackPlan: plan.ackPlan,
    }, apply.platform);
    expect(result.status).toBe('complete');
    expect(apply.platform.removeModels).toHaveBeenCalledWith(
      OLLAMA_DELETE_MODELS.map(({ tag }) => tag),
    );
    expect(result.after.ollama.inventory).toEqual([OLLAMA_RETAINED_MODEL]);
  });

  it('restores the predecessor when restart or retained-model smoke fails', async () => {
    const planner = platformFor([snapshot()]);
    const plan = await executeOllamaFinalization({ mode: 'dry-run' }, planner.platform);
    const apply = platformFor([snapshot(), snapshot()], new Error('restart failed'));
    await expect(executeOllamaFinalization({
      mode: 'apply',
      ownerAuthorized: true,
      ackPlan: plan.ackPlan,
    }, apply.platform)).rejects.toThrow('exact predecessor drop-in was restored');
    expect(apply.platform.restorePredecessor).toHaveBeenCalledOnce();
    expect(apply.writes.at(-1)).toMatchObject({
      status: 'failed',
      rollback: { status: 'restored' },
    });
  });

  it('pins loopback and the fixed 20 GiB zero-swap systemd envelope', () => {
    const effective = [
      'Environment=OLLAMA_HOST=127.0.0.1:11434 OLLAMA_CONTEXT_LENGTH=16384 OLLAMA_MAX_QUEUE=4 OLLAMA_NUM_PARALLEL=1 OLLAMA_MAX_LOADED_MODELS=1',
      'MemoryHigh=19327352832',
      'MemoryMax=21474836480',
      'MemorySwapMax=0',
      'CPUQuotaPerSecUSec=8s',
      'Nice=10',
    ].join('\n');
    expect(parseAndValidateOllamaEnvelope(effective, 0))
      .toMatchObject({ memorySwapMaxBytes: 0, cpuQuotaUsecPerSec: 8000000, nice: 10 });
    expect(() => parseAndValidateOllamaEnvelope(effective.replace(
      '127.0.0.1:11434',
      '0.0.0.0:11434',
    ), 0)).toThrow('OLLAMA_HOST');
  });

  it('installs the governed host tools, socket policy, manifest, and permanent install guard', () => {
    const installer = readFileSync('scripts/install-ollama.sh', 'utf8');
    const transaction = readFileSync('scripts/ollama-systemd-dropin-transaction.mjs', 'utf8');
    for (const source of [installer, transaction]) {
      expect(source).toContain('ollama-lean-finalize.mjs');
      expect(source).not.toMatch(/ollama-(?:observation|soak-evidence|large-model-cleanup|zero-swap)/);
    }
    expect(installer).toContain('00-nexus-ollama-install-guard.conf');
    expect(installer).toContain('local-inference-socket-transaction.mjs');
    expect(installer).toContain('local-model-benchmark-envelope-transaction.mjs');
    expect(installer).toContain('nexus-local-inference-sockets.conf');
    expect(transaction).toContain("'/usr/local/sbin/nexus-local-model-manifest.json'");
    expect(transaction).toContain("'/usr/local/sbin/nexus-local-inference-sockets.conf'");
    expect(transaction).toContain("'/usr/local/sbin/nexus-local-model-benchmark-envelope-transaction.mjs'");

    // SonarQube was decommissioned on 2026-08-07, so its local installer no
    // longer exists. What survives from that surface is the shared root
    // maintenance mutex, whose tmpfiles definition moved to ops/nexus-release/
    // under a non-Sonar owner while keeping the historical lock path.
    expect(existsSync('scripts/quality-sonar-local-install.sh')).toBe(false);
    const maintenanceLock = readFileSync(
      'ops/nexus-release/nexus-release-maintenance-lock.conf',
      'utf8',
    );
    expect(maintenanceLock).toContain('/run/lock/nexus-release-sonar.lock');
    expect(maintenanceLock).toContain('0660 root dominguez');
  });

  it('carries no Sonar state through the snapshot, plan, or receipt contract', () => {
    // The finalizer used to shell out to /usr/local/sbin/quality-sonar-release-state
    // and thread a `sonar` field through dry-run/apply drift detection. That binary
    // has no source in the repository any more, so the field is removed rather than
    // frozen to a placeholder — a placeholder would keep a dead comparison alive and
    // hide the fact that nothing validates it.
    const validated = validateFinalizationSnapshot(snapshot());
    expect(Object.keys(validated).sort())
      .toEqual(['dropIn', 'legacyZeroSwap', 'ollama', 'pm2', 'releases']);

    const plan = buildFinalizationPlan(validated, receiptPaths());
    expect(JSON.stringify(plan)).not.toMatch(/sonar/i);
  });

  it('still refuses every state surface it compares, after sonar was removed', () => {
    // Removing `sonar` must not weaken drift detection. Each remaining surface —
    // release identity, PM2, the Ollama inventory, the loaded models, and both
    // drop-ins — is validated against an exact expectation, so drift is refused
    // outright rather than surfacing as a changed digest. (The digest's job is to
    // invalidate a stale acknowledgment between dry-run and apply; determinism for
    // an unchanged snapshot is asserted separately above.)
    const cases: Array<[string, () => unknown, RegExp]> = [
      ['release artifact digest', () => {
        const drifted = snapshot();
        drifted.releases.production.state.artifactDigest = 'f'.repeat(64);
        return drifted;
      }, /current symlink is not the completed release directory/],
      ['pm2 offline', () => {
        const drifted = snapshot();
        drifted.pm2[0].pm2_env.status = 'stopped';
        return drifted;
      }, /is not the exact online release/],
      ['pm2 wrong cwd', () => {
        const drifted = snapshot();
        drifted.pm2[0].pm2_env.pm_cwd = '/somewhere/else';
        return drifted;
      }, /is not the exact online release/],
      ['pm2 wrong release sha', () => {
        const drifted = snapshot();
        drifted.pm2[2].pm2_env.NEXUS_RELEASE_SHA = 'e'.repeat(40);
        return drifted;
      }, /is not the exact online release/],
      ['ollama inventory', () => {
        const drifted = snapshot();
        drifted.ollama.inventory = drifted.ollama.inventory.slice(1);
        return drifted;
      }, /exact audited four-tag digest allowlist/],
    ];

    for (const [label, build, expected] of cases) {
      expect(() => validateFinalizationSnapshot(build() as never), label).toThrow(expected);
    }

    // A deletion target still resident in memory blocks the run.
    expect(() => validateFinalizationSnapshot(snapshot({ loaded: [OLLAMA_DELETE_MODELS[0]] })))
      .toThrow(/deletion target is still loaded/);

    // And the drop-in must match the digest the plan was acknowledged against.
    expect(() => validateFinalizationSnapshot(snapshot(), {
      expectedDropInSha256: 'a'.repeat(64),
    })).toThrow(/changed/);
  });

  it('leaves no executable reference to the removed Sonar state binary', () => {
    const finalizer = readFileSync('scripts/ollama-lean-finalize.mjs', 'utf8');
    for (const line of finalizer.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      expect(trimmed).not.toContain('quality-sonar-release-state');
      expect(trimmed).not.toContain('nexus.sonarqube-release-state.v1');
    }
    // The retained maintenance mutex is the one Sonar-named thing that stays.
    expect(finalizer).toContain("'/run/lock/nexus-release-sonar.lock'");
  });
});
