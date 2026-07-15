import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  isGitAncestor,
  validateGitHubIdentity,
  validateTestCountFloors,
} from '../../scripts/trusted-release-signer.mjs';

const runtimeSha = 'a'.repeat(40);
const repository = 'felipedrf74/cortex-telegram-hub-bot';
const candidateRunId = '123456789';

function successfulIdentity() {
  return {
    run: {
      id: Number(candidateRunId),
      run_attempt: 2,
      status: 'completed',
      conclusion: 'success',
      head_sha: runtimeSha,
      path: '.github/workflows/release-candidate-evidence.yml',
      event: 'workflow_dispatch',
      repository: { full_name: repository },
      head_repository: { full_name: repository },
    },
    jobs: {
      jobs: [
        '🧪 Full Vitest shard 1/4',
        '🧪 Full Vitest shard 2/4',
        '🧪 Full Vitest shard 3/4',
        '🧪 Full Vitest shard 4/4',
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

describe('trusted release signing boundary', () => {
  it('accepts only runtime commits reachable from protected main history', () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(isGitAncestor(process.cwd(), head)).toBe(true);
    expect(isGitAncestor(process.cwd(), 'f'.repeat(40))).toBe(false);

    const workflow = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    expect(workflow).toContain('fetch-depth: 0');
    expect(fs.readFileSync('scripts/trusted-release-signer.mjs', 'utf8'))
      .toContain("fail('candidate runtime SHA is not reachable from protected main')");
  });

  it('accepts only one successful exact-run, exact-head candidate artifact and complete gate jobs', () => {
    const identity = successfulIdentity();
    expect(validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
    })).toMatchObject({
      runAttempt: '2',
      expectedArtifactName: `release-candidate-v2-${runtimeSha}`,
      artifact: { id: 987654 },
    });
  });

  it('fails closed below the protected-main release test floors', () => {
    const policy = JSON.parse(fs.readFileSync('config/test-policy.json', 'utf8'));
    const floors = policy.releaseEvidence.minimumTestCounts;

    expect(floors).toEqual({ vitest: 9000, pytest: 6 });
    expect(() => validateTestCountFloors({ vitest: 1, pytest: 1 }, floors))
      .toThrow('vitest:1<9000');
    expect(() => validateTestCountFloors({ vitest: 8999, pytest: 6 }, floors))
      .toThrow('vitest:8999<9000');
    expect(() => validateTestCountFloors({ vitest: 9000, pytest: 5 }, floors))
      .toThrow('pytest:5<6');
    expect(() => validateTestCountFloors({ vitest: 9000, pytest: 6 }, floors))
      .not.toThrow();
  });

  it.each([
    ['run id', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.id += 1; }, 'run id mismatch'],
    ['head SHA', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.head_sha = 'c'.repeat(40); }, 'head SHA mismatch'],
    ['workflow path', (identity: ReturnType<typeof successfulIdentity>) => { identity.run.path = '.github/workflows/other.yml'; }, 'workflow path mismatch'],
    ['artifact run', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.id += 1; }, 'not bound'],
    ['artifact head', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].workflow_run.head_sha = 'd'.repeat(40); }, 'not bound'],
    ['artifact digest', (identity: ReturnType<typeof successfulIdentity>) => { identity.artifacts.artifacts[0].digest = ''; }, 'digest is missing'],
    ['full suite job', (identity: ReturnType<typeof successfulIdentity>) => { identity.jobs.jobs.pop(); }, 'missing, duplicated, or unsuccessful'],
  ])('fails closed on mismatched %s evidence', (_label, mutate, message) => {
    const identity = successfulIdentity();
    mutate(identity);
    expect(() => validateGitHubIdentity({
      ...identity,
      runtimeSha,
      repository,
      candidateRunId,
    })).toThrow(message);
  });

  it('keeps the private key out of RC and scopes both signing paths to protected main tooling', () => {
    const workflowsRoot = path.resolve('.github/workflows');
    const rc = fs.readFileSync(path.join(workflowsRoot, 'release-candidate-evidence.yml'), 'utf8');
    const manifestSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-release-manifest.yml'), 'utf8');
    const stagingSigner = fs.readFileSync(path.join(workflowsRoot, 'sign-staging-attestation.yml'), 'utf8');
    const allWorkflows = fs.readdirSync(workflowsRoot)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => fs.readFileSync(path.join(workflowsRoot, name), 'utf8'))
      .join('\n');

    expect(rc).not.toContain('NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM');
    expect(rc).not.toContain('sign_staging');
    expect(rc).toContain('release-candidate-v2-${{ github.sha }}');
    expect(rc).toContain('--allow-unsigned');
    expect(allWorkflows.match(/secrets\.NEXUS_RELEASE_EVIDENCE_PRIVATE_KEY_PEM/g)).toHaveLength(2);

    for (const signer of [manifestSigner, stagingSigner]) {
      expect(signer).toContain('environment: release-signing');
      expect(signer).toContain("github.ref == 'refs/heads/main'");
      expect(signer).toContain('ref: refs/heads/main');
      expect(signer).toContain('path: trusted-tooling');
      expect(signer).not.toMatch(/(?:node|bash|sh|npm|npx|\.\/)\s+candidate-(?:source|artifact)/);
      expect(signer).not.toContain('cd candidate-');
    }
    expect(manifestSigner).toContain('node trusted-tooling/scripts/trusted-release-signer.mjs');
    expect(manifestSigner).toContain('--candidate-run-id "$CANDIDATE_RUN_ID"');
    expect(manifestSigner).toContain('--run-metadata trusted-input/run.json');
    expect(manifestSigner).toContain('--jobs-metadata trusted-input/jobs.json');
    expect(manifestSigner).toContain('--artifact-metadata trusted-input/artifacts.json');
    expect(manifestSigner).toContain('path: candidate-artifact/.local/release');
    expect(manifestSigner).not.toMatch(/^\s*path:\s*candidate-artifact\s*$/m);
    expect(stagingSigner).toContain('node trusted-tooling/scripts/release-staging-attestation.mjs');
    expect(stagingSigner).not.toContain('ref: ${{ inputs.runtime_sha }}');
  });

  it('validates dispatch identities before use and never renders them into signer shell source', () => {
    const signer = fs.readFileSync('.github/workflows/sign-release-manifest.yml', 'utf8');
    const runBlocks = workflowRunBlocks(signer).join('\n');
    const maliciousRunId = '29407618419?x=$(printf exfiltrate)';

    // actions/download-artifact parses run-id with parseInt, so this shape can
    // still select a legitimate run unless the workflow rejects it first.
    expect(Number.parseInt(maliciousRunId, 10)).toBe(29407618419);
    expect(/^[0-9]+$/.test(maliciousRunId)).toBe(false);
    expect(/^[0-9]+$/.test(candidateRunId)).toBe(true);
    expect(/^[0-9a-f]{40}$/.test(runtimeSha)).toBe(true);

    expect(signer).toContain('RUNTIME_SHA: ${{ inputs.runtime_sha }}');
    expect(signer).toContain('CANDIDATE_RUN_ID: ${{ inputs.candidate_run_id }}');
    expect(signer).toContain('[[ "$RUNTIME_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(signer).toContain('[[ "$CANDIDATE_RUN_ID" =~ ^[0-9]+$ ]]');
    expect(signer.indexOf('Validate workflow dispatch identity'))
      .toBeLessThan(signer.indexOf('Check out protected main signing tooling'));
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
