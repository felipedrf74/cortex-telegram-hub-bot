// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV =
  'TRAINING_EXERCISE_MEDIA_CATALOG_ROOT' as const;
export const TRAINING_EXERCISE_MEDIA_PRODUCTION_VALIDATOR_SHA256 =
  'afec1234ecdc5603eb809995a89288e9be420bf757eda9e9fc475156f4e2399f' as const;

interface ExternalCatalogGateOptions {
  catalogRoot?: string;
  backendRoot?: string;
  expectedValidatorSha256?: string;
  nodeExecutable?: string;
}

export interface ExternalCatalogGateResult {
  catalogRoot: string;
  validatorPath: string;
  validatorSha256: string;
  stdout: string;
}

/**
 * Runs the independent catalog's production validator before backend package
 * activation is considered. The CLI caller deliberately exposes no skip or
 * expected-hash override: tests may inject an expected hash only by calling
 * this helper directly with a temporary validator.
 */
export function assertExternalTrainingExerciseMediaProductionGate(
  options: ExternalCatalogGateOptions = {},
): ExternalCatalogGateResult {
  const configuredRoot = options.catalogRoot ?? process.env[TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV];
  if (!configuredRoot) {
    throw new Error(
      `${TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV} must name the absolute reviewed catalog root.`,
    );
  }
  if (!path.isAbsolute(configuredRoot)) {
    throw new Error(`${TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV} must be an absolute path.`);
  }

  const catalogRoot = requireNonSymlinkDirectory(configuredRoot, 'catalog root');
  const validatorPath = path.join(catalogRoot, 'validate-catalog.mjs');
  const validatorStats = lstatOrThrow(validatorPath, 'production catalog validator');
  if (validatorStats.isSymbolicLink() || !validatorStats.isFile()) {
    throw new Error('Production catalog validator must be a regular non-symlink file.');
  }
  const resolvedValidatorPath = fs.realpathSync(validatorPath);
  if (!isChild(catalogRoot, resolvedValidatorPath)) {
    throw new Error('Production catalog validator resolves outside the reviewed catalog root.');
  }

  const validatorBytes = fs.readFileSync(resolvedValidatorPath);
  const validatorSha256 = createHash('sha256').update(validatorBytes).digest('hex');
  const expectedValidatorSha256 = options.expectedValidatorSha256
    ?? TRAINING_EXERCISE_MEDIA_PRODUCTION_VALIDATOR_SHA256;
  if (validatorSha256 !== expectedValidatorSha256) {
    throw new Error(
      `Production catalog validator hash mismatch: expected ${expectedValidatorSha256}, received ${validatorSha256}.`,
    );
  }

  const backendRootValue = options.backendRoot ?? process.cwd();
  if (!path.isAbsolute(backendRootValue)) {
    throw new Error('Backend root must be an absolute path.');
  }
  const backendRoot = requireNonSymlinkDirectory(backendRootValue, 'backend root');
  const result = spawnSync(
    options.nodeExecutable ?? process.execPath,
    [resolvedValidatorPath, '--mode=production', `--backend-root=${backendRoot}`],
    {
      cwd: catalogRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) {
    throw new Error(`Production catalog validator could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const evidence = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    throw new Error(
      `Production catalog validator blocked activation (exit ${result.status ?? 'unknown'}).`
        + (evidence ? `\n${evidence}` : ''),
    );
  }

  return {
    catalogRoot,
    validatorPath: resolvedValidatorPath,
    validatorSha256,
    stdout: result.stdout ?? '',
  };
}

/** External verification always runs before the internal activation verifier. */
export function runTrainingExerciseMediaActivationGate<T>(
  internalVerification: () => T,
  externalVerification: () => void = () => {
    assertExternalTrainingExerciseMediaProductionGate();
  },
): T {
  externalVerification();
  return internalVerification();
}

function requireNonSymlinkDirectory(value: string, label: string): string {
  const stats = lstatOrThrow(value, label);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory.`);
  }
  return fs.realpathSync(value);
}

function lstatOrThrow(value: string, label: string): fs.Stats {
  try {
    return fs.lstatSync(value);
  } catch {
    throw new Error(`${label} is missing or unreadable.`);
  }
}

function isChild(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
