import fs from 'node:fs';
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertBenchmarkHostPressure,
  assertBenchmarkDropInRollbackBytes,
  buildBenchmarkEnvelopePlan,
  resolveInstalledCandidateIdentity,
} from '../../scripts/local-model-benchmark-envelope-transaction.mjs';

function evidence() {
  return {
    release: {
      releaseId: 'release-1',
      sourceSha: 'a'.repeat(40),
      releasePayloadDigest: 'b'.repeat(64),
      completedAt: '2026-08-12T00:00:00.000Z',
    },
    manifest: {
      manifestVersion: '2026-08-12.1',
      candidateModelId: 'candidate',
      candidateModelTag: 'candidate:tag',
      candidateModelDigest: `sha256:${'c'.repeat(64)}`,
      benchmarkEnvelope: {
        cpuQuotaPercent: 800,
        memoryHighBytes: 22 * 1024 ** 3,
        memoryMaxBytes: 24 * 1024 ** 3,
        memorySwapMaxBytes: 0,
        minimumHostAvailableBytes: 6 * 1024 ** 3,
        maxLoadedModels: 1,
        parallelGenerations: 1,
        waitingQueueDepth: 4,
        maxContextTokens: 16_384,
        nice: 10,
      },
    },
    host: { availableBytes: 8 * 1024 ** 3, swapUsedBytes: 0 },
    dropIn: {
      path: '/etc/systemd/system/ollama.service.d/zz-nexus-benchmark-envelope.conf',
      state: 'absent',
      sha256: 'd'.repeat(64),
      mode: 0o644,
    },
  };
}

describe('local-model benchmark envelope transaction', () => {
  it('binds owner acknowledgement to immutable host policy without hashing volatile pressure', () => {
    const first = buildBenchmarkEnvelopePlan(evidence());
    const replay = buildBenchmarkEnvelopePlan(evidence());
    const changedObservation = buildBenchmarkEnvelopePlan({
      ...evidence(),
      host: { availableBytes: 8 * 1024 ** 3 + 4096, swapUsedBytes: 0 },
    });
    const changedPolicy = buildBenchmarkEnvelopePlan({
      ...evidence(),
      manifest: {
        ...evidence().manifest,
        benchmarkEnvelope: {
          ...evidence().manifest.benchmarkEnvelope,
          minimumHostAvailableBytes: 7 * 1024 ** 3,
        },
      },
    });
    const changedManifest = buildBenchmarkEnvelopePlan({
      ...evidence(),
      manifest: { ...evidence().manifest, manifestVersion: '2026-08-12.2' },
    });

    expect(first.ackPlan).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(replay.ackPlan).toBe(first.ackPlan);
    expect(changedObservation.ackPlan).toBe(first.ackPlan);
    expect(changedObservation.hostObservation).not.toEqual(first.hostObservation);
    expect(changedPolicy.ackPlan).not.toBe(first.ackPlan);
    expect(changedManifest.ackPlan).not.toBe(first.ackPlan);
  });

  it('rechecks live host headroom and swap against the acknowledged policy', () => {
    const envelope = evidence().manifest.benchmarkEnvelope;
    expect(assertBenchmarkHostPressure({
      availableBytes: envelope.minimumHostAvailableBytes,
      swapUsedBytes: envelope.memorySwapMaxBytes,
    }, envelope)).toEqual({
      availableBytes: envelope.minimumHostAvailableBytes,
      swapUsedBytes: envelope.memorySwapMaxBytes,
    });
    expect(() => assertBenchmarkHostPressure({
      availableBytes: envelope.minimumHostAvailableBytes - 1,
      swapUsedBytes: 0,
    }, envelope)).toThrow('host has less than the signed minimum available memory');
    expect(() => assertBenchmarkHostPressure({
      availableBytes: envelope.minimumHostAvailableBytes,
      swapUsedBytes: 1,
    }, envelope)).toThrow('host swap exceeds the signed benchmark limit');
    expect(() => assertBenchmarkHostPressure({
      availableBytes: envelope.minimumHostAvailableBytes,
      swapUsedBytes: -1,
    }, envelope)).toThrow('host swap exceeds the signed benchmark limit');
  });

  it('canonicalizes the bare digest shape returned by Ollama inventory', () => {
    const digestHex = 'c'.repeat(64);
    expect(resolveInstalledCandidateIdentity({
      candidateModelId: 'candidate',
      candidateModelTag: 'candidate:tag',
      candidateDeclaredDigest: `sha256:${digestHex}`,
    }, {
      models: [{ name: 'candidate:tag', digest: digestHex }],
    })).toEqual({
      candidateModelId: 'candidate',
      candidateModelTag: 'candidate:tag',
      candidateModelDigest: `sha256:${digestHex}`,
    });
  });

  it('requires stopped gateways and receipt-bound exact-file rollback', () => {
    const source = fs.readFileSync('scripts/local-model-benchmark-envelope-transaction.mjs', 'utf8');
    expect(source).toContain("'/run/nexus-inference/staging/ollama.sock'");
    expect(source).toContain("'/run/nexus-inference/production/ollama.sock'");
    expect(source).toContain("const MAINTENANCE_LOCK = '/run/lock/nexus-release-sonar.lock'");
    expect(source).toContain('zz-nexus-benchmark-envelope.conf');
    expect(source).toContain('benchmark envelope drop-in changed; refusing automatic removal');
    expect(source).toContain('sourceReceiptSha256: acknowledgement');
    expect(source).toContain('rollbackReceiptSha256: `sha256:');
    expect(source).toContain("await requestJson('/api/tags')");
    expect(source).toContain("apply requires --candidate-id <signed-manifest-id>");
    expect(source).toContain('winners.length !== 0');
    expect(source).not.toContain('/api/pull');
    expect(source).not.toContain('rmSync(');
  });

  it('executes the exact-byte rollback guard before any governed drop-in removal', () => {
    const bytes = Buffer.from('[Service]\nMemoryMax=25769803776\n');
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    expect(assertBenchmarkDropInRollbackBytes(digest, bytes)).toBe(true);
    expect(() => assertBenchmarkDropInRollbackBytes(digest, Buffer.from('changed')))
      .toThrow('benchmark envelope drop-in changed; refusing automatic removal');
  });
});
