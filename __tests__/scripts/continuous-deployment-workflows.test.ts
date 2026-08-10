import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CI routing contract for the continuous-deployment pipeline.
 *
 * These assertions guard the properties that make the pipeline safe to run
 * unattended, and that a well-meaning workflow edit could silently undo:
 *
 *   - the test runner is test-only: no registry credential, no Docker, no deploy
 *   - application-image production happens exactly once on a hosted x86_64 runner
 *   - signing happens in a different fresh hosted job with no dependency lifecycle
 *   - protected main has latest-green concurrency
 *   - SonarQube is gone
 *   - iOS work is triggered by changed contracts, not by every backend release
 *
 * They are workflow-text assertions by necessity — GitHub Actions job routing
 * cannot be executed locally. The behavioural half of the pipeline lives in
 * `release-continuous-deployment.test.ts`, which drives the deployment code
 * itself through real failure paths.
 */

const root = resolve(process.cwd());
const workflowsDir = join(root, '.github/workflows');
const ci = readFileSync(join(workflowsDir, 'ci.yml'), 'utf8');
const release = readFileSync(join(workflowsDir, 'release.yml'), 'utf8');
const manifestBuilder = readFileSync(join(root, 'scripts/release-manifest-build.mjs'), 'utf8');
const signingHandoff = readFileSync(join(root, 'scripts/release-signing-handoff.mjs'), 'utf8');
const policy = JSON.parse(readFileSync(join(root, 'config/continuous-deployment.json'), 'utf8'));
const iosContractClassifier = readFileSync(join(root, 'scripts/ios-contract-change-check.mjs'), 'utf8');
const continuousDeploymentDoc = readFileSync(join(root, 'docs/release/continuous-deployment.md'), 'utf8');

const iosContractOwners = [
  'src/release/backend-ios-contract-fixture.ts',
  'src/services/dashboard-home-view-state.ts',
  'src/services/training-home-view-state.ts',
  'src/services/training-copy-sanitizer.ts',
  'src/services/content-home-view-state.ts',
  'src/services/screen-contract-meta.ts',
  'src/api/routes/training-plan-generation-response-contract.ts',
  'src/services/training-plan-clarification-registry.ts',
  'scripts/release-bundle.mjs',
  'scripts/lib/backend-ios-contract-fixture.mjs',
  '__tests__/scripts/backend-ios-contract-fixture.test.ts',
] as const;

