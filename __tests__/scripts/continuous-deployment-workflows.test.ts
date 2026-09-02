import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
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
const schemaActivation = readFileSync(
  join(workflowsDir, 'release-manifest-schema-activate.yml'),
  'utf8',
);
const manifestBuilder = readFileSync(join(root, 'scripts/release-manifest-build.mjs'), 'utf8');
const signingHandoff = readFileSync(join(root, 'scripts/release-signing-handoff.mjs'), 'utf8');
const policy = JSON.parse(readFileSync(join(root, 'config/continuous-deployment.json'), 'utf8'));
const iosContractClassifier = readFileSync(join(root, 'scripts/ios-contract-change-check.mjs'), 'utf8');
const continuousDeploymentDoc = readFileSync(join(root, 'docs/release/continuous-deployment.md'), 'utf8');
const releaseOperatorRunbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');

const iosContractOwners = [
  'docs/contracts/',
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

function expectedCiGate(eventName: 'pull_request' | 'push', docsOnly: boolean) {
  const docsPrGate = eventName === 'pull_request' && docsOnly;
  return {
    docsPrGate: docsPrGate ? 'success' : 'skipped',
    codeGate: docsPrGate ? 'skipped' : 'success',
  } as const;
}

function jobBlock(source: string, jobId: string): string {
  const start = source.indexOf(`\n  ${jobId}:\n`);
  expect(start, `job ${jobId} exists`).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z0-9_-]+:\n/);
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

