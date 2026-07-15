import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isGitAncestor,
  validateCandidateManifestTiming,
  validateGitHubIdentity,
  validateNightlyGitHubIdentity,
  validateRecomputedSelection,
  validateTestEvidence,
} from '../../scripts/trusted-release-signer.mjs';

const runtimeSha = 'a'.repeat(40);
const repository = 'felipedrf74/cortex-telegram-hub-bot';
const candidateRunId = '123456789';
const roots: string[] = [];

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function fullIdentitySelection() {
  return { tier: 'full-sharded', fullRequired: true };
}

function defaultIdentitySelection() {
  return { tier: 'changed-critical-cannot-skip', fullRequired: false };
}

function successfulIdentity(selection = fullIdentitySelection()) {
  const runStartedAt = new Date(Date.now() - 120_000).toISOString();
  const runUpdatedAt = new Date(Date.now() - 30_000).toISOString();
  const tierJobs = selection.fullRequired
    ? [1, 2, 3, 4].map((shard) => `🧪 Full Vitest shard ${shard}/4`)
    : ['🧪 Policy-selected Vitest'];
  return {
    run: {
      id: Number(candidateRunId),
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      head_sha: runtimeSha,
      path: '.github/workflows/release-candidate-evidence.yml',
      event: 'workflow_dispatch',
      run_started_at: runStartedAt,
      updated_at: runUpdatedAt,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    jobs: {
      jobs: [
        '🧭 Resolve release test tier',
        ...tierJobs,
        '🐍 Content Engine full pytest',
        '📦 Write unsigned release candidate',
      ].map((name, index) => ({ id: index + 1, name, conclusion: 'success' })),
    },
    artifacts: {
      artifacts: [{
        id: 987654,
        name: `release-candidate-v2-${runtimeSha}`,
        expired: false,
        size_in_bytes: 1024,
        digest: `sha256:${'b'.repeat(64)}`,
        workflow_run: { id: Number(candidateRunId), head_sha: runtimeSha },
      }],
    },
  };
}

function recomputationFixture({
  full = false,
  removed = [] as string[],
  unresolved = [] as string[],
} = {}) {
  const changed = ['__tests__/services/changed.test.ts'];
  const critical = ['__tests__/security/critical.test.ts'];
  const cannotSkip = ['__tests__/scope/tenant.test.ts'];
  const selectedFiles = [...new Set([...changed, ...critical, ...cannotSkip])].sort();
  const allFiles = [...selectedFiles, '__tests__/services/other.test.ts'].sort();
  const impactResolved = unresolved.length === 0;
  const classifier = {
    baseRef: runtimeSha,
    flags: { impactResolved: true, fullSuiteTrigger: false },
    cannotSkip: ['tenant-isolation'],
  };
  const selected = {
    base: runtimeSha,
    changed,
    critical,
    cannotSkip,
    removed,
    unresolved,
    impactResolved: impactResolved && removed.length === 0,
    selected: selectedFiles,
  };
  const files = full ? allFiles : selectedFiles;
  const selection = {
    baseSha: runtimeSha,
    selected: {
      changed,
      critical,
      cannotSkip,
      removed,
      removedDigest: digest(removed),
      unresolved,
      unresolvedDigest: digest(unresolved),
      files,
      filesDigest: digest(files),
    },
    classifier: {
      impactResolved: impactResolved && removed.length === 0,
      fullSuiteTrigger: false,
      cannotSkip: ['tenant-isolation'],
    },
    fullRequired: full,
  };
  return { selection, classifier, selected, allFiles };
}

function workflowRunBlocks(raw: string) {
  const lines = raw.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*\|\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const body: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      const currentIndent = line.length - line.trimStart().length;
      if (line.trim() && currentIndent <= indent) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('trusted release signing boundary', () => {
  it('binds candidate-generated time and nightly freshness to the trusted GitHub run', () => {
    const nowMs = Date.now();
    const runStartedAtMs = nowMs - 120_000;
    const runUpdatedAtMs = nowMs - 30_000;
    const generatedAtMs = nowMs - 60_000;
    expect(validateCandidateManifestTiming({
      generatedAtMs,
      expiresAtMs: generatedAtMs + 72 * 3_600_000,
      runStartedAtMs,
      runUpdatedAtMs,
      nowMs,
    })).toBe(runUpdatedAtMs);

    const backdatedGeneratedAtMs = nowMs - 48 * 3_600_000;
    expect(() => validateCandidateManifestTiming({
      generatedAtMs: backdatedGeneratedAtMs,
      expiresAtMs: backdatedGeneratedAtMs + 72 * 3_600_000,
      runStartedAtMs,
      runUpdatedAtMs,
      nowMs,
    })).toThrow('outside the trusted candidate GitHub run');
  });

  it('accepts only runtime commits reachable from protected main history', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(isGitAncestor(process.cwd(), head)).toBe(true);
    expect(isGitAncestor(process.cwd(), 'f'.repeat(40))).toBe(false);

    const workflow = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    expect(workflow).toContain('fetch-depth: 0');
    expect(fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8'))
      .toContain("fail('candidate runtime SHA is not reachable from protected main')");
  });

  it.each([
    ['full-sharded', fullIdentitySelection()],
    ['changed plus critical plus cannot-skip', defaultIdentitySelection()],
  ])('accepts the exact successful %s job identity', (_label, selection) => {
    const identity = successfulIdentity(selection);
    expect(validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
      selection,
    })).toMatchObject({
      runAttempt: '2',
      expectedArtifactName: `release-candidate-v2-${runtimeSha}`,
      artifact: { id: 987654 },
    });
  });

  it('does not use a raw release test-count floor', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const signer = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');
    expect(policy.releaseEvidence.minimumTestCounts).toBeUndefined();
    expect(policy.releaseEvidence.defaultTier).toBe('changed-critical-cannot-skip');
    expect(signer).not.toContain('validateTestCountFloors');
    expect(signer).not.toContain('9000');
  });

  it.each([
    ['run id', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.id += 1; }, 'run id mismatch'],
    ['head SHA', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.head_sha = 'c'.repeat(40); }, 'head SHA mismatch'],
    ['workflow path', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.path = '.github/workflows/other.yml'; }, 'workflow path mismatch'],
    ['artifact run', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.id += 1; }, 'not bound'],
    ['artifact head', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.head_sha = 'd'.repeat(40); }, 'not bound'],
    ['artifact digest', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].digest = ''; }, 'digest is missing'],
    ['tier job', (identity: ReturnType<typeof successfulIdentity>) => { identity.jobs.jobs.splice(1, 1); }, 'missing, duplicated, or unsuccessful'],
    ['run timestamps', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.updated_at = 'invalid'; }, 'run timestamps are invalid'],
  ])('fails closed on mismatched %s candidate evidence', (_label, mutate, message) => {
    const selection = fullIdentitySelection();
    const identity = successfulIdentity(selection);
    mutate(identity);
    expect(() => validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
      selection,
    })).toThrow(message);
  });

  it('independently rejects tampered selection arrays, digests, and classifier flags', () => {
    const fixture = recomputationFixture();
    expect(() => validateRecomputedSelection(fixture)).not.toThrow();

    const changed = structuredClone(fixture);
    changed.selection.selected.changed = [];
    expect(() => validateRecomputedSelection(changed)).toThrow('changed tests');

    const flags = structuredClone(fixture);
    flags.selection.classifier.impactResolved = false;
    expect(() => validateRecomputedSelection(flags)).toThrow('classifier flags');

    const fileDigest = structuredClone(fixture);
    fileDigest.selection.selected.filesDigest = 'f'.repeat(64);
    expect(() => validateRecomputedSelection(fileDigest)).toThrow('selected test digest');

    const removed = recomputationFixture({ full: true, removed: ['__tests__/services/retired.test.ts'] });
    expect(() => validateRecomputedSelection(removed)).not.toThrow();
    removed.selection.selected.removedDigest = '0'.repeat(64);
    expect(() => validateRecomputedSelection(removed)).toThrow('removed test digest');
  });

  it('recomputes missing-nightly full plans and binds unresolved impact paths', () => {
    const missingNightly = recomputationFixture({ full: true });
    expect(() => validateRecomputedSelection(missingNightly)).not.toThrow();

    const unresolved = recomputationFixture({ full: true, unresolved: ['src/services/unmapped.ts'] });
    expect(() => validateRecomputedSelection(unresolved)).not.toThrow();
    unresolved.selection.selected.unresolvedDigest = '0'.repeat(64);
    expect(() => validateRecomputedSelection(unresolved)).toThrow('unresolved dependency digest');
  });

  it('validates the actual qualifying-nightly run, artifact, evidence, and Git test-file digest', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-nightly-identity-'));
    roots.push(temp);
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const testFiles = execFileSync('git', [
      'ls-tree', '-r', '--name-only', actualHead, '--', '__tests__',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/)
      .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file)).sort();
    const policyDocument = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const policy = policyDocument.releaseEvidence.qualifyingNightly;
    const policyDigest = createHash('sha256').update(fs.readFileSync('config/test-policy.json')).digest('hex');
    const completedAt = new Date(Date.now() - 60_000).toISOString();
    const identity = { headSha: actualHead, completedAt, runId: '54321', runAttempt: '2' };
    const selection = { fullRequiredReason: null, nightlyEvidence: identity };
    const evidence = {
      schema: 'nexus.nightly-full-suite-evidence.v1',
      status: 'passed',
      tier: 'full-sharded',
      headSha: actualHead,
      completedAt,
      testPolicyDigest: policyDigest,
      counts: { vitest: 1 },
      testFiles: { count: testFiles.length, digest: digest(testFiles) },
      ci: { runId: '54321', runAttempt: '2', workflow: policy.workflowName },
    };
    fs.writeFileSync(path.join(temp, 'nightly-full-suite-evidence.json'), JSON.stringify(evidence));
    const run = {
      id: 54321,
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      path: policy.workflowPath,
      name: policy.workflowName,
      event: 'schedule',
      head_branch: 'main',
      head_sha: actualHead,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      run_started_at: new Date(Date.now() - 120_000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    const artifacts = { artifacts: [{
      id: 77,
      name: `${policy.artifactPrefix}54321-2`,
      expired: false,
      size_in_bytes: 512,
      digest: `sha256:${'e'.repeat(64)}`,
      workflow_run: { id: 54321, head_sha: actualHead },
    }] };
    const input = {
      selection,
      policy,
      policyDigest,
      run,
      artifacts,
      evidenceRoot: temp,
      repository,
      runtimeSha: actualHead,
      trustedReferenceTimeMs: Date.now(),
      candidateSourceRoot: process.cwd(),
    };
    expect(validateNightlyGitHubIdentity(input)).toMatchObject({ artifact: { id: 77 } });

    const wrongWorkflow = structuredClone(input);
    wrongWorkflow.run.path = '.github/workflows/other.yml';
    expect(() => validateNightlyGitHubIdentity(wrongWorkflow)).toThrow('workflow path or name');

    const wrongArtifact = structuredClone(input);
    wrongArtifact.artifacts.artifacts[0].workflow_run.id = 999;
    expect(() => validateNightlyGitHubIdentity(wrongArtifact)).toThrow('not bound');

    const tamperedEvidence = { ...evidence, testFiles: { ...evidence.testFiles, digest: '0'.repeat(64) } };
    fs.writeFileSync(path.join(temp, 'nightly-full-suite-evidence.json'), JSON.stringify(tamperedEvidence));
    expect(() => validateNightlyGitHubIdentity(input)).toThrow('Git test-file tree');
  });

  it('accepts stale-nightly identity only when a full result carries the stale reason', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-stale-nightly-result-'));
    roots.push(temp);
    const resultsRoot = path.join(temp, '.local/release/rc-test-results');
    fs.mkdirSync(resultsRoot, { recursive: true });
    const actualHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const policyDigest = createHash('sha256').update(fs.readFileSync('config/test-policy.json')).digest('hex');
    const trustedReferenceTimeMs = Date.now();
    const staleAt = new Date(trustedReferenceTimeMs - 37 * 3_600_000).toISOString();
    const files = execFileSync('git', [
      'ls-tree', '-r', '--name-only', actualHead, '--', '__tests__',
    ], { encoding: 'utf8' }).trim().split(/\r?\n/)
      .filter((file) => /^__tests__\/.+\.test\.ts$/.test(file)).sort().slice(0, 4);
    const selection = {
      schema: 'nexus.release-test-selection.v1',
      tier: 'full-sharded',
      headSha: actualHead,
      baseSha: actualHead,
      policyDigest,
      fullRequired: true,
      fullRequiredReason: 'qualifying_nightly_evidence_stale',
      selected: {
        changed: [],
        critical: [],
        cannotSkip: [],
        removed: [],
        removedDigest: digest([]),
        unresolved: [],
        unresolvedDigest: digest([]),
        files,
        filesDigest: digest(files),
      },
      classifier: { impactResolved: true, fullSuiteTrigger: false, cannotSkip: [] },
      nightlyEvidence: {
        headSha: actualHead,
        completedAt: staleAt,
        runId: '54321',
        runAttempt: '1',
      },
    };
    for (let index = 0; index < files.length; index += 1) {
      fs.writeFileSync(path.join(resultsRoot, `vitest-results-${index + 1}.json`), JSON.stringify({
        success: true,
        numTotalTests: 1,
        testResults: [{ name: path.resolve(files[index]), assertionResults: [{ status: 'passed' }] }],
      }));
    }
    fs.writeFileSync(path.join(resultsRoot, 'pytest-results.log'), '1 passed in 0.01s\n');
    fs.writeFileSync(path.join(temp, '.local/release/test-results.json'), JSON.stringify({
      schema: 'nexus.release-test-results.v2',
      status: 'passed',
      runtimeSha: actualHead,
      completedAt: new Date(trustedReferenceTimeMs - 60_000).toISOString(),
      tier: 'full-sharded',
      selection,
      testPolicyDigest: policyDigest,
      toolchain: { node: 'v22.23.1', python: 'Python 3.12.0' },
      counts: { vitest: files.length, pytest: 1 },
      ci: { runId: '12345', runAttempt: '1' },
    }));

    expect(validateTestEvidence({
      candidateArtifactRoot: temp,
      runtimeSha: actualHead,
      runId: '12345',
      runAttempt: '1',
      trustedReferenceTimeMs,
      selection,
      trustedPolicy: policy,
      trustedPolicyDigest: policyDigest,
      candidateSourceRoot: process.cwd(),
    })).toMatchObject({ status: 'passed', tier: 'full-sharded' });
  });

  it('keeps candidate source inert while trusted tooling recomputes selection and fetches nightly proof', () => {
    const workflowsRoot = path.resolve('.github/workflows');
    const rc = fs.readFileSync(path.join(workflowsRoot, 'release-candidate-evidence.yml'), 'utf8');
    const manifestSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-release-manifest.yml'), 'utf8');
    const stagingSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-staging-attestation.yml'), 'utf8');
    const trustedSigner = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');
    const selector = fs.readFileSync('scripts/select-vitest-files.mjs', 'utf8');
    const staticMapper = fs.readFileSync('scripts/lib/static-test-dependency-map.mjs', 'utf8');
    const allWorkflows = fs.readdirSync(workflowsRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => fs.readFileSync(path.join(workflowsRoot, name), 'utf8'))
      .join('\n');

    expect(rc).not.toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(allWorkflows.match(/secrets\.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM/g)).toHaveLength(2);
    for (const signer of [manifestSigner, stagingSigner]) {
      expect(signer).toContain('environment: release-signing');
      expect(signer).toContain("github.ref == 'refs/heads/main'");
      expect(signer).toContain('path: trusted-tooling');
      expect(signer).not.toMatch(/(?:node|bash|sh|npm|npx|\.\/)\s+candidate-(?:source|artifact)/);
      expect(signer).not.toContain('cd candidate-');
    }
    expect(selector).toContain('staticTestDependencyImpact');
    expect(selector).not.toContain('node_modules');
    expect(selector).not.toContain('vitest.config');
    expect(staticMapper).not.toMatch(/\beval\s*\(|new Function/);
    expect(manifestSigner).not.toMatch(/working-directory:\s*candidate-source/);
    expect(manifestSigner).toContain('nightly-request');
    expect(manifestSigner).toContain('/actions/runs/${NEXUS_NIGHTLY_RUN_ID}');
    expect(manifestSigner).toContain('--name "$NEXUS_NIGHTLY_ARTIFACT_NAME"');
    expect(trustedSigner).toContain('NEXUS_CLASSIFIER_REPO_ROOT: candidateSourceRoot');
    expect(trustedSigner).toContain('delete commandEnv.NEXUS_RELEASE_MANIFEST_PRIVATE_KEY_PEM');
  });

  it('validates dispatch identities before use and never renders them into signer shell source', () => {
    const signer = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    const runBlocks = workflowRunBlocks(signer).join('\n');
    const maliciousRunId = '29407618419?x=$(printf exfiltrate)';

    expect(Number.parseInt(maliciousRunId, 10)).toBe(29407618419);
    expect(/^[0-9]+$/.test(maliciousRunId)).toBe(false);
    expect(signer).toContain('[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(signer).toContain('[[ "$CANDIDATE_RUN_ID" =~ ^[0-9]+$ ]]');
    expect(runBlocks).not.toContain('${{ inputs.');
    expect(runBlocks).toContain('--runtime-sha "$RUNTIME_SHA"');
    expect(runBlocks).toContain('--candidate-run-id "$CANDIDATE_RUN_ID"');
  });

  it('does not resolve artifact helpers from the candidate root', () => {
    const manifest = fs.readFileSync('scripts/release-manifest-v2.mjs', 'utf8');
    const trustedSigner = fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8');

    expect(manifest).toContain("from './lib/release-artifact-manifest.mjs'");
    expect(manifest).not.toContain("path.join(root, 'scripts/release-artifact-manifest.mjs')");
    expect(trustedSigner).toContain('verifyReleaseBundle(bundleRoot, runtimeSha)');
    expect(trustedSigner).not.toMatch(/execFileSync\([^)]*candidate/i);
  });
});
