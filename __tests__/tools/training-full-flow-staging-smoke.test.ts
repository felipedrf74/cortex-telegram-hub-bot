// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import {
  evaluateTrainingFullFlowSmokePrerequisites,
  parseSmokeNow,
  renderTrainingFullFlowSmokeReportMarkdown,
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

function countGfmTableDelimiters(row: string): number {
  return [...row].reduce((count, character, index) => (
    character === '|' && row[index - 1] !== '\\' ? count + 1 : count
  ), 0);
}

function renderGfmTableCodeSpanSource(source: string): string {
  const openingFence = source.match(/^(`+)/)?.[1];
  const closingFence = source.match(/(`+)$/)?.[1];
  expect(openingFence).toBeTruthy();
  expect(closingFence).toBe(openingFence);
  // GFM table parsing consumes the backslash that protects a pipe even
  // inside a code span (GFM spec example 200); code-span parsing then keeps
  // every remaining backslash literally.
  let content = source
    .slice(openingFence!.length, -closingFence!.length)
    .replace(/\\\|/g, '|')
    .replace(/\r\n?|\n/g, ' ');
  if (content.startsWith(' ') && content.endsWith(' ') && /[^ ]/.test(content)) {
    content = content.slice(1, -1);
  }
  return content;
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

  it('escapes an existing backslash before a Markdown table delimiter and preserves ordinary cells', () => {
    const evidenceWithBackslashPipe = String.raw`evidence path \| forged cell`;
    const evidenceWithBacktickEdges = '`edge\\|tail`';
    const markdown = renderTrainingFullFlowSmokeReportMarkdown({
      runId: 'training-full-flow-markdown-escape',
      startedAt: '2026-08-06T08:00:00.000Z',
      finishedAt: '2026-08-06T08:01:00.000Z',
      plannerNow: '2026-08-06T08:00:00.000Z',
      userId: 42,
      tenantId: 42,
      userEmail: null,
      scenario: 'hybrid_event',
      provider: 'google',
      dryRun: false,
      prerequisites: { ok: true, missing: [], warnings: [] },
      operations: [{
        operation: 'create',
        expected: 'ordinary expectation',
        actual: String.raw`provider path \| forged cell`,
        status: 'pass',
        evidence: [evidenceWithBackslashPipe, evidenceWithBacktickEdges, 'ordinary evidence'],
      }],
      cleanupFailures: [],
    });

    const operationRow = markdown.split('\n').find((line) => line.startsWith('| create |'))!;
    expect(countGfmTableDelimiters(operationRow)).toBe(6);
    expect(operationRow).toContain(
      `| create | ordinary expectation | ${String.raw`provider path \\\| forged cell`} | pass |`,
    );
    const evidenceSource = operationRow.match(/\| pass \| (.*) \|$/)?.[1];
    expect(evidenceSource?.split('<br>').map(renderGfmTableCodeSpanSource)).toEqual([
      evidenceWithBackslashPipe,
      evidenceWithBacktickEdges,
      'ordinary evidence',
    ]);
  });

  it('normalizes CR and CRLF from operation actual and cleanup error text', () => {
    const markdown = renderTrainingFullFlowSmokeReportMarkdown({
      runId: 'training-full-flow-line-break-escape',
      startedAt: '2026-08-06T08:00:00.000Z',
      finishedAt: '2026-08-06T08:01:00.000Z',
      plannerNow: '2026-08-06T08:00:00.000Z',
      userId: 42,
      tenantId: 42,
      userEmail: null,
      scenario: 'hybrid_event',
      provider: 'google',
      dryRun: false,
      prerequisites: { ok: true, missing: [], warnings: [] },
      operations: [{
        operation: 'create',
        expected: 'ordinary expectation',
        actual: 'actual before\r\nafter',
        status: 'pass',
        evidence: [],
      }],
      cleanupFailures: ['error before\rafter'],
    });

    expect(markdown).toContain('| create | ordinary expectation | actual before<br>after | pass |');
    expect(markdown).toContain('- error before<br>after');
    expect(markdown).not.toContain('\r');
  });
});
