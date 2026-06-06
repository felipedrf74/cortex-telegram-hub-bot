// Phase 7 batch 37 (2026-05-15): cross-tenant alerting hook tests.

import { describe, expect, it } from 'vitest';
import {
  dispatchCrossTenantAlerts,
  formatAlertPayload,
  RecordingAlertChannel,
  type AlertChannel,
} from '../../src/services/registry-cross-tenant-alert-hook';
import type {
  CrossTenantAdversarialPattern,
  CrossTenantSeverity,
} from '../../src/services/registry-adversarial-discovery';

function buildPattern(
  severity: CrossTenantSeverity,
  overrides: Partial<CrossTenantAdversarialPattern> = {},
): CrossTenantAdversarialPattern {
  return {
    skill: 'mail',
    action: 'send_email',
    failureReason: 'prompt_injection_marker_detected',
    outcome: null,
    totalCount: 10,
    tenantCount: 5,
    firstSeen: '2026-05-15T00:00:00Z',
    lastSeen: '2026-05-15T12:00:00Z',
    windowDays: 0.5,
    perTenantCounts: { '1': 2, '2': 2, '3': 2, '4': 2, '5': 2 },
    severity,
    ...overrides,
  };
}

describe('cross-tenant alerting hook (Phase 7 batch 37)', () => {
  it('dispatches critical alerts to a channel with minSeverity=medium', async () => {
    const channel = new RecordingAlertChannel('test', 'medium');
    const result = await dispatchCrossTenantAlerts(
      [buildPattern('critical')],
      [channel],
    );
    expect(result.alertsSent).toBe(1);
    expect(channel.received).toHaveLength(1);
    expect(channel.received[0].severity).toBe('critical');
  });

  it('skips patterns below the channel\'s minSeverity', async () => {
    const channel = new RecordingAlertChannel('test', 'high');
    const result = await dispatchCrossTenantAlerts(
      [buildPattern('medium')],
      [channel],
    );
    expect(result.alertsSent).toBe(0);
    expect(result.alertsSkipped).toBe(1);
    expect(channel.received).toHaveLength(0);
  });

  it('dispatches to multiple channels with different thresholds', async () => {
    const lowThreshold = new RecordingAlertChannel('low', 'medium');
    const highThreshold = new RecordingAlertChannel('high', 'critical');
    const patterns = [
      buildPattern('critical'),
      buildPattern('high'),
      buildPattern('medium'),
    ];
    const result = await dispatchCrossTenantAlerts(patterns, [lowThreshold, highThreshold]);
    expect(lowThreshold.received).toHaveLength(3);
    expect(highThreshold.received).toHaveLength(1);
    expect(result.perChannel.low.sent).toBe(3);
    expect(result.perChannel.high.sent).toBe(1);
  });

  it('respects shadowMode (no actual sends)', async () => {
    const channel = new RecordingAlertChannel('test', 'medium');
    const result = await dispatchCrossTenantAlerts(
      [buildPattern('critical')],
      [channel],
      { shadowMode: true },
    );
    expect(result.alertsSent).toBe(0);
    expect(result.alertsSkipped).toBe(1);
    expect(channel.received).toHaveLength(0);
  });

  it('records errors per channel without short-circuiting other channels', async () => {
    const throwingChannel: AlertChannel = {
      id: 'broken',
      minSeverity: 'medium',
      send: () => {
        throw new Error('channel offline');
      },
    };
    const goodChannel = new RecordingAlertChannel('good', 'medium');
    const result = await dispatchCrossTenantAlerts(
      [buildPattern('critical')],
      [throwingChannel, goodChannel],
    );
    expect(result.alertsSent).toBe(1);
    expect(result.perChannel.broken.errors).toHaveLength(1);
    expect(result.perChannel.broken.errors[0]).toMatch(/channel offline/);
    expect(goodChannel.received).toHaveLength(1);
  });

  it('formatAlertPayload constructs a stable shape with severity, title, description', () => {
    const pattern = buildPattern('critical');
    const payload = formatAlertPayload(pattern, '2026-05-15T13:00:00Z');
    expect(payload.severity).toBe('critical');
    expect(payload.title).toMatch(/CRITICAL/);
    expect(payload.title).toMatch(/mail.send_email/);
    expect(payload.description).toMatch(/prompt_injection_marker_detected/);
    expect(payload.description).toMatch(/5 \(10 total/);
    expect(payload.generatedAt).toBe('2026-05-15T13:00:00Z');
  });

  it('handles empty pattern list gracefully', async () => {
    const channel = new RecordingAlertChannel('test', 'medium');
    const result = await dispatchCrossTenantAlerts([], [channel]);
    expect(result.totalPatterns).toBe(0);
    expect(result.alertsSent).toBe(0);
    expect(channel.received).toHaveLength(0);
  });

  it('async channels are awaited (returns after all sends complete)', async () => {
    let asyncSendCompleted = false;
    const asyncChannel: AlertChannel = {
      id: 'async',
      minSeverity: 'medium',
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        asyncSendCompleted = true;
      },
    };
    await dispatchCrossTenantAlerts(
      [buildPattern('critical')],
      [asyncChannel],
    );
    expect(asyncSendCompleted).toBe(true);
  });

  it('severity ordering: critical > high > medium > info', () => {
    // Same channel, dispatching one of each severity.
    const channel = new RecordingAlertChannel('test', 'info');
    return dispatchCrossTenantAlerts(
      [
        buildPattern('info'),
        buildPattern('medium'),
        buildPattern('high'),
        buildPattern('critical'),
      ],
      [channel],
    ).then(() => {
      expect(channel.received).toHaveLength(4);
      const severities = channel.received.map((p) => p.severity);
      expect(severities).toEqual(['info', 'medium', 'high', 'critical']);
    });
  });
});