function bashFunction(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  expect(start, `bash function ${name} exists`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}\n', start);
  expect(end, `bash function ${name} has a closing brace`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

function jqObjectProgramsContainingSchema(source: string, schema: string): string[] {
  const escapedSchema = schema.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...source.matchAll(new RegExp(
    `'(\\{schema:"${escapedSchema}"[\\s\\S]*?\\})'`,
    'g',
  ))].map((match) => match[1]);
}

function runJqNullInputObject(
  program: string,
  values: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const args = ['-cn'];
  for (const [name, value] of Object.entries(values)) {
    args.push('--arg', name, value);
  }
  args.push(program);
  const result = spawnSync('jq', args, { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
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

  it('keeps one fail-closed required aggregate check name stable', () => {
    expect(ci.match(/^    name: 🧪 Tests$/gm)).toHaveLength(1);
    expect(ci).not.toContain('name: 🧪 Code tests');
    const aggregate = jobBlock(ci, 'test');
    expect(aggregate).toContain('if: ${{ always() }}');
    expect(aggregate).toContain(
      'needs: [runner, runner_guardrails, classify, docs_pr_gate, code_gate]',
    );
    expect(aggregate).toContain('test "$DOCS_PR_GATE_RESULT" = "success"');
    expect(aggregate).toContain('test "$DOCS_PR_GATE_RESULT" = "skipped"');
    expect(aggregate).toContain('test "$CODE_GATE_RESULT" = "success"');
    expect(aggregate).toContain('test "$CODE_GATE_RESULT" = "skipped"');
  });

  it.each([
    ['docs-only PR', 'pull_request', true, 'success', 'skipped'],
    ['code PR', 'pull_request', false, 'skipped', 'success'],
    ['docs delta pushed to main', 'push', true, 'skipped', 'success'],
    ['code delta pushed to main', 'push', false, 'skipped', 'success'],
  ] as const)(
    'routes %s through exactly one expected gate',
    (_name, eventName, docsOnly, docsPrGate, codeGate) => {
      expect(expectedCiGate(eventName, docsOnly)).toEqual({ docsPrGate, codeGate });
    },
  );

  it('encodes the gate truth table in the workflow without treating skip as pass', () => {
    const docsPrGate = jobBlock(ci, 'docs_pr_gate');
    const codeGate = jobBlock(ci, 'code_gate');
    const aggregate = jobBlock(ci, 'test');
    const codeLaneCondition = "if: ${{ !(github.event_name == 'pull_request' && needs.classify.outputs.docs_only == 'true') }}";
    expect(docsPrGate).toContain(
      "if: ${{ always() && github.event_name == 'pull_request' && needs.classify.outputs.docs_only == 'true' }}",
    );
    expect(codeGate).toContain(
      "if: ${{ always() && !(github.event_name == 'pull_request' && needs.classify.outputs.docs_only == 'true') }}",
    );
    expect(aggregate).toContain(
      'if [ "$EVENT_NAME" = "pull_request" ] && [ "$DOCS_ONLY" = "true" ]; then',
    );
    expect(aggregate).not.toMatch(/(?:DOCS_PR_GATE_RESULT|CODE_GATE_RESULT).*!= "failure"/);
    for (const jobId of ['lint', 'test_focused', 'build', 'science_policy']) {
      expect(jobBlock(ci, jobId), jobId).toContain(codeLaneCondition);
    }
  });

  it('checks committed Python release-lock metadata in required CI', () => {
    const pythonJob = jobBlock(ci, 'python-test');
    const lockCheckAt = pythonJob.indexOf('Verify committed Python release-lock metadata');
    const installAt = pythonJob.indexOf('name: Install dependencies');
    expect(lockCheckAt).toBeGreaterThan(-1);
    expect(pythonJob).toContain(
      'node scripts/generate-python-release-lock.mjs --verify-committed',
    );
    expect(installAt).toBeGreaterThan(lockCheckAt);
  });

  it('binds lint/typecheck and build into the code gate feeding the aggregate', () => {
    const codeGate = jobBlock(ci, 'code_gate');
    const needs = codeGate.match(/^    needs: \[(.+)\]$/m)?.[1] ?? '';
    expect(needs.split(',').map((entry) => entry.trim())).toEqual(
      expect.arrayContaining(['lint', 'build']),
    );
    expect(codeGate).toContain('LINT_RESULT: ${{ needs.lint.result }}');
    expect(codeGate).toContain('BUILD_RESULT: ${{ needs.build.result }}');
    expect(codeGate).toContain('test "$LINT_RESULT" = "success"');
    expect(codeGate).toContain('test "$BUILD_RESULT" = "success"');
    expect(codeGate).not.toContain('test "$LINT_RESULT" = "skipped"');
    expect(codeGate).not.toContain('test "$BUILD_RESULT" = "skipped"');
    expect(codeGate).toContain('skip|focused)');
    expect(codeGate).toContain('test "$FOCUSED_RESULT" = "success"');
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

  it('recomputes the exact manifest-schema transition in CI and again before publication', () => {
    const classify = jobBlock(ci, 'classify');
    const builder = jobBlock(release, 'build');
    const publisher = jobBlock(release, 'publish');
    expect(classify).toContain('node scripts/release-manifest-schema-guard.mjs');
    expect(classify).toContain('--base "$BASE_REF"');
    expect(classify).toContain('--head "$(git rev-parse HEAD)"');
    expect(classify.indexOf('release-manifest-schema-guard.mjs'))
      .toBeLessThan(classify.indexOf('scripts/changed-area-classifier.sh'));
    expect(builder).toContain('node scripts/release-manifest-schema-guard.mjs');
    expect(builder).toContain("--base '${{ steps.source.outputs.migration_base }}'");
    expect(builder).toContain("--head '${{ steps.source.outputs.sha }}'");
    expect(builder.indexOf('release-manifest-schema-guard.mjs'))
      .toBeLessThan(builder.indexOf('Build and push the backend image'));
    expect(publisher).toContain('Recompute the schema transition in the fresh signer');
    expect(publisher).toContain("--base '${{ needs.build.outputs.migration_base }}'");
    expect(publisher).toContain("--head '${{ needs.build.outputs.source_sha }}'");
    expect(publisher.indexOf('release-manifest-schema-guard.mjs'))
      .toBeLessThan(publisher.indexOf('Build and sign the release manifest'));
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
    const payload = stepBlock(release, 'Build and push the exact-SHA release payload image');

    expect(backend).toContain(
      'nexus-hub-backend:${{ steps.source.outputs.sha }}',
    );
    expect(contentEngine).toContain(
      'nexus-hub-content-engine:${{ steps.source.outputs.sha }}',
    );
    expect(release).not.toContain('nexus-hub-backend:main');
    expect(release).not.toContain('nexus-hub-content-engine:main');
    expect(payload).toContain('nexus-hub-release:${{ needs.build.outputs.source_sha }}');
    expect(payload).not.toContain('nexus-hub-release:main');
    expect(schemaActivation).toContain('--tag "$IMAGE:main" "$IMAGE@$CANDIDATE_DIGEST"');
  });

  it('installs dependencies and recomputes the full verdict before image publication', () => {
    const block = jobBlock(release, 'build');
    const pythonLockAt = block.indexOf(
      'Reproduce and verify the Python release closure before publication',
    );
    const installAt = block.indexOf('Install the exact host-side verification dependencies');
    const verificationAt = block.indexOf(
      'Recompute and bind the migration verdict without signing authority',
    );
    const registryLoginAt = block.indexOf('docker/login-action');
    const backendPublishAt = block.indexOf('Build and push the backend image');
    const contentPublishAt = block.indexOf('Build and push the content-engine image');
    expect(pythonLockAt).toBeGreaterThan(-1);
    expect(block.slice(pythonLockAt, installAt)).toContain(
      'node scripts/generate-python-release-lock.mjs --check',
    );
    expect(block.slice(pythonLockAt, installAt)).toContain('--require-hashes');
    expect(installAt).toBeGreaterThan(pythonLockAt);
    expect(block.slice(installAt, verificationAt)).toContain('run: npm ci');
    expect(verificationAt).toBeGreaterThan(installAt);
    expect(registryLoginAt).toBeGreaterThan(verificationAt);
    expect(registryLoginAt).toBeGreaterThan(pythonLockAt);
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
    const prePayloadAt = publisher.indexOf(
      'Re-assert protected-main head immediately before publishing the exact release payload',
    );
    const payloadAt = publisher.indexOf('Build and push the exact-SHA release payload image');
    const pointerGuardAt = publisher.indexOf('Compare signed release-pointer schema generations');
    const pointerMoveAt = publisher.indexOf(
      'Move the release pointer only for an equal signed schema generation',
    );
    const signerStepAt = publisher.lastIndexOf('\n      - name:', signerAt);
    const payloadStepAt = publisher.lastIndexOf('\n      - name:', payloadAt);
    expect(backendAt).toBeGreaterThan(-1);
    expect(contentAt).toBeGreaterThan(backendAt);
    expect(handoffAt).toBeGreaterThan(contentAt);
    expect(publisher).toContain('needs: build');
    expect(preSignAt).toBeGreaterThan(-1);
    expect(signerAt).toBeGreaterThan(preSignAt);
    expect(signerStepAt).toBeGreaterThan(preSignAt);
    expect(prePayloadAt).toBeGreaterThan(signerAt);
    expect(payloadAt).toBeGreaterThan(prePayloadAt);
    expect(payloadStepAt).toBeGreaterThan(prePayloadAt);
    expect(pointerGuardAt).toBeGreaterThan(payloadAt);
    expect(pointerMoveAt).toBeGreaterThan(pointerGuardAt);

    // Both authority checks are adjacent to the operation they guard. An early
    // main-head check is insufficient because image builds can outlive a newer
    // protected-main push.
    expect(publisher.slice(preSignAt, signerStepAt)).not.toMatch(/\n {6}- /);
    expect(publisher.slice(prePayloadAt, payloadStepAt)).not.toMatch(/\n {6}- /);
    for (const stepName of [
      'Re-assert protected CI and main immediately before signing',
      'Re-assert protected-main head immediately before publishing the exact release payload',
    ]) {
      const check = stepBlock(release, stepName);
      expect(check).toContain('git fetch --no-tags origin main');
      expect(check).toContain('test "$(git rev-parse origin/main)" = "$SHA"');
    }
    const pointerGuard = stepBlock(release, 'Compare signed release-pointer schema generations');
    const pointerMove = stepBlock(
      release,
      'Move the release pointer only for an equal signed schema generation',
    );
    expect(pointerGuard).toContain('scripts/release-manifest-pointer-guard.mjs');
    expect(pointerGuard).toContain('--candidate-manifest');
    expect(pointerGuard).toContain('--current-manifest');
    expect(pointerGuard).toContain('hold_generation_mismatch');
    expect(pointerMove).toContain("if: steps.pointer_guard.outputs.decision == 'move_main'");
    expect(pointerMove).toContain('test "$(resolve_digest "$IMAGE:main")" = "$EXPECTED_CURRENT_DIGEST"');
    expect(pointerMove).toContain('--prefer-index=false');
    expect(pointerMove).toContain('--tag "$IMAGE:main" "$IMAGE@$CANDIDATE_DIGEST"');
    expect(pointerMove).toContain('test "$(resolve_digest "$IMAGE:main")" = "$CANDIDATE_DIGEST"');
  });

  it('keeps schema activation owner-only, protected-main-bound, and separately approved', () => {
    const topLevel = schemaActivation.slice(0, schemaActivation.indexOf('\njobs:\n'));
    const admission = jobBlock(schemaActivation, 'admission');
    const activate = jobBlock(schemaActivation, 'activate');
    expect(release).not.toContain('workflow_dispatch');
    expect(schemaActivation).toContain('workflow_dispatch:');
    expect(topLevel).not.toContain('concurrency:');
    expect(admission).not.toContain('concurrency:');
    expect(activate).toContain('concurrency:\n      group: release-publish-main');
    expect(activate).toContain('cancel-in-progress: false');
    expect(schemaActivation).toContain('test "$ACTOR" = "$OWNER"');
    expect(schemaActivation).toContain('TRIGGERING_ACTOR: ${{ github.triggering_actor }}');
    expect(schemaActivation).toContain('test "$TRIGGERING_ACTOR" = "$OWNER"');
    expect(schemaActivation).toContain("test \"$REF\" = 'refs/heads/main'");
    expect(schemaActivation).toContain('environment:\n      name: release-publish');
    expect(schemaActivation).toContain('packages: write');
    expect(schemaActivation).toContain('--activation');
    expect(schemaActivation).toContain('--expected-installed-control-plane-digest');
    expect(schemaActivation).toContain('test "$(git rev-parse origin/main)" = "$SOURCE_SHA"');
    expect(schemaActivation).toContain('test "$(resolve_digest "$IMAGE:main")" = "$CURRENT_DIGEST"');
    expect(schemaActivation).toContain('--prefer-index=false');
    expect(schemaActivation).toContain('--tag "$IMAGE:main" "$IMAGE@$CANDIDATE_DIGEST"');
    expect(schemaActivation).toContain('machine-generated host attestation');
    expect(schemaActivation).not.toContain('NEXUS_RELEASE_MANIFEST_SIGNING_KEY');
  });

  it('does not claim an unavailable destructive-migration executor exists', () => {
    expect(release).toContain(
      'destructive SQL still requires the unimplemented maintenance path',
    );
    expect(release).toContain('every live-ledger-pending inventory entry');
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
  it('runs the six-example fixture test only for governed fixture-owner prefixes', () => {
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
    expect(classifyIosContract(['docs/contracts/openapi-v1.yaml'])).toMatchObject({
      required: true,
      matchedPaths: ['docs/contracts/openapi-v1.yaml'],
      watchedPrefixes: iosContractOwners,
    });
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

  it('bridges descriptor-verified APNs key material instead of a host-only path', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    const backend = compose.slice(compose.indexOf('  backend:'), compose.indexOf('  migrator:'));
    const migrator = compose.slice(compose.indexOf('  migrator:'));
    expect(backend).toContain(
      'APNS_AUTH_KEY_P8: ${NEXUS_APNS_AUTH_KEY_P8_ESCAPED:-}',
    );
    expect(migrator).not.toContain('NEXUS_APNS_AUTH_KEY_P8_ESCAPED');
    expect(migrator).toContain('APNS_AUTH_KEY_P8: ""');
    expect(compose).not.toContain(':/run/secrets/');
  });

  it('signs the Compose-safe escaped APNs key in the standalone smoke', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const baseEnvironment = {
      ...process.env,
      APNS_ENABLED: 'true',
      APNS_TEAM_ID: 'TESTTEAMID',
      APNS_KEY_ID: 'TESTKEYID',
      APNS_BUNDLE_ID: 'me.nexushub.test',
      APNS_ENVIRONMENT: 'production',
    };
    const inlineResult = spawnSync(process.execPath, ['scripts/apns-smoke.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...baseEnvironment,
        APNS_AUTH_KEY_P8: pem.replace(/\n/g, '\\n'),
      },
    });

    expect(inlineResult.status, inlineResult.stderr).toBe(0);
    expect(inlineResult.stdout).toContain('JWT signs cleanly');
    expect(inlineResult.stdout).not.toContain('BEGIN PRIVATE KEY');

    const fixture = mkdtempSync(join(tmpdir(), 'nexus-apns-smoke-'));
    try {
      const keyFile = join(fixture, 'private-key.p8');
      writeFileSync(keyFile, pem, { mode: 0o600 });
      const fileResult = spawnSync(process.execPath, ['scripts/apns-smoke.mjs', '--check'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...baseEnvironment, APNS_AUTH_KEY_P8: keyFile },
      });
      expect(fileResult.status, fileResult.stderr).toBe(0);
      expect(fileResult.stdout).toContain('JWT signs cleanly');
      expect(fileResult.stdout).not.toContain(keyFile);
      expect(fileResult.stdout).not.toContain('BEGIN PRIVATE KEY');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('runs the signed Ollama gateway over isolated Unix sockets with no application secrets', () => {
    const compose = readFileSync(join(root, 'docker-compose.release.yml'), 'utf8');
    const gateway = compose.slice(
      compose.indexOf('  ollama-gateway:'),
      compose.indexOf('  content-engine:'),
    );
    const backend = compose.slice(compose.indexOf('  backend:'), compose.indexOf('  migrator:'));

    expect(gateway).toContain('image: ${NEXUS_BACKEND_IMAGE:?');
    expect(gateway).toContain('network_mode: host');
    expect(gateway).toContain('command: ["node", "dist/tools/ollama-unix-gateway.js"]');
    expect(gateway).toContain('curl --unix-socket');
    expect(gateway).toContain('user: "10001:10001"');
    expect(gateway).toContain('cap_drop:\n      - ALL');
    expect(gateway).toContain('read_only: true');
    expect(gateway).not.toContain('env_file:');
    expect(gateway).not.toContain('ports:');
    expect(gateway).not.toContain('DATABASE_PATH');
    expect(backend).toContain('ollama-gateway:\n        condition: service_healthy');
    expect(backend).toContain(
      'OLLAMA_GATEWAY_SOCKET_PATH: ${NEXUS_OLLAMA_GATEWAY_SOCKET_PATH:?exact Ollama gateway socket path is required}',
    );
    expect(compose.split('${NEXUS_OLLAMA_GATEWAY_SOCKET_DIR:?root-created Ollama gateway socket directory is required}'))
      .toHaveLength(5);
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
    const dockerignore = readFileSync(join(root, '.dockerignore'), 'utf8');
    expect(contentEngine).toContain('USER nexus:nexus');
    expect(contentEngine).toContain('COPY content-engine/requirements-release.txt');
    expect(contentEngine).toContain('--only-binary=:all: --require-hashes');
    expect(contentEngine).not.toContain('-r requirements.txt');
    // Assert the executed command, not the prose: the header comment explains
    // why --reload is absent and would otherwise match a naive search.
    const contentCmd = contentEngine
      .split('\n')
      .filter((line) => line.startsWith('CMD ') || line.startsWith('ENTRYPOINT '))
      .join(' ');
    expect(contentCmd).toContain('uvicorn');
    expect(contentCmd).not.toContain('--reload');
    for (const auditOnlyPath of [
      'content-engine/requirements-audit-tool.in',
      'content-engine/requirements-audit-tool.txt',
      'content-engine/requirements-lock-tool.txt',
    ]) {
      expect(dockerignore).toContain(auditOnlyPath);
    }

    const security = readFileSync(join(root, '.github/workflows/security.yml'), 'utf8');
    const securityCommands = security.replace(/\\\n\s*/g, ' ').replace(/\s+/g, ' ');
    expect(securityCommands).toContain(
      '--require-hashes --only-binary=:all: -r content-engine/requirements-lock-tool.txt',
    );
    expect(securityCommands).toContain('node scripts/generate-python-release-lock.mjs --check');
    expect(securityCommands).toContain(
      '--dry-run --ignore-installed --require-hashes --only-binary=:all:',
    );
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
    expect(wrapper).toContain('NEXUS_RELEASE_LOCK_FD=9');
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
    const lockMarkerExport = wrapper.indexOf('export NEXUS_RELEASE_LOCK_HELD=1');
    const lockDescriptorExport = wrapper.indexOf('export NEXUS_RELEASE_LOCK_FD=9');
    expect(lockMarkerExport)
      .toBeGreaterThan(wrapper.lastIndexOf('assert_lock_fd_matches_path 9 "$LOCK_FILE"'));
    expect(lockMarkerExport)
      .toBeGreaterThan(wrapper.lastIndexOf('assert_lock_fd_matches_path 8 "$MAINTENANCE_LOCK"'));
    expect(lockDescriptorExport).toBeGreaterThan(lockMarkerExport);
    expect(wrapper).toContain(
      `stat -c '%U:%G:%a:%h:%s' -- "$LOCK_FILE")" = 'root:root:600:1:0'`,
    );
    expect(wrapper).toContain('local guard_root=/etc/systemd/system.control');
    expect(wrapper).toContain("stat -Lc '%U:%G:%a' -- \"$guard_root\"");
    expect(wrapper).toContain("stat -c '%U:%G:%F' -- \"$guard\"");
    expect(wrapper).toContain('--property=LoadState --value');
    expect(wrapper).toContain('--property=FragmentPath --value');
    expect(wrapper).toContain('--property=CanStart --value');
    expect(wrapper).toContain('--property=ActiveState --value');
    expect(wrapper).toContain('[ "$fragment" = "$guard" ]');
    expect(wrapper).not.toContain('[ "$fragment" = /dev/null ]');
    expect(wrapper).not.toContain('is-enabled "$unit"');
    expect(wrapper).not.toContain('masked-runtime');
    expect(wrapper).toContain('\nassert_pm2_guard\n\nexec "$NODE_BIN"');
    expect(wrapper).not.toMatch(
      /if \[ "\$argument" = --allow-first-container-bootstrap \]; then\s+assert_pm2_guard/,
    );
  });

  it('keeps discovery-alert durability bound to the held poller lock and non-gating', () => {
    const entrypoint = readFileSync(join(root, 'scripts/release-deploy.mjs'), 'utf8');
    const notifier = readFileSync(join(root, 'scripts/lib/release-notify.mjs'), 'utf8');
    expect(entrypoint).toContain("from './lib/release-discovery-alert-state.mjs'");
    expect(entrypoint).toContain('let discoveryAlerts = null');
    expect(entrypoint).toContain('stateDirectory: policy.paths.stateDir');
    expect(entrypoint).toContain('lockFile: policy.paths.lockFile');
    expect(entrypoint).toContain('release discovery alert store is unavailable');
    expect(entrypoint).toContain('await drainReleaseDeploymentAbort({');
    expect(entrypoint).toContain('if (releaseDeploymentResultProvesDiscovery(result))');
    expect(entrypoint).toContain('await resolveReleaseDeploymentAbort({');
    expect(entrypoint).toContain('alertStore: discoveryAlerts');
    expect(entrypoint).not.toContain('onDiscoveryVerified');
    expect(notifier).toContain('release discovery alert persistence or delivery failed');
    expect(notifier).not.toContain('inspect release journal and active state before retrying');

    const run = entrypoint.indexOf('const result = await runReleaseDeployment({');
    const proof = entrypoint.indexOf('if (releaseDeploymentResultProvesDiscovery(result))');
    const resolve = entrypoint.indexOf('await resolveReleaseDeploymentAbort({');
    expect(proof).toBeGreaterThan(run);
    expect(resolve).toBeGreaterThan(proof);
    expect(resolve).toBeLessThan(entrypoint.lastIndexOf('process.stdout.write'));
  });

  it('accepts the persistent guard source path reported by systemd', () => {
    const wrapper = readFileSync(join(root, 'scripts/release-poll.sh'), 'utf8');
    const guardFunction = bashFunction(wrapper, 'assert_pm2_guard').replace(
      'local guard_root=/etc/systemd/system.control',
      'local guard_root="$NEXUS_TEST_GUARD_ROOT"',
    );
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-poller-guard-'));
    const controlRoot = join(fixtureRoot, 'etc/systemd/system.control');
    const fakeSystemctl = join(fixtureRoot, 'systemctl');
    try {
      writeFileSync(fakeSystemctl, String.raw`#!/usr/bin/env bash
set -euo pipefail
test "$1" = show
unit="$2"
property="${'$'}{3#--property=}"
case "$property" in
  LoadState) printf 'masked\n' ;;
  FragmentPath)
    case "${'$'}{FAKE_FRAGMENT_MODE:-source}" in
      source) printf '%s/%s\n' "$NEXUS_TEST_GUARD_ROOT" "$unit" ;;
      target) printf '/dev/null\n' ;;
      *) exit 64 ;;
    esac
    ;;
  CanStart) printf 'no\n' ;;
  ActiveState) printf 'inactive\n' ;;
  *) exit 64 ;;
esac
`);
      chmodSync(fakeSystemctl, 0o755);
      const result = spawnSync('bash', ['-s', '--', controlRoot, fakeSystemctl], {
        encoding: 'utf8',
        input: `set -euo pipefail
export NEXUS_TEST_GUARD_ROOT="$1"
SYSTEMCTL_BIN="$2"
mkdir -p "$NEXUS_TEST_GUARD_ROOT"
ln -s /dev/null "$NEXUS_TEST_GUARD_ROOT/pm2-dominguez.service"
ln -s /dev/null "$NEXUS_TEST_GUARD_ROOT/nexus-release-pm2-recovery-daemon.service"
die() { printf 'refused: %s\\n' "$*" >&2; exit 1; }
stat() {
  case "$1:$2" in
    '-Lc:%U:%G:%a') printf 'root:root:755\\n' ;;
    '-c:%U:%G:%F') printf 'root:root:symbolic link\\n' ;;
    *) command stat "$@" ;;
  esac
}
${guardFunction}
export FAKE_FRAGMENT_MODE=source
assert_pm2_guard
export FAKE_FRAGMENT_MODE=target
if (assert_pm2_guard) >/dev/null 2>&1; then
  exit 41
fi
`,
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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

  it('documents governance-only authorization with the poller clean environment and pinned dependencies', () => {
    const requiredAssignments = [
      'PATH=/usr/bin:/bin',
      'HOME=/var/lib/nexus-release/home',
      'DOCKER_CONFIG=/etc/nexus-release/docker',
      'NEXUS_RELEASE_OWNER_AUTHORIZED=1',
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
    for (const document of [continuousDeploymentDoc, releaseOperatorRunbook]) {
      const command = bashBlockContaining(document, '--authorize-governance-only');
      expect(command).toMatch(/^sudo \/usr\/bin\/env -i /);
      for (const assignment of requiredAssignments) {
        expect(command).toContain(assignment);
      }
      expect(command).toContain(
        '/opt/nexus-release/checkout/scripts/release-poll.sh',
      );
      expect(command).toContain(
        '--authorize-governance-only <exact-32-hex-releaseId>',
      );
    }
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
    expect(provision).toContain(
      '/usr/bin/git -C "$STAGE_DIR" -c protocol.version=0 -c http.version=HTTP/1.1 fetch',
    );
    expect(provision).not.toContain(
      '/usr/bin/git -C "$STAGE_DIR" -c protocol.version=0 fetch',
    );
    expect(provision).not.toContain(
      '/usr/bin/git -C "$STAGE_DIR" fetch --quiet --no-tags --depth=1',
    );
    expect(provision).toContain("fetch --quiet --no-tags --depth=1 \\\n  origin \"$SOURCE_REF\"");
    expect(provision).toContain('test "$FETCHED_SHA" = "$SOURCE_SHA"');
    expect(provision).toContain('test "$(/usr/bin/node --version)" = v22.23.1');
    expect(provision).toContain("test -x /usr/bin/timeout || die '/usr/bin/timeout is missing'");
    expect(provision).toContain("test -x /usr/bin/sleep || die '/usr/bin/sleep is missing'");
    expect(provision).toContain(
      'cd / && /usr/bin/env -i HOME=/root PATH=/usr/bin:/bin \\\n'
      + '    NPM_CONFIG_USERCONFIG=/dev/null /usr/bin/npm --version',
    );
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
    for (const backupAsset of [
      'scripts/local-backup-systemd-install.sh',
      'scripts/local-backup.py',
      'scripts/local-backup-retry-launcher.sh',
      'ops/local-backup/systemd/nexus-local-backup-pre-promotion.service',
      'ops/local-backup/systemd/nexus-local-backup-restore-verify.timer',
      'ops/local-backup/nexus-local-backup.sudoers',
    ]) {
      expect(provision).toContain(backupAsset);
    }
    expect(provision).not.toContain(
      'sudo install -d -o root -g "$BUILD_GID" -m 710 "$CONTROL_ROOT"',
    );
    const asBuilderStart = provision.indexOf('as_builder() {');
    const asBuilderEnd = provision.indexOf(
      '\n}\n\nnormalize_builder_tracked_modes',
      asBuilderStart,
    );
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
    const trackedModeNormalizerStart = provision.indexOf('normalize_builder_tracked_modes() {');
    const trackedModeNormalizerEnd = provision.indexOf(
      '\n}\n\nrequire_safe_candidate_tree',
      trackedModeNormalizerStart,
    );
    expect(trackedModeNormalizerStart).toBeGreaterThan(asBuilderEnd);
    expect(trackedModeNormalizerEnd).toBeGreaterThan(trackedModeNormalizerStart);
    const trackedModeNormalizer = provision.slice(
      trackedModeNormalizerStart,
      trackedModeNormalizerEnd + 2,
    );
    expect(trackedModeNormalizer).toContain("'ls-files', '--stage', '-z'");
    expect(trackedModeNormalizer).toContain('100644|100755|120000');
    expect(trackedModeNormalizer).toContain('new TextDecoder(\'utf-8\', { fatal: true })');
    expect(trackedModeNormalizer).toContain('after.dev !== before.dev');
    expect(trackedModeNormalizer).toContain('after.ino !== before.ino');
    expect(provision).toContain('/usr/bin/pgrep -u "$BUILD_UID"');
    expect(provision).toContain("*) die 'cannot prove the dedicated build account is quiescent'");
    expect(provision).toContain("test -x /usr/bin/findmnt || die '/usr/bin/findmnt is missing'");
    expect(provision).toContain('/usr/bin/findmnt -rn -t fuse.portal -o TARGET');
    expect(provision).toContain('0|1) ;;');
    expect(provision).toContain("die 'portal-mount inventory failed before open-handle proof'");
    expect(provision).toContain('[[ "$portal_mount" =~ ^/run/user/[0-9]+/doc$ ]]');
    expect(provision).toContain(
      '/usr/bin/findmnt -rn -M "$portal_mount" -o SOURCE,FSTYPE',
    );
    expect(provision).toContain('test "$portal_identity" = "portal fuse.portal"');
    expect(provision).toContain('lsof_args+=(+e "$portal_mount")');
    expect(provision).toContain('/usr/bin/findmnt -rn -t fuse.gvfsd-fuse -o TARGET');
    expect(provision).toContain("die 'GVFS-mount inventory failed before open-handle proof'");
    expect(provision).toContain('[[ "$gvfs_mount" =~ ^/run/user/[0-9]+/gvfs$ ]]');
    expect(provision).toContain(
      '/usr/bin/findmnt -rn -M "$gvfs_mount" -o SOURCE,FSTYPE',
    );
    expect(provision).toContain(
      'test "$gvfs_identity" = "gvfsd-fuse fuse.gvfsd-fuse"',
    );
    expect(provision).toContain('lsof_args+=(+e "$gvfs_mount")');
    expect(provision).toContain('lsof_args+=(+D "$candidate")');
    expect(provision).toContain('/usr/bin/lsof "${lsof_args[@]}"');
    expect(provision).not.toContain('/usr/bin/lsof -nP -F pfn +D "$candidate"');
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
    const controlLockIdentity = provision.indexOf(
      "control-plane mutex changed identity after acquisition",
      controlLock,
    );
    const releaseLockPreparation = provision.indexOf(
      '\nprepare_release_lock\n',
      controlLockIdentity,
    );
    const resumeAdmission = provision.indexOf('RESUME_TRANSACTION=0');
    const buildFetch = provision.indexOf(
      '-c protocol.version=0 -c http.version=HTTP/1.1 fetch --quiet --no-tags --depth=1',
    );
    expect(controlLock).toBeGreaterThan(-1);
    expect(controlLockIdentity).toBeGreaterThan(controlLock);
    expect(releaseLockPreparation).toBeGreaterThan(controlLockIdentity);
    expect(releaseLockPreparation).toBeLessThan(resumeAdmission);
    expect(resumeAdmission).toBeLessThan(buildFetch);
    expect(provision).toContain('release_lock_is_exact()');
    expect(provision).toContain('prepare_release_lock()');
    expect(provision).toContain(
      '( umask 077; set -o noclobber; : >"$RELEASE_LOCK" ) 2>/dev/null',
    );
    expect(provision).toContain(
      'sync -f "$RELEASE_LOCK"; sync -f "$(dirname "$RELEASE_LOCK")"',
    );
    expect(provision).toContain(
      "test \"$(stat -Lc '%U:%G:%a:%h' -- \"$RELEASE_LOCK\")\" = root:root:600:1",
    );
    expect(provision).toContain('nexus.control-plane-transaction.v1');
    expect(provision).toContain(
      'keys == ["backupTimerWasActive","backupTimerWasEnabled",',
    );
    for (const transactionField of [
      'backupTimerWasActive',
      'backupTimerWasEnabled',
      'controlPlaneSchema',
      'controlPlaneDigest',
      'pollerTimerDesiredActive',
      'pollerTimerDesiredEnabled',
      'livenessTimerWasActive',
      'livenessTimerWasEnabled',
      'livenessTimerDesiredActive',
      'livenessTimerDesiredEnabled',
      'restoreVerifyTimerWasActive',
      'restoreVerifyTimerWasEnabled',
    ]) {
      expect(provision).toContain(transactionField);
    }
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
    const disable = provision.indexOf('disable_timer_if_present "$TIMER_UNIT"', prepared);
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
    expect(provision).toContain('require_local_backup_services_settled()');
    expect(provision).toContain('verify_installed_backup_interface()');
    expect(provision).toContain(
      "'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|555|755'",
    );
    expect(provision).toContain(
      "'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/"
      + "nexus-local-backup/local-backup-retry-launcher.sh|555|755'",
    );
    expect(provision).toContain(
      "'ops/local-backup/systemd/nexus-local-backup.service|/etc/systemd/system/nexus-local-backup.service|444|644'",
    );
    expect(provision).toContain('require_installed_backup_verifier_pair()');
    expect(provision).toContain(
      "test \"$CONTROL_PLANE_MODE\" = rollback \\\n      || die 'new controller candidate lacks its installed-backup verifier'",
    );
    expect(provision).toContain(
      "test \"$CONTROL_PLANE_MODE\" = rollback \\\n      || die 'installed local-backup checker is absent outside rollback'",
    );

    expect(provision).toContain('candidate_transaction_guards_state()');
    expect(provision).toContain('new controller candidate lacks transaction symlink guards');
    expect(provision).toContain(
      'installed service cannot honor a symbolic transaction gate',
    );
    expect(provision).toContain(
      'installed service cannot honor a symbolic post-gate journal',
    );
    expect(provision).toContain(
      'candidate backup-liveness service lacks the durable transaction gate',
    );
    expect(provision).toContain('nexus-release-backup-liveness-force.service');
    expect(provision).toContain(
      'start_and_prove_post_gate_service nexus-release-backup-liveness-force.service',
    );
    const postGateProof = provision.match(
      /start_and_prove_post_gate_service\(\) \{[\s\S]*?\n\}/u,
    )?.[0];
    expect(postGateProof).toBeTruthy();
    expect(postGateProof).toContain('case "$load_state:$active" in');
    expect(postGateProof).toContain('loaded:inactive) ;;');
    expect(postGateProof).toContain('loaded:failed)');
    expect(postGateProof!.indexOf('loaded:failed)'))
      .toBeLessThan(postGateProof!.indexOf('systemctl reset-failed "$unit"'));
    expect(provision).not.toContain(
      'start_and_prove_post_gate_service nexus-release-backup-liveness.service',
    );
    expect(provision).toContain(
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json',
    );
    expect(provision).toContain(
      'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json',
    );

    const previousPhase = provision.indexOf('publish_transaction_phase previous_selected');
    const activePhase = provision.indexOf('publish_transaction_phase active_selected');
    const capabilitiesPhase = provision.indexOf('publish_transaction_phase capabilities_installed');
    const backupInterfacePhase = provision.indexOf(
      'publish_transaction_phase backup_interface_installed',
    );
    const reloadPhase = provision.indexOf('publish_transaction_phase units_reloaded');
    const timersPhase = provision.indexOf('publish_transaction_phase timers_restored');
    const completePhase = provision.indexOf('publish_transaction_phase complete');
    const retireGate = provision.indexOf('mv -T -- "$TRANSACTION_STATE" "$POST_GATE_STATE"');
    const enterFinalization = provision.indexOf(
      'mv -T -- "$POST_GATE_STATE" "$FINALIZATION_STATE"',
      retireGate,
    );
    const retireFinalization = provision.indexOf('rm -f -- "$FINALIZATION_STATE"',
      enterFinalization);
    expect(candidateMove).toBeLessThan(previousPhase);
    expect(previousPhase).toBeLessThan(activePhase);
    expect(activePhase).toBeLessThan(capabilitiesPhase);
    expect(capabilitiesPhase).toBeLessThan(backupInterfacePhase);
    expect(backupInterfacePhase).toBeLessThan(reloadPhase);
    expect(reloadPhase).toBeLessThan(timersPhase);
    expect(timersPhase).toBeLessThan(completePhase);
    expect(completePhase).toBeLessThan(retireGate);
    expect(retireGate).toBeLessThan(enterFinalization);
    expect(enterFinalization).toBeLessThan(retireFinalization);
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
      .toBeLessThan(enterFinalization);
    expect(provision).toContain('require_installed_transition_bytes()');
    expect(provision).toContain('start_terminal_timer_if_active nexus-release-poller.timer');
    expect(provision).toContain('start_terminal_timer_if_active nexus-release-heartbeat.timer');
    expect(provision).toContain('start_terminal_timer_if_active nexus-local-backup.timer');
    expect(provision).toContain(
      'start_terminal_timer_if_active nexus-local-backup-restore-verify.timer',
    );
    expect(provision).toContain('prove_installed_control_plane "$TARGET"');
    expect(provision.lastIndexOf('require_immutable_candidate "$TARGET" "$CANDIDATE_DIGEST"'))
      .toBeLessThan(enterFinalization);
    expect(provision.lastIndexOf('read_timer_bits nexus-release-heartbeat.timer'))
      .toBeLessThan(retireFinalization);
    expect(provision.indexOf('TIMER_FAILSAFE_ARMED=0')).toBeLessThan(retireGate);
    expect(provision.indexOf('sync -f "$STATE_ROOT"', retireFinalization))
      .toBeGreaterThan(retireFinalization);
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
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-transaction.json',
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
      expect(unit).toContain(
        'ConditionPathExists=!/var/lib/nexus-release/state/control-plane-post-gate.json',
      );
      expect(unit).toContain(
        'ConditionPathIsSymbolicLink=!/var/lib/nexus-release/state/control-plane-post-gate.json',
      );
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
      'ExecStart=/opt/nexus-release/checkout/scripts/'
      + 'release-backup-liveness-launcher.sh --weekly',
    );
    expect(heartbeat.match(/^ExecStart=(.+)$/m)?.[1]).not.toContain(
      'NEXUS_RELEASE_TELEGRAM_',
    );
    expect(heartbeat.match(/^ExecStart=(.+)$/m)?.[1]).not.toContain('AUDIT_MIRROR_HOST');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_NODE_BIN=');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_FLOCK_BIN=');
    expect(pollerEnv).not.toContain('NEXUS_RELEASE_GIT_BIN=');
    expect(runbook).not.toContain('sudo npm --prefix /opt/nexus-release/checkout');
  });

  it('normalizes restrictive builder checkout modes before immutable freeze', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const provision = bashBlockContaining(runbook, 'CONTROL-PLANE PROVISION REFUSED');
    const start = provision.indexOf('normalize_builder_tracked_modes() {');
    const end = provision.indexOf('\n}\n\nrequire_safe_candidate_tree', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const normalizer = provision.slice(start, end + 2);
    const programMarker = "<<'NODE'\n";
    const programStart = normalizer.indexOf(programMarker);
    const programEnd = normalizer.lastIndexOf('\nNODE');
    expect(programStart).toBeGreaterThanOrEqual(0);
    expect(programEnd).toBeGreaterThan(programStart);
    const normalizerProgram = normalizer.slice(programStart + programMarker.length, programEnd);
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-builder-modes-'));
    const plain = join(fixtureRoot, 'plain.txt');
    const executable = join(fixtureRoot, 'executable.sh');
    try {
      writeFileSync(plain, 'plain\n', { mode: 0o644 });
      writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(spawnSync('git', ['init', '--quiet', fixtureRoot], { encoding: 'utf8' }).status)
        .toBe(0);
      expect(spawnSync('git', ['-C', fixtureRoot, 'add', '--', 'plain.txt', 'executable.sh'], {
        encoding: 'utf8',
      }).status).toBe(0);
      expect(spawnSync('git', ['-C', fixtureRoot, 'update-index', '--chmod=-x', 'plain.txt'], {
        encoding: 'utf8',
      }).status).toBe(0);
      expect(spawnSync('git', ['-C', fixtureRoot, 'update-index', '--chmod=+x', 'executable.sh'], {
        encoding: 'utf8',
      }).status).toBe(0);
      chmodSync(plain, 0o600);
      chmodSync(executable, 0o700);

      const execution = spawnSync(
        process.execPath,
        ['--input-type=module', '-', fixtureRoot],
        { encoding: 'utf8', input: normalizerProgram },
      );
      expect(execution.status, execution.stderr).toBe(0);
      expect(lstatSync(plain).mode & 0o7777).toBe(0o644);
      expect(lstatSync(executable).mode & 0o7777).toBe(0o755);

      chmodSync(plain, (lstatSync(plain).mode & 0o7777) & ~0o222);
      chmodSync(executable, (lstatSync(executable).mode & 0o7777) & ~0o222);
      expect(lstatSync(plain).mode & 0o7777).toBe(0o444);
      expect(lstatSync(executable).mode & 0o7777).toBe(0o555);
    } finally {
      chmodSync(fixtureRoot, 0o700);
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('creates the initial release mutex once and refuses unsafe or absent non-initial state', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const provision = bashBlockContaining(runbook, 'CONTROL-PLANE PROVISION REFUSED');
    const helpers = [
      bashFunction(provision, 'release_lock_is_exact'),
      bashFunction(provision, 'require_release_lock'),
      bashFunction(provision, 'prepare_release_lock'),
    ].join('\n');
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-release-lock-'));
    const releaseLock = join(fixtureRoot, 'release.lock');
    const syncLog = join(fixtureRoot, 'sync.log');
    try {
      const result = spawnSync('bash', ['-s', '--', fixtureRoot], {
        encoding: 'utf8',
        input: `set -euo pipefail
FIXTURE_ROOT="$1"
SYNC_LOG="$FIXTURE_ROOT/sync.log"
NEXUS_TEST_UNSAFE_PATH=
die() { printf 'refused: %s\\n' "$*" >&2; exit 1; }
stat() {
  if test "$1" = -Lc && test "$2" = '%U:%G:%a:%h' && test "$3" = --; then
    test -f "$4" && test ! -L "$4" || return 1
    if test "$4" = "$NEXUS_TEST_UNSAFE_PATH"; then
      printf 'root:root:644:1\\n'
    else
      printf 'root:root:600:1\\n'
    fi
    return 0
  fi
  command stat "$@"
}
sync() {
  test "$1" = -f && test "$#" -eq 2
  printf '%s\\n' "$2" >>"$SYNC_LOG"
}
${helpers}

CONTROL_PLANE_MODE=initial
RELEASE_LOCK="$FIXTURE_ROOT/release.lock"
prepare_release_lock
printf 'sentinel\\n' >"$RELEASE_LOCK"
prepare_release_lock
test "$(<"$RELEASE_LOCK")" = sentinel

NEXUS_TEST_UNSAFE_PATH="$FIXTURE_ROOT/unsafe.lock"
: >"$NEXUS_TEST_UNSAFE_PATH"
RELEASE_LOCK="$NEXUS_TEST_UNSAFE_PATH"
if (prepare_release_lock) >/dev/null 2>&1; then
  exit 41
fi

NEXUS_TEST_UNSAFE_PATH=
printf 'target\\n' >"$FIXTURE_ROOT/target"
ln -s "$FIXTURE_ROOT/target" "$FIXTURE_ROOT/symbolic.lock"
RELEASE_LOCK="$FIXTURE_ROOT/symbolic.lock"
if (prepare_release_lock) >/dev/null 2>&1; then
  exit 42
fi

CONTROL_PLANE_MODE=upgrade
RELEASE_LOCK="$FIXTURE_ROOT/missing.lock"
if (prepare_release_lock) >/dev/null 2>&1; then
  exit 43
fi
`,
      });
      expect(result.status, result.stderr).toBe(0);
      const lockStat = lstatSync(releaseLock);
      expect(lockStat.isFile()).toBe(true);
      expect(lockStat.isSymbolicLink()).toBe(false);
      expect(lockStat.mode & 0o777).toBe(0o600);
      expect(readFileSync(releaseLock, 'utf8')).toBe('sentinel\n');
      expect(readFileSync(syncLog, 'utf8').trim().split('\n')).toEqual([
        releaseLock,
        fixtureRoot,
        releaseLock,
        fixtureRoot,
      ]);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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
    expect(cutover).toContain(
      'masked)\n      test "$UNIT" = nexus-release-pm2-recovery-daemon.service',
    );
    expect(cutover).toContain('unexpectedly masked before first cutover');
    expect(cutover).toContain('install_pm2_guard "$UNIT"');
    expect(cutover).toContain('PM2_GUARD_ROOT=/etc/systemd/system.control');
    expect(cutover).toContain('test "$load" = masked');
    expect(cutover).toContain('test "$fragment" = "$guard"');
    expect(cutover).not.toContain('test "$fragment" = /dev/null');
    expect(cutover).toContain('test "$can_start" = no');
    expect(cutover).not.toContain('systemctl mask --runtime');
    expect(cutover).toContain('require_pm2_guard');
    expect(cutover).toContain('require_no_legacy_listeners');
    expect(cutover).toContain('MAINTENANCE_LOCK=/run/lock/nexus-release-sonar.lock');
    expect(cutover.indexOf('flock -n 9')).toBeLessThan(cutover.indexOf('flock -n 8'));
    expect(cutover).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(cutover).toContain('productionArtifactDigest');
    expect(cutover).toContain('productionDatabaseIdentity');
    expect(cutover.indexOf('RUNTIME_EVIDENCE_STAGE='))
      .toBeLessThan(cutover.indexOf(
        'run_pm2_as_dominguez stop',
      ));
    expect(cutover).toContain('sudo sync -f "$RUNTIME_EVIDENCE_STAGE"');
    expect(cutover).toContain(
      'sudo mv -T -- "$RUNTIME_EVIDENCE_STAGE" "$RUNTIME_EVIDENCE"',
    );
    expect(cutover).toContain('sudo sync -f "$(dirname "$RUNTIME_EVIDENCE")"');
    expect(cutover.indexOf('sudo sync -f "$(dirname "$RUNTIME_EVIDENCE")"'))
      .toBeLessThan(cutover.indexOf(
        'run_pm2_as_dominguez stop',
      ));
    expect(cutover).not.toContain('sudo ln "$RUNTIME_EVIDENCE_STAGE"');
    const preStopTargetGuard = 'container target exists before PM2 stop';
    expect(cutover).toContain(
      'for TARGET in "$NEW_PRODUCTION/bot.db" "$NEW_PRODUCTION/bot.db.next"',
    );
    expect(cutover).toContain('"$NEW_STAGING/bot.db" "$NEW_STAGING/bot.db.next"');
    expect(cutover.indexOf(preStopTargetGuard))
      .toBeLessThan(cutover.indexOf(
        'run_pm2_as_dominguez stop',
      ));
    expect(cutover.indexOf('installed runtime tree differs from its captured artifact'))
      .toBeLessThan(cutover.indexOf(
        'run_pm2_as_dominguez stop',
      ));
    expect(cutover).toContain('nexus.bootstrap-database-transition.v1');
    expect(cutover).toContain('sudo sync -f "$TRANSITION_EVIDENCE_STAGE"');

    const productionTargetDigest = cutover.indexOf(
      'PRODUCTION_TARGET_LOGICAL_SHA="$(logical_digest "$NEW_PRODUCTION/bot.db.next")"',
    );
    const stagingTargetDigest = cutover.indexOf(
      'STAGING_TARGET_LOGICAL_SHA="$(logical_digest "$NEW_STAGING/bot.db.next")"',
    );
    const targetSidecarCleanup = cutover.indexOf(
      'remove_proven_stale_wal_sidecars \\\n'
        + '  "$NEW_PRODUCTION/bot.db.next" "$NEW_STAGING/bot.db.next"',
    );
    const targetSidecarAbsence = cutover.indexOf(
      'require_no_sqlite_sidecars \\\n'
        + '  "$NEW_PRODUCTION/bot.db.next" "$NEW_STAGING/bot.db.next"',
      targetSidecarCleanup,
    );
    const publishProductionTarget = cutover.indexOf(
      'sudo mv -f "$NEW_PRODUCTION/bot.db.next" "$NEW_PRODUCTION/bot.db"',
    );
    const finalTargetSidecarCleanup = cutover.lastIndexOf(
      'remove_proven_stale_wal_sidecars \\\n'
        + '  "$NEW_PRODUCTION/bot.db" "$NEW_STAGING/bot.db"',
    );
    const transitionEvidenceStart = cutover.indexOf(
      'TRANSITION_EVIDENCE_TEMP="$(mktemp)"',
      finalTargetSidecarCleanup,
    );
    const transitionEvidencePublish = cutover.indexOf(
      'sudo mv -T -- "$TRANSITION_EVIDENCE_STAGE" "$TRANSITION_EVIDENCE"',
      transitionEvidenceStart,
    );
    expect(productionTargetDigest).toBeGreaterThanOrEqual(0);
    expect(stagingTargetDigest).toBeGreaterThanOrEqual(0);
    expect(targetSidecarCleanup).toBeGreaterThan(productionTargetDigest);
    expect(targetSidecarCleanup).toBeGreaterThan(stagingTargetDigest);
    expect(targetSidecarAbsence).toBeGreaterThan(targetSidecarCleanup);
    expect(publishProductionTarget).toBeGreaterThan(targetSidecarAbsence);
    expect(finalTargetSidecarCleanup).toBeGreaterThan(publishProductionTarget);
    expect(transitionEvidenceStart).toBeGreaterThan(finalTargetSidecarCleanup);
    expect(transitionEvidencePublish).toBeGreaterThan(transitionEvidenceStart);
    const postCleanupTransition = cutover.slice(
      finalTargetSidecarCleanup,
      transitionEvidencePublish,
    );
    expect(postCleanupTransition).toContain(
      '--arg targetProductionLogicalDigest "$PRODUCTION_TARGET_LOGICAL_SHA"',
    );
    expect(postCleanupTransition).toContain(
      '--arg targetStagingLogicalDigest "$STAGING_TARGET_LOGICAL_SHA"',
    );
    expect(postCleanupTransition).not.toContain(
      'logical_digest "$NEW_PRODUCTION/bot.db"',
    );
    expect(postCleanupTransition).not.toContain(
      'logical_digest "$NEW_STAGING/bot.db"',
    );

    const loadCaseStart = cutover.indexOf('case "$LOAD_STATE" in');
    const loadCaseEnd = cutover.indexOf('\n  esac', loadCaseStart);
    expect(loadCaseStart).toBeGreaterThanOrEqual(0);
    expect(loadCaseEnd).toBeGreaterThan(loadCaseStart);
    const loadCase = cutover.slice(loadCaseStart, loadCaseEnd + '\n  esac'.length);
    const loadCaseResult = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      input: `set -euo pipefail
die() { return 1; }
sudo() { return 0; }
check_load_state() {
${loadCase}
}
UNIT=nexus-release-pm2-recovery-daemon.service
LOAD_STATE=masked
check_load_state
UNIT=pm2-dominguez.service
if check_load_state; then
  exit 41
fi
LOAD_STATE=loaded
check_load_state
`,
    });
    expect(loadCaseResult.status, loadCaseResult.stderr).toBe(0);
    expect(cutover).toContain(
      'sudo mv -T -- "$TRANSITION_EVIDENCE_STAGE" "$TRANSITION_EVIDENCE"',
    );
    expect(cutover).toContain('sudo sync -f "$(dirname "$TRANSITION_EVIDENCE")"');
    expect(cutover).not.toContain('sudo ln "$TRANSITION_EVIDENCE_STAGE"');
    expect(cutover).toContain('governed backup is not bound to legacy production before cutover');
  });

  it('reconciles real zero-WAL sidecars on both validated temporary snapshots', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const cutover = bashBlockContaining(runbook, 'CUTOVER REFUSED');
    const functions = [
      bashFunction(cutover, 'require_no_open_handles'),
      bashFunction(cutover, 'require_no_sqlite_sidecars'),
      bashFunction(cutover, 'require_valid_sqlite'),
      bashFunction(cutover, 'logical_digest'),
      bashFunction(cutover, 'remove_proven_stale_wal_sidecars'),
    ].join('\n\n');

    const result = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}:/sbin:/usr/sbin`,
      },
      input: `set -euo pipefail
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT

die() {
  printf 'fixture refused: %s\\n' "$*" >&2
  exit 1
}

portable_links() {
  case "$(uname -s)" in
    Darwin) command stat -f '%l' "$1" ;;
    *) command stat -c '%h' -- "$1" ;;
  esac
}

portable_size() {
  case "$(uname -s)" in
    Darwin) command stat -f '%z' "$1" ;;
    *) command stat -c '%s' -- "$1" ;;
  esac
}

sudo() {
  local format links path program size
  program="$1"; shift
  case "$program" in
    lsof) return 1 ;;
    stat)
      test "$1" = -c
      format="$2"; shift 2
      test "$1" = --; shift
      path="$1"
      test -f "$path" && test ! -L "$path"
      links="$(portable_links "$path")"
      size="$(portable_size "$path")"
      case "$format" in
        '%F:%h:%s')
          if test "$size" -eq 0; then
            printf 'regular empty file:%s:%s\\n' "$links" "$size"
          else
            printf 'regular file:%s:%s\\n' "$links" "$size"
          fi
          ;;
        '%F:%h') printf 'regular file:%s\\n' "$links" ;;
        *) return 64 ;;
      esac
      ;;
    *) command "$program" "$@" ;;
  esac
}

${functions}

production_source="$fixture/legacy-production.db"
staging_source="$fixture/legacy-staging.db"
production_target="$fixture/production-bot.db.next"
staging_target="$fixture/staging-bot.db.next"

for spec in \
  "$production_source|$production_target|production" \
  "$staging_source|$staging_target|staging"; do
  IFS='|' read -r source target role <<<"$spec"
  sqlite3 "$source" \
    "PRAGMA journal_mode=WAL;
     CREATE TABLE evidence(role TEXT PRIMARY KEY, value INTEGER NOT NULL);
     INSERT INTO evidence(role,value) VALUES ('$role',1);
     PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
  sqlite3 "$source" ".backup '$target'"
  test "$(od -An -t u1 -j 18 -N 2 "$target" | awk '{$1=$1; print}')" = '2 2'
  # A read-only WAL open with no sidecars is SQLite-build dependent. Leave the
  # exact real zero-WAL state observed live without a graceful connection close
  # so every build validates and reconciles the same on-disk fixture.
  python3 -c \
    'import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
checkpoint = connection.execute("PRAGMA wal_checkpoint(TRUNCATE)").fetchone()
assert checkpoint == (0, 0, 0), checkpoint
os._exit(0)' "$target"
  require_valid_sqlite "$target"
  test -f "$target-wal" && test ! -L "$target-wal"
  test -f "$target-shm" && test ! -L "$target-shm"
  test "$(portable_links "$target-wal")" -eq 1
  test "$(portable_size "$target-wal")" -eq 0
  test "$(portable_links "$target-shm")" -eq 1
done

production_source_digest="$(logical_digest "$production_source")"
staging_source_digest="$(logical_digest "$staging_source")"
production_target_digest="$(logical_digest "$production_target")"
staging_target_digest="$(logical_digest "$staging_target")"
test "$production_target_digest" = "$production_source_digest"
test "$staging_target_digest" = "$staging_source_digest"

restore_xtrace=0
case "$-" in
  *x*) restore_xtrace=1; { set +x; } 2>/dev/null ;;
esac
remove_proven_stale_wal_sidecars "$production_target" "$staging_target"
require_no_sqlite_sidecars "$production_target" "$staging_target"
if test "$restore_xtrace" -eq 1; then set -x; fi

production_final="$fixture/production-bot.db"
staging_final="$fixture/staging-bot.db"
mv -- "$production_target" "$production_final"
mv -- "$staging_target" "$staging_final"

transition_evidence="$(jq -cn \
  --arg targetProductionLogicalDigest "$production_target_digest" \
  --arg targetStagingLogicalDigest "$staging_target_digest" \
  '{schema:"nexus.bootstrap-database-transition.v1",
    target:{production:{logicalDigest:$targetProductionLogicalDigest},
      staging:{logicalDigest:$targetStagingLogicalDigest}}}')"
jq -e --arg production "$production_source_digest" \
  --arg staging "$staging_source_digest" \
  '.schema == "nexus.bootstrap-database-transition.v1"
   and .target.production.logicalDigest == $production
   and .target.staging.logicalDigest == $staging' \
  <<<"$transition_evidence" >/dev/null

for spec in "$production_final|production" "$staging_final|staging"; do
  IFS='|' read -r target role <<<"$spec"
  test "$(sqlite3 "file:$target?mode=ro&immutable=1" 'PRAGMA integrity_check;')" = ok
  test "$(sqlite3 "file:$target?mode=ro&immutable=1" \
    'SELECT role FROM evidence;')" = "$role"
  require_no_sqlite_sidecars "$target"
done
`,
    });
    expect(result.status, result.stderr).toBe(0);
  });

  it('binds every governed backup invocation to immutable installed producer bytes', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const cutover = bashBlockContaining(runbook, 'CUTOVER REFUSED');
    const blocks = [
      cutover,
      bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED'),
    ];
    for (const block of blocks) {
      expect(block).toContain('require_local_backup_installation()');
      expect(block).toContain(
        '[[ "$active_root" =~ ^/opt/nexus-release/control-plane/[0-9a-f]{40}$ ]]',
      );
      expect(block).toContain(
        "'scripts/local-backup.py|/usr/local/libexec/nexus-local-backup/local-backup.py|755'",
      );
      expect(block).toContain(
        "'scripts/local-backup-retry-launcher.sh|/usr/local/libexec/"
        + "nexus-local-backup/local-backup-retry-launcher.sh|755'",
      );
      expect(block).toContain('sudo cmp -s -- "$source" "$destination"');
      expect(block).toContain("root:root:$mode:1");
      expect(block).toContain('--property=FragmentPath --value');
      expect(block).toContain('--property=DropInPaths --value');
      expect(block).toContain('--property=ExecStart --value');
      expect(block).toContain('argv[]=/usr/local/libexec/nexus-local-backup/local-backup.py pre-promotion ;');
      expect(block).toContain('sudo systemctl daemon-reload');
    }

    const proofDefinitionEnd = cutover.indexOf(
      '\n}\n\nPM2_GUARD_ROOT=',
      cutover.indexOf('require_local_backup_installation()'),
    );
    const firstProof = cutover.indexOf(
      '\nrequire_local_backup_installation\n',
      proofDefinitionEnd,
    );
    const pm2Stop = cutover.indexOf(
      'run_pm2_as_dominguez stop',
    );
    const firstBackup = cutover.indexOf(
      'sudo systemctl start nexus-local-backup-pre-promotion.service',
    );
    expect(firstProof).toBeGreaterThan(proofDefinitionEnd);
    expect(firstProof).toBeLessThan(pm2Stop);
    expect(firstProof).toBeLessThan(firstBackup);
    const cutoverBackupStarts = [
      ...cutover.matchAll(
        /sudo systemctl start nexus-local-backup-pre-promotion\.service/g,
      ),
    ].map((match) => match.index ?? -1);
    expect(cutoverBackupStarts).toHaveLength(2);
    for (const backupStart of cutoverBackupStarts) {
      const cleanup = cutover.lastIndexOf(
        'remove_proven_stale_wal_sidecars',
        backupStart,
      );
      const absence = cutover.lastIndexOf(
        'require_no_sqlite_sidecars',
        backupStart,
      );
      const requested = cutover.lastIndexOf(
        'BACKUP_REQUESTED_MS="$(date +%s%3N)"',
        backupStart,
      );
      expect(cleanup).toBeGreaterThanOrEqual(0);
      expect(absence).toBeGreaterThan(cleanup);
      expect(requested).toBeGreaterThan(absence);
      expect(backupStart).toBeGreaterThan(requested);
      expect(cutover.slice(cleanup, backupStart)).not.toContain('sudo sqlite3');
    }

    const expectedFreshBackupCalls = [3, 3, 1];
    for (const [blockIndex, block] of blocks.slice(1).entries()) {
      const freshBackup = block.slice(
        block.indexOf('fresh_backup_for() {'),
        block.indexOf('\n}\n\nPM2_GUARD_ROOT=', block.indexOf('fresh_backup_for() {')),
      );
      const installationProof = freshBackup.indexOf('require_local_backup_installation');
      const cleanup = freshBackup.indexOf(
        'remove_proven_stale_wal_sidecars "$expected"',
      );
      const absence = freshBackup.indexOf(
        'require_no_sqlite_sidecars "$expected"',
      );
      const requested = freshBackup.indexOf('requested_ms="$(date +%s%3N)"');
      const backupStart = freshBackup.indexOf(
        'sudo systemctl start nexus-local-backup-pre-promotion.service',
      );
      expect(installationProof).toBeGreaterThanOrEqual(0);
      expect(installationProof)
        .toBeLessThan(cleanup);
      expect(cleanup).toBeLessThan(absence);
      expect(absence).toBeLessThan(requested);
      expect(requested).toBeLessThan(backupStart);
      expect(freshBackup.slice(cleanup, backupStart)).not.toContain('sudo sqlite3');
      expect(block.match(/fresh_backup_for "/g) ?? []).toHaveLength(
        expectedFreshBackupCalls[blockIndex],
      );
    }

    const preBaseline = blocks[1];
    const finalLegacyValidation = preBaseline.indexOf(
      'require_canonical_database "$OLD_STAGING" "$STAGING_DATABASE_IDENTITY"',
    );
    const finalLegacyCleanup = preBaseline.indexOf(
      'remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"',
      finalLegacyValidation,
    );
    const guardRetirement = preBaseline.indexOf(
      'retire_canonical_pm2_guard pm2-dominguez.service',
      finalLegacyCleanup,
    );
    expect(finalLegacyValidation).toBeGreaterThanOrEqual(0);
    expect(finalLegacyCleanup).toBeGreaterThan(finalLegacyValidation);
    expect(guardRetirement).toBeGreaterThan(finalLegacyCleanup);

    const rebaseline = blocks[3];
    const legacyDigests = rebaseline.indexOf(
      'PRODUCTION_LOGICAL_SHA="$(logical_digest "$OLD_PRODUCTION")"',
    );
    const postDigestCleanup = rebaseline.indexOf(
      'remove_proven_stale_wal_sidecars "$OLD_PRODUCTION" "$OLD_STAGING"',
      legacyDigests,
    );
    expect(legacyDigests).toBeGreaterThanOrEqual(0);
    expect(postDigestCleanup).toBeGreaterThan(legacyDigests);
    expect(rebaseline).toContain(
      'container reset candidate differs from authoritative PM2 data: $DB"\n'
        + '    remove_proven_stale_wal_sidecars "$DB"\n'
        + '    require_no_sqlite_sidecars "$DB"',
    );
    expect(rebaseline).toContain(
      'governed database differs from authoritative PM2 data: $DB"\n'
        + '    remove_proven_stale_wal_sidecars "$DB"\n'
        + '    require_no_sqlite_sidecars "$DB"',
    );

    expect(runbook).toContain(
      'ACTIVE_BACKUP_SOURCE="$(sudo readlink -f -- /opt/nexus-release/checkout)"',
    );
    expect(runbook).toContain(
      'sudo "$ACTIVE_BACKUP_SOURCE/scripts/local-backup-systemd-install.sh"',
    );
    expect(runbook).not.toContain(
      'local-backup-systemd-install.sh" /opt/nexus-release/checkout',
    );
    const repair = bashBlockContaining(runbook, 'ACTIVE_BACKUP_SOURCE=');
    const repairSyntax = spawnSync('bash', ['-n'], {
      input: repair,
      encoding: 'utf8',
    });
    expect(repairSyntax.status, repairSyntax.stderr).toBe(0);
    expect(repair.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(repair.indexOf('.nexus-control-plane-ready'))
      .toBeLessThan(repair.indexOf('local-backup-systemd-install.sh'));
  });

  it('emits a source SHA only from valid legacy markers with the real jq filters', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const filters = [...runbook.matchAll(
      /(?:RUNTIME_SHA|SOURCE_SHA)="\$\(sudo jq -er(?: \\\n+)?\s*'([\s\S]*?)' "\$MARKER"\)"/g,
    )].map((match) => match[1]);
    const runtimeSha = 'a'.repeat(40);
    const artifactDigest = 'b'.repeat(64);
    const valid = {
      schema: 'nexus.release-bundle.v1',
      runtimeSha,
      artifactDigest,
    };
    const invalid = [
      { ...valid, schema: 'nexus.release-bundle.v0' },
      { ...valid, runtimeSha: 'a'.repeat(39) },
      { ...valid, artifactDigest: 'b'.repeat(63) },
      { ...valid, runtimeSha: false },
      { ...valid, artifactDigest: null },
      null,
    ];

    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      expect(filter.trimStart()).toMatch(/^select\(/);
      const accepted = spawnSync('jq', ['-er', filter], {
        input: JSON.stringify(valid),
        encoding: 'utf8',
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout.trim()).toBe(runtimeSha);

      for (const fixture of invalid) {
        const rejected = spawnSync('jq', ['-er', filter], {
          input: JSON.stringify(fixture),
          encoding: 'utf8',
        });
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).not.toBe(0);
        expect(rejected.stdout).toBe('');
      }
    }
  });

  it('binds every null-input cutover and recovery evidence field to its jq argument', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const cutover = bashBlockContaining(runbook, 'CUTOVER REFUSED');
    const preBaseline = bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED');
    const recovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');
    const rebaseline = bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED');
    expect([cutover, preBaseline, recovery, rebaseline].map(
      (block) => block.match(/\bjq -cn\b/g)?.length ?? 0,
    )).toEqual([2, 0, 1, 3]);

    const values = (...names: string[]): Record<string, string> => Object.fromEntries(
      names.map((name) => [name, `bound:${name}`]),
    );
    const runtimeValues = values(
      'createdAt',
      'productionSourceSha',
      'productionArtifactDigest',
      'productionRuntimePath',
      'productionMarkerSha256',
      'productionDatabaseIdentity',
      'stagingSourceSha',
      'stagingArtifactDigest',
      'stagingRuntimePath',
      'stagingMarkerSha256',
      'stagingDatabaseIdentity',
    );
    const runtimePrograms = [cutover, rebaseline].flatMap((block) => (
      jqObjectProgramsContainingSchema(block, 'nexus.bootstrap-legacy-runtime-capture.v2')
    ));
    expect(runtimePrograms).toHaveLength(2);
    for (const program of runtimePrograms) {
      expect(runJqNullInputObject(program, runtimeValues)).toEqual({
        schema: 'nexus.bootstrap-legacy-runtime-capture.v2',
        ...runtimeValues,
      });
    }

    const transitionValues = values(
      'createdAt',
      'runtimeCaptureSha256',
      'legacyProductionIdentity',
      'legacyProductionLogicalDigest',
      'legacyStagingIdentity',
      'legacyStagingLogicalDigest',
      'targetProductionIdentity',
      'targetProductionLogicalDigest',
      'targetStagingIdentity',
      'targetStagingLogicalDigest',
    );
    const transitionPrograms = [cutover, rebaseline].flatMap((block) => (
      jqObjectProgramsContainingSchema(block, 'nexus.bootstrap-database-transition.v1')
    ));
    expect(transitionPrograms).toHaveLength(2);
    for (const program of transitionPrograms) {
      expect(runJqNullInputObject(program, transitionValues)).toEqual({
        schema: 'nexus.bootstrap-database-transition.v1',
        createdAt: transitionValues.createdAt,
        runtimeCaptureSha256: transitionValues.runtimeCaptureSha256,
        legacy: {
          production: {
            path: '/home/dominguez/telegram-hub-bot/data/bot.db',
            identity: transitionValues.legacyProductionIdentity,
            logicalDigest: transitionValues.legacyProductionLogicalDigest,
          },
          staging: {
            path: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
            identity: transitionValues.legacyStagingIdentity,
            logicalDigest: transitionValues.legacyStagingLogicalDigest,
          },
        },
        target: {
          production: {
            path: '/var/lib/nexus-hub/production/data/bot.db',
            identity: transitionValues.targetProductionIdentity,
            logicalDigest: transitionValues.targetProductionLogicalDigest,
          },
          staging: {
            path: '/var/lib/nexus-hub/staging/data/bot.db',
            identity: transitionValues.targetStagingIdentity,
            logicalDigest: transitionValues.targetStagingLogicalDigest,
          },
        },
        backupDatabasePath: '/var/lib/nexus-hub/production/data/bot.db',
      });
    }

    const recoveryValues = values(
      'createdAt',
      'baselineSha256',
      'runtimeCaptureSha256',
      'incidentDir',
      'phase',
      'backupDatabasePath',
      'liveProductionIdentity',
      'liveProductionDigest',
      'liveStagingIdentity',
      'liveStagingDigest',
      'observedProductionIdentity',
      'observedProductionDigest',
      'capturedProductionIdentity',
      'stagingIdentity',
      'stagingDigest',
      'swappedIdentity',
    );
    const recoveryPrograms = jqObjectProgramsContainingSchema(
      recovery,
      'nexus.bootstrap-first-cutover-recovery.v1',
    );
    expect(recoveryPrograms).toHaveLength(1);
    expect(runJqNullInputObject(recoveryPrograms[0], recoveryValues)).toEqual({
      schema: 'nexus.bootstrap-first-cutover-recovery.v1',
      createdAt: recoveryValues.createdAt,
      updatedAt: recoveryValues.createdAt,
      baselineSha256: recoveryValues.baselineSha256,
      runtimeCaptureSha256: recoveryValues.runtimeCaptureSha256,
      incidentDir: recoveryValues.incidentDir,
      phase: recoveryValues.phase,
      backupDatabasePath: recoveryValues.backupDatabasePath,
      liveProduction: {
        path: '/var/lib/nexus-hub/production/data/bot.db',
        identity: recoveryValues.liveProductionIdentity,
        logicalDigest: recoveryValues.liveProductionDigest,
      },
      liveStaging: {
        path: '/var/lib/nexus-hub/staging/data/bot.db',
        identity: recoveryValues.liveStagingIdentity,
        logicalDigest: recoveryValues.liveStagingDigest,
      },
      observedPm2Production: {
        path: '/home/dominguez/telegram-hub-bot/data/bot.db',
        identity: recoveryValues.observedProductionIdentity,
        logicalDigest: recoveryValues.observedProductionDigest,
      },
      capturedPm2ProductionIdentity: recoveryValues.capturedProductionIdentity,
      pm2Staging: {
        path: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
        identity: recoveryValues.stagingIdentity,
        logicalDigest: recoveryValues.stagingDigest,
      },
      swappedPm2ProductionIdentity: recoveryValues.swappedIdentity,
    });

    const rebaselineValues = values(
      'createdAt',
      'incidentDir',
      'expectedReleaseId',
      'expectedPayloadDigest',
      'oldBaselineSha256',
      'oldReleaseId',
      'oldTargetDigest',
      'archivedBaseline',
      'runtimeEvidenceSha256',
      'transitionEvidenceSha256',
      'recoveryStateSha256',
      'productionPath',
      'productionIdentity',
      'stagingPath',
      'stagingIdentity',
      'productionRuntime',
      'productionSha',
      'productionArtifact',
      'productionMarker',
      'stagingRuntime',
      'stagingSha',
      'stagingArtifact',
      'stagingMarker',
    );
    const rebaselinePrograms = jqObjectProgramsContainingSchema(
      rebaseline,
      'nexus.bootstrap-rebaseline.v1',
    );
    expect(rebaselinePrograms).toHaveLength(1);
    expect(runJqNullInputObject(rebaselinePrograms[0], rebaselineValues)).toEqual({
      schema: 'nexus.bootstrap-rebaseline.v1',
      createdAt: rebaselineValues.createdAt,
      updatedAt: rebaselineValues.createdAt,
      phase: 'admitted',
      incidentDir: rebaselineValues.incidentDir,
      expectedTarget: {
        releaseId: rebaselineValues.expectedReleaseId,
        payloadDigest: rebaselineValues.expectedPayloadDigest,
      },
      oldBaseline: {
        sha256: rebaselineValues.oldBaselineSha256,
        releaseId: rebaselineValues.oldReleaseId,
        payloadDigest: rebaselineValues.oldTargetDigest,
        archivePath: rebaselineValues.archivedBaseline,
      },
      oldEvidence: {
        runtimeSha256: rebaselineValues.runtimeEvidenceSha256,
        transitionSha256: rebaselineValues.transitionEvidenceSha256,
        recoveryStateSha256: rebaselineValues.recoveryStateSha256,
      },
      legacy: {
        production: {
          path: rebaselineValues.productionPath,
          identity: rebaselineValues.productionIdentity,
          logicalDigest: null,
        },
        staging: {
          path: rebaselineValues.stagingPath,
          identity: rebaselineValues.stagingIdentity,
          logicalDigest: null,
        },
      },
      runtime: {
        production: {
          path: rebaselineValues.productionRuntime,
          sourceSha: rebaselineValues.productionSha,
          artifactDigest: rebaselineValues.productionArtifact,
          markerSha256: rebaselineValues.productionMarker,
        },
        staging: {
          path: rebaselineValues.stagingRuntime,
          sourceSha: rebaselineValues.stagingSha,
          artifactDigest: rebaselineValues.stagingArtifact,
          markerSha256: rebaselineValues.stagingMarker,
        },
      },
    });
  });

  it('guards administrator PM2 units through the persistent higher-priority control path', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const blocks = [
      bashBlockContaining(runbook, 'CUTOVER REFUSED'),
      bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BASELINE REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED'),
    ];
    for (const block of blocks) {
      const syntax = spawnSync('bash', ['-n'], { input: block, encoding: 'utf8' });
      expect(syntax.status, syntax.stderr).toBe(0);
      expect(block).toContain('/etc/systemd/system.control');
      expect(block).toContain('--property=LoadState --value');
      expect(block).toContain('--property=FragmentPath --value');
      expect(block).toContain('--property=CanStart --value');
      expect(block).toContain('--property=ActiveState --value');
      expect(block).not.toContain('systemctl mask --runtime');
      expect(block).not.toContain('systemctl unmask --runtime');
      expect(block).not.toContain('masked-runtime');
    }

    const cutover = blocks[0];
    const preBaseline = blocks[1];
    const recovery = blocks[3];
    const rebaseline = blocks[4];
    for (const block of [cutover, preBaseline, recovery, rebaseline]) {
      expect(block).toContain('install_pm2_guard()');
      expect(block).toContain('test "$load" = masked');
      expect(block).toContain('test "$fragment" = "$guard"');
      expect(block).not.toContain('test "$fragment" = /dev/null');
      expect(block).toContain('test "$can_start" = no');
      expect(block).toContain('test "$active" = inactive');
    }
    expect(blocks[2]).toContain(
      'systemctl show "$UNIT" --property=FragmentPath --value)" = "$GUARD"',
    );
    expect(blocks[2]).not.toContain(
      'systemctl show "$UNIT" --property=FragmentPath --value)" = /dev/null',
    );
    for (const block of [preBaseline, recovery, rebaseline]) {
      expect(block).toContain('pm2_fail_closed_is_exact()');
      expect(block).toContain('enforce_pm2_fail_closed()');
      expect(block).toContain(
        'local action_failed=0 unit\n  if pm2_fail_closed_is_exact; then\n'
          + '    return 0\n  fi',
      );
      expect(block).toContain('run_pm2_as_dominguez kill || action_failed=1');
      expect(block).toContain("pgrep -u dominguez -f 'PM2.*God Daemon'");
      expect(block).toContain('-sTCP:LISTEN 2>&1');
      expect(block).toContain('/home/dominguez/telegram-hub-bot/data/bot.db.next-bootstrap-recovery');
      expect(block).toContain('/var/lib/nexus-hub/production/data/bot.db.next');
      expect(block).toContain("for suffix in '' -wal -shm -journal");
      expect(block).toContain('sudo lsof -nP -t -- "$path" 2>&1');
      expect(block).not.toContain('cleanup_failed');
      expect(block).toContain(
        "printf 'PM2 fail-closed postconditions remain false (action failures: %s)\\n'",
      );
    }
    expect(preBaseline).toContain(
      "enforce_pm2_fail_closed \\\n    || die 'PM2 fail-closed quiescence could not prove every postcondition'",
    );
    expect(recovery).toContain(
      "enforce_pm2_fail_closed \\\n    || die 'forced PM2 guard could not prove fail-closed postconditions'",
    );
    for (const trapName of [
      'fail_closed_pm2_restart',
      'fail_closed_bootstrap_restart',
      'fail_closed_rebaseline',
    ]) {
      const block = trapName === 'fail_closed_pm2_restart'
        ? preBaseline
        : trapName === 'fail_closed_bootstrap_restart' ? recovery : rebaseline;
      const handler = block.slice(
        block.indexOf(`${trapName}()`),
        block.indexOf(`trap ${trapName} EXIT`),
      );
      expect(handler).toContain('enforce_pm2_fail_closed');
      expect(handler).toContain(
        trapName === 'fail_closed_rebaseline' ? 'status=70' : 'exit 70',
      );
    }
    for (const block of [preBaseline, recovery]) {
      const trapAt = block.indexOf('trap fail_closed_');
      const retireAt = block.indexOf(
        'retire_canonical_pm2_guard pm2-dominguez.service',
      );
      const removeLegacyAt = block.indexOf('sudo rm -- "$legacy_guard"');
      const removeControlAt = block.indexOf('sudo rm -- "$guard"');
      const reloadAt = block.indexOf('sudo systemctl daemon-reload', removeControlAt);
      const canonicalProofAt = block.indexOf('test "$load" = loaded', removeControlAt);
      expect(trapAt).toBeGreaterThanOrEqual(0);
      expect(trapAt).toBeLessThan(retireAt);
      expect(removeLegacyAt).toBeLessThan(removeControlAt);
      expect(removeControlAt).toBeLessThan(reloadAt);
      expect(reloadAt).toBeLessThan(canonicalProofAt);
      expect(block).toContain('sudo test ! -e "$legacy_guard"');
      expect(block).toContain('test "$fragment" = "$canonical"');
      expect(block).toContain('test "$can_start" = yes');
      expect(block).toContain('test "$active" = inactive');
    }

    const guardHelpers = [cutover, preBaseline, recovery, rebaseline].map((block) => [
      bashFunction(block, 'pm2_guard_path'),
      bashFunction(block, 'pm2_guard_root_is_exact'),
      bashFunction(block, 'pm2_guard_is_exact'),
    ].join('\n'));
    expect(new Set(guardHelpers).size).toBe(1);
    const guardFixture = mkdtempSync(join(tmpdir(), 'nexus-runbook-guard-'));
    try {
      const runbookGuard = spawnSync('bash', ['-s', '--', guardFixture], {
        encoding: 'utf8',
        input: `set -euo pipefail
PM2_GUARD_ROOT="$1/etc/systemd/system.control"
mkdir -p "$PM2_GUARD_ROOT"
ln -s /dev/null "$PM2_GUARD_ROOT/pm2-dominguez.service"
ln -s /dev/null "$PM2_GUARD_ROOT/nexus-release-pm2-recovery-daemon.service"
sudo() { "$@"; }
stat() {
  case "$1:$2" in
    '-Lc:%U:%G:%a') printf 'root:root:755\\n' ;;
    '-c:%U:%G:%F') printf 'root:root:symbolic link\\n' ;;
    *) command stat "$@" ;;
  esac
}
systemctl() {
  test "$1" = show
  case "$3" in
    --property=LoadState) printf 'masked\\n' ;;
    --property=FragmentPath)
      case "$FAKE_FRAGMENT_MODE" in
        source) printf '%s/%s\\n' "$PM2_GUARD_ROOT" "$2" ;;
        target) printf '/dev/null\\n' ;;
        *) return 64 ;;
      esac
      ;;
    --property=CanStart) printf 'no\\n' ;;
    --property=ActiveState) printf 'inactive\\n' ;;
    *) return 64 ;;
  esac
}
${guardHelpers[0]}
FAKE_FRAGMENT_MODE=source
pm2_guard_is_exact pm2-dominguez.service
pm2_guard_is_exact nexus-release-pm2-recovery-daemon.service
FAKE_FRAGMENT_MODE=target
if pm2_guard_is_exact pm2-dominguez.service; then
  exit 41
