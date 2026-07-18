import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

function writeProviderArtifact(dir: string, count: number): string {
  const artifactPath = path.join(dir, 'provider-invocations.json');
  writeFileSync(artifactPath, JSON.stringify({
    invocations: Array.from({ length: count }, (_, index) => ({
      invocationId: `provider-cli-call-${index + 1}`,
      provider: 'configured-provider',
      model: 'configured-model',
      tier: 'chat',
      category: 'content_day_to_day_eval',
      status: 'succeeded',
      capturedAt: `2026-06-04T00:00:0${index}.000Z`,
      routingPath: 'provider_registry',
    })),
  }));
  return artifactPath;
}

describe('content-evaluation-harness CLI provenance lanes', () => {
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

  it('threads valid external evidence so CLI runs can reach release PASS', () => {
    const outDir = tempDir('content-eval-with-evidence-');
    const jsonPath = path.join(outDir, 'result.json');
    const providerArtifact = writeProviderArtifact(outDir, 5);
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
      '--ios-extraction-score', '96',
      '--ios-extraction-run-id', 'ios-cli-evidence-20260604',
      '--ios-extraction-source', 'xcodebuild-content-ui-tests',
      '--ios-extraction-sample-count', '4',
      '--real-provider-sample-score', '95',
      '--real-provider-sample-run-id', 'provider-cli-evidence-20260604',
      '--real-provider-sample-source', 'limited-real-provider-eval',
      '--real-provider-sample-count', '5',
      '--real-provider-invocation-artifact', providerArtifact,
    ]);

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Release gate: PASS');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.passed).toBe(true);
    expect(result.aggregate.releaseGate).toBe('PASS');
    expect(result.aggregate.laneScores.iosExtractionScore).toBe(96);
    expect(result.aggregate.laneScores.realProviderSampleScore).toBe(95);
  }, CLI_TIMEOUT_MS);

  it('threads valid external evidence from CONTENT_EVAL environment variables', () => {
    const outDir = tempDir('content-eval-env-evidence-');
    const jsonPath = path.join(outDir, 'result.json');
    const providerArtifact = writeProviderArtifact(outDir, 5);
    const { exitCode, stdout, stderr } = runHarness([
      '--mode', 'fixture',
      '--json', jsonPath,
      '--markdown', path.join(outDir, 'result.md'),
    ], {
      CONTENT_EVAL_IOS_EXTRACTION_SCORE: '96',
      CONTENT_EVAL_IOS_EXTRACTION_RUN_ID: 'ios-env-evidence-20260604',
      CONTENT_EVAL_IOS_EXTRACTION_SOURCE: 'xcodebuild-content-ui-tests',
      CONTENT_EVAL_IOS_EXTRACTION_SAMPLE_COUNT: '4',
      CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SCORE: '95',
      CONTENT_EVAL_REAL_PROVIDER_SAMPLE_RUN_ID: 'provider-env-evidence-20260604',
      CONTENT_EVAL_REAL_PROVIDER_SAMPLE_SOURCE: 'limited-real-provider-eval',
      CONTENT_EVAL_REAL_PROVIDER_SAMPLE_COUNT: '5',
      CONTENT_EVAL_REAL_PROVIDER_INVOCATION_ARTIFACT: providerArtifact,
    });

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Release gate: PASS');

    const result = JSON.parse(readFileSync(jsonPath, 'utf8'));
    expect(result.passed).toBe(true);
    expect(result.aggregate.releaseGate).toBe('PASS');
    expect(result.aggregate.laneScores.iosExtractionScore).toBe(96);
    expect(result.aggregate.laneScores.realProviderSampleScore).toBe(95);
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
      failureCode: 'missing_invocation_provenance',
    });
  }, CLI_TIMEOUT_MS);
});
