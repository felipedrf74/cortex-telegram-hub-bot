import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROTECTED_MAIN_CI_SCHEMA,
  PROTECTED_MAIN_REUSE_SCOPE,
  PROTECTED_MAIN_WORKFLOW,
  RELEASE_SHADOW_COMPARISON_SCHEMA,
  canonicalJson,
  compareProtectedMainToRelease,
  sha256,
  validateProtectedMainCiEvidence,
} from '../../scripts/protected-main-ci-evidence.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const policyDigest = 'c'.repeat(64);
const files = [
  '__tests__/scripts/release-manifest-v2.test.ts',
  '__tests__/scripts/release-test-evidence.test.ts',
];

function validEvidence() {
  return {
    schema: PROTECTED_MAIN_CI_SCHEMA,
    status: 'passed',
    reuseScope: PROTECTED_MAIN_REUSE_SCOPE,
    headSha,
    baseSha,
    completedAt: new Date().toISOString(),
    testPolicyDigest: policyDigest,
    lockfiles: {
      packageLockSha256: 'd'.repeat(64),
      pythonRequirementsSha256: 'e'.repeat(64),
    },
    toolchain: { node: 'v22.23.1', python: 'Python 3.12.11' },
    vitest: {
      mode: 'focused',
      files,
      filesDigest: sha256(canonicalJson(files)),
      tests: 42,
    },
    build: {
      artifactName: `release-bundle-${headSha}-${'f'.repeat(64)}`,
      artifactDigest: 'f'.repeat(64),
    },
    ci: {
      repository: 'felipedrf74/cortex-telegram-hub-bot',
      workflow: PROTECTED_MAIN_WORKFLOW,
      runId: '12345',
      runAttempt: '1',
      event: 'push',
      ref: 'refs/heads/main',
    },
    jobs: {
      classify: 'success',
      tests: 'success',
      lint: 'success',
      build: 'success',
      sciencePolicy: 'success',
      python: 'skipped',
      migrations: 'skipped',
    },
  };
}

describe('protected-main CI reuse shadow evidence', () => {
  it('binds exact source, policy, lockfiles, selected tests, build, and protected jobs', () => {
    expect(validateProtectedMainCiEvidence(validEvidence(), {
      expectedHeadSha: headSha,
      expectedPolicyDigest: policyDigest,
    })).toMatchObject({
      status: 'passed',
      reuseScope: 'vitest-and-exact-runtime-bundle-shadow',
      vitest: { tests: 42, files },
      jobs: { tests: 'success', build: 'success' },
    });
  });

  it('rejects drifted selection and non-protected workflow identity', () => {
    const drifted = validEvidence();
    drifted.vitest.files = [...drifted.vitest.files].reverse();
    expect(() => validateProtectedMainCiEvidence(drifted)).toThrow('file digest mismatch');

    const untrusted = validEvidence();
    untrusted.ci.workflow = 'candidate workflow';
    expect(() => validateProtectedMainCiEvidence(untrusted)).toThrow('GitHub identity is invalid');

    const mismatchedArtifact = validEvidence();
    mismatchedArtifact.build.artifactDigest = '1'.repeat(64);
    expect(() => validateProtectedMainCiEvidence(mismatchedArtifact)).toThrow(
      'artifact name is not bound to its exact SHA and digest',
    );
  });

  it('marks reuse eligible only when main covers the exact RC selection', () => {
    const releaseResults = {
      runtimeSha: headSha,
      testPolicyDigest: policyDigest,
      artifactDigest: 'f'.repeat(64),
      lockfiles: {
        packageLockSha256: 'd'.repeat(64),
        pythonRequirementsSha256: 'e'.repeat(64),
      },
      toolchain: { node: 'v22.23.1', python: 'Python 3.12.11' },
      selection: { selected: { files: [files[0]] } },
      ci: { runId: '67890', runAttempt: '1' },
    };
    expect(compareProtectedMainToRelease(validEvidence(), releaseResults)).toMatchObject({
      schema: RELEASE_SHADOW_COMPARISON_SCHEMA,
      status: 'eligible',
      reason: null,
      checks: {
        mainSelectionCoversRelease: true,
        runtimeArtifactMatch: true,
        packageLockMatch: true,
      },
    });

    releaseResults.selection.selected.files = [...files, '__tests__/security/uncovered.test.ts'];
    expect(compareProtectedMainToRelease(validEvidence(), releaseResults)).toMatchObject({
      status: 'ineligible',
      reason: 'protected_main_evidence_mismatch',
      checks: { mainSelectionCoversRelease: false },
    });
  });

  it('keeps evidence packaging sequential and RC reuse in shadow mode', () => {
    const ci = fs.readFileSync('.github/workflows/ci.yml', 'utf8');
    const rc = fs.readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
    expect(ci).toContain('matrix:\n        shard: [1, 2, 3, 4]');
    expect(ci).toContain('protected_main_evidence:');
    expect(ci).toContain('needs: [classify, test, lint, build, python-test, science_policy, migrations]');
    expect(ci).toContain('scripts/protected-main-ci-evidence.mjs write');
    expect(ci).toContain('Upload exact runtime release bundle');
    expect(ci).toContain('Download and verify the uploaded exact runtime bundle');
    expect(ci).toContain('--verify-bundle .local/ci-evidence/downloaded-runtime-bundle');
    expect(ci).not.toContain('name: dist-${{ github.sha }}');
    expect(rc).toContain('Compare protected-main evidence in shadow mode');
    expect(rc).toContain('scripts/protected-main-ci-evidence.mjs compare');
    expect(rc).not.toContain('skip_release_vitest');
  });
});