fi
`,
      });
      expect(runbookGuard.status, runbookGuard.stderr).toBe(0);
    } finally {
      rmSync(guardFixture, { recursive: true, force: true });
    }

    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-systemd-guard-'));
    try {
      const topology = spawnSync('bash', ['-s', '--', fixtureRoot], {
        encoding: 'utf8',
        input: String.raw`set -euo pipefail
fixture="$1"
unit=pm2-dominguez.service
control="$fixture/etc/systemd/system.control"
admin="$fixture/etc/systemd/system"
runtime="$fixture/run/systemd/system"
mkdir -p "$control" "$admin" "$runtime"
canonical="$admin/$unit"
legacy="$runtime/$unit"
guard="$control/$unit"
: >"$canonical"
ln -s /dev/null "$legacy"

resolve_fragment() {
  local candidate
  for candidate in "$control/$unit" "$admin/$unit" "$runtime/$unit"; do
    if test -e "$candidate" || test -L "$candidate"; then
      printf '%s\n' "$candidate"
      return
    fi
  done
  return 1
}
exact_control_guard() {
  test -L "$guard" && test "$(readlink "$guard")" = /dev/null
}

# The ordinary runtime mask loses to the administrator unit.
test "$(resolve_fragment)" = "$canonical"
# A wrong target and a regular file are both rejected as guards.
ln -s /tmp/not-dev-null "$guard"
if exact_control_guard; then exit 41; fi
rm "$guard"; : >"$guard"
if exact_control_guard; then exit 42; fi
rm "$guard"; ln -s /dev/null "$guard"
exact_control_guard
test "$(resolve_fragment)" = "$guard"
# A simulated reboot clears /run but cannot remove the persistent control guard.
rm -rf "$fixture/run"
mkdir -p "$runtime"
test "$(resolve_fragment)" = "$guard"
# Retire the lower artifact while the high-priority guard still wins, then
# retire the control link and recover the exact administrator fragment.
ln -s /dev/null "$legacy"
rm "$legacy"
test "$(resolve_fragment)" = "$guard"
rm "$guard"
test "$(resolve_fragment)" = "$canonical"
`,
      });
      expect(topology.status, topology.stderr).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('runs PM2 from the dominguez home without sudo chdir-policy options', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const blocks = [
      bashBlockContaining(runbook, 'CUTOVER REFUSED'),
      bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED'),
    ];
    const helpers: string[] = [];
    for (const block of blocks) {
      const start = block.indexOf('run_pm2_as_dominguez() {');
      const end = block.indexOf('\n}\n\n', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      helpers.push(block.slice(start, end + 2));
      expect(block.match(/sudo -u dominguez pm2/g)).toHaveLength(1);
      expect(block.match(/run_pm2_as_dominguez (?:jlist|start|stop|kill)/g)?.length)
        .toBeGreaterThan(0);
      expect(block).not.toContain('--chdir=/home/dominguez');
      expect(block).not.toMatch(/sudo -u dominguez (?:-D|--chdir)/);
    }
    expect(new Set(helpers).size).toBe(1);

    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-pm2-cwd-'));
    try {
      const helper = helpers[0].replace(
        'local pm2_cwd=/home/dominguez',
        `local pm2_cwd='${fixtureRoot}'`,
      );
      const result = spawnSync('bash', ['-s'], {
        encoding: 'utf8',
        input: `set -euo pipefail
