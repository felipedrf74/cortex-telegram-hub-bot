import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  assertTrainingE2ERunProvenance,
  computeTrainingE2EDirtyTreeDigest,
} from './training-e2e-contract.mjs';

function execute(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function normalizedLines(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function requireSingleRunningContainer({ metadata, service, label, runCommand }) {
  const ids = normalizedLines(runCommand('docker', [
    'ps',
    '--no-trunc',
    '--filter',
    `label=com.docker.compose.project=${metadata.composeProject}`,
    '--filter',
    `label=com.docker.compose.service=${service}`,
    '--format',
    '{{.ID}}',
  ]));
  if (ids.length !== 1) {
    throw new Error(`Training E2E freshness failed: expected exactly one running ${label} container, found ${ids.length}`);
  }
  return ids[0];
}

function assertImageFreshness({ metadata, key, service, label, runCommand }) {
  const image = metadata.images[key];
  const runningContainerId = requireSingleRunningContainer({
    metadata,
    service,
    label,
    runCommand,
  });
  if (runningContainerId !== image.containerId) {
    throw new Error(`Training E2E freshness failed: running ${label} container changed after startup`);
  }

  const runningImageId = String(runCommand('docker', [
    'inspect',
    runningContainerId,
    '--format',
    '{{.Image}}',
  ])).trim();
  if (runningImageId !== image.actualContainerImageId || runningImageId !== image.builtImageId) {
    throw new Error(`Training E2E freshness failed: running ${label} image changed after startup`);
  }

  const taggedImageId = String(runCommand('docker', [
    'image',
    'inspect',
    image.name,
    '--format',
    '{{.Id}}',
  ])).trim();
  if (taggedImageId !== image.builtImageId) {
    throw new Error(`Training E2E freshness failed: run-scoped ${label} image tag changed after startup`);
  }
}

/**
 * Re-resolve the mutable identities behind a Training E2E run. Metadata shape
 * validation alone cannot prove that source or containers stayed unchanged
 * between `training:e2e:up` and the lifecycle/persona evidence writers.
 */
export function assertTrainingE2ERunFreshness({
  metadata,
  repoRoot,
  gitDir,
  computeDirtyTreeDigest = computeTrainingE2EDirtyTreeDigest,
  runCommand = execute,
  now = () => new Date(),
}) {
  assertTrainingE2ERunProvenance(metadata);

  const resolvedRepoRoot = path.resolve(String(repoRoot || ''));
  const resolvedGitDir = path.resolve(String(gitDir || ''));
  const currentCommit = String(runCommand('git', [
    `--git-dir=${resolvedGitDir}`,
    `--work-tree=${resolvedRepoRoot}`,
    'rev-parse',
    'HEAD',
  ])).trim();
  if (currentCommit !== metadata.git.commit) {
    throw new Error('Training E2E freshness failed: backend HEAD changed after startup');
  }

  const currentDirtyTreeDigest = computeDirtyTreeDigest({
    repoRoot: resolvedRepoRoot,
    gitDir: resolvedGitDir,
  });
  if (currentDirtyTreeDigest !== metadata.git.dirtyTreeDiffSha256) {
    throw new Error('Training E2E freshness failed: source dirty-tree digest changed after startup');
  }

  if (typeof metadata.composeProject !== 'string' || metadata.composeProject.trim().length === 0) {
    throw new Error('Training E2E freshness failed: compose project is missing');
  }
  assertImageFreshness({
    metadata,
    key: 'backend',
    service: 'nexus-hub',
    label: 'backend',
    runCommand,
  });
  assertImageFreshness({
    metadata,
    key: 'contentEngine',
    service: 'content-engine',
    label: 'content-engine',
    runCommand,
  });

  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || !Number.isFinite(verifiedAt.getTime())) {
    throw new Error('Training E2E freshness failed: verification time is invalid');
  }
  return {
    schemaVersion: 'training_e2e_backend_provenance.v1',
    environmentSchemaVersion: metadata.schemaVersion,
    verifiedAt: verifiedAt.toISOString(),
    git: structuredClone(metadata.git),
    images: structuredClone(metadata.images),
  };
}
