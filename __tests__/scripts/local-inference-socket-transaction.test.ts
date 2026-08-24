import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildSocketTransactionPlan,
  resolveSocketRollbackDirectories,
} from '../../scripts/local-inference-socket-transaction.mjs';

function evidence() {
  return {
    release: {
      releaseId: 'release-1',
      sourceSha: 'a'.repeat(40),
      releasePayloadDigest: 'b'.repeat(64),
      completedAt: '2026-08-12T00:00:00.000Z',
    },
    model: {
      manifestVersion: '2026-08-24.1',
      selectionStatus: 'production_selected',
      id: 'winner',
      tag: 'winner:tag',
      digest: `sha256:${'c'.repeat(64)}`,
    },
    ollama: { version: '0.24.0', listener: '127.0.0.1:11434', service: 'active' },
    host: { availableBytes: 8 * 1024 ** 3, swapUsedBytes: 0, freeDiskBytes: 20 * 1024 ** 3 },
    tmpfilesPolicy: {
      sourcePath: '/usr/local/sbin/nexus-local-inference-sockets.conf',
      activePath: '/etc/tmpfiles.d/nexus-local-inference-sockets.conf',
      sourceSha256: 'd'.repeat(64),
      state: 'absent',
    },
    directories: [
      { path: '/run/nexus-inference', state: 'absent' },
      { environment: 'staging', path: '/run/nexus-inference/staging', state: 'absent' },
      { environment: 'production', path: '/run/nexus-inference/production', state: 'absent' },
    ],
  };
}

describe('local-inference socket host transaction', () => {
  it('binds the owner acknowledgement to release, model, host, config, and directory preimage', () => {
    const first = buildSocketTransactionPlan(evidence());
    const replay = buildSocketTransactionPlan(evidence());
    const changed = buildSocketTransactionPlan({
      ...evidence(),
      model: { ...evidence().model, digest: `sha256:${'e'.repeat(64)}` },
    });

    expect(first.ackPlan).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(replay.ackPlan).toBe(first.ackPlan);
    expect(changed.ackPlan).not.toBe(first.ackPlan);
  });

  it('keeps staging and production sockets in separate UID-10001 mode-0700 directories', () => {
    const config = fs.readFileSync(
      path.resolve('scripts/systemd/nexus-local-inference-sockets.conf'),
      'utf8',
    );
    expect(config).toContain('d /run/nexus-inference/staging 0700 10001 10001 -');
    expect(config).toContain('d /run/nexus-inference/production 0700 10001 10001 -');

    const source = fs.readFileSync(
      path.resolve('scripts/local-inference-socket-transaction.mjs'),
      'utf8',
    );
    expect(source).toContain("const MAINTENANCE_LOCK = '/run/lock/nexus-release-sonar.lock'");
    expect(source).toContain('owner acknowledgement does not match the current preflight plan');
    expect(source).toContain('stop gateway containers before rollback');
    expect(source).toContain('restoreTmpfilesPolicy(receipt.before.tmpfilesPolicy)');
    expect(source).toContain('production selection does not resolve to exactly one trusted benchmark rollback receipt');
    expect(source).toContain("receipt.manifest?.candidateModelId !== activeModel.id");
    expect(source).toContain("receipt.manifest?.candidateModelDigest !== activeModel.digest");
    expect(source).toContain("receipt.restoredEnvelope?.schema !== 'nexus.ollama-service-envelope-check.v1'");
    expect(source).toContain("winners.length !== 1 || winners[0]?.id !== active?.id");
    expect(source).not.toContain('rmSync(');
  });

  it('executes fixed-scope rollback planning and refuses any non-empty created directory', () => {
    const before = evidence().directories;
    const empty = Object.fromEntries(before.map((entry) => [entry.path, {
      exists: true, safeDirectory: true, entries: [],
    }]));
    expect(resolveSocketRollbackDirectories(before, empty)).toEqual([
      '/run/nexus-inference/production',
      '/run/nexus-inference/staging',
      '/run/nexus-inference',
    ]);
    expect(() => resolveSocketRollbackDirectories(before, {
      ...empty,
      '/run/nexus-inference/production': {
        exists: true, safeDirectory: true, entries: ['ollama.sock'],
      },
    })).toThrow('socket directory is not empty');
    expect(() => resolveSocketRollbackDirectories(before, {
      ...empty,
      '/run/nexus-inference/staging': { exists: true, safeDirectory: false, entries: [] },
    })).toThrow('socket directory is not empty');
    expect(() => resolveSocketRollbackDirectories([
      ...before.slice(0, 2),
      { path: '/tmp/not-governed', state: 'absent' },
    ], empty)).toThrow('socket transaction receipt directory scope is invalid');
  });
});