EXPECTED_CWD='${fixtureRoot}'
sudo() {
  local argument
  for argument in "$@"; do
    case "$argument" in -D|--chdir|--chdir=*) return 91 ;; esac
  done
  test "$1" = -u && test "$2" = dominguez && test "$3" = pm2 || return 92
  shift 3
  test "$PWD" = "$EXPECTED_CWD" || return 93
  case "$1" in
    jlist)
      test "$#" -eq 5 || return 94
      test "$1" = jlist || return 95
      test "$2" = 'two words' || return 96
      test -z "$3" || return 97
      test "$4" = '*' || return 98
      test "$5" = 'literal;not-executed' || return 99
      printf '%s|exact-argv\\n' "$PWD"
      ;;
    kill)
      test "$#" -eq 1 || return 100
      ;;
    *) return 101 ;;
  esac
  return "\${FAKE_SUDO_STATUS:-0}"
}
${helper}
caller_cwd="$PWD"
output_file="$EXPECTED_CWD/pm2-output"
run_pm2_as_dominguez jlist 'two words' '' '*' \
  'literal;not-executed' >"$output_file"
test "$PWD" = "$caller_cwd"
test "$(<"$output_file")" = "$EXPECTED_CWD|exact-argv"
set +e
FAKE_SUDO_STATUS=37 run_pm2_as_dominguez kill >/dev/null
status=$?
set -e
test "$status" -eq 37
`,
      });
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('retries all four PM2 health endpoints together until a delayed listener is ready', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const preBaseline = bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED');
    const recovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');
    const helpers = [preBaseline, recovery].map((block) => {
      const start = block.indexOf('wait_for_all_pm2_health() {');
      const end = block.indexOf('\n}\n\nfresh_backup_for() {', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return block.slice(start, end + 2);
    });
    expect(new Set(helpers).size).toBe(1);
    for (const helper of helpers) {
      expect(helper).toContain('deadline=$((SECONDS + 120))');
      expect(helper).toContain('iteration_ok=1');
      expect(helper).toContain('for endpoint in "${endpoints[@]}"');
      expect(helper).toContain('--connect-timeout 1');
      expect(helper).toContain('--max-time "$curl_max"');
      expect(helper).toContain('test "$iteration_ok" -eq 1 && return 0');
      for (const port of [8200, 8100, 8201, 8101]) {
        expect(helper).toContain(`http://127.0.0.1:${port}/health`);
      }
    }
    const preBaselineHealth = preBaseline.lastIndexOf('wait_for_all_pm2_health \\');
    expect(preBaselineHealth).toBeGreaterThanOrEqual(0);
    expect(preBaselineHealth)
      .toBeLessThan(preBaseline.lastIndexOf('PM2_RESTART_ARMED=0'));
    const durableProof = recovery.slice(
      recovery.indexOf('prove_durable_running_pm2() {'),
      recovery.indexOf('\n}\n\npublish_early_pm2_restored()'),
    );
    expect(durableProof).toContain('wait_for_all_pm2_health || return 1');
    const recoveryHealth = recovery.lastIndexOf('wait_for_all_pm2_health \\');
    expect(recoveryHealth).toBeGreaterThanOrEqual(0);
    expect(recoveryHealth)
      .toBeLessThan(recovery.lastIndexOf('PM2_RESTART_ARMED=0'));
    expect(runbook).not.toContain(
      'curl --fail --silent --show-error --max-time 5 http://127.0.0.1:',
    );

    const basePort = 41000 + ((process.pid % 1000) * 4);
    const testPorts = [basePort, basePort + 1, basePort + 2, basePort + 3];
    let executableHelper = helpers[0];
    for (const [productionPort, testPort] of [
      [8200, testPorts[0]],
      [8100, testPorts[1]],
      [8201, testPorts[2]],
      [8101, testPorts[3]],
    ]) {
      executableHelper = executableHelper.replaceAll(
        `127.0.0.1:${productionPort}`,
        `127.0.0.1:${testPort}`,
      );
    }
    executableHelper = executableHelper.replace(
      'deadline=$((SECONDS + 120))',
      'deadline=$((SECONDS + 10))',
    );
    const delayed = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      timeout: 15_000,
      input: `set -euo pipefail
server_root="$(mktemp -d)"
: >"$server_root/health"
pids=()
cleanup() {
  set +e
  for pid in "\${pids[@]}"; do kill "$pid" 2>/dev/null; done
  for pid in "\${pids[@]}"; do wait "$pid" 2>/dev/null; done
  rm -rf -- "$server_root"
}
trap cleanup EXIT
start_server() {
  local port="$1" delay="$2"
  (
    sleep "$delay"
    cd "$server_root"
    exec python3 -m http.server "$port" --bind 127.0.0.1
  ) >"$server_root/server-$port.log" 2>&1 &
  pids+=("$!")
}
start_server ${testPorts[0]} 0
start_server ${testPorts[1]} 0
start_server ${testPorts[2]} 0
start_server ${testPorts[3]} 4
sleep 1
curl() {
  local endpoint="\${!#}" port
  port="\${endpoint#http://127.0.0.1:}"
  port="\${port%%/*}"
  printf 'x\\n' >>"$server_root/count-$port"
  command curl "$@"
}
${executableHelper}
started="$SECONDS"
wait_for_all_pm2_health
elapsed=$((SECONDS - started))
test "$elapsed" -ge 2 && test "$elapsed" -lt 15
for port in ${testPorts.slice(0, 3).join(' ')}; do
  test "$(wc -l <"$server_root/count-$port")" -ge 2
done
`,
    });
    expect(delayed.status, delayed.stderr).toBe(0);
  });

  it('returns nonzero at the PM2 health deadline when one listener never starts', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const recovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');
    const helperStart = recovery.indexOf('wait_for_all_pm2_health() {');
    const helperEnd = recovery.indexOf('\n}\n\nfresh_backup_for() {', helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);

    const basePort = 49000 + ((process.pid % 1000) * 4);
    const testPorts = [basePort, basePort + 1, basePort + 2, basePort + 3];
    let executableHelper = recovery.slice(helperStart, helperEnd + 2);
    for (const [productionPort, testPort] of [
      [8200, testPorts[0]],
      [8100, testPorts[1]],
      [8201, testPorts[2]],
      [8101, testPorts[3]],
    ]) {
      executableHelper = executableHelper.replaceAll(
        `127.0.0.1:${productionPort}`,
        `127.0.0.1:${testPort}`,
      );
    }
    executableHelper = executableHelper.replace(
      'deadline=$((SECONDS + 120))',
      'deadline=$((SECONDS + 4))',
    );

    const neverReady = spawnSync('bash', ['-s'], {
      encoding: 'utf8',
      timeout: 10_000,
      input: `set -euo pipefail
server_root="$(mktemp -d)"
: >"$server_root/health"
pids=()
cleanup() {
  set +e
  for pid in "\${pids[@]}"; do kill "$pid" 2>/dev/null; done
  for pid in "\${pids[@]}"; do wait "$pid" 2>/dev/null; done
  rm -rf -- "$server_root"
}
trap cleanup EXIT
for port in ${testPorts.slice(0, 3).join(' ')}; do
  (
    cd "$server_root"
    exec python3 -m http.server "$port" --bind 127.0.0.1
  ) >"$server_root/server-$port.log" 2>&1 &
  pids+=("$!")
done
sleep 1
curl() {
  local endpoint="\${!#}" port
  port="\${endpoint#http://127.0.0.1:}"
  port="\${port%%/*}"
  printf 'x\\n' >>"$server_root/count-$port"
  command curl "$@"
}
${executableHelper}
started="$SECONDS"
set +e
wait_for_all_pm2_health
status=$?
set -e
elapsed=$((SECONDS - started))
test "$status" -eq 1
test "$elapsed" -ge 3 && test "$elapsed" -le 6
for port in ${testPorts.join(' ')}; do
  test "$(wc -l <"$server_root/count-$port")" -ge 2
done
`,
    });
    expect(neverReady.status, neverReady.stderr).toBe(0);
  });

  it('preserves signal status through every PM2 restore EXIT cleanup', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const handlers = [
      ['PRE-BASELINE RECOVERY REFUSED', 'fail_closed_pm2_restart'],
      ['BOOTSTRAP RECOVERY REFUSED', 'fail_closed_bootstrap_restart'],
      ['BOOTSTRAP REBASELINE REFUSED', 'fail_closed_rebaseline'],
    ] as const;
    for (const [marker, handler] of handlers) {
      const block = bashBlockContaining(runbook, marker);
      const armed = handler === 'fail_closed_rebaseline'
        ? 'REBASELINE_ARMED=0' : 'PM2_RESTART_ARMED=0';
      const traps = block.split('\n').filter((line) => (
        line === `trap ${handler} EXIT`
        || /^trap 'exit (?:129|130|143)' (?:HUP|INT|TERM)$/.test(line)
      ));
      expect(traps).toHaveLength(4);
      const handlerBody = block.slice(
        block.indexOf(`${handler}() {`),
        block.indexOf(`trap ${handler} EXIT`),
      );
      expect(handlerBody).toContain('trap - EXIT HUP INT TERM');
      expect(block.lastIndexOf('trap - EXIT HUP INT TERM'))
        .toBeGreaterThan(block.lastIndexOf(armed));
      for (const [signal, expectedStatus] of [
        ['HUP', 129],
        ['INT', 130],
        ['TERM', 143],
      ] as const) {
        const result = spawnSync('bash', ['-s'], {
          encoding: 'utf8',
          input: `set -euo pipefail
${handler}() {
  status=$?
  trap - EXIT HUP INT TERM
  exit "$status"
}
${traps.join('\n')}
kill -${signal} "$$"
exit 99
`,
        });
        expect(result.status, result.stderr).toBe(expectedStatus);
      }
    }
  });

  it('arms fail-closed cleanup before early PM2 reconciliation can block or fail', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const preBaseline = bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED');
    const recovery = bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED');

    const preBaselineTrap = preBaseline.indexOf('trap fail_closed_pm2_restart EXIT');
    expect(preBaselineTrap).toBeGreaterThanOrEqual(0);
    expect(preBaselineTrap).toBeLessThan(preBaseline.indexOf('PM2_ALREADY_GUARDED=1'));
    expect(preBaselineTrap).toBeLessThan(preBaseline.indexOf(
      'PM2_JSON="$(run_pm2_as_dominguez jlist)"',
    ));
    expect(preBaselineTrap).toBeLessThan(preBaseline.indexOf(
      "enforce_pm2_fail_closed \\\n    || die 'PM2 fail-closed quiescence could not prove every postcondition'",
    ));
    expect(preBaseline.match(/fail_closed_pm2_restart\(\)/g)).toHaveLength(1);
    const checkpointExit = preBaseline.slice(
      preBaseline.indexOf('pre-baseline checkpoint exit is not exactly fail-closed'),
      preBaseline.indexOf('\nfi\n', preBaseline.indexOf(
        'pre-baseline checkpoint exit is not exactly fail-closed',
      )),
    );
    expect(checkpointExit).toContain('PM2_RESTART_ARMED=0');
    expect(checkpointExit).toContain('trap - EXIT HUP INT TERM');

    const recoveryTrap = recovery.indexOf('trap fail_closed_bootstrap_restart EXIT');
    const guardObservation = recovery.indexOf('PM2_GUARD_OBSERVED=1');
    const earlyProof = recovery.indexOf('if prove_durable_running_pm2; then');
    expect(recoveryTrap).toBeGreaterThanOrEqual(0);
    expect(recoveryTrap).toBeLessThan(guardObservation);
    expect(recoveryTrap).toBeLessThan(earlyProof);
    expect(recovery.match(/fail_closed_bootstrap_restart\(\)/g)).toHaveLength(1);
    const earlyBranchEnd = recovery.indexOf('\nrequire_pm2_guard\n', earlyProof);
    const earlyBranch = recovery.slice(earlyProof, earlyBranchEnd);
    const earlyPublish = earlyBranch.indexOf('publish_early_pm2_restored \\');
    const earlyDisarm = earlyBranch.indexOf('PM2_RESTART_ARMED=0');
    expect(earlyPublish).toBeGreaterThanOrEqual(0);
    expect(earlyDisarm).toBeGreaterThan(earlyPublish);
    expect(earlyBranch.indexOf('trap - EXIT HUP INT TERM')).toBeGreaterThan(earlyDisarm);
    expect(earlyBranch.indexOf('exit 0')).toBeGreaterThan(earlyDisarm);
    const finalPublication = recovery.lastIndexOf('publish_recovery_state pm2_restored');
    const finalDisarm = recovery.lastIndexOf('PM2_RESTART_ARMED=0');
    expect(finalDisarm).toBeGreaterThan(finalPublication);

    const handlerStart = recovery.indexOf('fail_closed_bootstrap_restart() {');
    const handlerEnd = recovery.indexOf('\n}\n', handlerStart);
    const handler = recovery.slice(handlerStart, handlerEnd + 2);
    const traps = recovery.split('\n').filter((line) => (
      line === 'trap fail_closed_bootstrap_restart EXIT'
      || /^trap 'exit (?:129|130|143)' (?:HUP|INT|TERM)$/.test(line)
    ));
    expect(traps).toHaveLength(4);
    const healthStart = recovery.indexOf('wait_for_all_pm2_health() {');
    const healthEnd = recovery.indexOf('\n}\n\nfresh_backup_for() {', healthStart);
    const healthHelper = recovery.slice(healthStart, healthEnd + 2);

    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-early-pm2-trap-'));
    try {
      const termCleanup = join(fixtureRoot, 'term-cleanup');
      const term = spawnSync('bash', ['-s', '--', termCleanup], {
        encoding: 'utf8',
        timeout: 5_000,
        input: `set -euo pipefail
cleanup_receipt="$1"
enforce_pm2_fail_closed() {
  printf 'closed\\n' >>"$cleanup_receipt"
}
PM2_RESTART_ARMED=1
${handler}
${traps.join('\n')}
curl() { while :; do :; done; }
${healthHelper}
(sleep 0.2; kill -TERM "$$") &
wait_for_all_pm2_health
exit 99
`,
      });
      expect(term.status, term.stderr).toBe(143);
      expect(readFileSync(termCleanup, 'utf8')).toBe('closed\n');

      const publicationCleanup = join(fixtureRoot, 'publication-cleanup');
      const branchStart = recovery.indexOf(
        'if test "$PM2_GUARD_OBSERVED" -eq 0; then',
      );
      const branchEnd = recovery.indexOf('\nrequire_pm2_guard\n', branchStart);
      const exactEarlyBranch = recovery.slice(branchStart, branchEnd);
      const publication = spawnSync('bash', ['-s', '--', publicationCleanup], {
        encoding: 'utf8',
        input: `set -euo pipefail
cleanup_receipt="$1"
die() { exit 1; }
enforce_pm2_fail_closed() {
  printf 'closed\\n' >>"$cleanup_receipt"
}
prove_durable_running_pm2() {
  PROVED_RECOVERY_PHASE=backup_repointed
}
publish_early_pm2_restored() {
  printf 'publish-failed\\n' >>"$cleanup_receipt"
  return 42
}
PM2_RESTART_ARMED=1
${handler}
${traps.join('\n')}
PM2_GUARD_OBSERVED=0
${exactEarlyBranch}
exit 99
`,
      });
      expect(publication.status, publication.stderr).toBe(1);
      expect(readFileSync(publicationCleanup, 'utf8'))
        .toBe('publish-failed\nclosed\n');
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('keeps PM2 closure idempotent and preserves later failure or signal status', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const blocks = [
      bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED'),
    ];
    const enforcers = blocks.map((block) => {
      const start = block.indexOf('enforce_pm2_fail_closed() {');
      const end = block.indexOf('\n}\n', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return block.slice(start, end + 2);
    });
    expect(new Set(enforcers).size).toBe(1);
    const enforcer = enforcers[0];
    expect(enforcer).toContain(
      'if pm2_fail_closed_is_exact; then\n    return 0\n  fi',
    );
    expect(enforcer).toContain(
      'if pm2_fail_closed_is_exact; then\n    return 0\n  fi',
    );
    expect(enforcer.trimEnd()).toMatch(/return 1\n}$/);

    const recovery = blocks[1];
    const handlerStart = recovery.indexOf('fail_closed_bootstrap_restart() {');
    const handlerEnd = recovery.indexOf('\n}\n', handlerStart);
    const handler = recovery.slice(handlerStart, handlerEnd + 2);
    const traps = recovery.split('\n').filter((line) => (
      line === 'trap fail_closed_bootstrap_restart EXIT'
      || /^trap 'exit (?:129|130|143)' (?:HUP|INT|TERM)$/.test(line)
    ));
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'nexus-idempotent-pm2-close-'));
    try {
      for (const [event, expectedStatus] of [
        ['FAIL', 1],
        ['HUP', 129],
        ['INT', 130],
        ['TERM', 143],
      ] as const) {
        const actions = join(fixtureRoot, `actions-${event}`);
        const trigger = event === 'FAIL' ? 'false' : `kill -${event} "$$"`;
        const result = spawnSync('bash', ['-s', '--', actions], {
          encoding: 'utf8',
          input: `set -euo pipefail
action_receipt="$1"
CLOSED=0
pm2_fail_closed_is_exact() { test "$CLOSED" -eq 1; }
run_pm2_as_dominguez() {
  printf 'pm2:%s\\n' "$1" >>"$action_receipt"
  test "$CLOSED" -eq 0 || return 44
  if test "$1" = kill; then CLOSED=1; fi
}
sudo() {
  printf 'sudo:%s\\n' "$*" >>"$action_receipt"
  test "$CLOSED" -eq 0
}
install_pm2_guard() {
  printf 'guard:%s\\n' "$1" >>"$action_receipt"
  test "$CLOSED" -eq 0
}
${enforcer}
PM2_RESTART_ARMED=1
${handler}
${traps.join('\n')}
enforce_pm2_fail_closed
test "$CLOSED" -eq 1
enforce_pm2_fail_closed
${trigger}
exit 99
`,
        });
        expect(result.status, result.stderr).toBe(expectedStatus);
        expect(readFileSync(actions, 'utf8').trim().split('\n')).toHaveLength(7);
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('rejects a fail-closed PM2 proof while any governed database handle remains', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const blocks = [
      bashBlockContaining(runbook, 'PRE-BASELINE RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP RECOVERY REFUSED'),
      bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED'),
    ];
    const functions = blocks.map((block) => {
      const start = block.indexOf('pm2_fail_closed_is_exact() {');
      const end = block.indexOf('\n}\n\nenforce_pm2_fail_closed() {', start);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      return block.slice(start, end + 2);
    });
    expect(new Set(functions).size).toBe(1);

    for (const openHandle of [0, 1]) {
      const result = spawnSync('bash', ['-s'], {
        encoding: 'utf8',
        env: { ...process.env, OPEN_HANDLE: String(openHandle) },
        input: `set -euo pipefail
OPEN_PATH=/home/dominguez/telegram-hub-bot/data/bot.db
pm2_guard_is_exact() { return 0; }
sudo() {
  case "$1" in
    pgrep) return 1 ;;
    test)
      if test "$2" = -e && test "$3" = "$OPEN_PATH"; then return 0; fi
      return 1 ;;
    lsof)
      if [[ " $* " == *" -iTCP:"* ]]; then return 1; fi
      if test "\${*: -1}" = "$OPEN_PATH" && test "$OPEN_HANDLE" -eq 1; then
        printf '4242\\n'
        return 0
      fi
      return 1 ;;
    *) return 64 ;;
  esac
}
${functions[0]}
pm2_fail_closed_is_exact
`,
      });
      expect(result.status, result.stderr).toBe(openHandle === 0 ? 0 : 1);
    }
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
      .toBeLessThan(cutover.indexOf(
        'run_pm2_as_dominguez stop',
      ));
    expect(preBaseline).toContain('PRE_BASELINE_ACTION');
    expect(preBaseline).toContain('recover-pm2|resume-baseline|reset-cutover');
    expect(preBaseline).toContain('bootstrap baseline exists; use the baseline-dependent recovery branch');
    expect(preBaseline).toContain('nexus.bootstrap-legacy-runtime-capture.v2');
    expect(preBaseline).toContain('productionMarkerSha256');
    expect(preBaseline).toContain('productionDatabaseIdentity');
    expect(preBaseline).toContain('verify_installed_runtime');
    expect(preBaseline).toContain('--verify-installed-source');
    expect(preBaseline).toContain('verify-predecessor-extracted');
    expect(preBaseline).toContain('runtime selector changed under lock');
    expect(preBaseline).toContain('PM2_AUTHORITY_OR_DAEMON_ACTIVE=0');
    expect(preBaseline).toContain('PM2_CAPTURE_IDENTITY_PROVED=1');
    expect(preBaseline).toContain('length == 4');
    expect(preBaseline).toContain('PM2_CAPTURE_IDENTITY_PROVED=0');
    expect(preBaseline).toContain("pgrep -u dominguez -f 'PM2.*God Daemon'");
    expect(preBaseline).toContain(
      'if test "$PM2_AUTHORITY_OR_DAEMON_ACTIVE" -eq 1; then',
    );
    expect(preBaseline).toContain('install_pm2_guard "$unit"');
    expect(preBaseline).toContain('retire_canonical_pm2_guard pm2-dominguez.service');
    expect(preBaseline).not.toContain('systemctl mask --runtime');
    expect(preBaseline).toContain(
      'active PM2 identity mismatched the capture; authorities are now guarded; rerun recovery',
    );
    expect(preBaseline.indexOf('PM2_AUTHORITY_OR_DAEMON_ACTIVE=0'))
      .toBeLessThan(preBaseline.indexOf(
        'PM2_JSON="$(run_pm2_as_dominguez jlist)"',
      ));
    expect(preBaseline.indexOf('PM2_CAPTURE_IDENTITY_PROVED=0'))
      .toBeLessThan(preBaseline.indexOf(
        "enforce_pm2_fail_closed \\\n    || die 'PM2 fail-closed quiescence could not prove every postcondition'",
      ));
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
    expect(preBaseline).toContain('wait_for_all_pm2_health');
    expect(preBaseline.indexOf('set +e')).toBeLessThan(0);
    expect(preBaseline).not.toContain('mv -f');
    expect(laterRecovery).toContain('BASELINE_FILE=');
  });

  it('requires a fresh delivered heartbeat proof before the first poller invocation', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const heartbeatUnit = readFileSync(
      join(root, 'ops/nexus-release/nexus-release-heartbeat.service'),
      'utf8',
    );
    const heartbeatProof = bashBlockContaining(runbook, 'HEARTBEAT LIVENESS REFUSED');
    const syntax = spawnSync('bash', ['-n'], { input: heartbeatProof, encoding: 'utf8' });

    expect(syntax.status, syntax.stderr).toBe(0);
    expect(heartbeatProof.trimStart()).toMatch(/^set -euo pipefail\n/);
    expect(heartbeatProof).toContain(
      'sudo journalctl -n 0 --show-cursor --output=cat --no-pager --quiet',
    );
    expect(heartbeatProof).toContain('--property=ActiveState --value');
    expect(heartbeatProof).toContain('--property=Type --value');
    expect(heartbeatProof).toContain('--property=RemainAfterExit --value');
    expect(heartbeatProof).toContain('test "$HEARTBEAT_CURSOR_COUNT" = 1');
    expect(heartbeatProof).toContain(
      'sudo journalctl --after-cursor="$HEARTBEAT_JOURNAL_CURSOR"',
    );
    expect(heartbeatProof).toContain('sudo systemctl start "$HEARTBEAT_UNIT"');
    expect(heartbeatProof).toContain('--property=Result --value');
    expect(heartbeatProof).not.toContain('--property=InvocationID --value');
    expect(heartbeatProof).toContain('sudo journalctl --sync');
    expect(heartbeatProof).toContain(
      '"_SYSTEMD_UNIT=$HEARTBEAT_UNIT"',
    );
    expect(heartbeatProof).toContain(
      '"_SYSTEMD_INVOCATION_ID=$HEARTBEAT_INVOCATION_ID"',
    );
    expect(heartbeatProof).toContain(
      '| select(type == "string" and test("^[0-9a-f]{32}$"))',
    );
    expect(heartbeatProof).toContain(
      'and ._SYSTEMD_INVOCATION_ID == $invocation',
    );
    expect(heartbeatProof).toContain('--output=json --no-pager --quiet');
    expect(heartbeatProof).toContain(
      'and keys == ["delivered", "reason", "schema"]',
    );
    expect(heartbeatProof).toContain(
      'and .schema == "nexus.release-heartbeat.v1"',
    );
    expect(heartbeatProof).toContain('and .delivered == true');
    expect(heartbeatProof).toContain('and .reason == "sent"');
    expect(heartbeatProof).toContain(
      'test "$HEARTBEAT_POST_CURSOR_INVOCATION_COUNT" = 1',
    );
    expect(heartbeatProof).toContain(
      'test "$HEARTBEAT_INVOCATION_PROOF_COUNT" = 1',
    );
    expect(heartbeatProof).toContain(
      'sudo systemctl start "$HEARTBEAT_TIMER"',
    );
    expect(heartbeatUnit).toContain('Type=oneshot');
    expect(heartbeatUnit).not.toContain('RemainAfterExit=yes');
    expect(heartbeatProof).not.toContain('NEXUS_RELEASE_TELEGRAM_');
    expect(heartbeatProof).not.toContain('/etc/nexus-release/poller.env');
    expect(heartbeatProof).not.toContain('set -x');

    const servicePrecondition = heartbeatProof.indexOf(
      'test "$(sudo systemctl show "$HEARTBEAT_UNIT" --property=ActiveState --value)"',
    );
    const timerPrecondition = heartbeatProof.indexOf(
      'test "$(sudo systemctl show "$HEARTBEAT_TIMER" --property=ActiveState --value)"',
    );
    const preCursorSync = heartbeatProof.indexOf('sudo journalctl --sync');
    const cursorCapture = heartbeatProof.indexOf('HEARTBEAT_CURSOR_OUTPUT="$(');
    const serviceStart = heartbeatProof.indexOf('sudo systemctl start "$HEARTBEAT_UNIT"');
    const postStartSync = heartbeatProof.indexOf('sudo journalctl --sync', preCursorSync + 1);
    const postCursorRead = heartbeatProof.indexOf(
      'sudo journalctl --after-cursor="$HEARTBEAT_JOURNAL_CURSOR"',
    );
    const postCursorCount = heartbeatProof.indexOf(
      'test "$HEARTBEAT_POST_CURSOR_INVOCATION_COUNT" = 1',
    );
    const invocationIdentity = heartbeatProof.indexOf('HEARTBEAT_INVOCATION_ID="$(');
    const invocationRead = heartbeatProof.indexOf(
      'sudo journalctl --after-cursor="$HEARTBEAT_JOURNAL_CURSOR"',
      postCursorRead + 1,
    );
    const invocationCount = heartbeatProof.indexOf(
      'test "$HEARTBEAT_INVOCATION_PROOF_COUNT" = 1',
    );
    const timerStartInProof = heartbeatProof.indexOf(
      'sudo systemctl start "$HEARTBEAT_TIMER"',
    );
    expect(servicePrecondition).toBeGreaterThanOrEqual(0);
    expect(servicePrecondition).toBeLessThan(timerPrecondition);
    expect(timerPrecondition).toBeLessThan(preCursorSync);
    expect(preCursorSync).toBeLessThan(cursorCapture);
    expect(cursorCapture).toBeGreaterThanOrEqual(0);
    expect(cursorCapture).toBeLessThan(serviceStart);
    expect(serviceStart).toBeLessThan(postStartSync);
    expect(postStartSync).toBeLessThan(postCursorRead);
    expect(postCursorRead).toBeLessThan(postCursorCount);
    expect(postCursorCount).toBeLessThan(invocationIdentity);
    expect(invocationIdentity).toBeLessThan(invocationRead);
    expect(invocationRead).toBeLessThan(invocationCount);
    expect(invocationCount).toBeLessThan(timerStartInProof);

    const timerEnable = runbook.indexOf(
      'sudo systemctl enable nexus-release-heartbeat.timer',
    );
    const proofStart = runbook.indexOf('HEARTBEAT_UNIT=nexus-release-heartbeat.service');
    const heartbeatTimerStart = runbook.indexOf(
      'sudo systemctl start "$HEARTBEAT_TIMER"',
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
    expect(recovery.indexOf('PM2_FORCED_GUARD=1'))
      .toBeLessThan(recovery.indexOf(
        "enforce_pm2_fail_closed \\\n    || die 'forced PM2 guard could not prove fail-closed postconditions'",
      ));
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
    expect(recovery).toContain(
      'run_pm2_as_dominguez start content-engine content-engine-staging',
    );
    expect(recovery).toContain(
      'run_pm2_as_dominguez start nexus-hub nexus-hub-staging',
    );
    expect(recovery).toContain('.legacyRuntime.productionSourceSha');
    expect(recovery).toContain('.legacyRuntime.stagingSourceSha');
    expect(recovery).toContain('legacy runtime capture differs from the bootstrap baseline');
    expect(recovery.indexOf('legacy runtime capture differs from the bootstrap baseline'))
      .toBeLessThan(recovery.indexOf('retire_canonical_pm2_guard pm2-dominguez.service'));
    expect(recovery.indexOf('verify_installed_runtime "$EXPECTED_RUNTIME"'))
      .toBeLessThan(recovery.indexOf('retire_canonical_pm2_guard pm2-dominguez.service'));
    expect(recovery).toContain('restarted with a source SHA outside the bootstrap baseline');

    expect(rebaseline).toContain('nexus.bootstrap-rebaseline.v1');
    expect(rebaseline).toContain('test "$OLD_RELEASE_ID" != "$EXPECTED_RELEASE_ID"');
    expect(rebaseline.indexOf('test "$OLD_RELEASE_ID" != "$EXPECTED_RELEASE_ID"'))
      .toBeLessThan(rebaseline.indexOf('nexus.bootstrap-rebaseline.v1'));
    expect(rebaseline).toContain('fail_closed_rebaseline');
    expect(rebaseline).toContain('trap fail_closed_rebaseline EXIT');
    expect(rebaseline.indexOf('trap fail_closed_rebaseline EXIT HUP INT TERM'))
      .toBeLessThan(0);
    expect(rebaseline).toContain("trap 'exit 130' INT");
    expect(rebaseline).toContain("trap 'exit 143' TERM");
    expect(rebaseline.indexOf('trap fail_closed_rebaseline EXIT'))
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

  it('accepts unmapped numeric owners for rebaseline container databases', () => {
    const runbook = readFileSync(join(root, 'ops/nexus-release/README.md'), 'utf8');
    const rebaseline = bashBlockContaining(runbook, 'BOOTSTRAP REBASELINE REFUSED');
    const metadataGuards = [...rebaseline.matchAll(
      /test "\$\(sudo stat -Lc '[^']+' -- "\$DB"\)" \\\n\s+= '10001:10001:600:1' \|\| die "[^"]+"/g,
    )].map((match) => match[0]);
    expect(metadataGuards).toHaveLength(2);

    const fakeBin = mkdtempSync(join(tmpdir(), 'nexus-rebaseline-owner-'));
    const fakeSudo = join(fakeBin, 'sudo');
    writeFileSync(fakeSudo, `#!/usr/bin/env bash
set -euo pipefail
test "$1" = stat
shift
case "$1:$2" in
  '-Lc:%u:%g:%a:%h') printf '10001:10001:600:1\\n' ;;
  '-Lc:%U:%G:%a:%h') printf 'UNKNOWN:UNKNOWN:600:1\\n' ;;
  *) printf 'unexpected fake stat invocation: %s\\n' "$*" >&2; exit 64 ;;
esac
`);
    chmodSync(fakeSudo, 0o755);

    try {
      for (const metadataGuard of metadataGuards) {
        const result = spawnSync('bash', ['-c', `set -euo pipefail
die() { printf '%s\\n' "$*" >&2; exit 1; }
DB=/tmp/nexus-unmapped-owner.db
${metadataGuard}
`], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}` },
        });
        expect(result.status, result.stderr).toBe(0);
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
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
    expect(timer).toContain('OnCalendar=Mon 09:30');
    expect(policy.notifications.heartbeatEnabled).toBe(true);
    expect(policy.notifications.heartbeatSchedule).toBe('Mon 09:30');
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
  const repositoryBaseHint = spawnSync('git', ['rev-parse', 'HEAD'], {
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
      const result = runMigrationSafety(root, repositoryBaseHint);
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
    comparisonBase?: string,
  ) {
    // During an in-progress feature/main merge, migration-safety-check
    // deliberately compares the resulting index with the main parent instead
    // of the pre-merge feature HEAD. Bind the manifest fixture to the verdict's
    // resolved base so the test exercises the same immutable identity that CI
    // will sign, while explicit fixture bases remain authoritative below.
    const resolvedComparisonBase = comparisonBase ?? repositoryVerdict().comparisonBase;
    return spawnSync(process.execPath, [
      'scripts/release-manifest-build.mjs',
      '--migration-base', resolvedComparisonBase,
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
    comparisonBase?: string,
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
    comparisonBase?: string,
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

  it('refuses a real contract migration relabeled as expand in the secretless verifier', () => {
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
  // The verifier performs a complete migration-policy recomputation in a child
  // process. Coverage instrumentation on hosted runners can legitimately take
  // longer than the ordinary local path while still remaining bounded.
  }, 120_000);

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
  }, 60_000);

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

  function parseSteps(jobBody: string): string[] {
    const lines = jobBody.split('\n');
    const stepsAt = lines.findIndex((line) => /^ {4}steps:\s*$/.test(line));
    if (stepsAt === -1) return [];

    const steps: string[][] = [];
    let current: string[] | null = null;
    for (const line of lines.slice(stepsAt + 1)) {
      if (/^      -(?:\s|$)/.test(line)) {
        if (current) steps.push(current);
        current = [line];
        continue;
      }
      if (current) current.push(line);
    }
    if (current) steps.push(current);
    return steps.map((step) => step.join('\n'));
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

  it('keeps hosted/self-hosted branching at step level', () => {
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

  it('binds the root-owned guard to every dynamic runner allocation before checkout', () => {
    // A successful guardrails job does not prove that a later job received the
    // same machine: GitHub may allocate any runner matching the dynamic label
    // set. Each allocated job must therefore establish the boundary itself as
    // its first step, before checkout or any other repository-controlled step.
    const dynamicJobs = Object.entries(jobs)
      .filter(([, job]) => job.runsOn?.includes('needs.runner.outputs.labels'));
    expect(dynamicJobs.length).toBeGreaterThan(4);

    for (const [name, job] of dynamicJobs) {
      const firstStep = parseSteps(job.body)[0] ?? '';
      expect(firstStep, `${name} must guard its own allocation first`).toContain(
        'name: Assert this allocated runner is test-only',
      );
      expect(firstStep, `${name} guard must be self-hosted-only`).toContain(
        "if: needs.runner.outputs.is_self_hosted == 'true'",
      );
      expect(firstStep, `${name} must use the installed guard`).toContain(
        'GUARD=/usr/local/sbin/nexus-pi-guardrails',
      );
      const rejectsGuardSymlink = /(?:test ! -L "\$GUARD"|if \[ -L "\$GUARD" \]; then)/
        .test(firstStep) || (
        firstStep.includes('if [ -L "$target" ]; then')
        && firstStep.includes('assert_trusted "$GUARD"')
      );
      expect(
        rejectsGuardSymlink,
        `${name} must reject a replaceable symlink`,
      ).toBe(true);
      expect(firstStep, `${name} must bind the guard parent`).toContain(
        'dirname "$GUARD"',
      );
      const exactInstallAssertions = firstStep.match(/= "0:0:755"/g) ?? [];
      const flexibleTrustAssertions = firstStep.includes('if [ "$owner" != "0" ]; then')
        && firstStep.includes('8#$mode & 8#022')
        && firstStep.includes('assert_trusted "$GUARD"')
        && firstStep.includes('assert_trusted "$(dirname "$GUARD")"');
      expect(
        exactInstallAssertions.length === 2 || flexibleTrustAssertions,
        `${name} must bind root ownership and non-writable modes for the guard and parent`,
      ).toBe(true);
      const bindsFullAncestorChain = firstStep.includes(
        'for ancestor in /usr/local /usr /',
      ) || (
        firstStep.includes('assert_trusted /usr/local')
        && firstStep.includes('assert_trusted /usr ')
        && firstStep.includes('assert_trusted / ')
      );
      expect(
        bindsFullAncestorChain,
        `${name} must bind every guard ancestor through the filesystem root`,
      ).toBe(true);
      expect(firstStep, `${name} must require a regular guard file`).toContain(
        'test -f "$GUARD"',
      );
      expect(firstStep, `${name} must reject a hard-linked guard`).toContain(
        `stat -c '%h' "$GUARD"`,
      );
      expect(firstStep, `${name} must execute the guard`).toContain('"$GUARD" --json');
    }
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
