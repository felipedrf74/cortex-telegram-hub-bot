// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertTrainingExerciseMediaSeedFilesystemBoundary,
  assertTrainingExerciseMediaProductionDatabasePrecondition,
  authorizeTrainingExerciseMediaSeed,
  productionSeedAcknowledgement,
  type TrainingExerciseMediaSeedReleaseSubject,
} from '../../scripts/lib/training-exercise-media-seed-authorization';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const subject: TrainingExerciseMediaSeedReleaseSubject = {
  manifestId: 'training-exercise-media-v1-reviewed',
  packageHash: '1'.repeat(64),
  releaseSubjectHash: '2'.repeat(64),
  finalOwnerApprovalHash: '3'.repeat(64),
};

function productionEnv(action: 'stage' | 'activate'): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    TRAINING_EXERCISE_MEDIA_V1_ENABLED: 'false',
    TRAINING_EXERCISE_MEDIA_PRODUCTION_MANIFEST_ID: subject.manifestId,
    TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH: subject.packageHash,
    TRAINING_EXERCISE_MEDIA_PRODUCTION_RELEASE_SUBJECT_HASH: subject.releaseSubjectHash,
    TRAINING_EXERCISE_MEDIA_PRODUCTION_FINAL_APPROVAL_HASH: subject.finalOwnerApprovalHash,
    [action === 'stage'
      ? 'TRAINING_EXERCISE_MEDIA_PRODUCTION_STAGE_ACK'
      : 'TRAINING_EXERCISE_MEDIA_PRODUCTION_ACTIVATE_ACK']:
      productionSeedAcknowledgement(action, subject),
  };
}

describe('training exercise media seed authorization', () => {
  it('ships a compiled runtime command without a production npx dependency', () => {
    const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['training:exercise-media:seed:runtime'])
      .toBe('node dist/tools/training-exercise-media-seed.js');
  });

  it('keeps the existing staging-only acknowledgement separate', () => {
    expect(authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'staging',
      legacyActivate: true,
      env: {
        NEXUS_STAGING: '1',
        TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK: 'staging-only-reviewed-manifest',
      },
      subject,
    })).toEqual({ target: 'staging', action: 'stage-and-activate' });
  });

  it('authorizes exact production stage and activate subjects independently', () => {
    for (const action of ['stage', 'activate'] as const) {
      expect(authorizeTrainingExerciseMediaSeed({
        apply: true,
        requestedTarget: 'production',
        requestedAction: action,
        legacyActivate: false,
        env: productionEnv(action),
        subject,
      })).toEqual({ target: 'production', action });
    }
  });

  it.each([
    ['missing package hash', 'TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH', undefined],
    ['wrong package hash', 'TRAINING_EXERCISE_MEDIA_PRODUCTION_PACKAGE_HASH', '4'.repeat(64)],
    ['truncated release hash', 'TRAINING_EXERCISE_MEDIA_PRODUCTION_RELEASE_SUBJECT_HASH', '2'.repeat(63)],
    ['wrong final approval hash', 'TRAINING_EXERCISE_MEDIA_PRODUCTION_FINAL_APPROVAL_HASH', '4'.repeat(64)],
    ['missing acknowledgement', 'TRAINING_EXERCISE_MEDIA_PRODUCTION_STAGE_ACK', undefined],
  ])('rejects %s', (_label, key, value) => {
    const env = productionEnv('stage');
    if (value == null) delete env[key];
    else env[key] = value;
    expect(() => authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'production',
      requestedAction: 'stage',
      legacyActivate: false,
      env,
      subject,
    })).toThrow();
  });

  it('rejects staging credentials in production and production credentials in staging', () => {
    expect(() => authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'production',
      requestedAction: 'stage',
      legacyActivate: false,
      env: {
        NODE_ENV: 'production',
        TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK: 'staging-only-reviewed-manifest',
      },
      subject,
    })).toThrow();
    expect(() => authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'staging',
      requestedAction: 'stage',
      legacyActivate: false,
      env: productionEnv('stage'),
      subject,
    })).toThrow();
  });

  it('rejects a global flag flip and legacy combined production activation', () => {
    expect(() => authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'production',
      requestedAction: 'stage',
      legacyActivate: false,
      env: { ...productionEnv('stage'), TRAINING_EXERCISE_MEDIA_V1_ENABLED: 'true' },
      subject,
    })).toThrow(/globally off/);
    expect(() => authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'production',
      requestedAction: undefined,
      legacyActivate: true,
      env: productionEnv('activate'),
      subject,
    })).toThrow(/combined/);
  });
});

