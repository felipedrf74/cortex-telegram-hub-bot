import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertTrainingE2ERunFreshness,
} from '../../scripts/lib/training-e2e-run-freshness.mjs';

const root = path.resolve(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const RUN_ID = 'training-e2e-20260803120000-abc1234';
const BACKEND_CONTAINER_ID = '1'.repeat(64);
const CONTENT_CONTAINER_ID = '2'.repeat(64);
const BACKEND_IMAGE_ID = `sha256:${'a'.repeat(64)}`;
const CONTENT_IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const COMMIT = 'c'.repeat(40);
const BASE_COMMIT = 'd'.repeat(40);
const DIRTY_TREE_DIGEST = 'e'.repeat(64);

function metadata() {
  return {
    schemaVersion: 'training_e2e_environment.v2',
    runId: RUN_ID,
    composeProject: `nexus-${RUN_ID}`,
    backendBaseUrl: 'http://127.0.0.1:18200',
    runPolicy: { mode: 'fresh', qualifying: true },
    git: {
      commit: COMMIT,
      baseCommit: BASE_COMMIT,
      dirtyTreeDiffSha256: DIRTY_TREE_DIGEST,
    },
    images: {
      backend: {
        name: `nexus-hub-node:training-e2e-${RUN_ID}`,
        containerId: BACKEND_CONTAINER_ID,
        builtImageId: BACKEND_IMAGE_ID,
        actualContainerImageId: BACKEND_IMAGE_ID,
      },
      contentEngine: {
        name: `nexus-hub-content-engine:training-e2e-${RUN_ID}`,
        containerId: CONTENT_CONTAINER_ID,
        builtImageId: CONTENT_IMAGE_ID,
        actualContainerImageId: CONTENT_IMAGE_ID,
      },
    },
  };
}

function dockerCommand(
  command: string,
  args: string[],
  overrides: {
    backendContainerId?: string;
    backendRunningImageId?: string;
    backendTaggedImageId?: string;
  } = {},
): string {
  if (command === 'git') return `${COMMIT}\n`;
  if (command !== 'docker') throw new Error(`Unexpected command: ${command}`);

  if (args[0] === 'ps') {
    const serviceFilter = args.find((arg) => arg.startsWith('label=com.docker.compose.service='));
    if (serviceFilter?.endsWith('nexus-hub')) {
      return `${overrides.backendContainerId ?? BACKEND_CONTAINER_ID}\n`;
    }
    if (serviceFilter?.endsWith('content-engine')) return `${CONTENT_CONTAINER_ID}\n`;
  }
  if (args[0] === 'inspect') {
    const containerId = args[1];
    if (containerId === (overrides.backendContainerId ?? BACKEND_CONTAINER_ID)) {
      return `${overrides.backendRunningImageId ?? BACKEND_IMAGE_ID}\n`;
    }
    if (containerId === CONTENT_CONTAINER_ID) return `${CONTENT_IMAGE_ID}\n`;
  }
  if (args[0] === 'image' && args[1] === 'inspect') {
    if (args[2] === `nexus-hub-node:training-e2e-${RUN_ID}`) {
      return `${overrides.backendTaggedImageId ?? BACKEND_IMAGE_ID}\n`;
    }
    if (args[2] === `nexus-hub-content-engine:training-e2e-${RUN_ID}`) {
      return `${CONTENT_IMAGE_ID}\n`;
    }
  }
  throw new Error(`Unexpected docker invocation: ${args.join(' ')}`);
}

describe('Training E2E flow provenance freshness', () => {
  it('returns a flow-safe backend provenance snapshot when source and running images remain exact', () => {
    const provenance = assertTrainingE2ERunFreshness({
      metadata: metadata(),
      repoRoot: root,
      gitDir: path.join(root, '.git'),
      computeDirtyTreeDigest: () => DIRTY_TREE_DIGEST,
      runCommand: dockerCommand,
      now: () => new Date('2026-08-03T12:00:00.000Z'),
    });

    expect(provenance).toEqual({
      schemaVersion: 'training_e2e_backend_provenance.v1',
      environmentSchemaVersion: 'training_e2e_environment.v2',
      verifiedAt: '2026-08-03T12:00:00.000Z',
      git: metadata().git,
      images: metadata().images,
    });
  });

  it('fails closed when the current dirty source digest differs from the built run', () => {
    expect(() => assertTrainingE2ERunFreshness({
      metadata: metadata(),
      repoRoot: root,
      gitDir: path.join(root, '.git'),
      computeDirtyTreeDigest: () => 'f'.repeat(64),
      runCommand: dockerCommand,
    })).toThrow(/source dirty-tree digest changed/i);
  });

  it('fails closed when the compose service container or running image identity changes', () => {
    expect(() => assertTrainingE2ERunFreshness({
      metadata: metadata(),
      repoRoot: root,
      gitDir: path.join(root, '.git'),
      computeDirtyTreeDigest: () => DIRTY_TREE_DIGEST,
      runCommand: (command, args) => dockerCommand(command, args, {
        backendContainerId: '3'.repeat(64),
      }),
    })).toThrow(/running backend container changed/i);

    expect(() => assertTrainingE2ERunFreshness({
      metadata: metadata(),
      repoRoot: root,
      gitDir: path.join(root, '.git'),
      computeDirtyTreeDigest: () => DIRTY_TREE_DIGEST,
      runCommand: (command, args) => dockerCommand(command, args, {
        backendRunningImageId: `sha256:${'f'.repeat(64)}`,
      }),
    })).toThrow(/running backend image changed/i);
  });

  it('revalidates freshness before lifecycle evidence publication and binds the evidence to the exact run', () => {
    const up = read('scripts/training-e2e-up.sh');
    const flow = read('scripts/training-e2e-flow.mjs');

    expect(up).toContain('assertTrainingE2ERunFreshness');
    expect(flow.match(/assertTrainingE2ERunFreshness\(/g)).toHaveLength(2);
    expect(flow).toContain("schemaVersion: 'training_e2e_flow.v2'");
    expect(flow).toContain('runId: metadata.runId');
    expect(flow).toContain('baseUrl');
    expect(flow).toContain('backendProvenance');
  });
});
