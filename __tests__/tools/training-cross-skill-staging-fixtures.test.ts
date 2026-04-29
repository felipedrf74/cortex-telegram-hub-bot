// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  assertStagingFixtureGate,
  parseFixtureMode,
  parseFixtureUserId,
} from '../../src/tools/training-cross-skill-staging-fixtures';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STAGING: 'true',
    TRAINING_CROSS_SKILL_STAGING_SMOKE: '1',
    TRAINING_CROSS_SKILL_STAGING_USER_ID: '42',
    TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE: '1',
    DATABASE_PATH: '/home/dominguez/telegram-hub-bot-staging/data/bot.db',
    ...overrides,
  };
}

describe('training cross-skill staging fixture guardrails', () => {
  it('parses fixture modes defensively', () => {
    expect(parseFixtureMode(['node', 'tool'])).toBe('seed');
    expect(parseFixtureMode(['node', 'tool', '--cleanup'])).toBe('cleanup');
    expect(parseFixtureMode(['node', 'tool', '--status'])).toBe('status');
  });

  it('requires a positive integer staging user id', () => {
    expect(parseFixtureUserId(env({ TRAINING_CROSS_SKILL_STAGING_USER_ID: '7' }))).toBe(7);
    expect(() => parseFixtureUserId(env({ TRAINING_CROSS_SKILL_STAGING_USER_ID: '0' }))).toThrow(
      'TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id> is required.',
    );
    expect(() => parseFixtureUserId(env({ TRAINING_CROSS_SKILL_STAGING_USER_ID: 'abc' }))).toThrow(
      'TRAINING_CROSS_SKILL_STAGING_USER_ID=<staging test user id> is required.',
    );
  });

  it('refuses production mode even when write flags are present', () => {
    expect(() => assertStagingFixtureGate('seed', env({
      NODE_ENV: 'production',
      STAGING: 'true',
    }))).toThrow('Refusing fixture writes outside staging mode.');
  });

  it('requires smoke mode and a staging-looking database path', () => {
    expect(() => assertStagingFixtureGate('seed', env({
      TRAINING_CROSS_SKILL_STAGING_SMOKE: '0',
    }))).toThrow('TRAINING_CROSS_SKILL_STAGING_SMOKE=1 is required.');

    expect(() => assertStagingFixtureGate('seed', env({
      DATABASE_PATH: '/home/dominguez/telegram-hub-bot/data/bot.db',
    }))).toThrow('DATABASE_PATH must look like a staging/test database.');
  });

  it('allows status checks without fixture write permission', () => {
    expect(() => assertStagingFixtureGate('status', env({
      TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE: undefined,
    }))).not.toThrow();
  });

  it('requires explicit fixture write permission for seed and cleanup', () => {
    const withoutWrite = env({ TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE: undefined });

    expect(() => assertStagingFixtureGate('seed', withoutWrite)).toThrow(
      'TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1 is required for seed/cleanup.',
    );
    expect(() => assertStagingFixtureGate('cleanup', withoutWrite)).toThrow(
      'TRAINING_CROSS_SKILL_STAGING_FIXTURE_WRITE=1 is required for seed/cleanup.',
    );
  });

  it('permits intentionally overridden non-staging clone paths only with an explicit override', () => {
    expect(() => assertStagingFixtureGate('seed', env({
      DATABASE_PATH: '/tmp/local-copy.db',
      TRAINING_CROSS_SKILL_ALLOW_NON_STAGING_DB: '1',
    }))).not.toThrow();
  });
});
