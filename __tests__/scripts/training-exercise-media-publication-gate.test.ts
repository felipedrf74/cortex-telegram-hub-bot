// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV,
  TRAINING_EXERCISE_MEDIA_PRODUCTION_VALIDATOR_SHA256,
  assertExternalTrainingExerciseMediaProductionGate,
  runTrainingExerciseMediaActivationGate,
} from '../../scripts/lib/training-exercise-media-publication-gate';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('Training exercise media external publication gate', () => {
  it('requires an operator-supplied absolute catalog root', () => {
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot: '' }))
      .toThrow(TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV);
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot: 'relative/catalog' }))
      .toThrow(/absolute path/);
  });

  it('requires the pinned validator file to exist', () => {
    const catalogRoot = makeDirectory('training-media-missing-validator-');
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot }))
      .toThrow(/production catalog validator is missing or unreadable/);
  });

  it('rejects a symlinked catalog root or validator', () => {
    const realRoot = makeDirectory('training-media-real-');
    const linkedRootParent = makeDirectory('training-media-root-link-');
    const linkedRoot = path.join(linkedRootParent, 'catalog');
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot: linkedRoot }))
      .toThrow(/non-symlink directory/);

    const catalogRoot = makeDirectory('training-media-validator-link-');
    const target = path.join(catalogRoot, 'validator-target.mjs');
    fs.writeFileSync(target, 'process.exit(0);\n', 'utf8');
    fs.symlinkSync(target, path.join(catalogRoot, 'validate-catalog.mjs'));
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot }))
      .toThrow(/regular non-symlink file/);
  });

  it('rejects validator byte drift against the production pin', () => {
    expect(TRAINING_EXERCISE_MEDIA_PRODUCTION_VALIDATOR_SHA256)
      .toBe('afec1234ecdc5603eb809995a89288e9be420bf757eda9e9fc475156f4e2399f');
    const { catalogRoot } = makeCatalog('process.exit(0);\n');
    expect(() => assertExternalTrainingExerciseMediaProductionGate({ catalogRoot }))
      .toThrow(new RegExp(TRAINING_EXERCISE_MEDIA_PRODUCTION_VALIDATOR_SHA256));
  });

  it('propagates a production-validator blocker and its evidence', () => {
    const { catalogRoot, validatorSha256 } = makeCatalog(`
      process.stdout.write(JSON.stringify({ verdict: 'FAIL', blockers: ['DOMAIN_APPROVAL_GATE'] }));
      process.exit(1);
    `);
    expect(() => assertExternalTrainingExerciseMediaProductionGate({
      catalogRoot,
      expectedValidatorSha256: validatorSha256,
    })).toThrow(/DOMAIN_APPROVAL_GATE/);
  });

  it('runs only production mode against the explicit backend root', () => {
    const { catalogRoot, validatorSha256 } = makeCatalog(`
      const args = process.argv.slice(2);
      const production = args.includes('--mode=production');
      const backend = args.find((value) => value.startsWith('--backend-root='));
      if (!production || !backend || backend === '--backend-root=') process.exit(12);
      process.stdout.write(JSON.stringify({ verdict: 'PASS', production, backend }));
    `);
    const result = assertExternalTrainingExerciseMediaProductionGate({
      catalogRoot,
      backendRoot: process.cwd(),
      expectedValidatorSha256: validatorSha256,
    });
    expect(result.stdout).toContain('"production":true');
    expect(result.stdout).toContain(`--backend-root=${fs.realpathSync(process.cwd())}`);
  });

  it('cannot reach internal activation checks when the external gate fails', () => {
    const order: string[] = [];
    expect(() => runTrainingExerciseMediaActivationGate(
      () => {
        order.push('internal');
      },
      () => {
        order.push('external');
        throw new Error('external blocker');
      },
    )).toThrow('external blocker');
    expect(order).toEqual(['external']);
  });

  it('propagates an internal activation failure after the external gate passes', () => {
    const order: string[] = [];
    expect(() => runTrainingExerciseMediaActivationGate(
      () => {
        order.push('internal');
        throw new Error('internal blocker');
      },
      () => {
        order.push('external');
      },
    )).toThrow('internal blocker');
    expect(order).toEqual(['external', 'internal']);
  });

  it('keeps the standard activation command fail-closed with no external root', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['training:exercise-media:verify:activation'])
      .toBe('npx tsx scripts/verify-training-exercise-media.ts --activation');

    const environment: NodeJS.ProcessEnv = { ...process.env };
    delete environment[TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV];
    const result = spawnSync(
      'npx',
      ['tsx', 'scripts/verify-training-exercise-media.ts', '--activation'],
      { cwd: process.cwd(), encoding: 'utf8', env: environment },
    );
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(TRAINING_EXERCISE_MEDIA_CATALOG_ROOT_ENV);
  });
});

function makeCatalog(validatorSource: string): { catalogRoot: string; validatorSha256: string } {
  const catalogRoot = makeDirectory('training-media-catalog-');
  const validatorPath = path.join(catalogRoot, 'validate-catalog.mjs');
  fs.writeFileSync(validatorPath, validatorSource, 'utf8');
  return {
    catalogRoot,
    validatorSha256: createHash('sha256').update(fs.readFileSync(validatorPath)).digest('hex'),
  };
}

function makeDirectory(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
