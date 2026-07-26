import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

function workflowJob(source: string, jobName: string): string {
  const marker = `  ${jobName}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const body = source.slice(start + marker.length);
  const nextJob = body.search(/^  [a-zA-Z0-9_-]+:\n/m);
  return nextJob < 0 ? body : body.slice(0, nextJob);
}

function workflowStep(source: string, stepName: string): string {
  const marker = `      - name: ${stepName}\n`;
  const start = source.indexOf(marker);
  if (start < 0) return '';
  const body = source.slice(start + marker.length);
  const nextStep = body.search(/^      - (?:name:|uses:|run:)/m);
  return nextStep < 0 ? body : body.slice(0, nextStep);
}

describe('privileged GitHub workflow action pinning', () => {
  it('pins write-capable workflow actions to immutable commit SHAs', () => {
    const mutableReferences: string[] = [];
    const workflowDir = path.join(repoRoot, '.github/workflows');
    const workflowFiles = fs.readdirSync(workflowDir)
      .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
      .map((name) => `.github/workflows/${name}`)
      .sort();

    for (const file of workflowFiles) {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      const actionReferences = source.matchAll(/uses:\s*([^\s@]+)@([^\s#]+)/g);

      for (const match of actionReferences) {
        const [, action, ref] = match;
        if (!/^[a-f0-9]{40}$/i.test(ref)) {
          mutableReferences.push(`${file}: ${action}@${ref}`);
        }
      }
    }

    expect(mutableReferences).toEqual([]);
  });

  it('binds RC gate results to one immutable ReleaseManifestV2 artifact', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release-candidate-evidence.yml'),
      'utf8',
    );
    const releaseEvidenceJob = workflowJob(workflow, 'release-evidence');

    expect(releaseEvidenceJob).toContain('needs: [contract-binding, test-plan, vitest-full, vitest-selected, python-full]');
    expect(releaseEvidenceJob).toContain('if: ${{ always() }}');
    expect(releaseEvidenceJob).toContain('mkdir -p .local/release/rc-test-results');
    expect(releaseEvidenceJob.match(/continue-on-error: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(releaseEvidenceJob).toContain('node scripts/release-test-evidence.mjs write-result');
    expect(releaseEvidenceJob).toContain('id: sandbox_smoke');
    expect(releaseEvidenceJob).toContain("NEXUS_RELEASE_VERDICT:");
    expect(releaseEvidenceJob).toContain("needs.test-plan.outputs.full_required == 'true' && needs.vitest-full.result != 'success'");
    expect(releaseEvidenceJob).toContain("needs.test-plan.outputs.full_required == 'false' && needs.vitest-selected.result != 'success'");
    expect(releaseEvidenceJob).toContain("steps.sandbox_smoke.outcome == 'success'");
    expect(releaseEvidenceJob).toContain('node scripts/release-bundle.mjs');
    expect(releaseEvidenceJob).toContain('node scripts/release-manifest-v2.mjs write');
    expect(releaseEvidenceJob).toContain('node scripts/release-manifest-v2.mjs validate-payload');
    expect(releaseEvidenceJob).toContain('--includes-ios');
    expect(releaseEvidenceJob).toContain('--backend-only');
    expect(releaseEvidenceJob).toContain('release-candidate-v2-${{ github.sha }}');
    expect(workflowStep(workflow, 'Upload unsigned release candidate and evidence'))
      .toContain('compression-level: 0');
    expect(releaseEvidenceJob).not.toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');

    const signer = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/sign-release-manifest.yml'),
      'utf8',
    );
    expect(signer).toContain('environment: release-signing');
    expect(signer).toContain('ref: refs/heads/main');
    expect(signer).toContain('node trusted-tooling/scripts/trusted-release-signer.mjs sign-manifest');
    expect(signer).toContain('--contract-scope "$CONTRACT_SCOPE"');
    expect(signer).toContain('--ios-evidence-root trusted-input/ios-evidence');
    expect(signer).toContain('--ios-distribution-evidence-root trusted-input/ios-distribution-evidence');
    expect(signer).toContain('IOS_ATTESTATION_BASE64: ${{ inputs.ios_attestation_base64 }}');
    expect(signer).toContain('IOS_DISTRIBUTION_ATTESTATION_BASE64: ${{ inputs.ios_distribution_attestation_base64 }}');
    expect(signer).not.toContain('NEXUS_IOS_RELEASE_EVIDENCE_READ_TOKEN');
    expect(signer).not.toContain('--ios-evidence-run-id');
    expect(signer).not.toContain('--ios-sha "$IOS_SHA"');
    expect(signer).toContain('release-manifest-v2-${{ env.RUNTIME_SHA }}');
    expect(workflowStep(signer, 'Upload signed immutable release artifact'))
      .toContain('compression-level: 0');

    const ci = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/ci.yml'),
      'utf8',
    );
    expect(workflowStep(ci, 'Upload exact runtime release bundle'))
      .toContain('compression-level: 0');

    const protectedMainEvidenceJob = workflowJob(ci, 'protected_main_evidence');
    expect(protectedMainEvidenceJob).toContain('fetch-depth: 0');
    expect(protectedMainEvidenceJob).toContain('node scripts/protected-main-ci-evidence.mjs write');
  });

  it('binds idempotent release closeout to the exact promoted transaction', () => {
    const release = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8',
    );
    const releaseJob = workflowJob(release, 'release');

    expect(release).toContain('runtime_sha:');
    expect(release).toContain('artifact_digest:');
    expect(release).toContain('promotion_transaction_id:');
    expect(release).toContain('promotion_evidence_sha256:');
    expect(releaseJob).toContain('if: ${{ github.actor == github.repository_owner }}');
    expect(releaseJob).toContain('ref: ${{ inputs.runtime_sha }}');
    expect(releaseJob).toContain('fetch-depth: 1');
    expect(releaseJob).toContain('[ "$(git rev-parse HEAD)" = "$RUNTIME_SHA" ]');
    expect(releaseJob).toContain('git ls-remote --exit-code --tags origin');
    expect(releaseJob).toContain('remote_tag_target');
    expect(releaseJob).toContain("if: ${{ steps.release.outputs.tag_exists != 'true' }}");
    expect(releaseJob).toContain('target_commitish: ${{ steps.release.outputs.runtime_sha }}');
    expect(releaseJob).toContain('body_path: .local/release/release-notes.md');
    expect(releaseJob).toContain('jq -n');
    expect(releaseJob).toContain('--data-binary @"$RUNNER_TEMP/notion-release.json"');
    expect(releaseJob).not.toContain('${{ github.event.inputs.changelog }}');
    expect(releaseJob).not.toContain('EXPECTED="${{');
  });
});
