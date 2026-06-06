// Copyright (c) 2025 Felipe Dominguez. MIT License. See LICENSE.

/**
 * Regression guard for the M2 workstream: ensure the `secretary_agenda_sync`
 * cron is registered exactly once with the correct cadence and category, and
 * that the cron body wraps the canonical `syncSecretaryAgendaItemsToProvider`
 * primitive (not a re-implementation).
 *
 * Plan reference: `/Users/felipedominguez/.claude/plans/graceful-stirring-scone.md`
 * Wave 1 workstream M2.
 */

import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const SCHEDULER_PATH = path.resolve(__dirname, '../../src/services/scheduler.ts');

describe('M2: secretary_agenda_sync cron registration', () => {
  const schedulerSource = fs.readFileSync(SCHEDULER_PATH, 'utf8');

  it('registers the job exactly once with the secretary category', () => {
    const registrations = schedulerSource.match(
      /registerJob\(\s*'secretary_agenda_sync'/g,
    );
    expect(registrations).not.toBeNull();
    expect(registrations!.length).toBe(1);
    // Asserts the cadence + category match the plan
    expect(schedulerSource).toContain(
      "registerJob('secretary_agenda_sync', 'Secretary Agenda → Calendar Sync', '*/5 * * * *', 'secretary')",
    );
  });

  it('wraps the canonical syncSecretaryAgendaItemsToProvider primitive', () => {
    // The cron body must call the existing primitive, not re-implement it.
    expect(schedulerSource).toContain("require('./secretary-agenda-provider-sync')");
    expect(schedulerSource).toContain('syncSecretaryAgendaItemsToProvider');
    // Adapter must come from the unified-calendar adapter helper.
    expect(schedulerSource).toContain('createUnifiedCalendarSecretaryProviderAdapter');
  });

  it('iterates active users and fans out per (user, source) with bounded concurrency', () => {
    const bodyMatch = schedulerSource.match(
      /wrapJob\('secretary_agenda_sync',\s*async[\s\S]*?\}\),\s*\{\s*timezone: tz\s*\}\)/,
    );
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch![0];
    expect(body).toContain('getActiveUserIds()');
    expect(body).toContain('isGoogleCalendarConfigured(userId)');
    expect(body).toContain('isOutlookCalendarConfigured(userId)');
    // Concurrency bound prevents simultaneous-user storms on Outlook quotas
    expect(body).toMatch(/CONCURRENCY\s*=\s*\d+/);
    // Per-user item cap bounds Outlook rate-limit exposure
    expect(body).toMatch(/PER_USER_CAP\s*=\s*\d+/);
  });

  it('isolates per-user failures so one bad user does not break the whole batch', () => {
    const bodyMatch = schedulerSource.match(
      /wrapJob\('secretary_agenda_sync',\s*async[\s\S]*?\}\),\s*\{\s*timezone: tz\s*\}\)/,
    );
    expect(bodyMatch).not.toBeNull();
    const body = bodyMatch![0];
    expect(body).toContain('Promise.allSettled');
    // Inner try/catch keeps a single user/source failure from spilling out
    expect(body).toContain('per-user/source failure');
  });

  it('passes the secretary tz to cron.schedule (DST-safe)', () => {
    const cronMatch = schedulerSource.match(
      /cron\.schedule\('\*\/5 \* \* \* \*',\s*wrapJob\('secretary_agenda_sync'[\s\S]*?\{\s*timezone: tz\s*\}/,
    );
    expect(cronMatch).not.toBeNull();
  });
});