describe('training exercise media seed filesystem boundary', () => {
  function deployment(name: 'telegram-hub-bot' | 'telegram-hub-bot-staging') {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'training-media-seed-'));
    temporaryRoots.push(parent);
    const root = path.join(parent, name);
    const data = path.join(root, 'data');
    fs.mkdirSync(data, { recursive: true });
    const databasePath = path.join(data, 'bot.db');
    fs.writeFileSync(databasePath, 'sqlite-fixture');
    return { root, databasePath };
  }

  it('binds staging and production targets to distinct deployed data roots', () => {
    const staging = deployment('telegram-hub-bot-staging');
    const production = deployment('telegram-hub-bot');
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: staging.root,
      databasePath: staging.databasePath,
    })).not.toThrow();
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'production',
      workingDirectory: production.root,
      databasePath: production.databasePath,
    })).not.toThrow();
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'production',
      workingDirectory: production.root,
      databasePath: './data/bot.db',
    })).not.toThrow();
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: production.root,
      databasePath: production.databasePath,
    })).toThrow(/checkout identity/);
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: staging.root,
      databasePath: production.databasePath,
    })).toThrow(/escapes/);
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: staging.root,
      databasePath: path.relative(staging.root, production.databasePath),
    })).toThrow(/escapes/);
  });

  it('cannot use staging credentials against the production checkout or database', () => {
    const production = deployment('telegram-hub-bot');
    const authorization = authorizeTrainingExerciseMediaSeed({
      apply: true,
      requestedTarget: 'staging',
      legacyActivate: true,
      env: {
        NODE_ENV: 'production',
        NEXUS_STAGING: '1',
        DATABASE_PATH: production.databasePath,
        TRAINING_EXERCISE_MEDIA_SEED_APPLY_ACK: 'staging-only-reviewed-manifest',
      },
      subject,
    });
    expect(authorization).toEqual({ target: 'staging', action: 'stage-and-activate' });
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: authorization!.target,
      workingDirectory: production.root,
      databasePath: production.databasePath,
    })).toThrow(/checkout identity/);
  });

  it('rejects symlinked database targets before opening SQLite', () => {
    const staging = deployment('telegram-hub-bot-staging');
    const linked = path.join(staging.root, 'data', 'linked.db');
    fs.symlinkSync(staging.databasePath, linked);
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: staging.root,
      databasePath: linked,
    })).toThrow(/single-link, non-symlink regular file/);
  });

  it('rejects a staging hard link that aliases another database inode', () => {
    const staging = deployment('telegram-hub-bot-staging');
    const production = deployment('telegram-hub-bot');
    const linked = path.join(staging.root, 'data', 'production-alias.db');
    fs.linkSync(production.databasePath, linked);
    expect(() => assertTrainingExerciseMediaSeedFilesystemBoundary({
      target: 'staging',
      workingDirectory: staging.root,
      databasePath: linked,
    })).toThrow(/single-link/);
  });
});

describe('training exercise media production database precondition', () => {
  function database(): Database.Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE training_exercise_media_manifests (
        manifest_id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        package_hash TEXT NOT NULL,
        publication_state TEXT NOT NULL
      );
    `);
    return db;
  }

  it('requires a separate exact STAGED readback before activation', () => {
    const db = database();
    expect(() => assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, subject, 'activate',
    )).toThrow(/prior command/);
    db.prepare(`
      INSERT INTO training_exercise_media_manifests
        (manifest_id, scope_key, package_hash, publication_state)
      VALUES (?, '__global__', ?, 'STAGED')
    `).run(subject.manifestId, subject.packageHash);
    expect(() => assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, subject, 'activate',
    )).not.toThrow();
    db.close();
  });

  it('refuses to rotate a different active manifest', () => {
    const db = database();
    db.prepare(`
      INSERT INTO training_exercise_media_manifests
        (manifest_id, scope_key, package_hash, publication_state)
      VALUES ('other', '__global__', ?, 'ACTIVE')
    `).run('4'.repeat(64));
    expect(() => assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, subject, 'stage',
    )).toThrow(/refuses rotation/);
    db.close();
  });

  it.each(['DEPRECATED', 'REVOKED'])('never reports an exact %s package as staged', (state) => {
    const db = database();
    db.prepare(`
      INSERT INTO training_exercise_media_manifests
        (manifest_id, scope_key, package_hash, publication_state)
      VALUES (?, '__global__', ?, ?)
    `).run(subject.manifestId, subject.packageHash, state);
    expect(() => assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, subject, 'stage',
    )).toThrow(/absent, DRAFT, or STAGED/);
    expect(() => assertTrainingExerciseMediaProductionDatabasePrecondition(
      db, subject, 'activate',
    )).toThrow(/prior command/);
    db.close();
  });
});
