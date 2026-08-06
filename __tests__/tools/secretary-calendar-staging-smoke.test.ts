// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

import { describe, expect, it } from 'vitest';
import { renderSecretaryCalendarStagingSmokeReportMarkdown } from '../../src/tools/secretary-calendar-staging-smoke';

describe('secretary calendar staging smoke report', () => {
  it('escapes an existing backslash before a Markdown table delimiter and preserves ordinary cells', () => {
    const markdown = renderSecretaryCalendarStagingSmokeReportMarkdown({
      runId: 'secretary-smoke-markdown-escape',
      startedAt: '2026-08-06T08:00:00.000Z',
      finishedAt: '2026-08-06T08:01:00.000Z',
      userId: 42,
      tenantId: 'tenant-42',
      providersRequested: ['google'],
      providersRun: ['google'],
      prerequisites: { ok: true, missing: [], warnings: [] },
      operations: [{
        provider: 'google',
        operation: 'create',
        expected: 'ordinary expectation',
        actual: String.raw`provider path \| forged cell`,
        status: 'pass',
        agendaItemIds: ['agenda-1'],
        providerEventIds: ['event-1'],
        cleanupStatus: 'cleaned',
      }],
      cleanupFailures: [{
        provider: 'google',
        agendaItemId: 'agenda-1',
        providerEventId: 'event-1',
        error: String.raw`cleanup path \| forged cell`,
      }],
    });

    expect(markdown).toContain(
      `| google | create | ordinary expectation | ${String.raw`provider path \\\| forged cell`} | pass |`,
    );
    expect(markdown).toContain(
      `| google | agenda-1 | event-1 | ${String.raw`cleanup path \\\| forged cell`} |`,
    );
    expect(markdown).toContain('ordinary expectation');
  });

  it('normalizes CR and CRLF from provider actual/error text without creating report rows', () => {
    const markdown = renderSecretaryCalendarStagingSmokeReportMarkdown({
      runId: 'secretary-smoke-line-break-escape',
      startedAt: '2026-08-06T08:00:00.000Z',
      finishedAt: '2026-08-06T08:01:00.000Z',
      userId: 42,
      tenantId: 'tenant-42',
      providersRequested: ['google'],
      providersRun: ['google'],
      prerequisites: { ok: true, missing: [], warnings: [] },
      operations: [{
        provider: 'google',
        operation: 'create',
        expected: 'ordinary expectation',
        actual: 'actual before\rafter',
        status: 'pass',
        agendaItemIds: [],
        providerEventIds: [],
        cleanupStatus: 'cleaned',
      }],
      cleanupFailures: [{
        provider: 'google',
        error: 'error before\r\nafter',
      }],
    });

    expect(markdown).toContain('| google | create | ordinary expectation | actual before<br>after | pass |');
    expect(markdown).toContain('| google | n/a | n/a | error before<br>after |');
    expect(markdown).not.toContain('\r');
  });
});
