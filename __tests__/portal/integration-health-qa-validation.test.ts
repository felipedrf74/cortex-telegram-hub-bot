/**
 * QA Validation Tests — Portal Integration Health Checks (OAuth Token Status)
 *
 * Validates the integration health panel added by the devops agent:
 * - inferTokenHealth logic (replicated from server.ts since it's nested)
 * - SnapshotResponse integration shape
 * - Portal HTML rendering elements
 * - Edge cases: stale tokens, never-ran jobs, recently expired
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

// ── Replicate inferTokenHealth logic for unit-level validation ──────
// This mirrors the function inside buildSnapshot() in src/portal/server.ts
function inferTokenHealth(
  configured: boolean,
  lastSuccess: string | null,
  lastFailure: string | null,
  nowMs: number = Date.now(),
): 'valid' | 'expired' | 'warning' | 'not_configured' {
  if (!configured) return 'not_configured';
  if (!lastSuccess && !lastFailure) return 'valid';
  const successTs = lastSuccess ? new Date(lastSuccess).getTime() : 0;
  const failureTs = lastFailure ? new Date(lastFailure).getTime() : 0;
  if (failureTs > successTs) {
    const hoursSinceFailure = (nowMs - failureTs) / 3_600_000;
    return hoursSinceFailure < 24 ? 'expired' : 'warning';
  }
  const hoursSinceSuccess = (nowMs - successTs) / 3_600_000;
  if (hoursSinceSuccess > 48) return 'warning';
  return 'valid';
}

// ── Helper: ISO timestamps relative to "now" ────────────────────────
function hoursAgo(hours: number, fromMs: number = Date.now()): string {
  return new Date(fromMs - hours * 3_600_000).toISOString();
}

describe('Integration Health — inferTokenHealth logic', () => {
  const NOW = Date.now();

  it('returns not_configured when integration is not configured', () => {
    expect(inferTokenHealth(false, null, null, NOW)).toBe('not_configured');
  });

  it('returns not_configured even if there are job timestamps (impossible but safe)', () => {
    expect(inferTokenHealth(false, hoursAgo(1, NOW), null, NOW)).toBe('not_configured');
  });

  it('returns valid when configured but no jobs have run yet', () => {
    expect(inferTokenHealth(true, null, null, NOW)).toBe('valid');
  });

  it('returns valid when last success is recent (< 48h) and no failures', () => {
    expect(inferTokenHealth(true, hoursAgo(2, NOW), null, NOW)).toBe('valid');
  });

  it('returns valid when last success is recent and failure is older', () => {
    expect(inferTokenHealth(true, hoursAgo(1, NOW), hoursAgo(10, NOW), NOW)).toBe('valid');
  });

  it('returns expired when failure is more recent than success and < 24h ago', () => {
    expect(inferTokenHealth(true, hoursAgo(10, NOW), hoursAgo(1, NOW), NOW)).toBe('expired');
  });

  it('returns warning when failure is more recent than success but > 24h ago', () => {
    expect(inferTokenHealth(true, hoursAgo(72, NOW), hoursAgo(30, NOW), NOW)).toBe('warning');
  });

  it('returns warning when last success is stale (> 48h)', () => {
    expect(inferTokenHealth(true, hoursAgo(50, NOW), null, NOW)).toBe('warning');
  });

  it('returns valid at exactly 48h boundary (not stale yet)', () => {
    // 47.9 hours should still be valid
    expect(inferTokenHealth(true, hoursAgo(47.9, NOW), null, NOW)).toBe('valid');
  });

  it('returns expired at exactly 23.9h after failure (still < 24h)', () => {
    expect(inferTokenHealth(true, hoursAgo(48, NOW), hoursAgo(23.9, NOW), NOW)).toBe('expired');
  });

  it('returns warning at exactly 24.1h after failure (just past threshold)', () => {
    expect(inferTokenHealth(true, hoursAgo(48, NOW), hoursAgo(24.1, NOW), NOW)).toBe('warning');
  });
});

describe('Integration Health — SnapshotResponse shape', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('SnapshotResponse interface includes tokenHealth field', () => {
    expect(serverTs).toContain("tokenHealth?: 'valid' | 'expired' | 'warning' | 'not_configured'");
  });

  it('SnapshotResponse interface includes lastApiCall field', () => {
    expect(serverTs).toContain('lastApiCall?: string | null');
  });

  it('SnapshotResponse interface includes group field', () => {
    expect(serverTs).toContain('group?: string');
  });

  it('snapshot builds Google Calendar integration with google group', () => {
    expect(serverTs).toContain("name: 'Google Calendar'");
    expect(serverTs).toContain("group: 'google'");
  });

  it('snapshot builds Google Drive integration', () => {
    expect(serverTs).toContain("name: 'Google Drive'");
  });

  it('snapshot builds Gmail integration', () => {
    expect(serverTs).toContain("name: 'Gmail'");
  });

  it('snapshot builds Outlook Calendar integration with microsoft group', () => {
    expect(serverTs).toContain("name: 'Outlook Calendar'");
    expect(serverTs).toContain("group: 'microsoft'");
  });

  it('snapshot builds Outlook Mail integration', () => {
    expect(serverTs).toContain("name: 'Outlook Mail'");
  });

  it('snapshot builds Microsoft To Do integration', () => {
    expect(serverTs).toContain("name: 'Microsoft To Do'");
  });

  it('snapshot builds Garmin Connect integration with garmin group', () => {
    expect(serverTs).toContain("name: 'Garmin Connect'");
    expect(serverTs).toContain("group: 'garmin'");
  });

  it('all integrations call inferTokenHealth', () => {
    // Count occurrences: should be at least 7 (3 Google + 3 MS + 1 Garmin)
    const matches = serverTs.match(/inferTokenHealth\(/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });
});

describe('Integration Health — SQL statements', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('defines lastSuccessForJob prepared statement', () => {
    expect(serverTs).toContain('lastSuccessForJob');
    expect(serverTs).toContain("result = 'success'");
  });

  it('defines lastFailureForJob prepared statement', () => {
    expect(serverTs).toContain('lastFailureForJob');
    expect(serverTs).toContain("result = 'failed'");
  });

  it('queries use parameterized job_name (not string interpolation)', () => {
    // The SQL should use ? placeholder, not template literals
    expect(serverTs).toContain('WHERE job_name = ?');
  });
});

describe('Integration Health — Portal HTML', () => {
  const html = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'portal.html'),
    'utf-8',
  );

  it('has integration-health container div', () => {
    expect(html).toContain('id="integration-health"');
  });

  it('has CSS classes for health status badges', () => {
    expect(html).toContain('.int-health.valid');
    expect(html).toContain('.int-health.expired');
    expect(html).toContain('.int-health.warning');
    expect(html).toContain('.int-health.not_configured');
  });

  it('has alert pulse animation for expired tokens', () => {
    expect(html).toContain('.int-alert.expired');
    expect(html).toContain('pulse-alert');
  });

  it('has alert indicator for warning tokens', () => {
    expect(html).toContain('.int-alert.warning');
  });

  it('defines group labels for Google, Microsoft, Garmin, System', () => {
    expect(html).toContain('Google (OAuth 2.0)');
    expect(html).toContain('Microsoft (MSAL)');
    expect(html).toContain('Garmin (Session)');
    expect(html).toContain('System');
  });

  it('defines health labels for all states', () => {
    expect(html).toContain('✓ Valid');
    expect(html).toContain('✗ Expired');
    expect(html).toContain('⚠ Stale');
    expect(html).toContain('— Not configured');
  });

  it('renderIntegrationHealth function exists in script', () => {
    expect(html).toContain('function renderIntegrationHealth');
  });

  it('renders last API call timestamp', () => {
    expect(html).toContain('Last successful API call');
    expect(html).toContain('lastApiCall');
  });

  it('card title is Integration Health', () => {
    expect(html).toContain('🔗 Integration Health');
  });
});

describe('Integration Health — imports and wiring', () => {
  const serverTs = fs.readFileSync(
    path.join(ROOT, 'src', 'portal', 'server.ts'),
    'utf-8',
  );

  it('imports isGoogleCalendarConfigured', () => {
    expect(serverTs).toContain("import { isGoogleCalendarConfigured } from '../services/google-calendar'");
  });

  it('imports isGmailConfigured', () => {
    expect(serverTs).toContain("import { isGmailConfigured } from '../services/google-gmail'");
  });

  it('imports isGoogleDriveEnabled', () => {
    expect(serverTs).toContain("import { isGoogleDriveEnabled } from '../services/google-drive'");
  });

  it('imports isOutlookCalendarConfigured', () => {
    expect(serverTs).toContain("import { isOutlookCalendarConfigured } from '../services/outlook-calendar'");
  });

  it('imports isOutlookMailConfigured', () => {
    expect(serverTs).toContain("import { isOutlookMailConfigured } from '../services/outlook-mail'");
  });

  it('imports isOutlookTodoConfigured', () => {
    expect(serverTs).toContain("import { isOutlookTodoConfigured } from '../services/microsoft-todo'");
  });

  it('uses daily_briefing job for Google token health proxy', () => {
    expect(serverTs).toContain("lastJobSuccess('daily_briefing')");
  });

  it('uses conflict_detection job for Microsoft token health proxy', () => {
    expect(serverTs).toContain("lastJobSuccess('conflict_detection')");
  });

  it('uses garmin_keepalive job for Garmin token health proxy', () => {
    expect(serverTs).toContain("lastJobSuccess('garmin_keepalive')");
  });
});
