/**
 * Garmin Sync Health Monitoring Tests
 *
 * Tests the telemetry functions for Garmin sync health tracking:
 * - Activity fetch recording (success/failure/count)
 * - Rate limit status tracking
 * - Session status tracking
 * - Consecutive keepalive failure counting
 * - Health bar status derivation logic
 * - Portal HTML elements for Garmin monitoring
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  recordGarminRefresh,
  getGarminRefreshStatus,
  recordGarminActivityFetch,
  recordGarminRateLimit,
  recordGarminSessionStatus,
  getGarminSyncHealth,
  type GarminSyncHealth,
} from '../../src/portal/telemetry';

const ROOT = path.resolve(__dirname, '..', '..');

// ── Garmin Activity Fetch Tracking ──────────────────────────────────

describe('Garmin Sync Health — Activity Fetch Tracking', () => {
  beforeEach(() => {
    // Reset to known state
    recordGarminActivityFetch(0, true);
    recordGarminRateLimit(false);
    recordGarminSessionStatus(false);
  });

  it('records a successful activity fetch with count', () => {
    recordGarminActivityFetch(3, true);
    const health = getGarminSyncHealth();
    expect(health.lastActivityFetchOk).toBe(true);
    expect(health.lastActivityCount).toBe(3);
    expect(health.lastFetchError).toBeNull();
    expect(health.lastActivityFetchAt).toBeTruthy();
  });

  it('records a failed activity fetch with error message', () => {
    recordGarminActivityFetch(0, false, 'Garmin SSO rate-limited');
    const health = getGarminSyncHealth();
    expect(health.lastActivityFetchOk).toBe(false);
    expect(health.lastActivityCount).toBe(0);
    expect(health.lastFetchError).toBe('Garmin SSO rate-limited');
  });

  it('records zero activities as successful (genuinely no workout)', () => {
    recordGarminActivityFetch(0, true);
    const health = getGarminSyncHealth();
    expect(health.lastActivityFetchOk).toBe(true);
    expect(health.lastActivityCount).toBe(0);
    expect(health.lastFetchError).toBeNull();
  });

  it('uses default error message when none provided', () => {
    recordGarminActivityFetch(0, false);
    const health = getGarminSyncHealth();
    expect(health.lastFetchError).toBe('unknown error');
  });

  it('successful fetch sets session as alive', () => {
    recordGarminSessionStatus(false);
    recordGarminActivityFetch(1, true);
    const health = getGarminSyncHealth();
    expect(health.sessionAlive).toBe(true);
  });

  it('subsequent fetch overwrites previous state', () => {
    recordGarminActivityFetch(5, true);
    recordGarminActivityFetch(0, false, 'timeout');
    const health = getGarminSyncHealth();
    expect(health.lastActivityFetchOk).toBe(false);
    expect(health.lastActivityCount).toBe(0);
    expect(health.lastFetchError).toBe('timeout');
  });
});

// ── Rate Limit Tracking ─────────────────────────────────────────────

describe('Garmin Sync Health — Rate Limit Tracking', () => {
  beforeEach(() => {
    recordGarminRateLimit(false);
  });

  it('records rate-limited state with expiry', () => {
    const until = new Date(Date.now() + 7200000).toISOString();
    recordGarminRateLimit(true, until);
    const health = getGarminSyncHealth();
    expect(health.rateLimited).toBe(true);
    expect(health.rateLimitedUntil).toBe(until);
  });

  it('clears rate limit state', () => {
    recordGarminRateLimit(true, new Date().toISOString());
    recordGarminRateLimit(false);
    const health = getGarminSyncHealth();
    expect(health.rateLimited).toBe(false);
    expect(health.rateLimitedUntil).toBeNull();
  });

  it('rate-limited without explicit expiry stores null for until', () => {
    recordGarminRateLimit(true);
    const health = getGarminSyncHealth();
    expect(health.rateLimited).toBe(true);
    expect(health.rateLimitedUntil).toBeNull();
  });
});

// ── Session Status Tracking ─────────────────────────────────────────

describe('Garmin Sync Health — Session Status', () => {
  it('records session alive', () => {
    recordGarminSessionStatus(true);
    expect(getGarminSyncHealth().sessionAlive).toBe(true);
  });

  it('records session dead', () => {
    recordGarminSessionStatus(false);
    expect(getGarminSyncHealth().sessionAlive).toBe(false);
  });
});

// ── Consecutive Keepalive Failures ──────────────────────────────────

describe('Garmin Sync Health — Consecutive Keepalive Failures', () => {
  beforeEach(() => {
    // Reset failure count
    recordGarminRefresh(true);
  });

  it('starts at zero after a success', () => {
    expect(getGarminSyncHealth().consecutiveKeepaliveFailures).toBe(0);
  });

  it('increments on failure', () => {
    recordGarminRefresh(false);
    expect(getGarminSyncHealth().consecutiveKeepaliveFailures).toBe(1);
  });

  it('accumulates consecutive failures', () => {
    recordGarminRefresh(false);
    recordGarminRefresh(false);
    recordGarminRefresh(false);
    expect(getGarminSyncHealth().consecutiveKeepaliveFailures).toBe(3);
  });

  it('resets to zero on success', () => {
    recordGarminRefresh(false);
    recordGarminRefresh(false);
    recordGarminRefresh(true);
    expect(getGarminSyncHealth().consecutiveKeepaliveFailures).toBe(0);
  });

  it('single failure after recovery stays at 1', () => {
    recordGarminRefresh(false);
    recordGarminRefresh(false);
    recordGarminRefresh(true);
    recordGarminRefresh(false);
    expect(getGarminSyncHealth().consecutiveKeepaliveFailures).toBe(1);
  });
});

// ── Full Health Summary ─────────────────────────────────────────────

describe('Garmin Sync Health — Full Summary Shape', () => {
  it('returns all expected fields', () => {
    const health = getGarminSyncHealth();
    expect(health).toHaveProperty('lastActivityFetchAt');
    expect(health).toHaveProperty('lastActivityFetchOk');
    expect(health).toHaveProperty('lastActivityCount');
    expect(health).toHaveProperty('lastFetchError');
    expect(health).toHaveProperty('consecutiveKeepaliveFailures');
    expect(health).toHaveProperty('rateLimited');
    expect(health).toHaveProperty('rateLimitedUntil');
    expect(health).toHaveProperty('sessionAlive');
  });
});

// ── Portal HTML Garmin Elements ─────────────────────────────────────

describe('Portal HTML — Garmin Sync Monitoring Elements', () => {
  const portalHtml = fs.readFileSync(path.join(ROOT, 'src/portal/portal.html'), 'utf-8');

  it('has Garmin health bar indicator', () => {
    expect(portalHtml).toContain('id="hb-garmin"');
    expect(portalHtml).toContain('id="hb-garmin-dot"');
  });

  it('has Garmin label in health bar', () => {
    expect(portalHtml).toContain('Garmin:');
  });

  it('renders syncHealth details in integration health panel', () => {
    expect(portalHtml).toContain('i.syncHealth');
    expect(portalHtml).toContain('sh.rateLimited');
    expect(portalHtml).toContain('sh.consecutiveKeepaliveFailures');
    expect(portalHtml).toContain('sh.lastActivityFetchAt');
  });

  it('health bar shows rate limited state in red', () => {
    expect(portalHtml).toContain("'rate limited'");
    expect(portalHtml).toContain("dot-red");
  });

  it('health bar shows session dead state (3+ failures)', () => {
    expect(portalHtml).toContain("'session dead'");
    expect(portalHtml).toContain('consecutiveKeepaliveFailures >= 3');
  });

  it('health bar shows activity count when healthy', () => {
    expect(portalHtml).toContain("sh.lastActivityCount + ' activities'");
  });
});

// ── Health Bar Status Derivation Logic ──────────────────────────────

describe('Garmin Health Bar — Status Derivation Logic', () => {
  // Replicate the portal.html health bar logic for unit testing
  function deriveGarminStatus(syncHealth: GarminSyncHealth | null, configured: boolean): {
    label: string;
    color: 'green' | 'yellow' | 'red';
  } {
    if (!configured) return { label: 'not configured', color: 'yellow' };
    if (!syncHealth) return { label: 'no data', color: 'yellow' };
    const sh = syncHealth;
    if (sh.rateLimited) return { label: 'rate limited', color: 'red' };
    if (sh.consecutiveKeepaliveFailures >= 3) return { label: 'session dead', color: 'red' };
    if (!sh.sessionAlive && sh.consecutiveKeepaliveFailures > 0) return { label: 'degraded', color: 'yellow' };
    if (sh.lastActivityFetchOk) return { label: sh.lastActivityCount + ' activities', color: 'green' };
    if (sh.sessionAlive) return { label: 'session ok', color: 'green' };
    return { label: 'unknown', color: 'yellow' };
  }

  it('not configured → yellow', () => {
    expect(deriveGarminStatus(null, false)).toEqual({ label: 'not configured', color: 'yellow' });
  });

  it('no sync data yet → yellow', () => {
    expect(deriveGarminStatus(null, true)).toEqual({ label: 'no data', color: 'yellow' });
  });

  it('rate limited → red', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: null, lastActivityFetchOk: false, lastActivityCount: 0,
      lastFetchError: null, consecutiveKeepaliveFailures: 0, rateLimited: true,
      rateLimitedUntil: new Date().toISOString(), sessionAlive: false,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: 'rate limited', color: 'red' });
  });

  it('3+ consecutive keepalive failures → red (session dead)', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: null, lastActivityFetchOk: false, lastActivityCount: 0,
      lastFetchError: null, consecutiveKeepaliveFailures: 3, rateLimited: false,
      rateLimitedUntil: null, sessionAlive: false,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: 'session dead', color: 'red' });
  });

  it('1 keepalive failure with session not alive → yellow (degraded)', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: null, lastActivityFetchOk: false, lastActivityCount: 0,
      lastFetchError: null, consecutiveKeepaliveFailures: 1, rateLimited: false,
      rateLimitedUntil: null, sessionAlive: false,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: 'degraded', color: 'yellow' });
  });

  it('successful activity fetch → green with count', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: new Date().toISOString(), lastActivityFetchOk: true, lastActivityCount: 2,
      lastFetchError: null, consecutiveKeepaliveFailures: 0, rateLimited: false,
      rateLimitedUntil: null, sessionAlive: true,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: '2 activities', color: 'green' });
  });

  it('session alive but no recent activity fetch → green', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: null, lastActivityFetchOk: false, lastActivityCount: 0,
      lastFetchError: null, consecutiveKeepaliveFailures: 0, rateLimited: false,
      rateLimitedUntil: null, sessionAlive: true,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: 'session ok', color: 'green' });
  });

  it('no session, no failures, no fetch → yellow (unknown)', () => {
    const sh: GarminSyncHealth = {
      lastActivityFetchAt: null, lastActivityFetchOk: false, lastActivityCount: 0,
      lastFetchError: null, consecutiveKeepaliveFailures: 0, rateLimited: false,
      rateLimitedUntil: null, sessionAlive: false,
    };
    expect(deriveGarminStatus(sh, true)).toEqual({ label: 'unknown', color: 'yellow' });
  });
});
