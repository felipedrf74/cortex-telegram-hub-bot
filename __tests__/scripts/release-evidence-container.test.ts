import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function cleanGitEnv(overrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_PREFIX',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE',
  ]) delete env[key];
  return { ...env, ...overrides };
}

describe('release-evidence-container wrapper', () => {
  const script = () => readFileSync('scripts/release-evidence-container.sh', 'utf8');
  const workflow = () => readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
  const releaseSigner = () => readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
  const stagingSigner = () => readFileSync('.github/workflows/sign-staging-attestation.yml', 'utf8');

  it('marks the bind-mounted workspace as a safe git directory', () => {
    const raw = script();

    expect(raw).toContain('-e GIT_CONFIG_COUNT=1');
    expect(raw).toContain('-e GIT_CONFIG_KEY_0=safe.directory');
    expect(raw).toContain('-e GIT_CONFIG_VALUE_0=/workspace');
  });

  it('forwards CI identity into the evidence-writing container', () => {
    const raw = script();

    for (const name of [
      'NEXUS_RELEASE_CI_PROVIDER',
      'NEXUS_RELEASE_RUN_ID',
      'NEXUS_RELEASE_RUN_ATTEMPT',
      'GITHUB_ACTIONS',
      'GITHUB_WORKFLOW',
      'GITHUB_RUN_ID',
      'GITHUB_RUN_ATTEMPT',
      'GITHUB_JOB',
    ]) {
      expect(raw).toContain(name);
    }
  });

  it('fails fast before evidence writing when the governed selected tier fails', () => {
    const raw = workflow();
    const planIndex = raw.indexOf('🧭 Resolve release test tier');
    const stopIndex = raw.indexOf('Stop when selected test prerequisites failed');
    const writeIndex = raw.indexOf('- name: Write exact release-test result');
    const unsignedIndex = raw.indexOf('- name: Write unsigned ReleaseManifestV2 candidate');

    expect(planIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeGreaterThan(-1);
    expect(writeIndex).toBeGreaterThan(stopIndex);
    expect(unsignedIndex).toBeGreaterThan(writeIndex);
    expect(raw).toContain("needs.test-plan.outputs.full_required == 'true' && needs.vitest-full.result != 'success'");
    expect(raw).toContain("needs.test-plan.outputs.full_required == 'false' && needs.vitest-selected.result != 'success'");
    expect(raw).toContain('release-test-selection-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(raw).toContain('release-manifest-v2.mjs write');
    expect(raw).toContain('--allow-unsigned');
    expect(raw).toContain('--includes-ios');
    expect(raw).toContain('--backend-only');
    expect(raw).toContain('contract_scope must be explicitly selected');
    expect(raw).toContain('.local/release/test-results.json');
    expect(raw).toContain('timeout-minutes: 30');
  });

  it('uploads the hidden immutable bundle completion seal', () => {
    const raw = workflow();

    expect(raw).toContain('.local/release/bundles/${{ github.sha }}/**/.complete.json');
    expect(raw).toContain('include-hidden-files: true');
  });

  it('promotes only the exact staged artifact through the versioned cutover path', () => {
    const operator = readFileSync('scripts/release-operator.sh', 'utf8');
    const promote = readFileSync('scripts/promote-exact-release.sh', 'utf8');

    expect(operator).toContain('scripts/promote-exact-release.sh');
    expect(operator).toContain('git status --porcelain=v1 --untracked-files=normal');
    expect(promote).toContain('rsync -a --delete');
    expect(promote).toContain('artifact aggregate digest mismatch');
    expect(promote).toContain('remote-create-release-backup.sh');
    expect(promote).toContain('remote-prepare-release-backup.sh');
    expect(promote).toContain('promotion failed after candidate mutation; restoring exact backup');
    expect(promote).toContain('promotion failed after production stop began; restarting the untouched predecessor');
    expect(operator.indexOf('resolve_remote_pm2')).toBeLessThan(operator.indexOf('mkdir -p'));
    expect(operator).toContain('release-installed-tree-attestation.mjs write');
    expect(operator).toContain('remote-release-preflight.sh');
    expect(operator).toContain('remote-release-readiness.sh');
    expect(operator).toContain('--readiness-evidence');
    expect(operator).toContain('scripts/staging-smoke.sh');
    expect(operator).toContain('release-staging-attestation.mjs request');
    expect(operator).toContain('--retry-connrefused');
    expect(operator).toContain('delete_staging_apps');
    expect(operator).not.toContain('startOrReload');
    expect(operator).not.toContain('--staging-evidence');
    expect(promote).toContain('--expect-aggregate-digest "$installed_digest"');
    expect(promote).toContain('(env.NEXUS_RELEASE_SHA||env.GIT_COMMIT)!==sha');
    expect(promote).toContain('active PM2/current identity mismatch');
    expect(promote).toContain('scripts/env-parity-check.sh');
    expect(promote).toContain('previous versioned runtime marker is missing');
    expect(promote).not.toContain('startOrReload');
    expect(promote).not.toContain('scripts/rollback.sh');
    expect(promote).not.toContain('npm ci');
    expect(promote).not.toContain('pip install');
  });

  it('rejects a dirty promotion checkout before manifest validation or SSH', () => {
    const root = mkdtempSync(join(tmpdir(), 'release-operator-dirty-'));
    try {
      mkdirSync(join(root, 'scripts/lib'), { recursive: true });
      copyFileSync('scripts/release-operator.sh', join(root, 'scripts/release-operator.sh'));
      copyFileSync('scripts/lib/release-gates.sh', join(root, 'scripts/lib/release-gates.sh'));
      chmodSync(join(root, 'scripts/release-operator.sh'), 0o755);
      writeFileSync(join(root, 'package.json'), '{"version":"0.0.0"}\n');
      const gitOptions = { cwd: root, env: cleanGitEnv() };
      execFileSync('git', ['init', '--initial-branch=main'], gitOptions);
      execFileSync('git', ['config', 'user.name', 'Release Fixture'], gitOptions);
      execFileSync('git', ['config', 'user.email', 'release@example.invalid'], gitOptions);
      execFileSync('git', ['add', '.'], gitOptions);
      execFileSync('git', ['commit', '-m', 'fixture'], gitOptions);
      writeFileSync(join(root, 'scripts/release-operator.sh'), '\n# dirty promotion helper\n', { flag: 'a' });

      const result = spawnSync('bash', [
        'scripts/release-operator.sh',
        'promote',
        '--manifest',
        'missing.json',
      ], { cwd: root, encoding: 'utf8', env: cleanGitEnv() });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('release:promote requires a clean checkout');
      expect(`${result.stdout}\n${result.stderr}`).not.toContain('missing.json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('validates operator status against the exact immutable bundle root', () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), 'release-operator-bundle-'));
    const bin = join(fixtureRoot, 'bin');
    const nodeLog = join(fixtureRoot, 'node.log');
    try {
      mkdirSync(join(fixtureRoot, 'scripts/lib'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      copyFileSync('scripts/release-operator.sh', join(fixtureRoot, 'scripts/release-operator.sh'));
      copyFileSync('scripts/lib/release-gates.sh', join(fixtureRoot, 'scripts/lib/release-gates.sh'));
      chmodSync(join(fixtureRoot, 'scripts/release-operator.sh'), 0o755);
      writeFileSync(join(fixtureRoot, 'package.json'), '{"version":"0.0.0"}\n');
      const gitOptions = { cwd: fixtureRoot, env: cleanGitEnv() };
      execFileSync('git', ['init', '--initial-branch=main'], gitOptions);
      execFileSync('git', ['config', 'user.name', 'Release Fixture'], gitOptions);
      execFileSync('git', ['config', 'user.email', 'release@example.invalid'], gitOptions);
      execFileSync('git', ['add', '.'], gitOptions);
      execFileSync('git', ['commit', '-m', 'fixture'], gitOptions);
      const fixtureSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: cleanGitEnv(),
      }).trim();
      const digest = 'b'.repeat(64);
      const manifest = join(fixtureRoot, '.local/release/manifests', `${fixtureSha}.json`);
      const bundle = join(fixtureRoot, '.local/release/bundles', fixtureSha, digest);
      mkdirSync(bundle, { recursive: true });
      mkdirSync(join(fixtureRoot, '.local/release/manifests'), { recursive: true });
      writeFileSync(join(bundle, '.complete.json'), '{}\n');
      writeFileSync(manifest, JSON.stringify({
        payload: { runtimeSha: fixtureSha, artifact: { digest } },
      }));
      writeFileSync(join(bin, 'node'), `#!/usr/bin/env bash
set -eu
if [ "\$1" = "-e" ]; then exec "\$REAL_NODE" "\$@"; fi
printf '%s\\n' "\$*" >> "\$NODE_LOG"
`);
      chmodSync(join(bin, 'node'), 0o755);
      const env = cleanGitEnv({
        PATH: `${bin}:${process.env.PATH}`,
        REAL_NODE: process.execPath,
        NODE_LOG: nodeLog,
      });

      const accepted = spawnSync('bash', [
        'scripts/release-operator.sh',
        'status',
        '--manifest', manifest,
      ], { cwd: fixtureRoot, encoding: 'utf8', env });
      expect(accepted.status).toBe(0);
      const invocation = readFileSync(nodeLog, 'utf8');
      expect(invocation).toContain(`--manifest ${manifest}`);
      expect(invocation).toContain(`/.local/release/bundles/${fixtureSha}/${digest}`);
      expect(invocation).toContain('--verify-bundle');
      expect(invocation).toContain(`--expect-runtime-sha ${fixtureSha}`);

      writeFileSync(manifest, JSON.stringify({
        payload: { runtimeSha: fixtureSha, artifact: { digest: '../outside' } },
      }));
      const traversal = spawnSync('bash', [
        'scripts/release-operator.sh',
        'status',
        '--manifest', manifest,
      ], { cwd: fixtureRoot, encoding: 'utf8', env });
      expect(traversal.status).toBe(1);
      expect(traversal.stderr).toContain('release manifest artifact digest is invalid');
      expect(readFileSync(nodeLog, 'utf8')).toBe(invocation);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it('signs release and staging evidence only through protected-main environment secret paths', () => {
    const raw = stagingSigner();
    const rc = workflow();
    const release = releaseSigner();
    const request = readFileSync('scripts/request-staging-attestation.sh', 'utf8');

    expect(raw).toContain('environment: release-signing');
    expect(raw).toContain("github.ref == 'refs/heads/main'");
    expect(raw).toContain('ref: refs/heads/main');
    expect(raw).toContain('path: trusted-tooling');
    expect(raw).toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(raw).toContain('trusted-tooling/scripts/release-staging-attestation.mjs validate-request');
    expect(raw).toContain('trusted-tooling/scripts/release-staging-attestation.mjs sign');
    expect(raw).toContain('staging-attestation-${{ inputs.request_id }}');
    expect(raw).not.toContain('SERVER_SSH_KEY');
    expect(release).toContain('environment: release-signing');
    expect(release).toContain('trusted-tooling/scripts/trusted-release-signer.mjs sign-manifest');
    expect(release).toContain('release-manifest-v2-${{ env.RUNTIME_SHA }}');
    expect(rc).not.toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(rc).not.toContain('sign_staging');
    expect(request).toContain('SIGNING_WORKFLOW="sign-staging-attestation.yml"');
    expect(request).toContain('gh workflow run "$SIGNING_WORKFLOW" --ref "$REF"');
  });

  it.each([
    {
      label: 'release manifest',
      script: 'request-release-manifest-signature.sh',
      workflow: 'sign-release-manifest.yml',
      args: (root: string, runtimeSha: string) => [runtimeSha, '123456', root, '--backend-only'],
      prepare: (_root: string, _runtimeSha: string) => {},
      contractScope: 'backend_only',
    },
    {
      label: 'shared release manifest',
      script: 'request-release-manifest-signature.sh',
      workflow: 'sign-release-manifest.yml',
      args: (root: string, runtimeSha: string) => [
        runtimeSha,
        '123456',
        root,
        '--includes-ios',
        '--ios-attestation',
        join(root, 'ios-contract-attestation.json'),
        '--ios-distribution-attestation',
        join(root, 'ios-distribution-attestation.json'),
      ],
      prepare: (root: string, _runtimeSha: string) => {
        writeFileSync(join(root, 'ios-contract-attestation.json'), '{"signed":"fixture"}\n');
        writeFileSync(join(root, 'ios-distribution-attestation.json'), '{"signed":"fixture"}\n');
      },
      contractScope: 'shared_backend_ios',
    },
    {
      label: 'staging attestation',
      script: 'request-staging-attestation.sh',
      workflow: 'sign-staging-attestation.yml',
      args: (root: string, runtimeSha: string) => [
        join(root, 'staging-request.json'),
        join(root, 'release-manifest.json'),
        join(root, 'staging-attestation.json'),
      ],
      prepare: (root: string, runtimeSha: string) => {
        writeFileSync(join(root, 'staging-request.json'), JSON.stringify({
          requestId: '11111111-1111-1111-1111-111111111111',
          runtimeSha,
        }));
        writeFileSync(join(root, 'scripts/release-staging-attestation.mjs'), `
          if (process.argv[2] !== 'validate-request') process.exit(70);
        `);
      },
      contractScope: null,
    },
  ])('behaviorally probes the $label workflow YAML before dispatch', ({
    script: scriptName,
    workflow: workflowName,
    args,
    prepare,
    contractScope,
  }) => {
    const root = mkdtempSync(join(tmpdir(), 'release-signing-probe-'));
    const runtimeSha = 'a'.repeat(40);
    const bin = join(root, 'bin');
    const scripts = join(root, 'scripts');
    const log = join(root, 'gh-argv.log');
    try {
      mkdirSync(bin, { recursive: true });
      mkdirSync(scripts, { recursive: true });
      copyFileSync(join('scripts', scriptName), join(scripts, scriptName));
      chmodSync(join(scripts, scriptName), 0o755);
      prepare(root, runtimeSha);
      writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  exit 0
fi
if [ "$1" = "workflow" ] && [ "$2" = "view" ]; then
  case " $* " in
    *" --ref "*" --yaml "*) exit 0 ;;
    *) exit 72 ;;
  esac
fi
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  exit 73
fi
exit 74
`);
      chmodSync(join(bin, 'gh'), 0o755);

      const result = spawnSync('bash', [
        join('scripts', scriptName),
        ...args(root, runtimeSha),
      ], {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv({
          FAKE_GH_LOG: log,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        }),
      });

      expect(result.status).toBe(73);
      const calls = readFileSync(log, 'utf8').trim().split('\n');
      const viewIndex = calls.findIndex((call) => call.startsWith(`workflow view ${workflowName} `));
      const dispatchIndex = calls.findIndex((call) => call.startsWith(`workflow run ${workflowName} `));
      expect(viewIndex).toBeGreaterThan(-1);
      expect(calls[viewIndex]).toContain('--ref main --yaml');
      expect(dispatchIndex).toBeGreaterThan(viewIndex);
      if (scriptName === 'request-release-manifest-signature.sh') {
        expect(calls[dispatchIndex]).toContain(`-f contract_scope=${contractScope}`);
        if (contractScope === 'shared_backend_ios') {
          expect(calls[dispatchIndex]).toContain('-f ios_attestation_base64=');
          expect(calls[dispatchIndex]).toContain('-f ios_distribution_attestation_base64=');
          expect(calls[dispatchIndex]).not.toContain('ios_evidence_run_id=');
          expect(calls[dispatchIndex]).not.toContain('ios_sha=');
          expect(calls[dispatchIndex]).not.toContain('ios_build_number=');
          expect(calls[dispatchIndex]).not.toContain('ios_contract_result=');
        }
      }
      expect(calls.some((call) => call.startsWith('run watch '))).toBe(false);
      expect(calls.some((call) => call.startsWith('run download '))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
