import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTrainingE2ECurrentRuntimeProvenance,
  assertTrainingE2ERunProvenance,
  computeTrainingE2EDirtyTreeDigest,
} from '../../scripts/lib/training-e2e-contract.mjs';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function completeProvenance() {
  const runId = 'training-e2e-20260803120000-abc1234';
  const backendImageId = `sha256:${'a'.repeat(64)}`;
  const contentImageId = `sha256:${'b'.repeat(64)}`;
  return {
    runId,
    qualifying: true,
    backendGit: {
      commit: 'c'.repeat(40),
      baseCommit: 'd'.repeat(40),
      dirtyTreeDiffSha256: 'e'.repeat(64),
    },
    images: {
      backend: {
        name: `nexus-hub-node:training-e2e-${runId}`,
        builtImageId: backendImageId,
        actualContainerImageId: backendImageId,
      },
      contentEngine: {
        name: `nexus-hub-content-engine:training-e2e-${runId}`,
        builtImageId: contentImageId,
        actualContainerImageId: contentImageId,
      },
    },
  };
}

describe('Training E2E source and image provenance', () => {
  it('does not inherit developer env files and supplies only fixture-safe required values', () => {
    const compose = read('docker-compose.training-e2e.yml');

    expect(compose).not.toMatch(/\benv_file\s*:/);
    expect(compose).not.toContain('.env.local');
    expect(compose).toContain('CONTENT_ENGINE_FIXTURE_MODE: "1"');
    expect(compose).toContain('INTERNAL_API_SECRET: ${NEXUS_TRAINING_E2E_INTERNAL_SECRET');
    expect(compose).toContain('NEXUS_LOCAL_ALLOW_MODEL_CALLS: "0"');
    expect(compose).toContain('NEXUS_MODEL_FIXTURE_MODE: "1"');
  });

  it('binds qualifying evidence to exact backend source and running image identities', () => {
    const provenance = completeProvenance();
    expect(assertTrainingE2ERunProvenance(provenance)).toBe(provenance);

    expect(() => assertTrainingE2ERunProvenance({
      ...provenance,
      backendGit: { ...provenance.backendGit, baseCommit: null },
    })).toThrow(/base commit/i);
    expect(() => assertTrainingE2ERunProvenance({
      ...provenance,
      backendGit: { ...provenance.backendGit, dirtyTreeDiffSha256: 'not-a-digest' },
    })).toThrow(/dirty-tree diff digest/i);
    expect(() => assertTrainingE2ERunProvenance({
      ...provenance,
      images: {
        ...provenance.images,
        backend: {
          ...provenance.images.backend,
          actualContainerImageId: `sha256:${'f'.repeat(64)}`,
        },
      },
    })).toThrow(/running backend image/i);
  });

  it('rejects image tags that are not bound to the exact run id', () => {
    const provenance = completeProvenance();
    expect(() => assertTrainingE2ERunProvenance({
      ...provenance,
      images: {
        ...provenance.images,
        backend: {
          ...provenance.images.backend,
          name: 'nexus-hub-node:training-e2e-another-run',
        },
      },
    })).toThrow(/run-scoped backend image name/i);
  });

  it('matches recorded metadata to freshly observed source and running image identities', () => {
    const recorded = {
      ...completeProvenance(),
      schemaVersion: 'training_e2e_environment.v2',
      git: completeProvenance().backendGit,
      backendGit: undefined,
    };
    const current = {
      commit: recorded.git.commit,
      baseCommit: recorded.git.baseCommit,
      dirtyTreeDiffSha256: recorded.git.dirtyTreeDiffSha256,
      backendActualImageId: recorded.images.backend.actualContainerImageId,
      contentActualImageId: recorded.images.contentEngine.actualContainerImageId,
    };

    expect(assertTrainingE2ECurrentRuntimeProvenance(recorded, current)).toBe(recorded);
    for (const override of [
      { commit: 'f'.repeat(40) },
      { baseCommit: 'f'.repeat(40) },
      { dirtyTreeDiffSha256: 'f'.repeat(64) },
      { backendActualImageId: `sha256:${'f'.repeat(64)}` },
      { contentActualImageId: `sha256:${'f'.repeat(64)}` },
    ]) {
      expect(() => assertTrainingE2ECurrentRuntimeProvenance(recorded, {
        ...current,
        ...override,
      })).toThrow(/current|changed|image|source|provenance/i);
    }
  });

  it('hashes tracked patches and untracked source deterministically without returning contents', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'training-e2e-provenance-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 'training-e2e@example.test'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Training E2E'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'baseline\n');
      execFileSync('git', ['add', 'tracked.txt'], { cwd: repo });
      execFileSync('git', ['commit', '--quiet', '-m', 'baseline'], { cwd: repo });
      const gitDir = path.join(repo, '.git');
      const clean = computeTrainingE2EDirtyTreeDigest({ repoRoot: repo, gitDir });
      const cleanAgain = computeTrainingE2EDirtyTreeDigest({ repoRoot: repo, gitDir });
      expect(cleanAgain).toBe(clean);

      fs.writeFileSync(path.join(repo, 'tracked.txt'), 'tracked secret sentinel\n');
      const tracked = computeTrainingE2EDirtyTreeDigest({ repoRoot: repo, gitDir });
      expect(tracked).not.toBe(clean);

      fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked secret sentinel\n');
      const untracked = computeTrainingE2EDirtyTreeDigest({ repoRoot: repo, gitDir });
      expect(untracked).not.toBe(tracked);
      expect(untracked).toMatch(/^[a-f0-9]{64}$/);
      expect(untracked).not.toContain('secret sentinel');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('records and validates the provenance before publishing run metadata', () => {
    const up = read('scripts/training-e2e-up.sh');

    expect(up).toContain('COMPOSE_DISABLE_ENV_FILE=1');
    expect(up).toContain("schemaVersion: 'training_e2e_environment.v2'");
    expect(up).toContain('NEXUS_TRAINING_E2E_BACKEND_COMMIT');
    expect(up).toContain('NEXUS_TRAINING_E2E_BASE_COMMIT');
    expect(up).toContain('NEXUS_TRAINING_E2E_DIRTY_TREE_DIFF_SHA256');
    expect(up).toContain('NEXUS_TRAINING_E2E_BACKEND_BUILT_IMAGE_ID');
    expect(up).toContain('NEXUS_TRAINING_E2E_CONTENT_BUILT_IMAGE_ID');
    expect(up).toContain('assertTrainingE2ERunProvenance');
  });
});
