import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');

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

  it('keeps release evidence generation alive for failed RC gates', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release-candidate-evidence.yml'),
      'utf8',
    );
    const releaseEvidenceJob = workflow.match(/  release-evidence:\n(?<body>[\s\S]*?)(?=\n  [a-zA-Z0-9_-]+:\n|$)/)?.groups?.body || '';

    expect(releaseEvidenceJob).toContain('needs: [vitest-full, python-full]');
    expect(releaseEvidenceJob).toMatch(/\n    if: always\(\)/);
    expect(releaseEvidenceJob).toContain('mkdir -p rc-test-results');
    expect(releaseEvidenceJob.match(/continue-on-error: true/g)?.length).toBeGreaterThanOrEqual(2);
    expect(releaseEvidenceJob).toContain("fs.existsSync(resultDir)");
    expect(releaseEvidenceJob).toContain('id: sandbox_smoke');
    expect(releaseEvidenceJob).toContain("NEXUS_RELEASE_VERDICT:");
    expect(releaseEvidenceJob).toContain("needs.vitest-full.result == 'success'");
    expect(releaseEvidenceJob).toContain("steps.sandbox_smoke.outcome == 'success'");
    expect(releaseEvidenceJob).toContain('NEXUS_RELEASE_SMOKE_RESULT: ${{ steps.sandbox_smoke.outcome }}');
    expect(releaseEvidenceJob).toContain('release-evidence-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}.json');
  });
});