function classifyIosContract(files: readonly string[]) {
  const result = spawnSync(process.execPath, [
    'scripts/ios-contract-change-check.mjs',
    '--files',
    files.join(','),
    '--json',
  ], { cwd: root, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function jobBlock(source: string, jobId: string): string {
  const start = source.indexOf(`\n  ${jobId}:\n`);
  expect(start, `job ${jobId} exists`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z_]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function stepBlock(source: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = source.indexOf(marker);
  expect(start, `step ${stepName} exists`).toBeGreaterThan(-1);
  const rest = source.slice(start);
  const next = rest.slice(marker.length).search(/\n {6}- (?:name:|uses:)/);
  return next === -1 ? rest : rest.slice(0, marker.length + next);
}

function bashBlockContaining(source: string, marker: string): string {
  const blocks = [...source.matchAll(/```bash\n([\s\S]*?)```/g)]
    .map((match) => match[1]);
  const block = blocks.find((candidate) => candidate.includes(marker));
  expect(block, `bash block containing ${marker}`).toBeDefined();
  return block!;
}

describe('CI test-runner routing', () => {
  it('routes every test, lint and check job through the resolved test runner', () => {
    const runsOn = [...ci.matchAll(/^ {4}runs-on: (.+)$/gm)].map((match) => match[1].trim());
    // Exactly one job may pin a hosted runner: the one that only resolves labels.
    const hosted = runsOn.filter((value) => !value.includes('needs.runner.outputs.labels'));
    expect(hosted).toEqual(['ubuntu-latest']);
    expect(jobBlock(ci, 'runner')).toContain('runs-on: ubuntu-latest');
  });

  it('falls back to hosted CI until the Pi readiness probe has passed', () => {
    const block = jobBlock(ci, 'runner');
    expect(block).toContain('vars.NEXUS_CI_TEST_RUNNER');
    expect(block).toContain('labels=["self-hosted","linux","ARM64","nexus-pi"]');
    expect(block).toContain('labels=["ubuntu-latest"]');
    // The Pi labels in CI must be the labels the readiness probe reports.
    expect(policy.piRunner.labels).toEqual(['self-hosted', 'linux', 'ARM64', 'nexus-pi']);
  });

  it('uses the persistent Pi only for trusted develop pushes', () => {
    const block = jobBlock(ci, 'runner');
    expect(block).toContain('EVENT_NAME: ${{ github.event_name }}');
    expect(block).toContain('EVENT_REF: ${{ github.ref }}');
    expect(block).toContain(
      'if [ "$EVENT_NAME" = "push" ] \\\n'
      + '              && [ "$EVENT_REF" = "refs/heads/develop" ] \\\n'
      + '              && [ "$SELECTION" = "pi" ]; then',
    );
    expect(block).not.toContain('refs/heads/main" ] && [ "$SELECTION" = "pi"');
    expect(block).not.toContain('EVENT_NAME" = "pull_request" ] && [ "$SELECTION" = "pi"');
  });

  it('asserts the self-hosted runner holds no deployment capability', () => {
    const block = jobBlock(ci, 'runner_guardrails');
    // The guard must NOT run repository code: a pull request could edit the probe
    // it is being checked by. It runs a root-owned host script, before any checkout.
    expect(block).not.toContain('actions/checkout');
    expect(block).toContain('/usr/local/sbin/nexus-pi-guardrails');
    // And it requires positive trust in the guard, not merely "the runner cannot
    // write it right now": root ownership, no group/other write bit on the file
    // or its parent directory, and not a symlink to something else.
    expect(block).toContain("stat -c '%u'");
    expect(block).toContain("stat -c '%a'");
    expect(block).toContain('guard parent directory');
    expect(block).toContain('is a symlink');
    // The guard STEP is self-hosted-only; the JOB always runs so a hosted
    // fallback cannot skip-propagate through `needs: runner_guardrails`.
    expect(block).toContain("needs.runner.outputs.is_self_hosted == 'true'");
    expect(block).toContain("needs.runner.outputs.is_self_hosted != 'true'");
    expect(policy.piRunner.forbiddenCapabilities).toEqual([
      'docker-socket',
      'production-secrets',
      'deploy-key',
      'production-audit-access',
    ]);
  });

  it('never grants the test workflow a registry credential, Docker, or a deploy path', () => {
    for (const forbidden of [
      'ghcr.io',
      'docker/login-action',
      'docker/build-push-action',
      'docker/setup-buildx-action',
      'packages: write',
      'NEXUS_RELEASE_MANIFEST_SIGNING_KEY',
      'release-poll.sh',
      'release-deploy.mjs',
    ]) {
      expect(ci, `ci.yml must not reference ${forbidden}`).not.toContain(forbidden);
    }
    // No ssh/rsync/scp path to the VPS either.
    expect(ci).not.toMatch(/\bssh\s|\brsync\b|\bscp\b/);
  });

  it('keeps the required aggregate check name stable', () => {
    expect(ci).toContain('name: 🧪 Tests');
  });

  it('binds lint/typecheck and build into the required aggregate context', () => {
    const aggregate = jobBlock(ci, 'test');
    const needs = aggregate.match(/^    needs: \[(.+)\]$/m)?.[1] ?? '';
    expect(needs.split(',').map((entry) => entry.trim())).toEqual(
      expect.arrayContaining(['lint', 'build']),
    );
    expect(aggregate).toContain('LINT_RESULT: ${{ needs.lint.result }}');
    expect(aggregate).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(aggregate).toContain('test "$LINT_RESULT" = "success"');
    expect(aggregate).toContain('test "$BUILD_RESULT" = "success"');
    expect(aggregate).toContain('test "$LINT_RESULT" = "skipped"');
    expect(aggregate).toContain('test "$BUILD_RESULT" = "skipped"');
    expect(aggregate).toContain('[ "$PROTECTED_MAIN" != "true" ]');
  });
});

describe('Pi runner readiness probe', () => {
  const source = readFileSync(join(root, 'scripts/pi-runner-readiness.mjs'), 'utf8');

  function runProbe(args: string[]) {
    return spawnSync(process.execPath, ['scripts/pi-runner-readiness.mjs', ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
    });
  }

  it('emits a governed JSON contract', () => {
    const result = runProbe(['--capabilities-only', '--json']);
    const payload = JSON.parse(result.stdout);
    expect(payload.schema).toBe('nexus.pi-runner-readiness.v1');
    expect(typeof payload.ok).toBe('boolean');
    expect(payload.expectedRunnerLabels).toEqual(policy.piRunner.labels);
    expect(Array.isArray(payload.checks)).toBe(true);
    // Exit code must track the verdict, because CI gates on it.
    expect(result.status).toBe(payload.ok ? 0 : 1);
  });

  it('asserts every forbidden capability the policy names', () => {
    const payload = JSON.parse(runProbe(['--capabilities-only', '--json']).stdout);
    const names = payload.checks.map((check: { name: string }) => check.name);
    for (const capability of policy.piRunner.forbiddenCapabilities) {
      expect(names).toContain(`absent_${capability.replace(/[^a-z0-9]+/gi, '_')}`);
    }
  });

  it('treats the co-hosted audit directory as an access boundary, not an absent path', () => {
    expect(source).toContain("capability === 'production-audit-access'");
    expect(source).toContain('fs.constants.R_OK');
    expect(source).toContain('fs.constants.W_OK');
    expect(source).toContain('fs.constants.X_OK');
    expect(source).toContain('policy.paths.stateDir');
    expect(source).not.toContain("'production-audit-path':");
  });

  it('denies all four split application env files to the runner account', () => {
    for (const environmentFile of [
      '/etc/nexus-release/production-backend.env',
      '/etc/nexus-release/production-content-engine.env',
      '/etc/nexus-release/staging-backend.env',
      '/etc/nexus-release/staging-content-engine.env',
    ]) {
      expect(source).toContain(environmentFile);
    }
  });

  it('skips hardware, egress and suite measurement under --capabilities-only', () => {
    const payload = JSON.parse(runProbe(['--capabilities-only', '--json']).stdout);
    const names = payload.checks.map((check: { name: string }) => check.name);
    // These are activation-time checks, not per-job checks.
    expect(names).not.toContain('usable_memory');
    expect(names).not.toContain('free_storage');
    expect(names).not.toContain('node_version');
    expect(names.filter((name: string) => name.startsWith('egress_'))).toEqual([]);
    const suite = payload.checks.find((check: { name: string }) => check.name === 'focused_suite_budget');
    expect(suite.result).toBe('skipped');
  });

  it('fails when the runner can reach a deployment capability', () => {
    // The probe reports a failed verdict rather than throwing, so CI shows which
    // capability leaked instead of an opaque crash.
    const payload = JSON.parse(runProbe(['--capabilities-only', '--json']).stdout);
    const dockerCheck = payload.checks.find(
      (check: { name: string }) => check.name === 'absent_docker_socket',
    );
    expect(['passed', 'failed']).toContain(dockerCheck.result);
    if (dockerCheck.result === 'failed') {
      expect(payload.ok).toBe(false);
      expect(dockerCheck.detail).toContain('/var/run/docker.sock');
    }
  });

  it('declares the activation thresholds the plan requires', () => {
    expect(policy.piRunner.requiredOs).toBe('linux');
    expect(policy.piRunner.requiredArch).toBe('aarch64');
    expect(policy.piRunner.minUsableMemoryGiB).toBe(6);
    expect(policy.piRunner.minFreeStorageGiB).toBe(20);
    expect(policy.piRunner.nodeVersion).toBe('22.23.1');
    expect(policy.piRunner.focusedSuiteBudgetSeconds).toBe(600);
    expect(policy.piRunner.requiredEgressHosts).toEqual([
      'github.com', 'api.github.com', 'registry.npmjs.org',
    ]);
  });
});

describe('CI latest-green concurrency', () => {
  it('cancels superseded runs on the same ref', () => {
    expect(ci).toMatch(/concurrency:\n\s+group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n\s+cancel-in-progress: true/);
  });

  it('lets every protected-main push immediately cancel an older publisher', () => {
    expect(release).toContain('push:\n    branches: [main]\n  workflow_run:');
    expect(release).toMatch(/concurrency:\n\s+group: release-publish-main\n\s+cancel-in-progress: true/);

    const superseder = jobBlock(release, 'supersede');
    expect(superseder).toContain("if: github.event_name == 'push'");
    expect(superseder).toContain('Cancel through the shared release concurrency group');
    expect(superseder).toContain('permissions: {}');
    expect(superseder).not.toContain('environment:');
    expect(superseder).not.toContain('${{ secrets.');

    const publisher = jobBlock(release, 'publish');
    expect(publisher).toContain("github.event_name == 'workflow_run'");
    expect(publisher).toContain("github.event.workflow_run.conclusion == 'success'");
  });
});

describe('release publication routing', () => {
  it('builds and signs only on separate hosted runners and asserts the image architecture', () => {
    const builder = jobBlock(release, 'build');
    const publisher = jobBlock(release, 'publish');
    expect(builder).toContain('runs-on: ubuntu-24.04');
    expect(publisher).toContain('runs-on: ubuntu-24.04');
    expect(publisher).toContain('needs: build');
    expect(builder).toContain("test \"$(uname -m)\" = 'x86_64'");
    expect(release).not.toContain('self-hosted');
  });

  it('publishes only after CI succeeded on protected main', () => {
    expect(release).toContain("workflows: ['CI — Risk-based parallel matrix']");
    // A privileged manual dispatch can run a branch-modified workflow. Release
    // authority comes only from the default-branch workflow_run definition.
    expect(release).not.toContain('workflow_dispatch');
    expect(jobBlock(release, 'build')).toContain("github.event_name == 'workflow_run'");
    expect(jobBlock(release, 'publish')).toContain("github.event_name == 'workflow_run'");
    expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(release).toContain("github.event.workflow_run.head_branch == 'main'");
    // Ancestry would admit every older green commit, turning republication into an
    // unaudited rollback path. The published commit must be the protected-main head.
    expect(release).not.toContain('git merge-base --is-ancestor "$SHA" origin/main');
    expect(release).toContain('test "$(git rev-parse origin/main)" = "$SHA"');
    expect(release).toContain("test \"$(echo \"$RUN_JSON\" | jq -r '.event')\" = 'push'");
    expect(release).toContain(
      "test \"${WORKFLOW_PATH%%@*}\" = '.github/workflows/ci.yml'",
    );
    expect(release).toContain("test \"$(echo \"$RUN_JSON\" | jq -r '.head_sha')\" = \"$SHA\"");
  });

  it('documents a live unattended signing-environment admission gate', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    expect(runbook).toContain('repos/$REPOSITORY/rules/branches/main');
    expect(runbook).toContain('.type == "pull_request"');
    expect(runbook).toContain('.type == "non_fast_forward"');
    expect(runbook).toContain('.type == "deletion"');
    expect(runbook).toContain('.context == "🧪 Tests"');
    expect(runbook).toContain('repos/$REPOSITORY/environments/release-publish');
    expect(runbook).toContain('.deployment_branch_policy.protected_branches == true');
    expect(runbook).toContain('.deployment_branch_policy.custom_branch_policies == false');
    expect(runbook).toContain('all(.protection_rules[]?; .type == "branch_policy")');
    expect(runbook).toContain('gh secret list --repo "$REPOSITORY" --env release-publish');
    expect(runbook).toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
  });

  it('produces both images plus the signed release payload', () => {
    for (const expected of [
      'Dockerfile.release.node',
      'Dockerfile.release.python',
      'Dockerfile.release.payload',
      'nexus-hub-backend',
      'nexus-hub-content-engine',
      'nexus-hub-release',
      'scripts/release-manifest-build.mjs',
    ]) {
      expect(release, expected).toContain(expected);
    }
    expect(release).toContain('platforms: linux/amd64');
  });

  it('publishes application images only under source-SHA tags', () => {
    const backend = stepBlock(release, 'Build and push the backend image');
    const contentEngine = stepBlock(release, 'Build and push the content-engine image');
    const payload = stepBlock(release, 'Build and push the release payload image');

    expect(backend).toContain(
      'nexus-hub-backend:${{ steps.source.outputs.sha }}',
    );
    expect(contentEngine).toContain(
      'nexus-hub-content-engine:${{ steps.source.outputs.sha }}',
    );
    expect(release).not.toContain('nexus-hub-backend:main');
    expect(release).not.toContain('nexus-hub-content-engine:main');
    expect(payload).toContain('nexus-hub-release:${{ needs.build.outputs.source_sha }}');
    expect(payload).toContain('nexus-hub-release:main');
  });

  it('installs dependencies and recomputes the full verdict before image publication', () => {
    const block = jobBlock(release, 'build');
    const installAt = block.indexOf('Install the exact host-side verification dependencies');
    const verificationAt = block.indexOf(
      'Recompute and bind the migration verdict without signing authority',
    );
    const registryLoginAt = block.indexOf('docker/login-action');
    const backendPublishAt = block.indexOf('Build and push the backend image');
    const contentPublishAt = block.indexOf('Build and push the content-engine image');
    expect(installAt).toBeGreaterThan(-1);
    expect(block.slice(installAt, verificationAt)).toContain('run: npm ci');
    expect(verificationAt).toBeGreaterThan(installAt);
    expect(registryLoginAt).toBeGreaterThan(verificationAt);
    expect(backendPublishAt).toBeGreaterThan(verificationAt);
    expect(contentPublishAt).toBeGreaterThan(verificationAt);
    expect(block).toContain('migration-safety-${{ steps.source.outputs.sha }}');
    expect(block).toContain('missing cdEligibility verdict');
    expect(block).toContain('scripts/release-manifest-build.mjs');
    // The exact multi-commit push boundary comes from GitHub-owned check-suite
    // metadata, never from an output produced by the selectable test runner.
    expect(block).toContain("'.before'");
    expect(block).toContain("'.after'");
    expect(block).toContain('checks: read');
    expect(block).toContain("--migration-base '${{ steps.source.outputs.migration_base }}'");
    expect(manifestBuilder).toContain('scripts/migration-safety-check.mjs');
    expect(manifestBuilder).toContain("'--changed-only'");
    expect(manifestBuilder).toContain("'--approval-mode', 'scan'");
    expect(manifestBuilder).toContain('deterministicVerdict');
    expect(manifestBuilder).toContain('does not match the hosted checkout recomputation');
  });

  it('keeps signing authority out of verification and digest-binds the later signer', () => {
    const verification = stepBlock(
      release,
      'Recompute and bind the migration verdict without signing authority',
    );
    const signer = stepBlock(release, 'Build and sign the release manifest');
    expect(verification).toContain('--verify-migration-only');
    expect(verification).toContain('echo "digest=$DIGEST" >> "$GITHUB_OUTPUT"');
    expect(verification).not.toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
    expect(verification).not.toContain('${{ secrets.');
    expect(signer).toContain(
      'NEXUS_RELEASE_MANIFEST_SIGNING_KEY: ${{ secrets.NEXUS_RELEASE_MANIFEST_SIGNING_KEY }}',
    );
    expect(signer).toContain('--hosted-migration-result');
    expect(signer).toContain('--hosted-migration-digest "$(node -e');
    expect(signer).toContain('signing-handoff-verification.json');
    expect(signer).not.toContain('--migration-result');
    expect(release.match(/^\s+NEXUS_RELEASE_MANIFEST_SIGNING_KEY:/gm)).toHaveLength(1);
    expect(release.match(/\$\{\{ secrets\.NEXUS_RELEASE_MANIFEST_SIGNING_KEY \}\}/g))
      .toHaveLength(1);
    expect(manifestBuilder).toContain(
      '--migration-result is accepted only in secretless verification mode',
    );
  });

  it('isolates the long-lived signing key from dependency and image build processes', () => {
    const builder = jobBlock(release, 'build');
    const publisher = jobBlock(release, 'publish');
    const signerAt = publisher.indexOf('Build and sign the release manifest');
    const beforeSigner = publisher.slice(0, signerAt);

    expect(builder).toContain('run: npm ci');
    expect(builder).not.toContain('environment:');
    expect(builder).not.toContain('release-publish');
    expect(builder).not.toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
    expect(publisher).toContain('environment:\n      name: release-publish');
    expect(publisher).toContain('needs: build');
    expect(signerAt).toBeGreaterThan(-1);
    expect(beforeSigner).not.toMatch(/\brun: npm\b|\bnpm ci\b|\bnpm install\b|\byarn\b|\bpnpm\b/);
    expect(beforeSigner).not.toContain('docker/build-push-action');
    expect(beforeSigner).not.toContain('docker/login-action');
    expect(beforeSigner).not.toMatch(/\b(?:nohup|setsid|disown)\b|(?<!&)&(?!&)/);
    expect([...beforeSigner.matchAll(/^\s+(?:- )?uses: ([^\s#]+)/gm)].map((match) => match[1]))
      .toEqual([
        'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
        'actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e',
        'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c',
      ]);

    const upload = stepBlock(release, 'Upload the immutable signing handoff');
    const download = stepBlock(release, 'Download the exact nonsecret signing handoff by artifact ID');
    const handoffVerification = stepBlock(
      release,
      'Verify the closed signing handoff before exposing the key',
    );
    expect(upload).toContain('path: .local/release/signing-handoff');
    expect(upload).toContain('include-hidden-files: true');
    expect(upload).toContain('if-no-files-found: error');
    expect(stepBlock(release, 'Build the digest-bound nonsecret signing handoff')).toContain(
      "--hosted-migration-digest '${{ steps.hosted_migrations.outputs.digest }}'",
    );
    expect(download).toContain('artifact-ids: ${{ needs.build.outputs.handoff_artifact_id }}');
    expect(download).toContain('merge-multiple: true');
    expect(handoffVerification).toContain('--expected-digest');
    expect(handoffVerification).toContain('test ! -e node_modules');
    expect(handoffVerification).not.toContain('${{ secrets.');

    // The only artifact parser run before the key is a built-in-only script. It
    // cannot execute handoff contents or leave a child process behind.
    expect(signingHandoff).toContain(
      "const EXPECTED_FILES = [COMPOSE_NAME, HOSTED_RESULT_NAME, MANIFEST_NAME]",
    );
    expect(signingHandoff).toContain("exactKeys(");
    expect(signingHandoff).toContain('O_NOFOLLOW');
    expect(signingHandoff).not.toMatch(/node:child_process|\bspawn(?:Sync)?\b|\bexec(?:File)?(?:Sync)?\b/);
    expect(signingHandoff).not.toMatch(/npm|postinstall|\.sh['"`]/);
  });

  it('publishes the release pointer last, after both images exist', () => {
    const builder = jobBlock(release, 'build');
    const publisher = jobBlock(release, 'publish');
    const backendAt = builder.indexOf('Build and push the backend image');
    const contentAt = builder.indexOf('Build and push the content-engine image');
    const handoffAt = builder.indexOf('Upload the immutable signing handoff');
    const preSignAt = publisher.indexOf(
      'Re-assert protected CI and main immediately before signing',
    );
    const signerAt = publisher.indexOf('Build and sign the release manifest');
    const prePointerAt = publisher.indexOf(
      'Re-assert protected-main head immediately before publishing the release pointer',
    );
    const payloadAt = publisher.indexOf('Build and push the release payload image');
    const signerStepAt = publisher.lastIndexOf('\n      - name:', signerAt);
    const payloadStepAt = publisher.lastIndexOf('\n      - name:', payloadAt);
    expect(backendAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(backendAt);
    expect(handoffAt).toBeGreaterThan(contentAt);
    expect(publisher).toContain('needs: build');
    expect(preSignAt).toBeGreaterThan(-1);
    expect(signerAt).toBeGreaterThan(preSignAt);
    expect(signerStepAt).toBeGreaterThan(preSignAt);
    expect(prePointerAt).toBeGreaterThan(signerAt);
    expect(payloadAt).toBeGreaterThan(prePointerAt);
    expect(payloadStepAt).toBeGreaterThan(prePointerAt);

    // Both authority checks are adjacent to the operation they guard. An early
    // main-head check is insufficient because image builds can outlive a newer
    // protected-main push.
    expect(publisher.slice(preSignAt, signerStepAt)).not.toMatch(/\n {6}- /);
    expect(publisher.slice(prePointerAt, payloadStepAt)).not.toMatch(/\n {6}- /);
    for (const stepName of [
      'Re-assert protected CI and main immediately before signing',
      'Re-assert protected-main head immediately before publishing the release pointer',
    ]) {
      const check = stepBlock(release, stepName);
      expect(check).toContain('git fetch --no-tags origin main');
      expect(check).toContain('test "$(git rev-parse origin/main)" = "$SHA"');
    }
  });

  it('does not claim an unavailable destructive-migration executor exists', () => {
    expect(release).toContain('container maintenance path is not implemented');
    expect(release).toContain('authorization, traffic drain, and database restore');
    expect(release).not.toContain('maintenance release handles the migration');
    expect(ci).toContain('maintenance executor is not implemented; owner policy is required');
    expect(ci).not.toContain('owner-authorized maintenance release;');
  });

  it('takes the signing key from the environment, never from argv', () => {
    expect(release).toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY: ${{ secrets.NEXUS_RELEASE_MANIFEST_SIGNING_KEY }}');
    expect(release).not.toMatch(/--signing-key/);
  });
});

describe('SonarQube decommissioning', () => {
  it('leaves no Sonar tooling in the repository', () => {
    const scripts = readdirSync(join(root, 'scripts'));
    expect(scripts.filter((name) => name.startsWith('quality-sonar'))).toEqual([]);
    expect(existsSync(join(root, 'ops/sonarqube'))).toBe(false);
  });

  it('removes every Sonar npm script', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(Object.keys(pkg.scripts).filter((name) => /sonar/i.test(name))).toEqual([]);
  });

  it('removes the Sonar coexistence gate from the release path', () => {
    const transaction = readFileSync(join(root, 'scripts/remote-user-release-transaction.sh'), 'utf8');
    expect(transaction).not.toMatch(/quality-sonar|sonarqube|sonar_(?:health|scan|gate)/i);
    // The shared maintenance mutex deliberately retains its historical path;
    // only the deleted Sonar executable/gate is forbidden.
    expect(transaction).toContain('MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock');
  });

  it('retains the shared root maintenance mutex under a non-Sonar owner', () => {
    // The lock name is historical; the mutual exclusion it provides between root
    // maintenance transactions is not about Sonar and must survive.
    const conf = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-maintenance-lock.conf'),
      'utf8',
    );
    expect(conf).toContain('/run/lock/nexus-release-sonar.lock');
    expect(conf).toMatch(/filename is historical/);
  });
});

describe('iOS decoupling from backend releases', () => {
  it('runs the six-example fixture test only for exact fixture owners', () => {
    const block = jobBlock(ci, 'ios_contract');
    expect(block).toContain("needs.classify.outputs.ios_contract == 'true'");
    expect(block).toContain('scripts/ios-contract-change-check.mjs');
    expect(policy.iosContractPaths).toEqual(iosContractOwners);

    for (const owner of iosContractOwners) {
      expect(classifyIosContract([owner])).toMatchObject({
        required: true,
        matchedPaths: [owner],
        watchedPrefixes: iosContractOwners,
      });
    }
  });

  it('does not claim fixture coverage for auth, push, health, or capabilities', () => {
    const unsupportedSurfaces = [
      'src/services/google-auth.ts',
      'src/services/apns-sender.ts',
      'src/portal/health-routes.ts',
      'config/capability-manifest.json',
    ];
    for (const path of unsupportedSurfaces) {
      expect(classifyIosContract([path])).toMatchObject({
        required: false,
        matchedPaths: [],
        watchedPrefixes: iosContractOwners,
      });
    }
    expect(iosContractClassifier).toContain('does not claim coverage for health, authentication, push/APNs');
    expect(continuousDeploymentDoc).toContain('It does not cover health, authentication, push/APNs');
  });

  it('does not label the shared-contract job as an iOS test run', () => {
    // The disclaimer lives in the comment banner immediately above the job, so
    // assert it against the workflow rather than the job body alone.
    expect(ci).toMatch(/NOT an iOS test run/);
    const block = jobBlock(ci, 'ios_contract');
    for (const forbidden of ['xcodebuild', 'simulator', 'TestFlight', 'macos-']) {
      expect(block.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('keeps no backend-triggered broad iOS release gate in the CI path', () => {
    expect(ci).not.toContain('shared-ios-release-gate');
  });
});

describe('release topology', () => {
  it('binds production and staging to distinct loopback ports', () => {
    expect(policy.environments.production.backendPort).toBe(8200);
    expect(policy.environments.production.contentEnginePort).toBe(8100);
    expect(policy.environments.staging.backendPort).toBe(8201);
    expect(policy.environments.staging.contentEnginePort).toBe(8101);

    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toContain('"127.0.0.1:${NEXUS_BACKEND_PORT');
    expect(compose).toContain('"127.0.0.1:${NEXUS_CONTENT_ENGINE_PORT');
  });

  it('reaches the content engine through service DNS, not a host port', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toContain('CONTENT_ENGINE_BASE_URL: "http://content-engine:8100"');
  });

  it('uses separate host-mounted databases and least-privilege env files per service', () => {
    expect(policy.environments.production.dataDir)
      .not.toBe(policy.environments.staging.dataDir);
    const environmentFiles = [
      policy.environments.production.backendEnvFile,
      policy.environments.production.contentEngineEnvFile,
      policy.environments.staging.backendEnvFile,
      policy.environments.staging.contentEngineEnvFile,
    ];
    expect(new Set(environmentFiles).size).toBe(4);
    for (const target of [policy.environments.production, policy.environments.staging]) {
      expect(target.backendEnvFile.startsWith('/etc/nexus-release/')).toBe(true);
      expect(target.contentEngineEnvFile.startsWith('/etc/nexus-release/')).toBe(true);
      expect(target.dataDir.startsWith('/var/lib/nexus-hub/')).toBe(true);
    }
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toContain('${NEXUS_DATA_DIR:?release data directory is required}:/app/data');
    expect(compose.split('${NEXUS_BACKEND_ENV_FILE:?root-owned backend env file is required}'))
      .toHaveLength(3);
    expect(compose.split(
      '${NEXUS_CONTENT_ENGINE_ENV_FILE:?root-owned content-engine env file is required}',
    )).toHaveLength(2);
    expect(compose).not.toContain('${NEXUS_ENV_FILE');
    expect(compose.split('STAGING: ${NEXUS_APP_STAGING:?exact staging identity is required}'))
      .toHaveLength(3);
    expect(compose).toContain('required: true');
    expect(compose.split('format: raw')).toHaveLength(4);
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    expect(runbook).toContain('/usr/bin/docker` + Compose >=2.30.0');
    expect(runbook).toContain('/usr/bin/docker compose version --short');
    expect(runbook).toContain('major === 2 && minor < 30');
  });

  it('defines the migrator as an explicit profile-gated one-shot service', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toMatch(/ {2}migrator:/);
    expect(compose).toContain('profiles:\n      - migrate');
    expect(compose).toContain('restart: "no"');
    expect(compose).toContain('dist/tools/run-release-migrations.js');
    // The migrator must not wait on the application containers: it runs while the
    // previous release is still serving.
    const migratorBlock = compose.slice(compose.indexOf('  migrator:'));
    expect(migratorBlock).not.toContain('depends_on');
  });

  it('pins images by digest through required environment variables', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toContain('${NEXUS_BACKEND_IMAGE:?');
    expect(compose).toContain('${NEXUS_CONTENT_ENGINE_IMAGE:?');
  });

  it('forbids the application from migrating at startup in a release container', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    expect(compose).toContain('MIGRATIONS_MODE: external');
    for (const requiredIdentity of [
      'NEXUS_RELEASE_ID: ${NEXUS_RELEASE_ID:?exact release ID is required}',
      'NEXUS_RELEASE_SOURCE_SHA: ${NEXUS_RELEASE_SOURCE_SHA:?exact release source SHA is required}',
      'NEXUS_RELEASE_BACKEND_DIGEST: ${NEXUS_RELEASE_BACKEND_DIGEST:?exact backend image digest is required}',
    ]) {
      // Both backend and migrator require the poller's exact signed identity;
      // even config/ps rendering cannot silently use mutable env-file defaults.
      expect(compose.split(requiredIdentity)).toHaveLength(3);
    }
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    for (const variable of [
      'NEXUS_RELEASE_ID',
      'NEXUS_RELEASE_SOURCE_SHA',
      'NEXUS_RELEASE_BACKEND_DIGEST',
    ]) {
      expect(runbook).toContain(`\`${variable}\``);
    }
    expect(runbook).toContain('are also poller-supplied and are forbidden');
    const dockerfile = readFileSync(join(root, 'Dockerfile.release.node'), 'utf8');
    expect(dockerfile).toContain('ENV MIGRATIONS_MODE=external');
    expect(dockerfile).toContain('COPY migrations ./migrations');
    expect(dockerfile).toContain('test -f dist/tools/run-release-migrations.js');
    // Only the migrator service runs in `boot` mode.
    const migratorBlock = compose.slice(compose.indexOf('  migrator:'));
    expect(migratorBlock).toContain('MIGRATIONS_MODE: boot');
  });

  it('runs the production images as a non-root user without dev dependencies', () => {
    const backend = readFileSync(join(root, 'Dockerfile.release.node'), 'utf8');
    expect(backend).toContain('USER nexus:nexus');
    expect(backend).toContain('npm ci --omit=dev');
    expect(backend).not.toContain('tsx watch');

    const contentEngine = readFileSync(join(root, 'Dockerfile.release.python'), 'utf8');
    expect(contentEngine).toContain('USER nexus:nexus');
    // Assert the executed command, not the prose: the header comment explains
    // why --reload is absent and would otherwise match a naive search.
    const contentCmd = contentEngine
      .split('\n')
      .filter((line) => line.startsWith('CMD ') || line.startsWith('ENTRYPOINT '))
      .join(' ');
    expect(contentCmd).toContain('uvicorn');
    expect(contentCmd).not.toContain('--reload');
  });

  it('packages the locked TypeScript validator required by runtime script generation', () => {
    const backend = readFileSync(join(root, 'Dockerfile.release.node'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    const scriptGeneration = readFileSync(
      join(root, 'src/services/script-generation.ts'),
      'utf8',
    );

    expect(scriptGeneration).toContain(
      "runValidator('npx', ['--no-install', 'tsc', '--noEmit', '--noCheck'",
    );
    expect(packageJson.dependencies.typescript).toBe('^5.9.3');
    expect(packageJson.devDependencies.typescript).toBeUndefined();
    expect(packageLock.packages['node_modules/typescript']).toMatchObject({
      version: '5.9.3',
    });
    expect(packageLock.packages['node_modules/typescript'].dev).not.toBe(true);
    expect(backend).toContain('npm ci --omit=dev');
    expect(backend).toContain('test -x node_modules/.bin/tsc');
  });

  it('packages the runtime script invoked by the daily tenant-isolation watcher', () => {
    const backend = readFileSync(join(root, 'Dockerfile.release.node'), 'utf8');
    const watcher = readFileSync(
      join(root, 'src/services/garmin-tenant-isolation-watcher.ts'),
      'utf8',
    );
    const runtimeScript = 'scripts/cleanup-tainted-garmin-sessions.mjs';

    expect(watcher).toContain(`process.cwd(), '${runtimeScript}'`);
    expect(backend).toContain(
      `COPY ${runtimeScript} ./${runtimeScript}`,
    );
    expect(readFileSync(join(root, runtimeScript), 'utf8')).toContain("require('better-sqlite3')");
  });

  it('packages every source path the runtime capability manifest validates', () => {
    const backend = readFileSync(join(root, 'Dockerfile.release.node'), 'utf8');
    const capabilityManifest = JSON.parse(readFileSync(
      join(root, 'config/capability-manifest.json'),
      'utf8',
    ));
    const schemaPaths = new Set<string>(Object.values(
      capabilityManifest.schemaReferences as Record<string, { path: string }>,
    ).map((reference) => reference.path));

    for (const schemaPath of schemaPaths) {
      expect(backend).toContain(`COPY ${schemaPath} ./${schemaPath}`);
    }
  });
});

describe('poller and timers', () => {
  it('serializes the poller with kernel flock through the wrapper', () => {
    const wrapper = readFileSync(join(root, 'scripts/release-poll.sh'), 'utf8');
    expect(wrapper).toContain('--nonblock');
    expect(wrapper).toContain('--conflict-exit-code 75');
    expect(wrapper).toContain('NEXUS_RELEASE_LOCK_HELD=1');
    expect(wrapper).toContain('scripts/release-deploy.mjs');
    expect(wrapper).not.toContain('NEXUS_RELEASE_LOCK_FILE');
    expect(wrapper).not.toContain('NEXUS_RELEASE_MAINTENANCE_LOCK_FILE');
    expect(wrapper).toContain("loadContinuousDeploymentPolicy('$ROOT').paths.lockFile");
    expect(wrapper).toContain(
      "loadContinuousDeploymentPolicy('$ROOT').paths.maintenanceLockFile",
    );
    expect(policy.paths.lockFile).toBe('/var/lib/nexus-release/locks/release.lock');
    expect(policy.paths.maintenanceLockFile).toBe('/run/lock/nexus-release-sonar.lock');
    expect(wrapper.indexOf('assert_lock_fd_matches_path 9 "$LOCK_FILE"'))
      .toBeLessThan(wrapper.indexOf('"$FLOCK_BIN" --nonblock --conflict-exit-code 75 9'));
    expect(wrapper.indexOf('"$FLOCK_BIN" --nonblock --conflict-exit-code 75 9'))
      .toBeLessThan(wrapper.lastIndexOf('assert_lock_fd_matches_path 9 "$LOCK_FILE"'));
    expect(wrapper.indexOf('assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"'))
      .toBeLessThan(wrapper.indexOf('"$FLOCK_BIN" --nonblock --conflict-exit-code 75 8'));
    expect(wrapper.indexOf('"$FLOCK_BIN" --nonblock --conflict-exit-code 75 8'))
      .toBeLessThan(wrapper.lastIndexOf('assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"'));
  });

  it('polls on the interval the policy declares', () => {
    const timer = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-poller.timer'),
      'utf8',
    );
    expect(timer).toContain(`OnUnitInactiveSec=${policy.timing.pollIntervalSeconds}`);
    // A missed window must not fire a burst of catch-up attempts.
    expect(timer).toContain('Persistent=false');
  });

  it('runs the poller as root with the deployment paths writable', () => {
    const unit = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-poller.service'),
      'utf8',
    );
    expect(unit).toContain('User=root');
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('NoNewPrivileges=yes');
    expect(unit).toContain('ReadOnlyPaths=/opt/nexus-release');
    expect(unit).toContain('ReadWritePaths=/var/lib/nexus-release /var/lib/nexus-hub');
    expect(unit).toContain('scripts/release-poll.sh');
  });

  it('scrubs the operator environment and forwards only declared values plus pinned dependencies', () => {
    const envExample = readFileSync(
      join(root, 'ops/nexus-release/poller.env.example'),
      'utf8',
    );
    const requiredExecAssignments = [
      'PATH=/usr/bin:/bin',
      'HOME=/var/lib/nexus-release/home',
      'DOCKER_CONFIG=/etc/nexus-release/docker',
      'NEXUS_RELEASE_NODE_BIN=/usr/bin/node',
      'NEXUS_RELEASE_GIT_BIN=/usr/bin/git',
      'NEXUS_RELEASE_FLOCK_BIN=/usr/bin/flock',
      'NEXUS_RELEASE_SYSTEMCTL_BIN=/usr/bin/systemctl',
      'NEXUS_RELEASE_DOCKER_BIN=/usr/bin/docker',
      'NEXUS_RELEASE_SQLITE_BIN=/usr/bin/sqlite3',
      'NEXUS_RELEASE_LSOF_BIN=/usr/bin/lsof',
      'NEXUS_RELEASE_SCP_BIN=/usr/bin/scp',
      'NEXUS_RELEASE_SSH_BIN=/usr/bin/ssh',
    ];
    for (const unitName of [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
    ]) {
      const unit = readFileSync(join(root, 'ops/nexus-release', unitName), 'utf8');
      const execStart = unit.match(/^ExecStart=(.+)$/m)?.[1] ?? '';
      expect(unit).toContain('EnvironmentFile=-/etc/nexus-release/poller.env');
      expect(unit.indexOf('EnvironmentFile=-/etc/nexus-release/poller.env'))
        .toBeLessThan(unit.indexOf('ExecStart=/usr/bin/env -i '));
      expect(unit).toContain(
        'UnsetEnvironment=LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG LD_PROFILE',
      );
      expect(execStart).toMatch(/^\/usr\/bin\/env -i /);
      for (const assignment of requiredExecAssignments) {
        expect(execStart).toContain(assignment);
      }
      for (const operatorAssignment of [
        'NEXUS_RELEASE_AUDIT_MIRROR_HOST=${NEXUS_RELEASE_AUDIT_MIRROR_HOST}',
        'NEXUS_RELEASE_TELEGRAM_BOT_TOKEN=${NEXUS_RELEASE_TELEGRAM_BOT_TOKEN}',
        'NEXUS_RELEASE_TELEGRAM_CHAT_ID=${NEXUS_RELEASE_TELEGRAM_CHAT_ID}',
      ]) {
        expect(execStart).toContain(operatorAssignment);
      }
      for (const execStartPre of unit.matchAll(/^ExecStartPre=(.+)$/gm)) {
        expect(execStartPre[1]).toMatch(/^\/usr\/bin\/env -i /);
      }
    }
    for (const forbiddenOverride of [
      'NEXUS_RELEASE_LOCK_FILE=',
      'NEXUS_RELEASE_MAINTENANCE_LOCK_FILE=',
      'NEXUS_RELEASE_NODE_BIN=',
      'NEXUS_RELEASE_FLOCK_BIN=',
      'NEXUS_RELEASE_SYSTEMCTL_BIN=',
      'NEXUS_RELEASE_DOCKER_BIN=',
      'NEXUS_RELEASE_SQLITE_BIN=',
      'NEXUS_RELEASE_LSOF_BIN=',
      'NEXUS_RELEASE_SCP_BIN=',
      'NEXUS_RELEASE_SSH_BIN=',
    ]) {
      expect(envExample).not.toContain(forbiddenOverride);
    }
    expect(envExample.split('\n')
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf('='))))
      .toEqual([
        'NEXUS_RELEASE_AUDIT_MIRROR_HOST',
        'NEXUS_RELEASE_TELEGRAM_BOT_TOKEN',
        'NEXUS_RELEASE_TELEGRAM_CHAT_ID',
      ]);
  });

  it('pins one first-install order and installs trust only from the immutable checkout', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const orderStart = runbook.indexOf('## Canonical first-install order');
    const orderEnd = runbook.indexOf('## 0. Host prerequisites');
    expect(orderStart).toBeGreaterThanOrEqual(0);
    expect(orderEnd).toBeGreaterThan(orderStart);
    const order = runbook.slice(orderStart, orderEnd);
    const keyCreation = order.indexOf('generate the signing pair');
    const controlPlane = order.indexOf('initial control-plane install');
    const hostTrust = order.indexOf('committed public pin');
    const databaseTransition = order.indexOf('quiesced database transition');
    const bootstrap = order.indexOf('non-enabled bootstrap one-shot');
    expect(keyCreation).toBeGreaterThanOrEqual(0);
    expect(keyCreation).toBeLessThan(controlPlane);
    expect(controlPlane).toBeLessThan(hostTrust);
    expect(hostTrust).toBeLessThan(databaseTransition);
    expect(databaseTransition).toBeLessThan(bootstrap);
    expect(order).toMatch(/Only then enable the ordinary\s+poller timer/);

    expect(runbook).toContain(
      '/opt/nexus-release/checkout/docs/release/evidence/release-manifest-public-key.pem',
    );
    expect(runbook).not.toContain(
      '/opt/nexus-release/docs/release/evidence/release-manifest-public-key.pem',
    );
  });

  it('provisions an exact immutable host control plane before any root unit can run it', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const provision = bashBlockContaining(runbook, 'CONTROL-PLANE PROVISION REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: provision, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(provision.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(provision).toContain("test \"$EUID\" -eq 0 || die 'run the complete transaction");
    expect(provision).toContain(
      "SOURCE_REPOSITORY='https://github.com/felipedrf74/cortex-telegram-hub-bot.git'",
    );
    expect(provision).toContain("SOURCE_REF='refs/heads/main'");
    expect(provision).toContain('[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(provision).toContain("fetch --quiet --no-tags --depth=1 \\\n  origin \"$SOURCE_REF\"");
    expect(provision).toContain('test "$FETCHED_SHA" = "$SOURCE_SHA"');
    expect(provision).toContain('test "$(/usr/bin/node --version)" = v22.23.1');
    expect(provision).toContain(
      'sudo install -d -o root -g root -m 711 "$CONTROL_ROOT"',
    );
    expect(provision).toContain(
      'sudo install -d -o root -g "$BUILD_GID" -m 710 "$STAGING_ROOT"',
    );
    expect(provision).toContain(
      'sudo install -d -o root -g root -m 700 "$VERSION_ROOT"',
    );
    expect(provision).toContain(
      `test "$(sudo stat -c '%U:%G:%a' -- "$CONTROL_ROOT")" = root:root:711`,
    );
    expect(provision).toContain(
      `test "$(sudo stat -c '%U:%g:%a' -- "$STAGING_ROOT")" = "root:$BUILD_GID:710"`,
    );
    expect(provision).toContain(
      `test "$(sudo stat -c '%U:%G:%a' -- "$VERSION_ROOT")" = root:root:700`,
    );
    expect(provision).toContain('sudo -u dominguez test -x "$CONTROL_ROOT"');
    expect(provision).toContain('sudo -u dominguez test -x "$CONTROL_ROOT/pm2"');
    expect(provision).not.toContain(
      'sudo install -d -o root -g "$BUILD_GID" -m 710 "$CONTROL_ROOT"',
    );
    const asBuilderStart = provision.indexOf('as_builder() {');
    const asBuilderEnd = provision.indexOf('\n}\n\nrequire_safe_candidate_tree', asBuilderStart);
    expect(asBuilderStart).toBeGreaterThan(-1);
    expect(asBuilderEnd).toBeGreaterThan(asBuilderStart);
    const asBuilder = provision.slice(asBuilderStart, asBuilderEnd);
    expect(asBuilder).toContain('/usr/bin/systemd-run \\');
    expect(asBuilder).toContain('--wait --pipe --quiet --collect \\');
    expect(asBuilder).toContain('--property=Type=exec \\');
    expect(asBuilder).toContain('--property=User="$BUILD_USER" \\');
    expect(asBuilder).toContain('--property=Group="$BUILD_GID" \\');
    expect(asBuilder).toContain('--property=KillMode=control-group \\');
    expect(asBuilder).toContain('--property=SendSIGKILL=yes \\');
    expect(asBuilder).toContain('--property=RemainAfterExit=no \\');
    expect(asBuilder).toContain('--property=ProtectControlGroups=yes \\');
    expect(asBuilder).toContain('--property=ReadWritePaths="$STAGE_DIR" \\');
    expect(asBuilder).not.toContain('sudo -u "$BUILD_USER"');
    expect(provision).toContain('/usr/bin/pgrep -u "$BUILD_UID"');
    expect(provision).toContain("*) die 'cannot prove the dedicated build account is quiescent'");
    expect(provision).toContain('/usr/bin/lsof -nP -F pfn +D "$candidate"');
    expect(provision).toContain("test \"$handle_status\" -eq 1 \\\n    || die 'cannot prove the candidate has no open handles'");
    expect(provision).toContain("die 'open-handle proof emitted diagnostics'");
    const builderPreflight = provision.indexOf(
      'if test "$CONTROL_PLANE_MODE" != rollback; then require_no_builder_processes; fi',
    );
    expect(builderPreflight).toBeGreaterThan(-1);
    expect(builderPreflight).toBeLessThan(provision.indexOf('if test "$RESUME_TRANSACTION" -eq 1; then'));
    const builderQuiescence = provision.lastIndexOf(
      'require_builder_quiescent "$STAGE_DIR"',
    );
    expect(builderQuiescence)
      .toBeGreaterThan(provision.indexOf('require_safe_candidate_tree "$STAGE_DIR"'));
    expect(builderQuiescence)
      .toBeLessThan(provision.indexOf('MARKER_TMP="$(mktemp)"'));
    expect(builderQuiescence)
      .toBeLessThan(provision.indexOf('sudo chown -hR root:root "$STAGE_DIR"'));

    expect(provision).toContain('FORBID_UNTRACKED_MARKER=0');
    const preLifecycleGit = provision.indexOf(
      'require_builder_git_exact "$STAGE_DIR" "$FORBID_UNTRACKED_MARKER"',
    );
    const sourceCapture = provision.indexOf('source_tree_manifest create "$STAGE_DIR"');
    const lifecycle = provision.indexOf('npm --prefix "$STAGE_DIR" ci');
    const postLifecycleGit = provision.lastIndexOf(
      'require_builder_git_exact "$STAGE_DIR" "$FORBID_UNTRACKED_MARKER"',
    );
    const sourceReproof = provision.indexOf('source_tree_manifest verify "$STAGE_DIR"');
    const retireGit = provision.indexOf('as_builder /usr/bin/rm -rf -- "$STAGE_DIR/.git"');
    expect(preLifecycleGit).toBeGreaterThan(-1);
    expect(preLifecycleGit).toBeLessThan(sourceCapture);
    expect(sourceCapture).toBeLessThan(lifecycle);
    expect(lifecycle).toBeLessThan(postLifecycleGit);
    expect(postLifecycleGit).toBeLessThan(sourceReproof);
    expect(sourceReproof).toBeLessThan(retireGit);
    expect(provision).toContain('cannot rebind candidate HEAD after lifecycle execution');
    expect(provision).toContain('update-index --really-refresh');
    expect(provision).toContain('diff-index --cached --quiet');
    expect(provision).toContain('candidate index contains a non-canonical entry flag');
    expect(provision).toContain('pre-lifecycle source-tree manifest');
    expect(provision).toContain('.nexus-control-plane-source-tree.json');
    expect(provision).toContain('.nexus-control-plane-tree.sha256');
    expect(provision).toContain('find "$candidate" -xdev ! -type l -perm /222');
    expect(provision).not.toContain('find "$candidate" -xdev -perm /222');
    expect(provision).not.toContain('done < <(as_builder /usr/bin/git');
    expect(provision).toContain('npm --prefix "$STAGE_DIR" ci');
    expect(provision).toContain('--omit=dev --no-audit --no-fund');
    expect(provision).toContain('node_modules/better-sqlite3/package.json');

    const controlLock = provision.indexOf('exec 7<>"$CONTROL_PLANE_LOCK"');
    const resumeAdmission = provision.indexOf('RESUME_TRANSACTION=0');
    const buildFetch = provision.indexOf('fetch --quiet --no-tags --depth=1');
    expect(controlLock).toBeGreaterThan(-1);
    expect(controlLock).toBeLessThan(resumeAdmission);
    expect(resumeAdmission).toBeLessThan(buildFetch);
    expect(provision).toContain('nexus.control-plane-transaction.v1');
    expect(provision).toContain('keys == ["candidateDigest","createdAt","expectedMarker"');
    expect(provision).toContain("root:root:600:1");
    expect(provision).toContain('sync -f "$TRANSACTION_STATE"; sync -f "$STATE_ROOT"');
    expect(provision).not.toContain('source "$TRANSACTION_STATE"');
    expect(provision).not.toContain('eval ');
    expect(provision).toContain('staging and immutable version roots are not on the same filesystem');
    expect(provision).toContain('STAGE_IDENTITY="$(stat -Lc \'%d:%i\' -- "$STAGE_DIR")"');
    expect(provision).toContain('candidate staging inode changed');
    expect(provision).toContain('both staged and immutable candidate paths exist');
    expect(provision).toContain('require_initial_no_authority()');
    expect(provision).toContain(
      '/usr/bin/env -i PATH=/usr/bin:/bin \\\n      /usr/bin/systemd-analyze unit-paths',
    );
    expect(provision).toContain('initial mode found physical release-unit definition');
    expect(provision).toContain('nexus-release-.service.d nexus-.service.d service.d');
    expect(provision).toContain('nexus-release-.timer.d nexus-.timer.d timer.d');
    expect(provision).toContain('--property=FragmentPath --value');
    expect(provision).toContain('--property=DropInPaths --value');
    expect(provision).toContain('require_exact_effective_systemd_units()');
    expect(provision).toContain('effective release-unit authority is not exact');
    expect(provision.match(/^\s*require_initial_no_authority$/gm)).toHaveLength(2);
    expect(provision).toContain('require_installed_transaction_gate()');
    expect(provision).toContain(
      'installed service cannot honor the durable transaction gate',
    );

    const prepared = provision.indexOf('publish_transaction_phase prepared');
    const candidateSync = provision.indexOf('sync -f "$RECORDED_STAGE_PATH"');
    const stagingParentSync = provision.indexOf('sync -f "$STAGING_ROOT"', candidateSync);
    const adoptedSync = provision.indexOf('sync -f "$TARGET"', candidateSync);
    const versionParentSync = provision.indexOf('sync -f "$VERSION_ROOT"', adoptedSync);
    const finalInitialReproof = provision.lastIndexOf('require_initial_no_authority');
    const disable = provision.indexOf(
      'systemctl disable --now nexus-release-poller.timer nexus-release-heartbeat.timer',
    );
    const candidateMove = provision.indexOf('mv -T -- "$RECORDED_STAGE_PATH" "$TARGET"');
    expect(prepared).toBeGreaterThan(-1);
    expect(candidateSync).toBeGreaterThan(-1);
    expect(candidateSync).toBeLessThan(stagingParentSync);
    expect(stagingParentSync).toBeLessThan(adoptedSync);
    expect(adoptedSync).toBeLessThan(versionParentSync);
    expect(versionParentSync).toBeLessThan(finalInitialReproof);
    expect(finalInitialReproof).toBeLessThan(prepared);
    expect(provision.indexOf('require_installed_transaction_gate', finalInitialReproof))
      .toBeLessThan(prepared);
    expect(provision.lastIndexOf('prove_installed_control_plane "$ORIGINAL_ACTIVE_PATH"', prepared))
      .toBeLessThan(prepared);
    expect(prepared).toBeLessThan(disable);
    expect(prepared).toBeLessThan(candidateMove);
    expect(provision).toContain('if test "$CONTROL_PLANE_MODE" != initial; then');
    expect(provision).toContain('exec 9<>"$RELEASE_LOCK"');
    expect(provision.indexOf('exec 9<>"$RELEASE_LOCK"'))
      .toBeLessThan(provision.indexOf('exec 8<>"$MAINTENANCE_LOCK"'));
    expect(provision).toContain('checkout.previous does not select the owner-reviewed rollback SHA');
    expect(provision).toContain('elif test "$CONTROL_PLANE_MODE" = rollback; then\n  STAGE_DIR=');
    expect(provision).toContain('read_timer_bits()');
    expect(provision).toContain('--property=LoadState --value');
    expect(provision).toContain('--property=ActiveState --value');
    expect(provision).toContain('--property=UnitFileState --value');
    expect(provision).toContain('timer unit-file state is not admissible');

    const previousPhase = provision.indexOf('publish_transaction_phase previous_selected');
    const activePhase = provision.indexOf('publish_transaction_phase active_selected');
    const capabilitiesPhase = provision.indexOf('publish_transaction_phase capabilities_installed');
    const reloadPhase = provision.indexOf('publish_transaction_phase units_reloaded');
    const timersPhase = provision.indexOf('publish_transaction_phase timers_restored');
    const completePhase = provision.indexOf('publish_transaction_phase complete');
    const retireGate = provision.indexOf('rm -f -- "$TRANSACTION_STATE"');
    expect(candidateMove).toBeLessThan(previousPhase);
    expect(previousPhase).toBeLessThan(activePhase);
    expect(activePhase).toBeLessThan(capabilitiesPhase);
    expect(capabilitiesPhase).toBeLessThan(reloadPhase);
    expect(reloadPhase).toBeLessThan(timersPhase);
    expect(timersPhase).toBeLessThan(completePhase);
    expect(completePhase).toBeLessThan(retireGate);
    expect(provision).toContain('install_atomic_root_file()');
    expect(provision).toContain('selector staging remnant is unsafe');
    expect(provision).toContain('systemctl daemon-reload');
    const installedDaemonReload = provision.lastIndexOf('systemctl daemon-reload', reloadPhase);
    const effectiveUnitProof = provision.indexOf(
      'require_exact_effective_systemd_units',
      installedDaemonReload,
    );
    expect(installedDaemonReload).toBeGreaterThan(capabilitiesPhase);
    expect(installedDaemonReload).toBeLessThan(effectiveUnitProof);
    expect(effectiveUnitProof).toBeLessThan(reloadPhase);
    expect(provision.lastIndexOf('require_exact_effective_systemd_units'))
      .toBeLessThan(retireGate);
    expect(provision).toContain('require_installed_transition_bytes()');
    expect(provision).toContain('systemctl start nexus-release-poller.timer');
    expect(provision).toContain('systemctl start nexus-release-heartbeat.timer');
    expect(provision).toContain('prove_installed_control_plane "$TARGET"');
    expect(provision.lastIndexOf('require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"'))
      .toBeLessThan(retireGate);
    expect(provision.lastIndexOf('read_timer_bits nexus-release-heartbeat.timer'))
      .toBeLessThan(retireGate);
    expect(provision.indexOf('TIMER_FAILSAFE_ARMED=0')).toBeLessThan(retireGate);
    expect(provision.indexOf('sync -f "$STATE_ROOT"', retireGate)).toBeGreaterThan(retireGate);
    expect(provision).not.toContain('sudo mv "$STAGE_DIR" "$VERSION_ROOT/$SOURCE_SHA"');
    expect(provision).not.toContain('CONTROL-PLANE ROLLBACK REFUSED');
    expect(runbook).toContain('Rollback uses the same durable transaction above');
    expect(runbook).toContain('CONTROL_PLANE_MODE=rollback');
    expect(provision).not.toContain('systemctl start nexus-release-bootstrap.service');
    expect(provision).not.toContain('systemctl enable nexus-release-bootstrap.service');

    const unitNames = [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
      'nexus-release-heartbeat.service',
    ];
    for (const unitName of unitNames) {
      const unit = readFileSync(join(root, 'ops/nexus-release', unitName), 'utf8');
      expect(unit).toContain(
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-transaction.json',
      );
      expect(unit).toContain(
        'ExecStartPre=/usr/bin/env -i PATH=/usr/bin:/bin /usr/bin/test -f '
        + '/opt/nexus-release/checkout/.nexus-control-plane-ready',
      );
      expect(unit).toContain(
        'ExecStartPre=/usr/bin/env -i PATH=/usr/bin:/bin '
        + 'HOME=/var/lib/nexus-release/home /usr/bin/node -e '
        + "\"if (process.version !== 'v22.23.1') process.exit(1)\"",
      );
      expect(unit).toContain('ReadOnlyPaths=/opt/nexus-release');
      expect(unit).not.toContain('[Install]');
    }

    for (const unitName of [
      'nexus-release-bootstrap.service',
      'nexus-release-poller.service',
    ]) {
      const unit = readFileSync(join(root, 'ops/nexus-release', unitName), 'utf8');
      expect(unit).toContain("require('/opt/nexus-release/checkout/node_modules/better-sqlite3')");
      expect(unit).toContain('/usr/bin/env -i PATH=/usr/bin:/bin');
      expect(unit).toContain('NEXUS_RELEASE_NODE_BIN=/usr/bin/node');
      expect(unit).toContain('NEXUS_RELEASE_FLOCK_BIN=/usr/bin/flock');
      expect(unit).toContain('NEXUS_RELEASE_GIT_BIN=/usr/bin/git');
    }
    const pollerEnv = readFileSync(
      join(root, 'ops/nexus-release/poller.env.example'),
      'utf8',
    );
    const heartbeat = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-heartbeat.service'),
      'utf8',
    );
    expect(heartbeat).toContain(
      'ExecStart=/usr/bin/env -i PATH=/usr/bin:/bin HOME=/var/lib/nexus-release/home '
      + 'NEXUS_RELEASE_TELEGRAM_BOT_TOKEN=${NEXUS_RELEASE_TELEGRAM_BOT_TOKEN} '
      + 'NEXUS_RELEASE_TELEGRAM_CHAT_ID=${NEXUS_RELEASE_TELEGRAM_CHAT_ID} '
      + '/usr/bin/node /opt/nexus-release/checkout/scripts/release-heartbeat.mjs',
    );
    expect(heartbeat.match(/^ExecStart=(.+)$/m)?.[1]).not.toContain('AUDIT_MIRROR_HOST');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_NODE_BIN=');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_FLOCK_BIN=');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_GIT_BIN=');
    expect(runbook).not.toContain('sudo npm --prefix /opt/nexus-release/checkout');
  });

  it('installs only an argument-free, env-scrubbed release state sudo capability', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const operatorSkill = readFileSync(
      join(root, '.agents/skills/release-operator/SKILL.md'),
      'utf8',
    );
    const wrapper = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-state-view'),
      'utf8',
    );
    const sudoers = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-state-view.sudoers'),
      'utf8',
    );

    expect(wrapper).toContain('if [ "$#" -ne 0 ]; then');
    expect(wrapper).toContain('exec /usr/bin/env -i');
    expect(wrapper).toContain('/opt/nexus-release/checkout/scripts/release-state-view.mjs');
    expect(wrapper).not.toMatch(/release-(?:acknowledge|deploy|bootstrap-baseline)\.mjs/);
    expect(sudoers.trim()).toBe(
      'Cmnd_Alias NEXUS_RELEASE_STATE_VIEW = /usr/local/sbin/nexus-release-state-view\n'
      + 'dominguez ALL=(root) NOPASSWD: NEXUS_RELEASE_STATE_VIEW',
    );
    expect(runbook).toContain('sudo /usr/sbin/visudo -cf "$STATE_VIEW_SUDOERS_SOURCE"');
    expect(runbook).toContain('sudo /usr/sbin/visudo -cf /etc/sudoers.d/nexus-release-state-view');
    expect(runbook).toContain('sudo install -o root -g root -m 755 --');
    expect(runbook).toContain('sudo install -o root -g root -m 440 --');
    expect(runbook).toContain('/usr/bin/cmp -s --');
    expect(runbook).toContain("/usr/local/sbin/nexus-release-state-view)\" = root:root:755:1");
    expect(runbook).toContain("/etc/sudoers.d/nexus-release-state-view)\" = root:root:440:1");
    expect(runbook).toContain(
      'sudo -u dominguez sudo -n /usr/local/sbin/nexus-release-state-view >/dev/null',
    );
    expect(runbook).toContain(
      '`ssh ServerDominguez sudo -n /usr/local/sbin/nexus-release-state-view`',
    );
    expect(operatorSkill).toContain(
      '/usr/bin/ssh ServerDominguez \\\n  sudo -n /usr/local/sbin/nexus-release-state-view',
    );
    expect(operatorSkill).toContain('/usr/bin/ssh -t ServerDominguez');
    expect(operatorSkill).toContain('sudo /usr/bin/env -i PATH=/usr/bin:/bin');
    expect(operatorSkill).not.toContain('sudo env PATH=');
  });

  it('migrates legacy secrets into four fail-closed service-scoped env files', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const split = bashBlockContaining(runbook, 'ENVIRONMENT SPLIT REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: split, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(split.trimStart()).toMatch(/^set -euo pipefail\n/);
    for (const environmentFile of [
      '/etc/nexus-release/production-backend.env',
      '/etc/nexus-release/production-content-engine.env',
      '/etc/nexus-release/staging-backend.env',
      '/etc/nexus-release/staging-content-engine.env',
    ]) {
      expect(split).toContain(environmentFile);
    }
    expect(split).toContain('ENV_SPLIT_TARGETS_OWNED=1');
    expect(split).toContain('ENV_SPLIT_TARGETS_OWNED=0');
    expect(split).toContain('NEXUS_RELEASE_PLAN_DIR');
    expect(split).toContain('key ~ /^(DYLD_|LD_|NODE_)/');
    expect(split).toContain('OPENSSL_CONF|SSL_CERT_DIR|SSL_CERT_FILE');
    expect(split).toContain('CONTENT_ENGINE_RESEARCH_NETWORK_DISABLED');
    expect(split).toContain('createReleaseEnvironmentGate');
    expect(split).toContain('gate.verify("staging")');
    expect(split).toContain('gate.verify("production")');
    expect(split).toContain("stat -Lc '%U:%G:%a:%h'");
    expect(split).not.toMatch(/(?:cat|printf|echo).*INTERNAL_API_SECRET/);
  });

  it('provisions both PM2 databases through a syntactically valid fail-closed transaction', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const cutover = bashBlockContaining(runbook, 'CUTOVER REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: cutover, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(cutover.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(cutover).not.toContain('|| :');
    expect(cutover).toContain('case "$lsof_status" in');
    expect(cutover).toContain('*) die "lsof failed with status $lsof_status"');
    expect(cutover).toContain('for suffix in -wal -shm -journal');
    expect(cutover).toContain("test \"$integrity\" = 'ok'");
    expect(cutover).toContain('test -z "$foreign_keys"');
    expect(cutover).toContain('production snapshot differs from the legacy production database');
    expect(cutover).toContain('staging snapshot differs from the legacy staging database');
    expect(cutover).toContain("stat -c '%d:%i'");
    expect(cutover).toContain('--property=Result --value');
    expect(cutover).toContain('.schema == "nexus.local-backup.v1"');
    expect(cutover).toContain('.status == "passed"');
    expect(cutover).toContain('.kind == "pre-promotion"');
    expect(cutover).toContain('.backupRoot == "/srv/nexus-backups/application"');
    expect(cutover).toContain('test("^[0-9a-f]{64}$")');
    expect(cutover).toContain('.startedAt | type == "string"');
    expect(cutover).toContain('BACKUP_PRODUCER_STARTED_MS');
    expect(cutover).toContain('date +%s%3N');
    expect(cutover).toContain('production container target already exists');
    expect(cutover.indexOf('production container target already exists'))
      .toBeLessThan(cutover.indexOf(".backup '$NEW_PRODUCTION/bot.db.next'"));
    expect(cutover).toContain('remove_proven_stale_wal_sidecars()');
    expect(cutover).toContain("test \"$checkpoint\" = '0|0|0'");
    expect(cutover).toContain("test \"$metadata\" = 'regular empty file:1:0'");
    expect(cutover).toContain('sudo rm -- "${stale_sidecars[@]}"');
    expect(cutover.indexOf('container-path backup unit failed'))
      .toBeLessThan(cutover.lastIndexOf('remove_proven_stale_wal_sidecars'));
    expect(cutover).toContain('systemctl disable --now "$UNIT"');
    expect(cutover).toContain('systemctl mask --runtime "$UNIT"');
    expect(cutover).toContain('require_pm2_guard');
    expect(cutover).toContain('require_no_legacy_listeners');
    expect(cutover).toContain('MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock');
    expect(cutover.indexOf('flock -n 9')).toBeLessThan(cutover.indexOf('flock -n 8'));
    expect(cutover).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(cutover).toContain('productionArtifactDigest');
    expect(cutover).toContain('productionDatabaseIdentity');
    expect(cutover.indexOf('RUNTIME_EVIDENCE_STAGE='))
      .toBeLessThan(cutover.indexOf('sudo -u dominguez pm2 stop'));
    expect(cutover).toContain('sudo sync -f "$RUNTIME_EVIDENCE_STAGE"');
    expect(cutover).toContain(
      'sudo mv -T -- "$RUNTIME_EVIDENCE_STAGE" "$RUNTIME_EVIDENCE"',
    );
    expect(cutover).toContain('sudo sync -f "$(dirname "$RUNTIME_EVIDENCE")"');
    expect(cutover.indexOf('sudo sync -f "$(dirname "$RUNTIME_EVIDENCE")"'))
      .toBeLessThan(cutover.indexOf('sudo -u dominguez pm2 stop'));
    expect(cutover).not.toContain('sudo ln "$RUNTIME_EVIDENCE_STAGE"');
    const preStopTargetGuard = 'container target exists before PM2 stop';
    expect(cutover).toContain(
      'for TARGET in "$NEW_PRODUCTION/bot.db" "$NEW_PRODUCTION/bot.db.next"',
    );
    expect(cutover).toContain('"$NEW_STAGING/bot.db" "$NEW_STAGING/bot.db.next"');
    expect(cutover.indexOf(preStopTargetGuard))
      .toBeLessThan(cutover.indexOf('sudo -u dominguez pm2 stop'));
    expect(cutover.indexOf('installed runtime tree differs from its captured artifact'))
      .toBeLessThan(cutover.indexOf('sudo -u dominguez pm2 stop'));
    expect(cutover).toContain('nexus.bootstrap-database-transition.v1');
    expect(cutover).toContain('sudo sync -f "$TRANSITION_EVIDENCE_STAGE"');
    expect(cutover).toContain(
      'sudo mv -T -- "$TRANSITION_EVIDENCE_STAGE" "$TRANSITION_EVIDENCE"',
    );
    expect(cutover).toContain('sudo sync -f "$(dirname "$TRANSITION_EVIDENCE")"');
    expect(cutover).not.toContain('sudo ln "$TRANSITION_EVIDENCE_STAGE"');
    expect(cutover).toContain('governed backup is not bound to legacy production before cutover');
  });

  it('binds bootstrap authority only after trust and registry setup', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const bootstrap = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-bootstrap.service'),
      'utf8',
    );
    const ordinary = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-poller.service'),
      'utf8',
    );
    const baseline = bashBlockContaining(runbook, 'BASELINE REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: baseline, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(baseline.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(baseline).toContain('DOCKER_CONFIG=/etc/nexus-release/docker');
    expect(baseline).toContain('.target.releasePayloadDigest');
    expect(baseline).toContain('.target.manifestDigest');
    expect(baseline).toContain('--expected-release-id "$EXPECTED_RELEASE_ID"');
    expect(baseline).toContain(
      '--expected-release-payload-digest "$EXPECTED_RELEASE_PAYLOAD_DIGEST"',
    );
    expect(baseline).toContain('bootstrap-legacy-runtime.json');
    expect(baseline).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(baseline).toContain('bootstrap-database-transition.json');
    expect(baseline).toContain('runtimeCaptureSha256 == $capture');
    expect(baseline).not.toContain('pm2 jlist');
    expect(runbook.indexOf('## 3. Registry access'))
      .toBeLessThan(runbook.indexOf('## 3a. Owner-authorized legacy migration baseline'));
    expect(runbook.indexOf('docker login ghcr.io'))
      .toBeLessThan(runbook.indexOf('release:cd:bootstrap-baseline --'));
    expect(runbook.indexOf('release:cd:bootstrap-baseline --'))
      .toBeLessThan(runbook.indexOf('sudo systemctl start nexus-release-bootstrap.service'));
    expect(runbook.indexOf('sudo systemctl start nexus-release-bootstrap.service'))
      .toBeLessThan(runbook.indexOf('sudo systemctl enable --now nexus-release-poller.timer'));

    expect(bootstrap).toContain(
      'ConditionPathExists=/var/lib/nexus-release/state/bootstrap-baseline.json',
    );
    expect(bootstrap).toContain(
      '/opt/nexus-release/checkout/scripts/release-poll.sh '
      + '--allow-first-container-bootstrap',
    );
    expect(ordinary).not.toContain('--allow-first-container-bootstrap');
  });

  it('provides a pre-baseline abort branch before baseline-dependent recovery', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const cutover = bashBlockContaining(runbook, 'CUTOVER REFUSED');
    const preBaseline = bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED');
    const laterRecovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: preBaseline, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(preBaseline.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(runbook.indexOf('PRE-BASELINE RECOVERY REFUSED'))
      .toBeLessThan(runbook.indexOf('BOOTSTRAP RECOVERY REFUSED'));
    expect(cutover.indexOf('RUNTIME_EVIDENCE_STAGE='))
      .toBeLessThan(cutover.indexOf('sudo -u dominguez pm2 stop'));
    expect(preBaseline).toContain('PRE_BASELINE_ACTION');
    expect(preBaseline).toContain('recover-pm2|resume-baseline|reset-cutover');
    expect(preBaseline).toContain('bootstrap baseline exists; use the baseline-dependent recovery branch');
    expect(preBaseline).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(preBaseline).toContain('productionMarkerSha256');
    expect(preBaseline).toContain('productionDatabaseIdentity');
    expect(preBaseline).toContain('verify_installed_runtime');
    expect(preBaseline).toContain('--verify-installed-source');
    expect(preBaseline).toContain('verify-extracted');
    expect(preBaseline).toContain('runtime selector changed under lock');
    expect(preBaseline).toContain('PM2_AUTHORITY_OR_DAEMON_ACTIVE=0');
    expect(preBaseline).toContain('PM2_CAPTURE_IDENTITY_PROVED=1');
    expect(preBaseline).toContain('length == 4');
    expect(preBaseline).toContain('PM2_CAPTURE_IDENTITY_PROVED=0');
    expect(preBaseline).toContain("pgrep -u dominguez -f 'PM2.*God Daemon'");
    expect(preBaseline).toContain(
      'if test "$PM2_AUTHORITY_OR_DAEMON_ACTIVE" -eq 1; then',
    );
    expect(preBaseline).toContain('systemctl mask --runtime "$UNIT"');
    expect(preBaseline).toContain(
      'active PM2 identity mismatched the capture; authorities are now guarded; rerun recovery',
    );
    expect(preBaseline.indexOf('PM2_AUTHORITY_OR_DAEMON_ACTIVE=0'))
      .toBeLessThan(preBaseline.indexOf('PM2_JSON="$(sudo -u dominguez pm2 jlist)"'));
    expect(preBaseline.indexOf('PM2_CAPTURE_IDENTITY_PROVED=0'))
      .toBeLessThan(preBaseline.indexOf('set +e'));
    expect(preBaseline.indexOf('set +e'))
      .toBeLessThan(preBaseline.indexOf('systemctl disable --now "$UNIT"'));
    expect(preBaseline.indexOf('\nrequire_pm2_guard\n'))
      .toBeLessThan(preBaseline.indexOf('active PM2 identity mismatched the capture'));
    expect(preBaseline).toContain('target may contain newer or divergent data; preserved untouched');
    expect(preBaseline).toContain('pre-baseline-reset');
    expect(preBaseline).toContain('reset archive differs from governed data');
    expect(preBaseline).toContain('retired transition archive differs from canonical evidence');
    expect(preBaseline).toContain('reset did not clear all section 1b target paths');
    expect(preBaseline).toContain('backup database path is outside the pre-baseline transaction');
    expect(preBaseline).toContain('resume requires the completed database-transition checkpoint');
    expect(preBaseline).toContain('continue with section 3a');
    expect(preBaseline).toContain('PM2_RESTART_ARMED=1');
    expect(preBaseline).toContain('fail_closed_pm2_restart');
    expect(preBaseline).toContain('restarted against a different database');
    expect(preBaseline).toContain('curl --fail --silent --show-error --max-time 5');
    expect(preBaseline).not.toContain('mv -f');
    expect(laterRecovery).toContain('BASELINE_FILE=');
  });

  it('requires a fresh delivered heartbeat proof before the first poller invocation', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const heartbeatProof = bashBlockContaining(runbook, 'HEARTBEAT LIVENESS REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: heartbeatProof, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(heartbeatProof.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(heartbeatProof).toContain('sudo systemctl start "$HEARTBEAT_UNIT"');
    expect(heartbeatProof).toContain('--property=Result --value');
    expect(heartbeatProof).toContain('--property=InvocationID --value');
    expect(heartbeatProof).toContain('sudo journalctl --sync');
    expect(heartbeatProof).toContain(
      'sudo journalctl "_SYSTEMD_INVOCATION_ID=$HEARTBEAT_INVOCATION_ID"',
    );
    expect(heartbeatProof).toContain('--output=json --no-pager --quiet');
    expect(heartbeatProof).toContain(
      'and keys == ["delivered", "reason", "schema"]',
    );
    expect(heartbeatProof).toContain('and .schema == "nexus.release-heartbeat.v1"');
    expect(heartbeatProof).toContain('and .delivered == true');
    expect(heartbeatProof).toContain('and .reason == "sent"');
    expect(heartbeatProof).toContain('test "$HEARTBEAT_EVIDENCE_COUNT" = 1');
    expect(heartbeatProof).toContain(
      'sudo systemctl start nexus-release-heartbeat.timer',
    );
    expect(heartbeatProof).not.toContain('NEXUS_RELEASE_TELEGRAM_');
    expect(heartbeatProof).not.toContain('/etc/nexus-release/poller.env');
    expect(heartbeatProof).not.toContain('set -x');

    const timerEnable = runbook.indexOf(
      'sudo systemctl enable nexus-release-heartbeat.timer',
    );
    const proofStart = runbook.indexOf('HEARTBEAT_UNIT=nexus-release-heartbeat.service');
    const heartbeatTimerStart = runbook.indexOf(
      'sudo systemctl start nexus-release-heartbeat.timer',
    );
    const bootstrapStart = runbook.indexOf(
      'sudo systemctl start nexus-release-bootstrap.service',
    );
    const pollerTimerEnable = runbook.indexOf(
      'sudo systemctl enable --now nexus-release-poller.timer',
    );
    expect(timerEnable).toBeGreaterThanOrEqual(0);
    expect(timerEnable).toBeLessThan(proofStart);
    expect(proofStart).toBeLessThan(heartbeatTimerStart);
    expect(heartbeatTimerStart).toBeLessThan(bootstrapStart);
    expect(bootstrapStart).toBeLessThan(pollerTimerEnable);
  });

  it('documents a fail-closed no-predecessor fallback and exact rebaseline branch', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const recovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');
    const rebaseline = bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED');
    for (const block of [recovery, rebaseline]) {
      const syntax = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(block.trimStart()).toMatch(/^set -euo pipefail\n/);
      expect(block).not.toContain('|| :');
      expect(block).toContain('for PROJECT in nexus-production nexus-staging');
    }

    expect(recovery).toContain('docker rm --force');
    expect(recovery).toContain('remove_proven_stale_wal_sidecars()');
    expect(recovery).toContain("test \"$checkpoint\" = '0|0|0'");
    expect(recovery).toContain('sudo test ! -e "$db-journal"');
    expect(recovery).toContain("test \"$metadata\" = 'regular empty file:1:0'");
    expect(recovery).toContain("test \"$metadata\" = 'regular file:1'");
    expect(recovery).toContain('sudo rm -- "${stale_sidecars[@]}"');
    const staleSidecarCleanup = 'remove_proven_stale_wal_sidecars '
      + '"$LIVE_PRODUCTION" "$LIVE_STAGING"';
    expect(recovery).toContain(staleSidecarCleanup);
    expect(recovery.indexOf('docker rm --force'))
      .toBeLessThan(recovery.indexOf(staleSidecarCleanup));
    expect(recovery.lastIndexOf(staleSidecarCleanup))
      .toBeGreaterThan(recovery.indexOf('docker rm --force'));
    expect(recovery).toContain(
      '"$LIVE_PRODUCTION:$INCIDENT_DIR/production-container.db:$LIVE_PRODUCTION_DIGEST"',
    );
    expect(recovery).toContain(
      '"$LIVE_STAGING:$INCIDENT_DIR/staging-container.db:$LIVE_STAGING_DIGEST"',
    );
    expect(recovery).toContain(".backup '$DESTINATION'");
    expect(recovery).toContain('PM2_NEXT="$PM2_PRODUCTION.next-bootstrap-recovery"');
    expect(recovery).toContain('production-pm2-next-$PM2_NEXT_SHA256.db');
    expect(recovery).toContain('.pm2NextArchives = (.pm2NextArchives // [])');
    expect(recovery).toContain('PM2 recovery temporary archive differs from guarded source');
    expect(recovery.indexOf('production-pm2-next-$PM2_NEXT_SHA256.db'))
      .toBeLessThan(recovery.indexOf('sudo rm -- "$PM2_NEXT"'));
    expect(recovery.indexOf('sudo rm -- "$PM2_NEXT"'))
      .toBeLessThan(recovery.indexOf(".backup '$PM2_NEXT'"));
    expect(recovery).toContain("= 'dominguez:dominguez:600:1'");
    expect(recovery).toContain('sudo mv -f -- "$PM2_NEXT" "$PM2_PRODUCTION"');
    expect(recovery).toContain('publish_recovery_state pm2_restored');
    expect(recovery).toContain('prove_durable_running_pm2');
    expect(recovery).toContain('publish_early_pm2_restored');
    expect(recovery).toContain('sudo sync -f "$(dirname "$RECOVERY_STATE")"');
    expect(recovery).toContain('PM2 fallback was already exact and healthy');
    expect(recovery).toContain('PM2_FORCED_GUARD=1');
    expect(recovery).toContain('set +e');
    expect(recovery).toContain(
      'interrupted-restart stage differs from guarded PM2 data',
    );
    expect(recovery).toContain('.interruptedRestartHistory = (.interruptedRestartHistory // [])');
    expect(recovery).toContain('publish_durable_recovery_state_stage()');
    const durableRecoveryState = recovery.slice(
      recovery.indexOf('publish_durable_recovery_state_stage()'),
      recovery.indexOf('append_interrupted_restart_history()'),
    );
    expect(durableRecoveryState.indexOf('sudo sync -f "$stage"'))
      .toBeLessThan(durableRecoveryState.indexOf('sudo mv -T -- "$stage" "$RECOVERY_STATE"'));
    expect(durableRecoveryState.indexOf('sudo mv -T -- "$stage" "$RECOVERY_STATE"'))
      .toBeLessThan(durableRecoveryState.indexOf('sudo sync -f "$RECOVERY_STATE"'));
    expect(durableRecoveryState.indexOf('sudo sync -f "$RECOVERY_STATE"'))
      .toBeLessThan(durableRecoveryState.indexOf('sudo sync -f "$(dirname "$RECOVERY_STATE")"'));
    expect(recovery).not.toContain('sudo mv -T -- "$state_stage" "$RECOVERY_STATE"');
    expect(recovery).not.toContain('sudo mv -T -- "$RECOVERY_STATE_STAGE" "$RECOVERY_STATE"');
    expect(recovery).not.toContain('sudo mv -T -- "$PM2_NEXT_STATE_STAGE" "$RECOVERY_STATE"');
    expect(recovery).not.toContain('sudo mv -T -- "$INTERRUPTED_STATE_STAGE" "$RECOVERY_STATE"');
    expect(recovery).toContain('retire_interrupted_restart_stages()');
    expect(recovery).toContain(
      '$role-pm2-interrupted-restart-$logical-$raw_sha.db',
    );
    expect(recovery).toContain('sudo ln -- "$stage" "$archive"');
    expect(recovery).toContain('sudo sync -f "$archive"');
    expect(recovery).toContain('append_interrupted_restart_history');
    expect(recovery.match(/publish_interrupted_restart_archive \\\n/g)).toHaveLength(2);
    expect(recovery.lastIndexOf('sudo sync -f "$archive"'))
      .toBeLessThan(recovery.lastIndexOf('append_interrupted_restart_history'));
    expect(recovery.indexOf('if prove_durable_running_pm2; then'))
      .toBeLessThan(recovery.indexOf('\nrequire_pm2_guard\n'));
    expect(recovery.indexOf('PM2_FORCED_GUARD=1'))
      .toBeLessThan(recovery.indexOf('\nrequire_pm2_guard\n'));
    expect(recovery).toContain('fresh_backup_for "$PM2_PRODUCTION"');
    expect(recovery).toContain('.schema == "nexus.local-backup.v1"');
    expect(recovery).toContain('.database == $expectedDatabase');
    expect(recovery).toContain('.startedAt | type == "string"');
    expect(recovery).toContain('test "$producer_started_ms" -ge "$requested_ms"');
    expect(recovery).toContain('pm2 start content-engine content-engine-staging');
    expect(recovery).toContain('pm2 start nexus-hub nexus-hub-staging');
    expect(recovery).toContain('.legacyRuntime.productionSourceSha');
    expect(recovery).toContain('.legacyRuntime.stagingSourceSha');
    expect(recovery).toContain('legacy runtime capture differs from the bootstrap baseline');
    expect(recovery.indexOf('legacy runtime capture differs from the bootstrap baseline'))
      .toBeLessThan(recovery.indexOf('systemctl unmask --runtime'));
    expect(recovery.indexOf('verify_installed_runtime "$EXPECTED_RUNTIME"'))
      .toBeLessThan(recovery.indexOf('systemctl unmask --runtime'));
    expect(recovery).toContain('restarted with a source SHA outside the bootstrap baseline');

    expect(rebaseline).toContain('nexus.bootstrap-rebaseline.v1');
    expect(rebaseline).toContain('test "$OLD_RELEASE_ID" != "$EXPECTED_RELEASE_ID"');
    expect(rebaseline.indexOf('test "$OLD_RELEASE_ID" != "$EXPECTED_RELEASE_ID"'))
      .toBeLessThan(rebaseline.indexOf('nexus.bootstrap-rebaseline.v1'));
    expect(rebaseline).toContain('fail_closed_rebaseline');
    expect(rebaseline.indexOf('trap fail_closed_rebaseline EXIT HUP INT TERM'))
      .toBeLessThan(rebaseline.lastIndexOf('systemctl disable --now pm2-dominguez.service'));
    expect(rebaseline).toContain('REBASELINE_PM2_LIVE=0');
    expect(rebaseline).toContain("pgrep -u dominguez -f 'PM2.*God Daemon'");
    expect(rebaseline).toContain('if test "$REBASELINE_PM2_LIVE" -eq 1; then');
    expect(rebaseline).toContain('PM2 daemon remains after rebaseline quiescence');
    expect(rebaseline).not.toContain('sudo -u dominguez pm2 stop');
    expect(rebaseline.indexOf('REBASELINE_PM2_LIVE=0'))
      .toBeLessThan(rebaseline.lastIndexOf('systemctl disable --now pm2-dominguez.service'));
    expect(rebaseline.indexOf('\nrequire_pm2_guard\n'))
      .toBeLessThan(rebaseline.indexOf('remove_proven_stale_wal_sidecars "$OLD_PRODUCTION"'));
    expect(rebaseline).toContain('targets_archived');
    expect(rebaseline).toContain('tree archive differs from source');
    expect(rebaseline).toContain(".backup '$PRODUCTION_NEXT'");
    expect(rebaseline).toContain(".backup '$STAGING_NEXT'");
    expect(rebaseline).toContain('BASELINE_ARCHIVE_DIR=');
    expect(rebaseline).toContain('--output-candidate');
    expect(rebaseline).toContain('require_baseline_shape "$CANDIDATE_BASELINE"');
    expect(rebaseline).toContain('sudo ln -- "$BASELINE_FILE" "$ARCHIVED_BASELINE"');
    expect(rebaseline).toContain('sudo mv -T -- "$CANDIDATE_BASELINE" "$BASELINE_FILE"');
    expect(rebaseline).not.toContain('sudo mv "$BASELINE_FILE" "$ARCHIVED_BASELINE"');
    expect(rebaseline.indexOf('require_baseline_shape "$CANDIDATE_BASELINE"'))
      .toBeLessThan(rebaseline.indexOf('sudo ln -- "$BASELINE_FILE" "$ARCHIVED_BASELINE"'));
    expect(rebaseline.indexOf('sudo ln -- "$BASELINE_FILE" "$ARCHIVED_BASELINE"'))
      .toBeLessThan(rebaseline.indexOf('sudo mv -T -- "$CANDIDATE_BASELINE" "$BASELINE_FILE"'));
    expect(rebaseline).toContain('DOCKER_CONFIG=/etc/nexus-release/docker');
    expect(rebaseline).toContain('--expected-release-id "$EXPECTED_RELEASE_ID"');
    expect(rebaseline).toContain('remove_proven_stale_wal_sidecars');
    expect(rebaseline).toContain('fresh_backup_for "$LIVE_PRODUCTION"');
    expect(rebaseline).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(rebaseline).toContain('nexus.bootstrap-database-transition.v1');
    expect(rebaseline).toContain('bootstrap-first-cutover-recovery.before.json');
    expect(rebaseline).toContain('install_or_verify_candidate()');
    expect(rebaseline).toContain('publish_or_verify_tree_archive()');
    expect(rebaseline).toContain('publish_durable_rebaseline_state_stage()');
    const durableRebaselineState = rebaseline.slice(
      rebaseline.indexOf('publish_durable_rebaseline_state_stage()'),
      rebaseline.indexOf('publish_rebaseline_phase()'),
    );
    expect(durableRebaselineState.indexOf('sudo sync -f "$stage"'))
      .toBeLessThan(
        durableRebaselineState.indexOf('sudo mv -T -- "$stage" "$REBASELINE_STATE"'),
      );
    expect(durableRebaselineState.indexOf('sudo mv -T -- "$stage" "$REBASELINE_STATE"'))
      .toBeLessThan(durableRebaselineState.indexOf('sudo sync -f "$REBASELINE_STATE"'));
    expect(durableRebaselineState.indexOf('sudo sync -f "$REBASELINE_STATE"'))
      .toBeLessThan(
        durableRebaselineState.indexOf('sudo sync -f "$(dirname "$REBASELINE_STATE")"'),
      );
    expect(rebaseline).not.toContain('sudo mv -T -- "$STATE_STAGE" "$REBASELINE_STATE"');
    expect(rebaseline).not.toContain('sudo mv -T -- "$state_stage" "$REBASELINE_STATE"');
    expect(rebaseline).toContain('sudo sync -f "$stage"');
    expect(rebaseline).toContain('sudo mv -T -- "$stage" "$candidate"');
    expect(rebaseline).toContain('sudo mv -T -- "$stage" "$archive"');
    expect(rebaseline).toContain('publish_rebaseline_phase complete');
  });

  it('prevents systemd from imposing an unsafe aggregate release deadline', () => {
    const bootstrap = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-bootstrap.service'),
      'utf8',
    );
    const ordinary = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-poller.service'),
      'utf8',
    );
    expect(bootstrap).toMatch(/^TimeoutStartSec=infinity$/m);
    expect(ordinary).toMatch(/^TimeoutStartSec=infinity$/m);
    expect(bootstrap).not.toMatch(/^TimeoutStartSec=\d+$/m);
    expect(ordinary).not.toMatch(/^TimeoutStartSec=\d+$/m);
  });

  it('schedules the weekly heartbeat the notifier liveness depends on', () => {
    const timer = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-heartbeat.timer'),
      'utf8',
    );
    expect(timer).toContain('OnCalendar=Mon 09:00');
    expect(policy.notifications.heartbeatEnabled).toBe(true);
    expect(policy.notifications.heartbeatSchedule).toBe('Mon 09:00');
  });

  it('keeps observation and rollback budgets aligned with the plan', () => {
    expect(policy.timing.observationSeconds).toBe(60);
    expect(policy.timing.rollbackObjectiveSeconds).toBe(120);
    expect(policy.registry.retainedImagePairs).toBe(2);
  });

  it('routes coding agents to unattended CD and the exact recovery commands', () => {
    const skill = readFileSync(
      join(root, '.agents/skills/release-operator/SKILL.md'),
      'utf8',
    );
    expect(skill).toContain('Default: unattended signed-container CD');
    expect(skill).toContain('run release:cd:ack -- --show');
    expect(skill).toContain('sudo /usr/bin/systemctl start nexus-release-poller.service');
    expect(skill).toContain('journalctl -u nexus-release-poller.service');
    expect(skill).toContain('run release:cd:ack -- --confirm <release-id>');
    expect(skill).toContain('ops/nexus-release/README.md#1b-quiesced-transition');
    for (const legacyCommand of [
      'npm run release:prepare',
      'npm run release:promote',
      'npm run release:chat-flags',
      'pm2 start',
    ]) {
      expect(skill).not.toContain(legacyCommand);
    }
  });

  it('documents the full incident and predecessor-switch clocks without ambiguity', () => {
    for (const file of [
      'docs/release/continuous-deployment.md',
      'docs/release/release-evidence-contract.md',
      'ops/nexus-release/README.md',
    ]) {
      const body = readFileSync(join(root, file), 'utf8');
      expect(body).toContain('incidentRecoveryDurationMs');
      expect(body).toContain('predecessorSwitchDurationMs');
      expect(body).toContain('predecessorSwitchObjectiveSeconds');
    }
  });
});

