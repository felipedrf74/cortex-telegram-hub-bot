import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('release-evidence-container wrapper', () => {
  const script = () => readFileSync('scripts/release-evidence-container.sh', 'utf8');
  const workflow = () => readFileSync('.github/workflows/release-candidate-evidence.yml', 'utf8');
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

  it('fails fast before evidence writing when prerequisite full suites fail', () => {
    const raw = workflow();
    const stopIndex = raw.indexOf('Stop when full-suite prerequisites failed');
    const countIndex = raw.indexOf('Count tests from shard artifacts');
    const writeIndex = raw.indexOf('- name: Write exact release-test result');
    const signIndex = raw.indexOf('- name: Sign ReleaseManifestV2');

    expect(stopIndex).toBeGreaterThan(-1);
    expect(countIndex).toBeGreaterThan(stopIndex);
    expect(writeIndex).toBeGreaterThan(stopIndex);
    expect(signIndex).toBeGreaterThan(writeIndex);
    expect(raw).toContain("needs.vitest-full.result != 'success' || needs.python-full.result != 'success'");
    expect(raw).toContain('release-manifest-v2.mjs write');
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
    expect(operator).not.toContain('NEXUS_RELEASE_MANIFEST_PATH="$ROOT/$MANIFEST" scripts/promote-to-prod.sh');
    expect(operator).toContain('git status --porcelain=v1 --untracked-files=normal');
    expect(promote).toContain('rsync -a --delete');
    expect(promote).toContain('artifact aggregate digest mismatch');
    expect(promote).toContain('remote-create-release-backup.sh');
    expect(promote).toContain('remote-prepare-release-backup.sh');
    expect(promote).toContain('candidate failed readiness; restoring exact backup');
    expect(operator.indexOf('resolve_remote_pm2')).toBeLessThan(operator.indexOf('mkdir -p'));
    expect(operator).toContain('release-installed-tree-attestation.mjs write');
    expect(operator).toContain('scripts/staging-smoke.sh');
    expect(operator).toContain('release-staging-attestation.mjs request');
    expect(operator).toContain('--retry-connrefused');
    expect(operator).toContain('delete_staging_apps');
    expect(operator).not.toContain('startOrReload');
    expect(operator).not.toContain('--staging-evidence');
    expect(promote).toContain('--expect-aggregate-digest "$installed_digest"');
    expect(promote).toContain('production PM2 exact-release identity mismatch');
    expect(promote).toContain('previous versioned runtime marker is missing');
    expect(promote).not.toContain('startOrReload');
    expect(promote).not.toContain('scripts/rollback.sh');
    expect(promote).not.toContain('npm ci');
    expect(promote).not.toContain('pip install');
  });

  it('signs detached staging evidence only through the owner-gated CI secret path', () => {
    const raw = stagingSigner();

    expect(raw).toContain('github.actor == github.repository_owner');
    expect(raw).toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(raw).toContain('release-staging-attestation.mjs validate-request');
    expect(raw).toContain('release-staging-attestation.mjs sign');
    expect(raw).toContain('staging-attestation-${{ inputs.request_id }}');
    expect(raw).not.toContain('SERVER_SSH_KEY');
  });
});
