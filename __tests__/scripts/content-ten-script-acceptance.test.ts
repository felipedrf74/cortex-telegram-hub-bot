// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
  renameSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  TEN_SCRIPT_ACCEPTANCE_SCENARIOS,
  TEN_SCRIPT_ACCEPTANCE_REVISION,
  TEN_SCRIPT_ACCEPTANCE_SCHEMA,
  TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
  TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA,
  LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA,
  TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA,
  bindProductionSmokeSource,
  createSuccessorAcceptanceState,
  migrateLegacyAcceptanceState,
  updateAcceptanceScenarioFromView,
  validateAcceptanceStateShape,
  validateAuthoritativeWorkloadReleaseView,
  validateCompletedReleaseView,
  validateSuccessorAcceptancePredecessor,
} from '../../scripts/content-ten-script-acceptance.mjs';
import {
  CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
  CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
  CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA,
  CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
  CONTENT_SCRIPT_JOB_EVIDENCE_KEYS_SCHEMA,
  OPERATION_USAGE_EVIDENCE_SCHEMA,
  acceptanceSourceBindingSha256,
  atomicPrivateWrite,
  readPrivateBytes,
  resolveImmutableToolSourceBinding,
  safeEvidenceCliFailureMessage,
  validateQualityReview,
} from '../../scripts/content-ten-script-evidence.mjs';
import { computeEconomics } from '../../scripts/economics-simulation.mjs';

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function contentJobFixtureKey(secret: string, info: string): Buffer {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from('nexushub-content-script-jobs-v2', 'utf8'),
    Buffer.from(info, 'utf8'),
    32,
  ));
}

function encryptContentJobFixture(value: unknown, secret: string, userId: number): string {
  const schema = 'nexus.content-script-job-encrypted.v3';
  const keyVersion = crypto.createHash('sha256')
    .update(contentJobFixtureKey(secret, 'key-version')).digest('hex').slice(0, 16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    contentJobFixtureKey(secret, `user:${userId}`),
    iv,
    { authTagLength: 16 },
  );
  cipher.setAAD(Buffer.from(`${schema}\u0000${keyVersion}`, 'utf8'));
  const ciphertext = Buffer.concat([
    iv,
    cipher.update(JSON.stringify(value), 'utf8'),
    cipher.final(),
  ]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext.subarray(iv.length)]);
  return JSON.stringify({ schema, keyVersion, ciphertext: packed.toString('hex') });
}

function acceptanceRequestHash(scenario: typeof TEN_SCRIPT_ACCEPTANCE_SCENARIOS[number]): string {
  return crypto.createHash('sha256').update(stableJson({
    topic: scenario.topic,
    niche: 'general education',
    format: 'YouTube',
    mode: 'deep',
    deliveryMode: scenario.deliveryMode,
    renderMode: 'structured',
    scriptStyle: 'detailed',
    maxDurationMinutes: 15,
    targetDurationSeconds: 900,
    forceRefresh: true,
    languageIntent: { source: 'explicit', value: scenario.language },
    pinnedSources: [],
  })).digest('hex');
}

