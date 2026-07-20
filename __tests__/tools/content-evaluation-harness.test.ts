import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  CONTENT_IOS_TEST_FINGERPRINT,
  CONTENT_IOS_TEST_GIT_COMMIT,
  CONTENT_IOS_TEST_KEY,
  CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
  makeContentIosExtractionTestArtifact,
} from '../fixtures/content-ios-extraction';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI_TIMEOUT_MS = 30_000;

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanContentEvalEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CONTENT_EVAL_')) delete env[key];
  }
  return env;
}

function runHarness(
  args: string[],
  envOverrides: NodeJS.ProcessEnv = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/tools/content-evaluation-harness.ts', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...cleanContentEvalEnv(), TMPDIR: '/tmp', ...envOverrides },
    timeout: CLI_TIMEOUT_MS,
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function writeProviderArtifact(dir: string) {
  const artifactPath = path.join(dir, 'provider-invocations.json');
  const artifact = {
    schemaVersion: 'nexus.content-live-eval.v2',
    runId: 'content-live-eval-forged-cli-20260719',
    summary: { score: 100, sampleCount: 5 },
    bindingDigest: 'a'.repeat(64),
  };
  writeFileSync(artifactPath, JSON.stringify(artifact));
  return { artifactPath, artifact };
}

describe('content-evaluation-harness CLI provenance lanes', () => {
  it('never lets a CLI fingerprint override the pre-dotenv release-environment pin', () => {
    const outDir = tempDir('content-eval-pin-override-');
    const source = readFileSync(path.join(REPO_ROOT, 'src/tools/content-evaluation-harness.ts'), 'utf8');
    expect(source.indexOf('launchTrustedAttestationKeyFingerprint'))
      .toBeLessThan(source.indexOf("require('../services/content-day-to-day-evaluation')"));

    const result = runHarness([
      '--mode', 'fixture',
      '--json', path.join(outDir, 'result.json'),
      '--trusted-attestation-key-sha256', 'b'.repeat(64),
    ], {
      CONTENT_EVAL_TRUSTED_ATTESTATION_KEY_SHA256: 'a'.repeat(64),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('Unknown Content evaluation argument');
  }, CLI_TIMEOUT_MS);

  it('ignores external scores without evidence and keeps the release gate non-passing', () => {
    const outDir = tempDir('content-eval-no-evidence-');
    const jsonPath = path.join(outDir, 'result.json');
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--ios-extraction-score', '96',
      '--real-provider-sample-score', '95',
    ]);

    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('Release gate: FAIL');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.passed).toBe(false);
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
  }, CLI_TIMEOUT_MS);

  it('accepts the iOS lane only from a typed, independently pinned artifact', () => {
    const outDir = tempDir('content-eval-ios-artifact-');
    const jsonPath = path.join(outDir, 'result.json');
    const artifactPath = path.join(outDir, 'ios-artifact.json');
    const keyPath = path.join(outDir, 'ios-attestation.key');
    writeFileSync(artifactPath, JSON.stringify(makeContentIosExtractionTestArtifact({
      generatedAt: new Date().toISOString(),
    })));
    writeFileSync(keyPath, CONTENT_IOS_TEST_KEY.toString('hex'), { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const { exitCode, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--ios-extraction-artifact', artifactPath,
      '--ios-extraction-attestation-key-file', keyPath,
    ], {
      CONTENT_EVAL_TRUSTED_IOS_ATTESTATION_KEY_SHA256: CONTENT_IOS_TEST_FINGERPRINT,
      CONTENT_EVAL_EXPECTED_IOS_GIT_COMMIT: CONTENT_IOS_TEST_GIT_COMMIT,
      CONTENT_EVAL_EXPECTED_IOS_SOURCE_TREE_DIGEST: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    });

    // The provider lane is intentionally absent, so the whole gate remains
    // conditional even though the typed iOS lane itself executed cleanly.
    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.aggregate.laneScores.iosExtractionScore).toBe(100);
    expect(result.aggregate.laneEvidence.iosExtraction).toMatchObject({
      status: 'executed',
      invocationCount: 5,
    });
  }, CLI_TIMEOUT_MS);

  it('fails rather than treating a requested but invalid iOS artifact as not executed', () => {
    const outDir = tempDir('content-eval-invalid-ios-artifact-');
    const jsonPath = path.join(outDir, 'result.json');
    const artifactPath = path.join(outDir, 'ios-artifact.json');
    const keyPath = path.join(outDir, 'ios-attestation.key');
    writeFileSync(artifactPath, JSON.stringify({ forged: true }));
    writeFileSync(keyPath, CONTENT_IOS_TEST_KEY.toString('hex'), { mode: 0o600 });
    chmodSync(keyPath, 0o600);

    const { exitCode } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--ios-extraction-artifact', artifactPath,
      '--ios-extraction-attestation-key-file', keyPath,
    ], {
      CONTENT_EVAL_TRUSTED_IOS_ATTESTATION_KEY_SHA256: CONTENT_IOS_TEST_FINGERPRINT,
      CONTENT_EVAL_EXPECTED_IOS_GIT_COMMIT: CONTENT_IOS_TEST_GIT_COMMIT,
      CONTENT_EVAL_EXPECTED_IOS_SOURCE_TREE_DIGEST: CONTENT_IOS_TEST_SOURCE_TREE_DIGEST,
    });

    expect(exitCode).not.toBe(0);
    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.aggregate.laneEvidence.iosExtraction).toMatchObject({
      status: 'invalid_evidence',
      failureCode: 'typed_artifact_required',
    });
  }, CLI_TIMEOUT_MS);

  it('rejects a public-digest artifact without an external operator key and trusted fingerprint', () => {
    const outDir = tempDir('content-eval-with-evidence-');
    const jsonPath = path.join(outDir, 'result.json');
    const { artifactPath: providerArtifact, artifact } = writeProviderArtifact(outDir);
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--ios-extraction-score', '96',
      '--ios-extraction-run-id', 'ios-cli-evidence-20260604',
      '--ios-extraction-source', 'xcodebuild-content-ui-tests',
      '--ios-extraction-sample-count', '4',
      '--real-provider-sample-score', String(artifact.summary.score),
      '--real-provider-artifact', providerArtifact,
    ]);

    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('Release gate: FAIL');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.passed).toBe(false);
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
  }, CLI_TIMEOUT_MS);

  it('rejects forged external evidence supplied through CONTENT_EVAL environment variables', () => {
    const outDir = tempDir('content-eval-env-evidence-');
    const jsonPath = path.join(outDir, 'result.json');
    const { artifactPath: providerArtifact, artifact } = writeProviderArtifact(outDir);
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
    ], {
      CONTENT_EVAL_IOS_EXTRACTION_SCORE: '96',
      CONTENT_EVAL_IOS_EXTRACTION_RUN_ID: 'ios-env-evidence-20260604',
      CONTENT_EVAL_IOS_EXTRACTION_SOURCE: 'xcodebuild-content-ui-tests',
      CONTENT_EVAL_IOS_EXTRACTION_SAMPLE_COUNT: '4',
      CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE: String(artifact.summary.score),
      CONTENT_EVAL_REAL_PROVIDER_ARTIFACT: providerArtifact,
    });

    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain('Release gate: FAIL');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.passed).toBe(false);
    expect(result.aggregate.releaseGate).toBe('FAIL');
    expect(result.aggregate.laneScores.iosExtractionScore).toBeNull();
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
  }, CLI_TIMEOUT_MS);

  it('does not claim provider execution from real-provider mode without an invocation artifact', () => {
    const outDir = tempDir('content-eval-requested-provider-only-');
    const jsonPath = path.join(outDir, 'result.json');
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'real_provider',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--real-provider-sample-score', '99',
      '--real-provider-sample-run-id', 'request-only',
      '--real-provider-sample-source', 'operator-request',
      '--real-provider-sample-count', '1',
    ]);

    expect(stderr).toBe('');
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain('Release gate: PASS\n');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.cases.every((testCase: any) => testCase.output.providerTrace.realProviderCalls === false)).toBe(true);
    expect(result.aggregate.laneScores.realProviderSampleScore).toBeNull();
    expect(result.aggregate.laneEvidence.realProviderSample).toMatchObject({
      status: 'invalid_evidence',
      invocationCount: 0,
      failureCode: 'missing_bound_artifact',
    });
  }, CLI_TIMEOUT_MS);
});