describe('migration verdict carries the signed inventory', () => {
  it('CI emits the inventory the manifest must bind', () => {
    // Without --emit-inventory the manifest cannot bind the ordered migration set,
    // and the deployment host has nothing to reconcile the ledger against.
    expect(ci).toContain('--emit-inventory');
    expect(ci).toContain('migration verdict carries no inventory');
  });

  it('keeps the default verdict small enough for ordinary pipe consumers', () => {
    // The full inventory is ~45 KiB. Emitting it by default pushed the payload past
    // the 64 KiB pipe buffer and truncated it for every execFileSync caller.
    const result = spawnSync(process.execPath, [
      'scripts/migration-safety-check.mjs', '--json',
      '--changed-only', '--approval-mode', 'scan',
      '--files', 'migrations/001_initial.sql',
    ], { cwd: root, encoding: 'utf8', timeout: 600_000 });
    expect(result.stdout.length).toBeLessThan(65536);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.migrationInventory).toBeNull();
    expect(parsed.cdEligibility).toBeDefined();
  });
});

describe('Sonar decommissioning is complete', () => {
  // A semantic sweep rather than a grep for the word "sonar": the failure mode is
  // an executable that invokes something deleted, or a document that tells an
  // operator to run a command that no longer exists.
  const DELETED_SONAR_PATHS = [
    'scripts/quality-sonar-scan.sh',
    'scripts/quality-sonar-release-state.sh',
    'scripts/quality-sonar-coverage-manifest.mjs',
    'scripts/quality-sonar-latency-gate.mjs',
    'scripts/quality-sonar-volume-identity.mjs',
    '/usr/local/sbin/quality-sonar-release-state',
    'ops/sonarqube/compose.yaml',
  ];

  function executableFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (['node_modules', '.git', 'dist', '.local'].includes(entry.name)) continue;
          walk(rel);
        } else if (/\.(mjs|sh|ts|js|yml|yaml)$/.test(entry.name)) {
          found.push(rel);
        }
      }
    };
    walk('scripts');
    walk('.github');
    return found;
  }

  it('leaves no executable invoking a deleted Sonar script', () => {
    const offenders: string[] = [];
    for (const file of executableFiles()) {
      const body = readFileSync(join(root, file), 'utf8');
      for (const deleted of DELETED_SONAR_PATHS) {
        // Only flag an actual invocation, not a comment explaining the removal.
        const lines = body.split('\n').filter((line) => line.includes(deleted));
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('#') || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
          offenders.push(`${file}: ${trimmed.slice(0, 90)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('confirms the deleted Sonar paths really are gone', () => {
    for (const deleted of DELETED_SONAR_PATHS.filter((p) => !p.startsWith('/'))) {
      expect(existsSync(join(root, deleted))).toBe(false);
    }
  });

  it('documents no npm script that does not exist', () => {
    // The general version of the Sonar-doc problem: any canonical document that
    // tells an operator to run a missing command is a broken runbook.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const available = new Set(Object.keys(pkg.scripts));
    const docs = [
      'docs/release/README.md',
      'docs/release/continuous-deployment.md',
      'docs/release/release-evidence-contract.md',
      'ops/nexus-release/README.md',
      '.agents/skills/release-operator/SKILL.md',
    ];
    const missing: string[] = [];
    for (const doc of docs) {
      if (!existsSync(join(root, doc))) continue;
      const body = readFileSync(join(root, doc), 'utf8');
      for (const line of body.split('\n')) {
        // Skip prose that explicitly says the command no longer exists.
        if (/no longer exist|decommissioned|removed|does not exist/i.test(line)) continue;
        for (const match of line.matchAll(/npm (?:--prefix \S+ )?run ([a-z0-9:_-]+)/g)) {
          if (match[1].startsWith('-')) continue;
          if (!available.has(match[1])) missing.push(`${doc}: npm run ${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the retained shared maintenance mutex, which is not Sonar', () => {
    // /run/lock/nexus-release-sonar.lock survives under its historical name as the
    // root maintenance mutex. Removing it would break the legacy PM2 paths that
    // still hold it during the transition.
    expect(existsSync(join(root, 'ops/nexus-release/nexus-release-maintenance-lock.conf')))
      .toBe(true);
    const doc = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    expect(doc).toMatch(/Lock order is release lock first, maintenance mutex second/);
  });
});

describe('release manifest publication fails closed on the pinned key', () => {
  const repositoryBase = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim();
  let cachedRepositoryVerdict: Record<string, any> | null = null;

  function runMigrationSafety(fixtureRoot: string, comparisonBase: string) {
    return spawnSync(process.execPath, [
      join(root, 'scripts/migration-safety-check.mjs'),
      '--root', fixtureRoot,
      '--base', comparisonBase,
      '--changed-only',
      '--approval-mode', 'scan',
      '--emit-inventory',
      '--json',
    ], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  function repositoryVerdict() {
    if (!cachedRepositoryVerdict) {
      const result = runMigrationSafety(root, repositoryBase);
      if (result.status !== 0) {
        throw new Error(`repository migration fixture failed: ${result.stdout}${result.stderr}`);
      }
      cachedRepositoryVerdict = JSON.parse(result.stdout);
    }
    return structuredClone(cachedRepositoryVerdict);
  }

  function runBuilder(
    extraArgs: string[],
    env: Record<string, string> = {},
    comparisonBase = repositoryBase,
  ) {
    return spawnSync(process.execPath, [
      'scripts/release-manifest-build.mjs',
      '--migration-base', comparisonBase,
      ...extraArgs,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: policy.trust.repository,
        GITHUB_REF: policy.trust.protectedRef,
        GITHUB_WORKFLOW: policy.trust.workflow,
        GITHUB_SHA: 'a'.repeat(40),
        GITHUB_RUN_ID: '1',
        GITHUB_RUN_ATTEMPT: '1',
        NEXUS_RELEASE_MANIFEST_SIGNING_KEY: '',
        ...env,
      },
    });
  }

  function migrationResultFixture(
    mutate: (verdict: Record<string, any>) => void = () => {},
  ) {
    const directory = mkdtempSync(join(tmpdir(), 'nexus-release-manifest-test-'));
    const verdict = repositoryVerdict();
    mutate(verdict);
    const resultPath = join(directory, 'migration-safety.json');
    const hostedResultPath = join(directory, 'hosted-migration-safety.json');
    const outputPath = join(directory, 'release-manifest.json');
    writeFileSync(resultPath, JSON.stringify(verdict));
    return {
      directory,
      resultPath,
      hostedResultPath,
      outputPath,
      inventory: verdict.migrationInventory,
      verdict,
    };
  }

  function verifyMigrationFixture(
    fixture: ReturnType<typeof migrationResultFixture>,
    env: Record<string, string> = {},
    comparisonBase = repositoryBase,
  ) {
    return runBuilder([
      '--migration-result', fixture.resultPath,
      '--verify-migration-only', fixture.hostedResultPath,
    ], env, comparisonBase);
  }

  function signHostedFixture(
    fixture: ReturnType<typeof migrationResultFixture>,
    digest: string,
    extraArgs: string[] = [],
    env: Record<string, string> = {},
    comparisonBase = repositoryBase,
  ) {
    return runBuilder([
      '--backend-digest', `sha256:${'1'.repeat(64)}`,
      '--content-engine-digest', `sha256:${'2'.repeat(64)}`,
      '--hosted-migration-result', fixture.hostedResultPath,
      '--hosted-migration-digest', digest,
      '--output', fixture.outputPath,
      ...extraArgs,
    ], env, comparisonBase);
  }

  it(
    'refuses a real contract migration relabeled as expand in the secretless verifier',
    { timeout: 30_000 },
    () => {
      const fixture = migrationResultFixture((verdict) => {
        const contract = verdict.migrationInventory.find(
          (entry: { kind: string }) => entry.kind === 'contract',
        );
        expect(contract, 'repository contains a contract migration').toBeDefined();
        contract!.kind = 'expand';
        contract!.predecessorCompatible = true;
      });
      try {
        const result = verifyMigrationFixture(fixture);
        expect(result.status).toBe(65);
        expect(result.stderr).toMatch(/does not match the hosted checkout recomputation/);
        expect(result.stderr).not.toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
        expect(existsSync(fixture.hostedResultPath)).toBe(false);
        expect(existsSync(fixture.outputPath)).toBe(false);
      } finally {
        rmSync(fixture.directory, { recursive: true, force: true });
      }
    },
  );

  it('refuses forged eligibility even when every inventory entry is identical', () => {
    const fixture = migrationResultFixture((verdict) => {
      const forgedEligible = !verdict.cdEligibility.eligible;
      verdict.cdEligibility = {
        ...verdict.cdEligibility,
        eligible: forgedEligible,
        predecessorCompatible: forgedEligible,
        reasons: forgedEligible ? [] : ['forged_ci_block'],
      };
    });
    try {
      expect(fixture.inventory).toEqual(repositoryVerdict().migrationInventory);
      const result = verifyMigrationFixture(fixture);
      expect(result.status).toBe(65);
      expect(result.stderr).toMatch(/does not match the hosted checkout recomputation/);
      expect(result.stderr).not.toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
      expect(existsSync(fixture.hostedResultPath)).toBe(false);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses an artifact that suppresses a real append-only violation', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-hosted-migration-tamper-'));
    const migration = 'migrations/001_initial.sql';
    const git = (...args: string[]) => spawnSync('git', args, {
      cwd: fixtureRoot,
      encoding: 'utf8',
    });
    try {
      cpSync(join(root, 'migrations'), join(fixtureRoot, 'migrations'), { recursive: true });
      mkdirSync(join(fixtureRoot, 'config'), { recursive: true });
      for (const policyFile of [
        'irreversible-migrations.json',
        'production-migration-lineages.json',
      ]) {
        writeFileSync(
          join(fixtureRoot, 'config', policyFile),
          readFileSync(join(root, 'config', policyFile)),
        );
      }
      writeFileSync(
        join(fixtureRoot, 'config/continuous-deployment.json'),
        readFileSync(join(root, 'config/continuous-deployment.json')),
      );
      const initialized = git('init', '--initial-branch=main');
      expect(initialized.status, `${initialized.stdout}${initialized.stderr}`).toBe(0);
      const sourceGitCommonDir = spawnSync(
        'git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' },
      ).stdout.trim();
      mkdirSync(join(fixtureRoot, '.git/objects/info'), { recursive: true });
      writeFileSync(
        join(fixtureRoot, '.git/objects/info/alternates'),
        `${resolve(root, sourceGitCommonDir, 'objects')}\n`,
      );
      for (const args of [
        ['config', 'user.name', 'Nexus CI Fixture'],
        ['config', 'user.email', 'ci-fixture@example.invalid'],
        ['add', '.'],
        ['commit', '-m', 'fixture: append-only base'],
      ]) {
        const result = git(...args);
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      }
      const comparisonBase = git('rev-parse', 'HEAD').stdout.trim();
      writeFileSync(
        join(fixtureRoot, migration),
        Buffer.concat([
          readFileSync(join(root, migration)),
          Buffer.from('\n-- forbidden historical edit\n'),
        ]),
      );

      const actual = runMigrationSafety(fixtureRoot, comparisonBase);
      expect(actual.status).toBe(1);
      const forged = JSON.parse(actual.stdout);
      expect(forged.errors).toContain(
        `migration_history_not_append_only:${migration}:modified`,
      );
      forged.ok = true;
      forged.checks.migrationHistoryAppendOnly = true;
      forged.errors = [];
      forged.cdEligibility = {
        ...forged.cdEligibility,
        eligible: true,
        predecessorCompatible: true,
        reasons: [],
      };
      const resultPath = join(fixtureRoot, 'forged-migration-safety.json');
      const hostedResultPath = join(fixtureRoot, 'hosted-migration-safety.json');
      const outputPath = join(fixtureRoot, 'release-manifest.json');
      writeFileSync(resultPath, JSON.stringify(forged));

      const result = runBuilder([
        '--root', fixtureRoot,
        '--migration-result', resultPath,
        '--verify-migration-only', hostedResultPath,
      ], {}, comparisonBase);
      expect(result.status).toBe(65);
      expect(result.stderr).toMatch(/hosted migration verdict did not pass/);
      expect(result.stderr).toMatch(/migration_history_not_append_only/);
      expect(result.stderr).not.toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
      expect(existsSync(hostedResultPath)).toBe(false);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('signs from the digest-bound hosted verdict without rereading the CI artifact', () => {
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const verificationSummary = JSON.parse(verification.stdout);
      expect(verificationSummary.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(existsSync(fixture.hostedResultPath)).toBe(true);

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publicKeyPath = join(fixture.directory, 'release-public-key.pem');
      writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
      const result = signHostedFixture(fixture, verificationSummary.digest, [
        '--public-key', publicKeyPath,
      ], {
        NEXUS_RELEASE_MANIFEST_SIGNING_KEY: privateKey
          .export({ type: 'pkcs8', format: 'pem' }).toString(),
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stderr).not.toMatch(/does not match the hosted checkout recomputation/);
      expect(existsSync(fixture.outputPath)).toBe(true);
      const envelope = JSON.parse(readFileSync(fixture.outputPath, 'utf8'));
      expect(envelope.payload.migrations.inventory).toEqual(fixture.inventory);
      expect(envelope.payload.migrations.cdEligibility).toEqual({
        eligible: fixture.verdict.cdEligibility.eligible,
        predecessorCompatible: fixture.verdict.cdEligibility.predecessorCompatible,
        reasons: fixture.verdict.cdEligibility.reasons,
      });
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses a tampered hosted verdict before reading the key or writing output', () => {
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const { digest } = JSON.parse(verification.stdout);
      const hosted = JSON.parse(readFileSync(fixture.hostedResultPath, 'utf8'));
      hosted.cdEligibility.eligible = !hosted.cdEligibility.eligible;
      writeFileSync(fixture.hostedResultPath, `${JSON.stringify(hosted, null, 2)}\n`);

      const result = signHostedFixture(fixture, digest);
      expect(result.status).toBe(65);
      expect(result.stderr).toMatch(/hosted migration verdict digest changed/);
      expect(result.stderr).not.toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses the selectable-runner artifact in signing mode before key or output', () => {
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const { digest } = JSON.parse(verification.stdout);
      const result = signHostedFixture(fixture, digest, [
        '--migration-result', fixture.resultPath,
      ]);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/accepted only in secretless verification mode/);
      expect(result.stderr).not.toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses to run the comparison mode when a signing key is present', () => {
    const fixture = migrationResultFixture();
    try {
      const result = verifyMigrationFixture(fixture, {
        NEXUS_RELEASE_MANIFEST_SIGNING_KEY: 'must-not-enter-verification',
      });
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/verification mode must not receive/);
      expect(existsSync(fixture.hostedResultPath)).toBe(false);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses to publish when the governed public key is absent', () => {
    // Previously this warned and published a manifest the deployment host could
    // not verify, halting the pipeline for a reason invisible from CI.
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const { digest } = JSON.parse(verification.stdout);
      const { privateKey } = generateKeyPairSync('ed25519');
      const result = signHostedFixture(
        fixture,
        digest,
        ['--public-key', '/nonexistent/key.pem'],
        {
          NEXUS_RELEASE_MANIFEST_SIGNING_KEY: privateKey
            .export({ type: 'pkcs8', format: 'pem' }).toString(),
        },
      );
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(66);
      expect(result.stderr).not.toMatch(/skipping the self-verification/);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('requires the signing key from the environment, never argv', () => {
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const { digest } = JSON.parse(verification.stdout);
      const result = signHostedFixture(fixture, digest);
      expect(result.status).toBe(64);
      expect(result.stderr).toMatch(/NEXUS_RELEASE_MANIFEST_SIGNING_KEY is required/);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('refuses to sign for a repository other than the governed one', () => {
    const fixture = migrationResultFixture();
    try {
      const verification = verifyMigrationFixture(fixture);
      expect(verification.status, `${verification.stdout}${verification.stderr}`).toBe(0);
      const { digest } = JSON.parse(verification.stdout);
      const result = signHostedFixture(fixture, digest, [], {
        GITHUB_REPOSITORY: 'someone-else/fork',
      });
      expect(result.status).toBe(66);
      expect(result.stderr).toMatch(/not the governed/);
      expect(existsSync(fixture.outputPath)).toBe(false);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });
});

describe('CI runner-guardrails graph semantics', () => {
  // A tiny structural reader for the `jobs:` block. The repository has no YAML
  // dependency, and these assertions are about the job graph rather than about
  // formatting, so grep alone would be too weak: a job-level `if:` and a step
  // level `if:` look identical to a text search.
  function parseJobs(workflow: string) {
    const lines = workflow.split('\n');
    const jobsAt = lines.findIndex((line) => /^jobs:\s*$/.test(line));
    const jobs: Record<string, { if?: string; needs: string[]; runsOn?: string; body: string }> = {};
    let current: string | null = null;
    let body: string[] = [];
    const flush = () => {
      if (!current) return;
      const text = body.join('\n');
      const ifMatch = /^ {4}if:\s*(.+)$/m.exec(text);
      const needsInline = /^ {4}needs:\s*\[(.+)\]\s*$/m.exec(text);
      const needsScalar = /^ {4}needs:\s*([A-Za-z_][\w-]*)\s*$/m.exec(text);
      const runsOn = /^ {4}runs-on:\s*(.+)$/m.exec(text);
      jobs[current] = {
        if: ifMatch?.[1]?.trim(),
        needs: needsInline
          ? needsInline[1].split(',').map((entry) => entry.trim())
          : (needsScalar ? [needsScalar[1]] : []),
        runsOn: runsOn?.[1]?.trim(),
        body: text,
      };
    };
    for (const line of lines.slice(jobsAt + 1)) {
      const header = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
      if (header) {
        flush();
        current = header[1];
        body = [];
        continue;
      }
      if (current) body.push(line);
    }
    flush();
    return jobs;
  }

  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const jobs = parseJobs(ci);

  it('runs the guardrails job unconditionally so hosted CI cannot skip-propagate', () => {
    // A job-level `if:` made this job skip on hosted runners. Every substantive
    // job declares `needs: runner_guardrails`, and GitHub skips a dependent whose
    // dependency was skipped — so the hosted fallback silently skipped the entire
    // gate while still reporting green.
    expect(jobs.runner_guardrails).toBeDefined();
    expect(jobs.runner_guardrails.if).toBeUndefined();
  });

  it('keeps only the self-hosted guard step conditional', () => {
    const body = jobs.runner_guardrails.body;
    expect(body).toMatch(/if: needs\.runner\.outputs\.is_self_hosted == 'true'/);
    expect(body).toMatch(/if: needs\.runner\.outputs\.is_self_hosted != 'true'/);
  });

  it('never checks out repository code in the guard job', () => {
    // A guard that runs a probe from the pull request's own checkout is not a
    // security boundary, because the pull request can edit the probe.
    expect(jobs.runner_guardrails.body).not.toMatch(/uses:\s*actions\/checkout/);
    expect(jobs.runner_guardrails.body).not.toMatch(/npm |npx |node scripts\//);
  });

  it('makes every self-hosted-capable job depend on the guardrails job', () => {
    const selfHosted = Object.entries(jobs)
      .filter(([name, job]) => job.runsOn?.includes('needs.runner.outputs.labels')
        && !['runner', 'runner_guardrails'].includes(name));
    expect(selfHosted.length).toBeGreaterThan(4);
    const missing = selfHosted
      .filter(([, job]) => !job.needs.includes('runner_guardrails'))
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('asserts ownership and permissions, not merely runner writability', () => {
    const body = jobs.runner_guardrails.body;
    // `-w` is false for a root-owned 0777 file when the check runs as a peer of
    // root, and says nothing about a group-writable parent directory.
    expect(body).toMatch(/stat -c '%u'/);
    expect(body).toMatch(/stat -c '%a'/);
    expect(body).toMatch(/guard parent directory/);
    expect(body).toMatch(/is a symlink/);
  });

  it('lets the hosted fallback reach classify and the substantive jobs', () => {
    // classify is the gate everything else derives from; if it cannot run on a
    // hosted runner the fallback is decorative.
    expect(jobs.classify.needs).toContain('runner_guardrails');
    expect(jobs.classify.if).toBeUndefined();
    for (const name of ['lint', 'docs_and_secrets', 'test_focused']) {
      expect(jobs[name], name).toBeDefined();
      expect(jobs[name].needs, name).toContain('classify');
    }
  });
});

describe('Pi runner host guard capability coverage', () => {
  const guard = readFileSync(join(root, 'ops/pi-runner/nexus-pi-guardrails'), 'utf8');

  it('detects scoped passwordless sudo, not just a blanket grant', () => {
    // `sudo -n true` fails for `NOPASSWD: /usr/bin/systemctl restart nexus-hub`,
    // which still hands the test runner a production capability.
    expect(guard).toMatch(/sudo -n -l/);
    expect(guard).toMatch(/NOPASSWD/);
    expect(guard).toMatch(/absent_scoped_passwordless_sudo/);
  });

  it('detects rootless and remote container endpoints', () => {
    // Rootless Podman and rootless Docker listen per-user, so the system socket
    // paths never see them; DOCKER_HOST needs no local socket at all.
    expect(guard).toMatch(/XDG_RUNTIME_DIR/);
    expect(guard).toMatch(/absent_rootless_podman_socket/);
    expect(guard).toMatch(/absent_rootless_docker_socket/);
    expect(guard).toMatch(/absent_docker_host_override/);
  });

  it('still covers the system sockets, daemon, credentials and deploy keys', () => {
    for (const check of [
      'absent_docker_socket',
      'absent_containerd_socket',
      'absent_podman_socket',
      'absent_docker_daemon',
      'absent_registry_credentials',
      'absent_deploy_key',
      'runner_is_unprivileged',
    ]) {
      expect(guard, check).toContain(check);
    }
    for (const environmentFile of [
      '/etc/nexus-release/production-backend.env',
      '/etc/nexus-release/production-content-engine.env',
      '/etc/nexus-release/staging-backend.env',
      '/etc/nexus-release/staging-content-engine.env',
    ]) {
      expect(guard).toContain(environmentFile);
    }
  });

  it('permits the isolated audit account while denying the runner receipt access', () => {
    // This machine hosts both accounts. Requiring the root-owned audit parent to
    // be absent would make the documented 0700 nexus-audit mirror incompatible
    // with every CI run; the boundary is the runner's effective access instead.
    expect(guard).toContain('refuse_directory_access inaccessible_audit_receipts');
    expect(guard).toContain('/var/lib/nexus-release-audit/receipts');
    expect(guard).toMatch(/\[ -r "\$2" \] \|\| \[ -w "\$2" \] \|\| \[ -x "\$2" \]/);
    expect(guard).not.toContain('absent_production_audit_path');
  });

  it('fails the CI run on any failed check', () => {
    // The guard is only a boundary if a failure is fatal.
    expect(guard).toMatch(/set -euo pipefail/);
    expect(guard).toMatch(/exit 1/);
  });
});

describe('QA-round finding F8: aggregate gate matches the guardrails contract', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');

  it('never requires the guardrails job to report skipped', () => {
    // Removing the job-level `if:` means the guard job ALWAYS runs, so it can
    // never report `skipped`. An aggregate that asserted `skipped` on hosted
    // runners would fail the required check on every PR and every push to main —
    // the fix for skip-propagation would itself have turned CI permanently red.
    expect(ci).not.toMatch(/GUARDRAILS_RESULT" = "skipped"/);
    expect(ci).toMatch(/GUARDRAILS_RESULT" = "success"/);
  });

  it('asserts guardrails success on both hosted and self-hosted runners', () => {
    const aggregate = ci.slice(ci.indexOf('\n  test:'));
    const guardrailsAssertions = aggregate.match(/GUARDRAILS_RESULT" = "[a-z]+"/g) ?? [];
    expect(guardrailsAssertions.length).toBeGreaterThan(0);
    for (const assertion of guardrailsAssertions) {
      expect(assertion).toBe('GUARDRAILS_RESULT" = "success"');
    }
  });
});
