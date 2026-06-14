// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateTrainingFullFlowSmokePrerequisites,
  parseSmokeNow,
  validateSmokeNow,
} from '../../src/tools/training-full-flow-staging-smoke';

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    STAGING: 'true',
    TRAINING_FULL_FLOW_STAGING_SMOKE: '1',
    TRAINING_FULL_FLOW_STAGING_ALLOW_LIVE_WRITES: '1',
    TRAINING_FULL_FLOW_STAGING_USER_IS_DEDICATED: '1',
    TRAINING_FULL_FLOW_STAGING_USER_ID: '42',
    OAUTH_ENCRYPTION_KEY: 'test-oauth-key',
    DATABASE_PATH: '/tmp/nexus-staging.db',
    GOOGLE_CLIENT_ID: 'google-client',
    GOOGLE_CLIENT_SECRET: 'google-secret',
    OUTLOOK_CLIENT_ID: 'outlook-client',
    OUTLOOK_CLIENT_SECRET: 'outlook-secret',
    ...overrides,
  };
}

describe('training full-flow staging smoke harness', () => {
  it('uses an explicit frozen planner clock when provided', () => {
    const fallback = new Date('2026-06-14T08:00:00.000Z');

    expect(parseSmokeNow('2026-06-15T08:00:00+01:00', fallback).toISOString()).toBe('2026-06-15T07:00:00.000Z');
    expect(parseSmokeNow(undefined, fallback).toISOString()).toBe('2026-06-14T08:00:00.000Z');
  });

  it('blocks invalid frozen planner clocks at prerequisite time', () => {
    expect(validateSmokeNow('not-a-date')).toBe('TRAINING_FULL_FLOW_STAGING_NOW must be an ISO-8601 date/time');

    const report = evaluateTrainingFullFlowSmokePrerequisites(env({
      TRAINING_FULL_FLOW_STAGING_NOW: 'not-a-date',
    }), 'outlook');

    expect(report.ok).toBe(false);
    expect(report.missing).toContain('TRAINING_FULL_FLOW_STAGING_NOW must be an ISO-8601 date/time');
  });
});