function fixtureJobId(index: number): string {
  return `script_job_00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}

function completedReleaseView(input: {
  sourceSha: string;
  releaseId: string;
  payloadDigest: string;
  completedAt: string;
  capturedAt: string;
  backendDigest?: string;
}) {
  const backendDigest = input.backendDigest ?? `sha256:${'8'.repeat(64)}`;
  return {
    schema: 'nexus.release-state-view.v2',
    capturedAt: input.capturedAt,
    blocked: null,
    active: {
      releaseId: input.releaseId,
      sourceSha: input.sourceSha,
      status: 'completed',
      releasePayloadDigest: input.payloadDigest,
      images: { backend: { digest: backendDigest } },
    },
    effective: {
      source: 'receipt',
      status: 'completed',
      releaseId: input.releaseId,
      provable: true,
      stateStatus: 'completed',
      staleProjection: false,
      releasePayloadDigest: input.payloadDigest,
    },
    activeReceipt: {
      schema: 'nexus.release-receipt.v3',
      releaseId: input.releaseId,
      sourceSha: input.sourceSha,
      outcome: 'completed',
      completedAt: input.completedAt,
      releasePayloadDigest: input.payloadDigest,
    },
  };
}

function pendingAcceptanceState() {
  return {
    schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
    acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
    createdAt: '2026-08-22T22:00:00Z',
    scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((scenario) => ({
      id: scenario.id,
      phase: scenario.phase,
      deliveryMode: scenario.deliveryMode,
      language: scenario.language,
      topicSha256: `sha256:${crypto.createHash('sha256').update(scenario.topic).digest('hex')}`,
      status: 'pending',
      jobId: null,
      output: null,
    })),
  };
}

function predecessorRecoveryState() {
  const state: any = pendingAcceptanceState();
  state.schemaVersion = LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA;
  state.scenarios.forEach((row, index) => {
    if (row.phase !== 'pre-release') return;
    row.jobId = fixtureJobId(index + 1);
    row.submittedAt = '2026-08-23T00:00:00Z';
    row.updatedAt = '2026-08-24T00:00:00Z';
    row.progress = index < 7 ? 100 : 0;
    row.stage = index < 7 ? 'completed' : 'failed';
    if (index < 7) {
      row.status = 'completed';
      row.output = {
        scriptSha256: `sha256:${String(index + 1).padStart(64, '0')}`,
        wordCount: 2_100,
        warnings: [],
        route: 'cloud',
        modelDigest: null,
        sourceConsistent: true,
        contractPass: true,
      };
    } else {
      row.status = 'failed';
      row.output = null;
      row.errorCode = 'OPENAI_BATCH_FAILED';
    }
  });
  return state;
}

describe('content acceptance evidence CLI error privacy', () => {
  it('preserves controlled refusals and redacts unexpected exception details', () => {
    const controlled = Object.assign(new Error('controlled evidence refusal'), { exitCode: 78 });
    expect(safeEvidenceCliFailureMessage(controlled)).toBe('controlled evidence refusal');
    expect(safeEvidenceCliFailureMessage(new Error('PRIVATE-EVIDENCE-PATH-MARKER'))).toBe('Error');
    expect(safeEvidenceCliFailureMessage('PRIVATE-EVIDENCE-STRING-MARKER')).toBe('string');
  });
});

describe('ten-script hybrid-plan acceptance inventory', () => {
  it('pins the global 4/3/3 delivery and 5/5 language budget with one production smoke', () => {
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS).toHaveLength(10);
    expect(new Set(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((row) => row.id)).size).toBe(10);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'standard')).toHaveLength(4);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'scheduled')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.deliveryMode === 'priority')).toHaveLength(3);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'en')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.language === 'pt-BR')).toHaveLength(5);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'pre-release')).toHaveLength(9);
    expect(TEN_SCRIPT_ACCEPTANCE_SCENARIOS.filter((row) => row.phase === 'production-smoke')).toHaveLength(1);
  });

  it('keeps every case on the complete fifteen-minute structured contract', () => {
    for (const row of TEN_SCRIPT_ACCEPTANCE_SCENARIOS) {
      expect(row.topic.length).toBeGreaterThan(40);
      expect(row.topic).not.toMatch(/https?:\/\//u);
      expect(['en', 'pt-BR']).toContain(row.language);
    }
  });

  it('creates and re-reads an immutable private state file without submitting work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-'));
    const state = join(directory, 'state.json');
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const output = execFileSync(process.execPath, [
          'scripts/content-ten-script-acceptance.mjs',
          '--phase', 'status', '--state', state,
        ], { encoding: 'utf8' });
        expect(JSON.parse(output)).toMatchObject({
          schemaVersion: TEN_SCRIPT_ACCEPTANCE_SCHEMA,
          acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
          inventoryCount: 10,
          submitted: 0,
          acceptancePass: false,
        });
      }
      expect(statSync(state).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(state, 'utf8')).scenarios).toHaveLength(10);
      chmodSync(state, 0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates a digest-bound successor carrying seven passes and resetting only two failures', () => {
    const predecessorBytes = Buffer.from(`${JSON.stringify(predecessorRecoveryState())}\n`);
    const successor: any = createSuccessorAcceptanceState(
      predecessorBytes,
      '2026-08-29T00:00:00Z',
    );
    expect(successor).toMatchObject({
      schemaVersion: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA,
      acceptanceRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
    });
    expect(successor.predecessor.stateSha256)
      .toBe(`sha256:${crypto.createHash('sha256').update(predecessorBytes).digest('hex')}`);
    expect(successor.scenarios.filter((row) => row.carriedForward)).toHaveLength(7);
    expect(successor.scenarios.filter((row) => row.phase === 'pre-release'
      && !row.carriedForward)).toHaveLength(2);
    expect(successor.scenarios.filter((row) => !row.carriedForward)
      .every((row) => row.status === 'pending' && row.jobId === null)).toBe(true);
    expect(validateSuccessorAcceptancePredecessor(successor, predecessorBytes)).toBe(successor);

    successor.scenarios.find((row) => row.carriedForward).progress = 99;
    expect(() => validateSuccessorAcceptancePredecessor(successor, predecessorBytes))
      .toThrow(/completed state|carried scenario/);
  });

  it('initializes a private successor state without mutating its predecessor file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-successor-'));
    const predecessorPath = join(directory, 'predecessor.json');
    const successorPath = join(directory, 'successor.json');
    const predecessorBytes = Buffer.from(`${JSON.stringify(predecessorRecoveryState())}\n`);
    try {
      writeFileSync(predecessorPath, predecessorBytes, { mode: 0o600 });
      const output = execFileSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status',
        '--state', successorPath,
        '--initialize-successor-from', predecessorPath,
      ], { encoding: 'utf8' });
      expect(JSON.parse(output)).toMatchObject({
        schemaVersion: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_SCHEMA,
        acceptanceRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
        inventoryCount: 10,
        completed: 7,
        terminalFailures: 0,
      });
      expect(readFileSync(predecessorPath)).toEqual(predecessorBytes);
      expect(statSync(successorPath).mode & 0o777).toBe(0o600);

      const missingPredecessor = spawnSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status',
        '--state', successorPath,
      ], { encoding: 'utf8' });
      expect(missingPredecessor.status).not.toBe(0);
      expect(missingPredecessor.stderr)
        .toContain('successor acceptance requires exactly one predecessor-state source');

      const resumed = execFileSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status',
        '--state', successorPath,
        '--predecessor-state', predecessorPath,
      ], { encoding: 'utf8' });
      expect(JSON.parse(resumed)).toMatchObject({
        acceptanceRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
        completed: 7,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses a state inode that changed before the locked read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-identity-'));
    const state = join(directory, 'state.json');
    const replacement = join(directory, 'replacement.json');
    try {
      execFileSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status', '--state', state,
      ], { encoding: 'utf8' });
      const identity = statSync(state, { bigint: true });
      const stateSha256 = crypto.createHash('sha256').update(readFileSync(state)).digest('hex');
      writeFileSync(replacement, readFileSync(state), { mode: 0o600 });
      renameSync(replacement, state);
      const result = spawnSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status', '--state', state,
        '--state-expected-dev', identity.dev.toString(),
        '--state-expected-ino', identity.ino.toString(),
        '--state-expected-sha256', stateSha256,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(75);
      expect(result.stderr).toMatch(/identity changed before the locked read/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses in-place state changes that preserve device and inode', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-bytes-'));
    const state = join(directory, 'state.json');
    try {
      execFileSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status', '--state', state,
      ], { encoding: 'utf8' });
      const originalBytes = readFileSync(state);
      const identity = statSync(state, { bigint: true });
      const stateSha256 = crypto.createHash('sha256').update(originalBytes).digest('hex');
      writeFileSync(state, Buffer.from(originalBytes).fill(0x20));
      const changedIdentity = statSync(state, { bigint: true });
      expect(changedIdentity.dev).toBe(identity.dev);
      expect(changedIdentity.ino).toBe(identity.ino);

      const result = spawnSync(process.execPath, [
        'scripts/content-ten-script-acceptance.mjs',
        '--phase', 'status', '--state', state,
        '--state-expected-dev', identity.dev.toString(),
        '--state-expected-ino', identity.ino.toString(),
        '--state-expected-sha256', stateSha256,
      ], { encoding: 'utf8' });
      expect(result.status).toBe(75);
      expect(result.stderr).toMatch(/bytes changed before the locked read/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resumes the same acceptance identity after an authenticated durable-job retry', () => {
    const row = {
      id: 'std-en-01',
      jobId: 'script_job_retry',
      status: 'failed',
      stage: 'failed',
      errorCode: 'Error',
      lastPollError: '/api/v1/content/script-jobs returned CONTENT_SCRIPT_JOBS_DISABLED',
      lastPollErrorAt: '2026-08-24T05:19:00.000Z',
      output: null,
    };

    updateAcceptanceScenarioFromView(row, {
      status: 'running',
      stage: 'outline',
      progress: 7,
      updatedAt: '2026-08-24T06:00:00.000Z',
      warnings: [],
      route: null,
      modelDigest: null,
    });

    expect(row).toMatchObject({
      jobId: 'script_job_retry',
      status: 'running',
      stage: 'outline',
      progress: 7,
      output: null,
    });
    expect(row).not.toHaveProperty('errorCode');
    expect(row).not.toHaveProperty('lastPollError');
    expect(row).not.toHaveProperty('lastPollErrorAt');
  });

  it('binds the production smoke source once and rejects mismatched polls', () => {
    const state: any = pendingAcceptanceState();
    const sourceSha = 'a'.repeat(40);
    const payloadDigest = `sha256:${'d'.repeat(64)}`;
    const releaseView = completedReleaseView({
      sourceSha,
      releaseId: 'b'.repeat(32),
      payloadDigest,
      completedAt: '2026-08-22T22:30:00Z',
      capturedAt: '2026-08-22T22:45:00Z',
    });
    const releaseViewBytes = Buffer.from(`${JSON.stringify(releaseView)}\n`);
    const binding = {
      releaseView,
      releaseViewBytes,
      boundAt: '2026-08-22T23:00:00Z',
    };
    expect(bindProductionSmokeSource(state, sourceSha, binding)).toBe(true);
    expect(state.productionSmokeSource).toMatchObject({
      schemaVersion: TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA,
      sourceSha,
    });
    expect(bindProductionSmokeSource(state, sourceSha, binding)).toBe(false);
    expect(() => bindProductionSmokeSource(state, 'b'.repeat(40), binding))
      .toThrow(/expected source/);

    const corrupt: any = pendingAcceptanceState();
    const smoke = corrupt.scenarios.find((row) => row.phase === 'production-smoke');
    smoke.jobId = fixtureJobId(99);
    smoke.status = 'queued';
    smoke.submittedAt = '2026-08-22T23:01:00Z';
    expect(() => bindProductionSmokeSource(corrupt, sourceSha, binding))
      .toThrow(/exists without/);
  });

  it('requires active and receipt source identity plus matching effective receipt identity', () => {
    const sourceSha = 'a'.repeat(40);
    const releaseView = completedReleaseView({
      sourceSha,
      releaseId: 'b'.repeat(32),
      payloadDigest: `sha256:${'d'.repeat(64)}`,
      completedAt: '2026-08-22T22:30:00Z',
      capturedAt: '2026-08-22T22:45:00Z',
    });
    expect(validateCompletedReleaseView(releaseView, sourceSha).sourceSha).toBe(sourceSha);
    releaseView.effective.releaseId = 'c'.repeat(32);
    expect(() => validateCompletedReleaseView(releaseView, sourceSha)).toThrow(/expected source/);
  });

  it('requires the workload snapshot to match the current authoritative receipt identity', () => {
    const sourceSha = 'a'.repeat(40);
    const candidate = completedReleaseView({
      sourceSha,
      releaseId: 'b'.repeat(32),
      payloadDigest: `sha256:${'d'.repeat(64)}`,
      completedAt: '2026-08-22T22:30:00Z',
      capturedAt: '2026-08-22T22:45:00Z',
    });
    const authoritative = structuredClone(candidate);
    authoritative.capturedAt = '2026-08-22T22:46:00Z';
    expect(validateAuthoritativeWorkloadReleaseView(
      Buffer.from(JSON.stringify(candidate)),
      authoritative,
      sourceSha,
    ).release.releaseId).toBe('b'.repeat(32));

    authoritative.active.releaseId = 'c'.repeat(32);
    authoritative.effective.releaseId = 'c'.repeat(32);
    authoritative.activeReceipt.releaseId = 'c'.repeat(32);
    expect(() => validateAuthoritativeWorkloadReleaseView(
      Buffer.from(JSON.stringify(candidate)),
      authoritative,
      sourceSha,
    )).toThrow(/current authoritative receipt/);
  });

  it('migrates the exact pre-smoke v2 inventory but rejects a bare legacy source assertion', () => {
    const legacy: any = pendingAcceptanceState();
    legacy.schemaVersion = LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA;
    const migrated = migrateLegacyAcceptanceState(legacy);
    expect(migrated.schemaVersion).toBe(TEN_SCRIPT_ACCEPTANCE_SCHEMA);
    expect(migrated.scenarios).toHaveLength(10);
    expect(migrated.scenarios).not.toBe(legacy.scenarios);

    legacy.productionSmokeSourceSha = 'a'.repeat(40);
    expect(() => migrateLegacyAcceptanceState(legacy)).toThrow(/unprovable smoke source/);

    delete legacy.productionSmokeSourceSha;
    const smoke = legacy.scenarios.find((row: any) => row.phase === 'production-smoke');
    smoke.jobId = fixtureJobId(99);
    smoke.status = 'queued';
    smoke.submittedAt = '2026-08-22T23:01:00Z';
    expect(() => migrateLegacyAcceptanceState(legacy)).toThrow(/after smoke submission/);

    const markerOnly: any = pendingAcceptanceState();
    markerOnly.schemaVersion = LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA;
    const markerSmoke = markerOnly.scenarios.find((row: any) => row.phase === 'production-smoke');
    markerSmoke.submittedAt = '2026-08-22T23:15:00Z';
    expect(() => migrateLegacyAcceptanceState(markerOnly)).toThrow(/fields do not match/);
  });

  it('rejects mutable scenario identity and forged completed output before the smoke lock', () => {
    const wrongPhase: any = pendingAcceptanceState();
    wrongPhase.scenarios[0].phase = 'production-smoke';
    expect(() => validateAcceptanceStateShape(wrongPhase)).toThrow(/scenario std-en-01/);

    const wrongDelivery: any = pendingAcceptanceState();
    wrongDelivery.scenarios[0].deliveryMode = 'priority';
    expect(() => validateAcceptanceStateShape(wrongDelivery)).toThrow(/scenario std-en-01/);

    const wrongLanguage: any = pendingAcceptanceState();
    wrongLanguage.scenarios[0].language = 'pt-BR';
    expect(() => validateAcceptanceStateShape(wrongLanguage)).toThrow(/scenario std-en-01/);

    const unsafeRow: any = pendingAcceptanceState();
    unsafeRow.scenarios[0].privateResult = 'must-not-be-admitted';
    expect(() => validateAcceptanceStateShape(unsafeRow)).toThrow(/scenario std-en-01/);

    const forged: any = pendingAcceptanceState();
    forged.scenarios[0] = {
      ...forged.scenarios[0],
      jobId: fixtureJobId(0),
      status: 'completed',
      submittedAt: '2026-08-22T23:00:00Z',
      output: {
        scriptSha256: `sha256:${'a'.repeat(64)}`,
        wordCount: 10,
        warnings: [],
        route: 'cloud',
        modelDigest: null,
        sourceConsistent: true,
        contractPass: true,
      },
    };
    expect(() => validateAcceptanceStateShape(forged)).toThrow(/derived verdict/);
  });

  it('binds successor evidence to its predecessor, distinct release SHAs, and attributed usage', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-ten-script-evidence-'));
    const statePath = join(directory, 'state.json');
    const predecessorPath = join(directory, 'predecessor.json');
    const databasePath = join(directory, 'acceptance.db');
    const qualityReviewPath = join(directory, 'quality-review.json');
    const workloadReleaseViewPath = join(directory, 'workload-release-view.json');
    const releaseViewPath = join(directory, 'release-view.json');
    const scriptJobKeyPath = join(directory, 'script-job-keys.json');
    const outputPath = join(directory, 'evidence.json');
    const workloadSourceSha = 'a'.repeat(40);
    const producerSourceRepository = join(directory, 'producer-source');
    mkdirSync(producerSourceRepository, { recursive: true, mode: 0o700 });
    const sourceRoot = execFileSync('/usr/bin/git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
    }).trim();
    for (const modulePath of CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES) {
      const destination = join(producerSourceRepository, modulePath);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(join(sourceRoot, modulePath)));
    }
    execFileSync('/usr/bin/git', ['init', '--quiet'], { cwd: producerSourceRepository });
    execFileSync('/usr/bin/git', ['config', 'user.name', 'Nexus Test'], { cwd: producerSourceRepository });
    execFileSync('/usr/bin/git', ['config', 'user.email', 'nexus-test@example.invalid'], {
      cwd: producerSourceRepository,
    });
    execFileSync('/usr/bin/git', ['config', 'core.autocrlf', 'false'], {
      cwd: producerSourceRepository,
    });
    execFileSync('/usr/bin/git', ['config', 'core.attributesFile', '/dev/null'], {
      cwd: producerSourceRepository,
    });
    execFileSync('/usr/bin/git', ['config', 'core.hooksPath', '/dev/null'], {
      cwd: producerSourceRepository,
    });
    execFileSync('/usr/bin/git', ['add', '--', ...CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES], {
      cwd: producerSourceRepository,
    });
    execFileSync('/usr/bin/git', [
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture producer source',
    ], {
      cwd: producerSourceRepository,
    });
    const producerSourceSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      cwd: producerSourceRepository,
      encoding: 'utf8',
    }).trim();
    const scriptJobSecret = 'fixture-content-script-job-evidence-key-2026';
    const digest = (value: string | Buffer) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
    const scriptBodies = TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((_, index) => (
      Array.from({ length: 2_100 }, (_unused, word) => `script${index}word${word}`).join(' ')
    ));
    const workloadReleaseView = completedReleaseView({
      sourceSha: workloadSourceSha,
      releaseId: '9'.repeat(32),
      payloadDigest: digest('workload-release-payload'),
      completedAt: '2026-08-22T23:30:00Z',
      capturedAt: '2026-08-22T23:45:00Z',
    });
    const workloadReleaseViewBytes = Buffer.from(`${JSON.stringify(workloadReleaseView)}\n`);
    const predecessor = {
      schemaVersion: LEGACY_TEN_SCRIPT_ACCEPTANCE_SCHEMA,
      acceptanceRevision: TEN_SCRIPT_ACCEPTANCE_REVISION,
      createdAt: '2026-08-22T22:00:00Z',
      scenarios: TEN_SCRIPT_ACCEPTANCE_SCENARIOS.map((scenario, index) => ({
        id: scenario.id,
        phase: scenario.phase,
        deliveryMode: scenario.deliveryMode,
        language: scenario.language,
        topicSha256: digest(scenario.topic),
        status: scenario.phase === 'pre-release' && index < 7 ? 'completed'
          : scenario.phase === 'pre-release' ? 'failed' : 'pending',
        jobId: scenario.phase === 'pre-release' ? fixtureJobId(index) : null,
        ...(scenario.phase === 'pre-release' ? {
          submittedAt: '2026-08-22T22:10:00Z',
          stage: index < 7 ? 'completed' : 'failed',
          progress: index < 7 ? 100 : 0,
          updatedAt: '2026-08-22T23:00:00Z',
        } : {}),
        ...(scenario.phase === 'pre-release' && index >= 7
          ? { errorCode: 'OPENAI_BATCH_FAILED' } : {}),
        output: scenario.phase === 'pre-release' && index < 7 ? {
          scriptSha256: digest(scriptBodies[index]),
          wordCount: 2_100,
          warnings: [],
          route: 'cloud',
          modelDigest: null,
          sourceConsistent: true,
          contractPass: true,
        } : null,
      })),
    };
    const predecessorBytes = Buffer.from(`${JSON.stringify(predecessor)}\n`);
    const state: any = createSuccessorAcceptanceState(
      predecessorBytes,
      '2026-08-22T23:55:00Z',
    );
    state.productionSmokeSource = {
      schemaVersion: TEN_SCRIPT_WORKLOAD_SOURCE_SCHEMA,
      sourceSha: workloadSourceSha,
      boundAt: '2026-08-22T23:56:00Z',
      releaseViewSha256: digest(workloadReleaseViewBytes),
      releaseId: workloadReleaseView.activeReceipt.releaseId,
      releasePayloadDigest: workloadReleaseView.activeReceipt.releasePayloadDigest,
      receiptCompletedAt: workloadReleaseView.activeReceipt.completedAt,
      viewCapturedAt: workloadReleaseView.capturedAt,
    };
    state.scenarios.forEach((scenario, index) => {
      if (scenario.carriedForward) return;
      scenario.status = 'completed';
      scenario.jobId = fixtureJobId(index + 20);
      scenario.submittedAt = '2026-08-22T23:59:00Z';
      scenario.stage = 'completed';
      scenario.progress = 100;
      scenario.updatedAt = '2026-08-23T00:01:00Z';
      scenario.output = {
        scriptSha256: digest(scriptBodies[index]),
        wordCount: 2_100,
        warnings: [],
        route: 'cloud',
        modelDigest: null,
        sourceConsistent: true,
        contractPass: true,
      };
    });
    validateSuccessorAcceptancePredecessor(state, predecessorBytes);
    writeFileSync(predecessorPath, predecessorBytes, { mode: 0o600 });
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    writeFileSync(workloadReleaseViewPath, workloadReleaseViewBytes, { mode: 0o600 });
    writeFileSync(scriptJobKeyPath, `${JSON.stringify({
      schemaVersion: CONTENT_SCRIPT_JOB_EVIDENCE_KEYS_SCHEMA,
      keys: [scriptJobSecret],
    })}\n`, { mode: 0o600 });
    const db = new Database(databasePath);
    try {
      db.exec(`CREATE TABLE content_script_jobs (
        job_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
        tenant_id INTEGER NOT NULL, owner_user_id INTEGER NOT NULL, status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
        request_json TEXT NOT NULL, target_duration_seconds INTEGER NOT NULL,
        result_json TEXT NOT NULL,
        delivery_mode TEXT NOT NULL, warning_codes_json TEXT NOT NULL, route TEXT,
        model_digest TEXT, created_at TEXT NOT NULL, completed_at TEXT NOT NULL,
        created_release_id TEXT, created_release_source_sha TEXT,
        created_release_backend_digest TEXT, completed_release_id TEXT,
        completed_release_source_sha TEXT, completed_release_backend_digest TEXT
      );
      CREATE TABLE api_usage (
        id INTEGER PRIMARY KEY, run_id TEXT, tenant_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL, provider_tool_cost_usd REAL NOT NULL,
        request_source TEXT NOT NULL, job_name TEXT, category TEXT, base_category TEXT,
        ts TEXT NOT NULL, provider TEXT NOT NULL DEFAULT 'openai',
        model TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
        pricing_status TEXT NOT NULL DEFAULT 'resolved'
      );
      CREATE TABLE skill_inference_runs (
        run_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
        tenant_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        status TEXT NOT NULL, evaluation_mode TEXT NOT NULL, final_route TEXT,
        provider TEXT, model_id TEXT, validation_status TEXT, created_at TEXT NOT NULL
      );`);
      const insertJob = db.prepare(`INSERT INTO content_script_jobs (
        job_id, operation_id, tenant_id, owner_user_id, status, idempotency_key,
        request_hash, request_json, target_duration_seconds, result_json,
        delivery_mode, warning_codes_json, route, model_digest, created_at, completed_at,
        created_release_id, created_release_source_sha, created_release_backend_digest,
        completed_release_id, completed_release_source_sha, completed_release_backend_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertInference = db.prepare(`INSERT INTO skill_inference_runs VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertUsage = db.prepare(`INSERT INTO api_usage (
        run_id, tenant_id, user_id, input_tokens, output_tokens, cost_usd,
        provider_tool_cost_usd, request_source, job_name, base_category, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      state.scenarios.forEach((scenario, index) => {
        const immutableScenario = TEN_SCRIPT_ACCEPTANCE_SCENARIOS[index];
        const operationId = `content-script:${scenario.jobId}`;
        const runId = `run-${index}`;
        const expectedTier = immutableScenario.deliveryMode === 'standard'
          ? 'flex' : immutableScenario.deliveryMode === 'scheduled' ? 'batch' : 'default';
        const request = {
          topic: immutableScenario.topic,
          niche: 'general education',
          format: 'YouTube',
          mode: 'deep',
          deliveryMode: immutableScenario.deliveryMode,
          language: immutableScenario.language,
          renderMode: 'structured',
          scriptStyle: 'detailed',
          maxDurationMinutes: 15,
          targetDurationSeconds: 900,
          forceRefresh: true,
          pinnedScriptRoute: 'cloud_primary',
          pinnedCloudProvider: 'openai',
          pinnedCloudModel: 'gpt-5.6-luna',
          pinnedCloudServiceTier: expectedTier,
          pinnedCreatorVoice: null,
          pinnedSources: [],
        };
        const runtimeRelease = scenario.phase === 'production-smoke'
          ? [
            workloadReleaseView.active.releaseId,
            workloadSourceSha,
            workloadReleaseView.active.images.backend.digest,
            workloadReleaseView.active.releaseId,
            workloadSourceSha,
            workloadReleaseView.active.images.backend.digest,
          ]
          : [null, null, null, null, null, null];
        insertJob.run(
          scenario.jobId, operationId, 42, 42, 'completed',
          `hybrid-plan-acceptance-${immutableScenario.id}-${scenario.requestRevision}`,
          acceptanceRequestHash(immutableScenario),
          encryptContentJobFixture(request, scriptJobSecret, 42),
          900,
          encryptContentJobFixture({ script: scriptBodies[index] }, scriptJobSecret, 42),
          scenario.deliveryMode, '[]', 'cloud', null,
          '2026-08-23T00:00:00Z', '2026-08-23T00:01:00Z',
          ...runtimeRelease,
        );
        insertInference.run(
          runId, operationId, 42, 42, 'completed', 'production', 'cloud',
          'openai', 'gpt-5.6-luna', 'valid', `2026-08-23T00:00:${String(index).padStart(2, '0')}Z`,
        );
        insertUsage.run(
          runId, 42, 42, 1_000 + index, 4_000 + index, 0.01, 0,
          'automation', 'content_script_job_stage', 'content_script_job_script_section',
          '2026-08-23T00:00:30Z',
        );
      });
      insertInference.run(
        'failed-retry-op-0', `content-script:${state.scenarios[0].jobId}`,
        42, 42, 'failed', 'production', 'cloud',
        'openai', 'gpt-5.6-luna', 'invalid', '2026-08-22T23:59:59Z',
      );
      // Failed paid attempts do not poison the accepted result, but their real
      // spend belongs to the same user-visible script operation.
      insertUsage.run(
        'failed-retry-op-0', 42, 42, 500, 100, 0.005, 0.001,
        'automation', 'content_script_job_stage', 'content_script_job_script_section',
        '2026-08-22T23:59:59Z',
      );
      db.prepare(`UPDATE api_usage SET provider = 'other-provider', model = 'historical-model'
        WHERE run_id = 'failed-retry-op-0'`).run();
      // Operation IDs are not globally unique in the schema. Evidence must
      // not attribute another tenant's usage to the accepted job.
      insertInference.run(
        'run-cross-tenant', `content-script:${state.scenarios[0].jobId}`,
        84, 84, 'completed', 'production', 'cloud',
        'openai', 'gpt-5.6-luna', 'valid', '2026-08-23T00:00:00Z',
      );
      insertUsage.run(
        'run-cross-tenant', 84, 84, 9_000_000, 9_000_000, 999, 999,
        'automation', 'content_script_job_stage', 'content_script_job_script_section',
        '2026-08-23T00:00:30Z',
      );
      // Scoped production interaction samples drive economics p95. Shadow and
      // foreign-scope rows use otherwise qualifying categories but are excluded.
      insertUsage.run(
        'standard-op-1', 42, 42, 2_000, 600, 0.00044, 0.0002,
        'interactive', 'ios_chat', 'ios_chat_message', '2026-08-22T00:00:00Z',
      );
      insertInference.run(
        'standard-op-1', 'standard-operation-1', 42, 42, 'completed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T00:00:00Z',
      );
      insertUsage.run(
        'standard-op-repair', 42, 42, 500, 100, 0.00015, 0.00005,
        'interactive', 'ios_chat', 'ios_chat_message', '2026-08-22T00:00:01Z',
      );
      insertInference.run(
        'standard-op-repair', 'standard-operation-1', 42, 42, 'failed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'invalid', '2026-08-22T00:00:01Z',
      );
      // A production Standard operation whose paid provider attempt never
      // completes must increase the completed-operation p95 rather than vanish
      // behind a completed-attempt EXISTS filter.
      insertUsage.run(
        'standard-failed-only-high-cost', 42, 42, 50_000, 0, 5, 0.5,
        'interactive', 'ios_chat', 'ios_chat_message', '2026-08-22T00:00:02Z',
      );
      insertInference.run(
        'standard-failed-only-high-cost', 'standard-failed-only-operation',
        42, 42, 'failed', 'production', 'cloud', 'openai', 'gpt-5.6-luna',
        'invalid', '2026-08-22T00:00:02Z',
      );
      insertUsage.run(
        'deep-op-1', 42, 42, 6_000, 2_500, 0.004, 0.0003,
        'interactive', 'content_script_generate', 'content_engine_script_deep',
        '2026-08-22T01:00:00Z',
      );
      insertInference.run(
        'deep-op-1', 'deep-operation-1', 42, 42, 'completed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T01:00:00Z',
      );
      insertUsage.run(
        'foreign-standard-op', 84, 84, 9_000_000, 9_000_000, 999, 999,
        'interactive', 'ios_chat', 'ios_chat_message', '2026-08-22T00:00:00Z',
      );
      insertInference.run(
        'foreign-standard-op', 'foreign-operation', 84, 84, 'completed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T00:00:00Z',
      );
      insertUsage.run(
        'shadow-standard-op', 42, 42, 9_000_000, 9_000_000, 999, 999,
        'interactive', 'local_primary_shadow', 'ios_chat_message', '2026-08-22T00:00:00Z',
      );
      insertInference.run(
        'shadow-standard-op', 'shadow-operation', 42, 42, 'completed', 'shadow',
        'local', 'ollama', 'qwen3:4b-instruct-2507-q4_K_M', 'valid', '2026-08-22T00:00:00Z',
      );
      insertUsage.run(
        'live-eval-standard-op', 42, 42, 9_000_000, 9_000_000, 999, 999,
        'interactive', 'chat_live_eval:baseline', 'ios_chat_message', '2026-08-22T00:00:00Z',
      );
      insertInference.run(
        'live-eval-standard-op', 'live-eval-operation', 42, 42, 'completed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T00:00:00Z',
      );
      insertUsage.run(
        'live-eval-deep-op', 42, 42, 9_000_000, 9_000_000, 999, 999,
        'interactive', 'content_live_eval:baseline', 'content_engine_script_deep',
        '2026-08-22T00:00:00Z',
      );
      insertInference.run(
        'live-eval-deep-op', 'live-eval-deep-operation', 42, 42, 'completed', 'production',
        'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T00:00:00Z',
      );
      // Legacy rows can carry the governed identity only in category.
      db.prepare(`UPDATE api_usage
        SET category = base_category, base_category = NULL
        WHERE run_id = 'standard-op-1'`).run();
    } finally {
      db.close();
    }
    chmodSync(databasePath, 0o600);
    const stateSha256 = digest(readFileSync(statePath));
    const qualityReview = {
      schemaVersion: CONTENT_TEN_SCRIPT_QUALITY_REVIEW_SCHEMA,
      acceptanceRevision: state.acceptanceRevision,
      reviewedAt: '2026-08-23T01:00:00Z',
      workloadSourceSha,
      stateSha256,
      reviewType: 'independent',
      attestation: 'no_critical_quality_regression',
      scenarios: state.scenarios.map((scenario) => ({
        id: scenario.id,
        scriptSha256: scenario.output.scriptSha256,
        verdict: 'pass',
        criticalRegressionCount: 0,
      })),
    };
    writeFileSync(qualityReviewPath, `${JSON.stringify(qualityReview)}\n`, { mode: 0o600 });
    const releasePayloadDigest = digest('release-payload');
    const releaseId = 'b'.repeat(32);
    const releaseView = {
      schema: 'nexus.release-state-view.v2',
      capturedAt: '2026-08-23T02:00:00Z',
      blocked: null,
      active: {
        releaseId,
        sourceSha: producerSourceSha,
        status: 'completed',
        releasePayloadDigest,
      },
      effective: {
        source: 'receipt',
        status: 'completed',
        releaseId,
        provable: true,
        stateStatus: 'completed',
        staleProjection: false,
        releasePayloadDigest,
      },
      activeReceipt: {
        schema: 'nexus.release-receipt.v3',
        releaseId,
        sourceSha: producerSourceSha,
        outcome: 'completed',
        completedAt: '2026-08-23T00:30:00Z',
        releasePayloadDigest,
      },
    };
    writeFileSync(releaseViewPath, `${JSON.stringify(releaseView)}\n`, { mode: 0o600 });
    try {
      const stdout = execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', outputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' });
      expect(JSON.parse(stdout)).toMatchObject({ acceptancePass: true });
      expect(statSync(outputPath).mode & 0o777).toBe(0o600);
      const evidence = JSON.parse(readFileSync(outputPath, 'utf8'));
      expect(evidence).toMatchObject({
        schemaVersion: CONTENT_TEN_SCRIPT_EVIDENCE_SCHEMA,
        workloadSourceSha,
        producerSourceSha,
        sourceBindingSha256: acceptanceSourceBindingSha256(
          workloadSourceSha,
          producerSourceSha,
          evidence.producerToolSource.bindingSha256,
        ),
        producerToolSource: {
          producerSourceSha,
          entrypoint: 'scripts/content-ten-script-evidence.mjs',
          bindingSha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        },
        acceptanceRevision: TEN_SCRIPT_SUCCESSOR_ACCEPTANCE_REVISION,
        acceptancePass: true,
        stateSha256,
        workloadRelease: {
          sourceSha: workloadSourceSha,
          releaseId: workloadReleaseView.activeReceipt.releaseId,
          viewSha256: digest(workloadReleaseViewBytes),
        },
        productionSmokeRuntimeRelease: {
          schemaVersion: CONTENT_SCRIPT_RUNTIME_RELEASE_SCHEMA,
          jobId: state.scenarios[9].jobId,
          creation: {
            releaseId: workloadReleaseView.active.releaseId,
            sourceSha: workloadSourceSha,
            backendImageDigest: workloadReleaseView.active.images.backend.digest,
          },
          completion: {
            releaseId: workloadReleaseView.active.releaseId,
            sourceSha: workloadSourceSha,
            backendImageDigest: workloadReleaseView.active.images.backend.digest,
          },
        },
        qualityReview: {
          reviewType: 'independent',
          attestation: 'no_critical_quality_regression',
        },
        release: {
          releaseId,
          sourceSha: producerSourceSha,
          receiptOutcome: 'completed',
          releasePayloadDigest,
        },
        inventory: { count: 10, preRelease: 9, productionSmoke: 1 },
        p95ByDeliveryMode: {
          standard: { sampleCount: 4 },
          scheduled: { sampleCount: 3 },
          priority: { sampleCount: 3 },
        },
        operationUsage: {
          schemaVersion: OPERATION_USAGE_EVIDENCE_SCHEMA,
          classes: {
            standardOp: {
              sampleCount: 1,
              failedOnlyOperationCount: 1,
              failedOnlyInputTokensAllocated: 50_000,
              failedOnlyOutputTokensAllocated: 0,
              failedOnlyModelCostUsdAllocated: 4.5,
              failedOnlyToolCostUsdAllocated: 0.5,
              inputTokens: 52_500, outputTokens: 700,
              modelCostUsd: 4.50034, toolCostUsd: 0.50025,
            },
            deepOp: {
              sampleCount: 1,
              failedOnlyOperationCount: 0,
              failedOnlyInputTokensAllocated: 0,
              failedOnlyOutputTokensAllocated: 0,
              failedOnlyModelCostUsdAllocated: 0,
              failedOnlyToolCostUsdAllocated: 0,
              inputTokens: 6_000,
              outputTokens: 2_500,
            },
          },
        },
      });
      expect(evidence.scripts[0]).toMatchObject({
        inputTokens: 1_500,
        outputTokens: 4_100,
        modelCostUsd: 0.014,
        toolCostUsd: 0.001,
        provider: 'openai',
        model: 'gpt-5.6-luna',
      });
      const missingPredecessorOutput = join(directory, 'missing-predecessor-evidence.json');
      const missingPredecessor = spawnSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', missingPredecessorOutput,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' });
      expect(missingPredecessor.status).not.toBe(0);
      expect(missingPredecessor.stderr).toContain('successor acceptance evidence requires --predecessor-state');
      expect(() => statSync(missingPredecessorOutput)).toThrow();

      const tamperedPredecessorPath = join(directory, 'tampered-predecessor.json');
      const tamperedPredecessorOutput = join(directory, 'tampered-predecessor-evidence.json');
      writeFileSync(
        tamperedPredecessorPath,
        Buffer.concat([predecessorBytes, Buffer.from(' ')]),
        { mode: 0o600 },
      );
      const tamperedPredecessor = spawnSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', tamperedPredecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', tamperedPredecessorOutput,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' });
      expect(tamperedPredecessor.status).not.toBe(0);
      expect(tamperedPredecessor.stderr).toContain('does not match the predecessor bytes');
      expect(() => statSync(tamperedPredecessorOutput)).toThrow();

      const mismatchedModule = join(
        producerSourceRepository,
        'scripts/content-ten-script-evidence.mjs',
      );
      writeFileSync(mismatchedModule, Buffer.concat([
        readFileSync(mismatchedModule),
        Buffer.from('\n// fixture mismatch\n'),
      ]));
      execFileSync('/usr/bin/git', ['add', '--', 'scripts/content-ten-script-evidence.mjs'], {
        cwd: producerSourceRepository,
      });
      execFileSync('/usr/bin/git', [
        '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'mismatched producer source',
      ], {
        cwd: producerSourceRepository,
      });
      const mismatchedProducerSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
        cwd: producerSourceRepository,
        encoding: 'utf8',
      }).trim();
      expect(() => resolveImmutableToolSourceBinding({
        producerSourceSha: mismatchedProducerSha,
        entrypoint: 'scripts/content-ten-script-evidence.mjs',
        modulePaths: CONTENT_TEN_SCRIPT_EVIDENCE_PRODUCER_MODULES,
        sourceRoot,
        repositoryPath: producerSourceRepository,
      })).toThrow(/differs from producer commit/);
      const economics = computeEconomics({
        version: 'failed-only-overhead-fixture',
        capturedAt: '2026-08-23T03:00:00Z',
        providerRatesUsdPerMTok: {
          standardOp: { input: 0, output: 0 },
          deepOp: { input: 0, output: 0 },
          standardScript: { input: 0, output: 0 },
          scheduledScript: { input: 0, output: 0 },
          priorityScript: { input: 0, output: 0 },
        },
        stripeFeePct: 0,
        stripeFeeFixedUsd: 0,
        appleProceedsPct: 1,
        vpsAllocationUsdPerPaidUser: 0,
        refundsPct: 0,
        taxesPct: 0,
        projectedCohortCounts: {
          pro_script_heavy: { web: 1, apple: 1 },
          max_script_heavy: { web: 1, apple: 1 },
          chat_heavy: { web: 1, apple: 1 },
          reasoning_heavy: { web: 1, apple: 1 },
          priority_pack_buyer: { web: 1, apple: 1 },
        },
      }, evidence.p95ByDeliveryMode, evidence.operationUsage);
      expect(economics.launchEligible).toBe(false);
      expect(economics.gates.webAtLeast80).toBe(false);

      const failedReview = structuredClone(qualityReview);
      failedReview.scenarios[0].criticalRegressionCount = 1;
      failedReview.scenarios[0].verdict = 'fail';
      expect(() => validateQualityReview(failedReview, {
        state,
        stateSha256,
        workloadSourceSha,
      }))
        .toThrow(/clean pass/);

      const releaseMismatchDb = new Database(databasePath);
      try {
        releaseMismatchDb.prepare(`UPDATE content_script_jobs SET completed_release_id = ?
          WHERE job_id = ?`).run('7'.repeat(32), state.scenarios[9].jobId);
      } finally {
        releaseMismatchDb.close();
      }
      const releaseMismatchOutputPath = join(directory, 'release-mismatch-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', releaseMismatchOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(releaseMismatchOutputPath)).toThrow();
      const restoreReleaseDb = new Database(databasePath);
      try {
        restoreReleaseDb.prepare(`UPDATE content_script_jobs SET completed_release_id = ?
          WHERE job_id = ?`).run(workloadReleaseView.active.releaseId, state.scenarios[9].jobId);
      } finally {
        restoreReleaseDb.close();
      }

      const duplicateOperationDb = new Database(databasePath);
      try {
        duplicateOperationDb.prepare(`UPDATE content_script_jobs SET operation_id = ?
          WHERE job_id = ?`).run(
          `content-script:${state.scenarios[0].jobId}`,
          state.scenarios[1].jobId,
        );
      } finally {
        duplicateOperationDb.close();
      }
      const duplicateOperationOutputPath = join(directory, 'duplicate-operation-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', duplicateOperationOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(duplicateOperationOutputPath)).toThrow();
      const restoreOperationDb = new Database(databasePath);
      try {
        restoreOperationDb.prepare(`UPDATE content_script_jobs SET operation_id = ?
          WHERE job_id = ?`).run(
          `content-script:${state.scenarios[1].jobId}`,
          state.scenarios[1].jobId,
        );
      } finally {
        restoreOperationDb.close();
      }

      const wrongSourceSpendDb = new Database(databasePath);
      try {
        wrongSourceSpendDb.prepare(`INSERT INTO api_usage (
          run_id, tenant_id, user_id, input_tokens, output_tokens, cost_usd,
          provider_tool_cost_usd, request_source, job_name, category, base_category,
          ts, provider, model, pricing_status
        ) VALUES ('run-0', 42, 42, 50000, 10000, 10, 1, 'interactive',
          'content_script_job_stage', 'content_script_job_script_section', NULL,
          '2026-08-23T00:00:31Z', 'openai', 'gpt-5.6-luna', 'resolved')`).run();
      } finally {
        wrongSourceSpendDb.close();
      }
      const wrongSourceSpendOutputPath = join(directory, 'wrong-source-spend-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', wrongSourceSpendOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(wrongSourceSpendOutputPath)).toThrow();
      const removeWrongSourceSpendDb = new Database(databasePath);
      try {
        removeWrongSourceSpendDb.prepare(`DELETE FROM api_usage
          WHERE run_id = 'run-0' AND request_source = 'interactive'`).run();
      } finally {
        removeWrongSourceSpendDb.close();
      }

      const wrongCategorySpendDb = new Database(databasePath);
      try {
        wrongCategorySpendDb.prepare(`INSERT INTO api_usage (
          run_id, tenant_id, user_id, input_tokens, output_tokens, cost_usd,
          provider_tool_cost_usd, request_source, job_name, category, base_category,
          ts, provider, model, pricing_status
        ) VALUES ('run-0', 42, 42, 50000, 10000, 10, 1, 'automation',
          'content_script_job_stage', 'content_script_job_unapproved_stage', NULL,
          '2026-08-23T00:00:31Z', 'openai', 'gpt-5.6-luna', 'resolved')`).run();
      } finally {
        wrongCategorySpendDb.close();
      }
      const wrongCategorySpendOutputPath = join(directory, 'wrong-category-spend-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', wrongCategorySpendOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(wrongCategorySpendOutputPath)).toThrow();
      const removeWrongCategorySpendDb = new Database(databasePath);
      try {
        removeWrongCategorySpendDb.prepare(`DELETE FROM api_usage
          WHERE category = 'content_script_job_unapproved_stage'`).run();
      } finally {
        removeWrongCategorySpendDb.close();
      }

      const incompleteCoverageDb = new Database(databasePath);
      try {
        incompleteCoverageDb.prepare(`INSERT INTO skill_inference_runs VALUES (
          'completed-without-usage', ?, 42, 42, 'completed', 'production',
          'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-23T00:00:59Z'
        )`).run(`content-script:${state.scenarios[1].jobId}`);
      } finally {
        incompleteCoverageDb.close();
      }
      const incompleteCoverageOutputPath = join(directory, 'incomplete-coverage-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', incompleteCoverageOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(incompleteCoverageOutputPath)).toThrow();
      const removeIncompleteCoverageDb = new Database(databasePath);
      try {
        removeIncompleteCoverageDb.prepare(`DELETE FROM skill_inference_runs
          WHERE run_id = 'completed-without-usage'`).run();
      } finally {
        removeIncompleteCoverageDb.close();
      }

      const unattributedDb = new Database(databasePath);
      try {
        const insertUnattributed = unattributedDb.prepare(`INSERT INTO api_usage (
          run_id, tenant_id, user_id, input_tokens, output_tokens, cost_usd,
          provider_tool_cost_usd, request_source, job_name, category, base_category,
          ts, provider, model, pricing_status
        ) VALUES (?, 42, 42, 10, 10, 0.01, 0, ?, ?, ?, ?, ?, 'openai',
          'gpt-5.6-luna', 'resolved')`);
        insertUnattributed.run(
          null, 'automation', 'content_script_job_stage',
          'content_script_job_script_section', null, '2026-08-23T00:00:30Z',
        );
        insertUnattributed.run(
          'dangling-operation-run', 'interactive', 'unattributed-operation-fixture',
          'ios_chat_message', null, '2026-08-22T00:00:03Z',
        );
        insertUnattributed.run(
          'foreign-standard-op', 'interactive', 'cross-scope-operation-fixture',
          null, 'ios_chat_message', '2026-08-22T00:00:04Z',
        );
        insertUnattributed.run(
          'invalid-category-run', 'automation', 'content_script_job_stage',
          'content_script_stage_typo', null, '2026-08-23T00:00:31Z',
        );
        insertUnattributed.run(
          'invalid-timestamp-run', 'interactive', 'invalid-timestamp-fixture',
          'ios_chat_message', null, 'not-a-timestamp',
        );
        insertUnattributed.run(
          'deep-op-1', 'interactive', 'unknown-paid-category-fixture',
          'content_engine_future_typo', null, '2026-08-22T01:00:01Z',
        );
      } finally {
        unattributedDb.close();
      }
      const unattributedOutputPath = join(directory, 'unattributed-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', unattributedOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(unattributedOutputPath)).toThrow();
      const removeUnattributedDb = new Database(databasePath);
      try {
        removeUnattributedDb.prepare(`DELETE FROM api_usage
          WHERE run_id IS NULL OR job_name IN (
            'unattributed-operation-fixture', 'cross-scope-operation-fixture',
            'invalid-timestamp-fixture', 'unknown-paid-category-fixture'
          ) OR run_id = 'invalid-category-run'`).run();
      } finally {
        removeUnattributedDb.close();
      }

      const crossClassDb = new Database(databasePath);
      try {
        crossClassDb.prepare(`INSERT INTO api_usage (
          run_id, tenant_id, user_id, input_tokens, output_tokens, cost_usd,
          provider_tool_cost_usd, request_source, job_name, category, base_category,
          ts, provider, model, pricing_status
        ) VALUES ('cross-class-deep-run', 42, 42, 100, 100, 0.01, 0,
          'interactive', 'content-script-cross-class', NULL, 'content_engine_script_deep',
          '2026-08-22T01:00:02Z', 'openai', 'gpt-5.6-luna', 'resolved')`).run();
        crossClassDb.prepare(`INSERT INTO skill_inference_runs VALUES (
          'cross-class-deep-run', 'standard-operation-1', 42, 42, 'completed', 'production',
          'cloud', 'openai', 'gpt-5.6-luna', 'valid', '2026-08-22T01:00:02Z'
        )`).run();
      } finally {
        crossClassDb.close();
      }
      const crossClassOutputPath = join(directory, 'cross-class-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', crossClassOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(crossClassOutputPath)).toThrow();
      const removeCrossClassDb = new Database(databasePath);
      try {
        removeCrossClassDb.prepare(`DELETE FROM api_usage WHERE run_id = 'cross-class-deep-run'`).run();
        removeCrossClassDb.prepare(`DELETE FROM skill_inference_runs
          WHERE run_id = 'cross-class-deep-run'`).run();
      } finally {
        removeCrossClassDb.close();
      }

      const unresolvedDb = new Database(databasePath);
      try {
        unresolvedDb.prepare(`UPDATE api_usage SET pricing_status = 'unresolved'
          WHERE run_id = 'run-0'`).run();
      } finally {
        unresolvedDb.close();
      }
      const unresolvedOutputPath = join(directory, 'unresolved-evidence.json');
      expect(() => execFileSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs', '--state', statePath,
        '--predecessor-state', predecessorPath,
        '--quality-review', qualityReviewPath,
        '--workload-release-view', workloadReleaseViewPath, '--release-view', releaseViewPath,
        '--database', databasePath, '--output', unresolvedOutputPath,
        '--script-job-key-file', scriptJobKeyPath,
        '--workload-source-sha', workloadSourceSha,
        '--producer-source-sha', producerSourceSha,
        '--producer-source-repository', producerSourceRepository,
      ], { encoding: 'utf8' })).toThrow();
      expect(() => statSync(unresolvedOutputPath)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses no-follow private file descriptors and a private canonical output parent', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-private-path-'));
    const privateDirectory = join(directory, 'private');
    const linkedDirectory = join(directory, 'linked');
    mkdirSync(privateDirectory, { mode: 0o700 });
    symlinkSync(privateDirectory, linkedDirectory);
    const input = join(privateDirectory, 'input.json');
    writeFileSync(input, '{}\n', { mode: 0o600 });
    try {
      expect(readPrivateBytes(input, 'test input').toString('utf8')).toBe('{}\n');
      const output = join(linkedDirectory, 'output.json');
      atomicPrivateWrite(output, Buffer.from('{}\n'));
      expect(statSync(join(privateDirectory, 'output.json')).mode & 0o777).toBe(0o600);

      const linkedFile = join(privateDirectory, 'linked-input.json');
      symlinkSync(input, linkedFile);
      expect(() => readPrivateBytes(linkedFile, 'linked input')).toThrow(/no-follow/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('never prints malformed private JSON excerpts in CLI refusal output', () => {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-private-json-refusal-'));
    const malformed = join(directory, 'malformed.json');
    const sentinel = 'PRIVATE-PROMPT-SCRIPT-JOB-PROVIDER-91AB';
    writeFileSync(malformed, `{"private":"${sentinel}`, { mode: 0o600 });
    try {
      const result = spawnSync(process.execPath, [
        'scripts/content-ten-script-evidence.mjs',
        '--state', malformed,
        '--quality-review', malformed,
        '--workload-release-view', malformed,
        '--release-view', malformed,
        '--script-job-key-file', malformed,
        '--database', malformed,
        '--output', join(directory, 'never-created.json'),
        '--workload-source-sha', 'a'.repeat(40),
        '--producer-source-sha', 'c'.repeat(40),
      ], { encoding: 'utf8' });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).not.toContain(sentinel);
      expect(result.stderr).toContain('content script evidence keys is not valid JSON');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
