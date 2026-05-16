// Phase 10 batch 54 (2026-05-16): channel routing policy tests.
//
// Validates the per-severity → channelIds[] policy layer:
//
//   • DEFAULT_ROUTING_POLICY exposes the expected severity-to-channel
//     mapping (operator can override).
//   • validateChannelRoutingPolicy catches unknown channel IDs and
//     missing severity rows.
//   • dispatchCrossTenantAlertsWithPolicy routes alerts only to channels
//     selected by the policy, respects channel.minSeverity, captures
//     per-channel errors, and supports shadowMode.

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ROUTING_POLICY,
  dispatchCrossTenantAlertsWithMultiRegionPolicy,
  dispatchCrossTenantAlertsWithPolicy,
  pickPolicyForRegion,
  validateChannelRoutingPolicy,
  validateMultiRegionChannelRoutingPolicy,
  type ChannelRoutingPolicy,
  type MultiRegionChannelRoutingPolicy,
} from '../../src/services/registry-channel-routing-policy';
import type {
  AlertChannel,
  AlertPayload,
} from '../../src/services/registry-cross-tenant-alert-hook';
import type {
  CrossTenantAdversarialPattern,
  CrossTenantSeverity,
} from '../../src/services/registry-adversarial-discovery';

function makePattern(severity: CrossTenantSeverity): CrossTenantAdversarialPattern {
  return {
    severity,
    skill: 'mail',
    action: 'send_email',
    failureReason: 'prompt_injection_marker_detected',
    outcome: 'refusal',
    tenantCount: 3,
    totalCount: 9,
    perTenantCounts: { '1': 3, '2': 3, '3': 3 },
    firstSeen: '2026-05-16T12:00:00Z',
    lastSeen: '2026-05-16T13:00:00Z',
    windowDays: 0.04,
  } as CrossTenantAdversarialPattern;
}

function makeStubChannel(id: string, minSeverity: CrossTenantSeverity): {
  channel: AlertChannel;
  sent: AlertPayload[];
} {
  const sent: AlertPayload[] = [];
  return {
    sent,
    channel: {
      id,
      minSeverity,
      send: vi.fn(async (payload: AlertPayload) => {
        sent.push(payload);
      }),
    },
  };
}

describe('DEFAULT_ROUTING_POLICY (Phase 10 batch 54)', () => {
  it('maps every severity to at least one channel id', () => {
    for (const sev of ['critical', 'high', 'medium', 'info'] as const) {
      expect(DEFAULT_ROUTING_POLICY[sev].length).toBeGreaterThan(0);
    }
  });

  it('routes critical to the highest number of channels', () => {
    expect(DEFAULT_ROUTING_POLICY.critical.length).toBeGreaterThanOrEqual(DEFAULT_ROUTING_POLICY.high.length);
    expect(DEFAULT_ROUTING_POLICY.high.length).toBeGreaterThanOrEqual(DEFAULT_ROUTING_POLICY.medium.length);
  });
});

describe('validateChannelRoutingPolicy (Phase 10 batch 54)', () => {
  it('returns ok=true when every channel id exists', () => {
    const { channel: ch1 } = makeStubChannel('pd', 'critical');
    const { channel: ch2 } = makeStubChannel('slack', 'medium');
    const policy: ChannelRoutingPolicy = {
      critical: ['pd', 'slack'], high: ['slack'], medium: ['slack'], info: ['slack'],
    };
    const result = validateChannelRoutingPolicy(policy, [ch1, ch2]);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('returns ok=false with a clear error when a channel id is missing', () => {
    const { channel: ch1 } = makeStubChannel('slack', 'medium');
    const policy: ChannelRoutingPolicy = {
      critical: ['pagerduty-missing', 'slack'], high: ['slack'], medium: ['slack'], info: ['slack'],
    };
    const result = validateChannelRoutingPolicy(policy, [ch1]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('pagerduty-missing');
  });

  it('returns ok=false when a severity is missing from the policy', () => {
    const { channel: ch1 } = makeStubChannel('slack', 'medium');
    const partial = { critical: ['slack'], high: ['slack'], medium: ['slack'] } as unknown as ChannelRoutingPolicy;
    const result = validateChannelRoutingPolicy(partial, [ch1]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('info');
  });
});

describe('dispatchCrossTenantAlertsWithPolicy (Phase 10 batch 54)', () => {
  it('routes critical alerts only to channels listed for critical', async () => {
    const { channel: pd, sent: pdSent } = makeStubChannel('pd', 'critical');
    const { channel: slack, sent: slackSent } = makeStubChannel('slack', 'medium');
    const { channel: email, sent: emailSent } = makeStubChannel('email', 'info');
    const policy: ChannelRoutingPolicy = {
      critical: ['pd', 'slack'], high: ['slack'], medium: ['slack'], info: ['email'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('critical')],
      [pd, slack, email],
      policy,
      { nowIso: '2026-05-16T12:00:00Z' },
    );
    expect(pdSent.length).toBe(1);
    expect(slackSent.length).toBe(1);
    expect(emailSent.length).toBe(0); // email is info-only
    expect(result.alertsSent).toBe(2);
  });

  it('skips alerts when shadowMode is on', async () => {
    const { channel: slack, sent: slackSent } = makeStubChannel('slack', 'medium');
    const policy: ChannelRoutingPolicy = {
      critical: ['slack'], high: ['slack'], medium: ['slack'], info: ['slack'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('critical')],
      [slack],
      policy,
      { shadowMode: true },
    );
    expect(slackSent.length).toBe(0);
    expect(result.alertsSkipped).toBe(1);
  });

  it('honors per-channel minSeverity even when policy targets the channel', async () => {
    // Channel only accepts critical, policy routes a high alert at it.
    const { channel: pd, sent: pdSent } = makeStubChannel('pd', 'critical');
    const policy: ChannelRoutingPolicy = {
      critical: ['pd'], high: ['pd'], medium: ['pd'], info: ['pd'],
    };
    const highResult = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('high')], [pd], policy,
    );
    expect(pdSent.length).toBe(0);
    expect(highResult.alertsSkipped).toBe(1);

    const critResult = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('critical')], [pd], policy,
    );
    expect(pdSent.length).toBe(1);
    expect(critResult.alertsSent).toBe(1);
  });

  it('captures per-channel errors without stopping the fanout', async () => {
    const failing: AlertChannel = {
      id: 'broken', minSeverity: 'info',
      send: vi.fn(async () => { throw new Error('upstream 500'); }),
    };
    const { channel: ok, sent: okSent } = makeStubChannel('ok', 'info');
    const policy: ChannelRoutingPolicy = {
      critical: ['broken', 'ok'], high: ['broken', 'ok'], medium: ['broken', 'ok'], info: ['broken', 'ok'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('critical')], [failing, ok], policy,
    );
    expect(okSent.length).toBe(1);
    expect(result.perChannel.broken.errors[0]).toContain('upstream 500');
    expect(result.alertsSent).toBe(1);
    expect(result.alertsSkipped).toBe(1);
  });

  it('records a per-channel error when policy references an unknown channel at dispatch time', async () => {
    const { channel: slack, sent: slackSent } = makeStubChannel('slack', 'medium');
    // Policy references "ghost-channel" not registered in the channels array.
    const policy: ChannelRoutingPolicy = {
      critical: ['slack', 'ghost-channel'], high: ['slack'], medium: ['slack'], info: ['slack'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('critical')], [slack], policy,
    );
    expect(slackSent.length).toBe(1);
    expect(result.perChannel['ghost-channel']?.errors[0]).toContain('not registered');
    expect(result.alertsSkipped).toBe(1);
  });

  it('returns 0 dispatched when patterns array is empty', async () => {
    const { channel: slack } = makeStubChannel('slack', 'info');
    const policy: ChannelRoutingPolicy = {
      critical: ['slack'], high: ['slack'], medium: ['slack'], info: ['slack'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy([], [slack], policy);
    expect(result.totalPatterns).toBe(0);
    expect(result.alertsSent).toBe(0);
  });

  it('handles a severity whose policy entry is empty (no channels for that severity)', async () => {
    const { channel: slack, sent: slackSent } = makeStubChannel('slack', 'info');
    const policy: ChannelRoutingPolicy = {
      critical: ['slack'], high: ['slack'], medium: [], info: ['slack'],
    };
    const result = await dispatchCrossTenantAlertsWithPolicy(
      [makePattern('medium')], [slack], policy,
    );
    expect(slackSent.length).toBe(0);
    expect(result.alertsSent).toBe(0);
  });
});

describe('Multi-region channel routing (Phase 11 batch 57)', () => {
  const defaultPolicy: ChannelRoutingPolicy = {
    critical: ['slack-global'], high: ['slack-global'], medium: ['slack-global'], info: ['slack-global'],
  };

  it('pickPolicyForRegion returns the default policy when no region is given', () => {
    const policy: MultiRegionChannelRoutingPolicy = { default: defaultPolicy };
    expect(pickPolicyForRegion(policy)).toBe(defaultPolicy);
  });

  it('pickPolicyForRegion returns the region override when one exists', () => {
    const euPolicy: ChannelRoutingPolicy = {
      critical: ['slack-eu'], high: ['slack-eu'], medium: ['slack-eu'], info: ['slack-eu'],
    };
    const policy: MultiRegionChannelRoutingPolicy = {
      default: defaultPolicy,
      byRegion: { eu: euPolicy },
    };
    expect(pickPolicyForRegion(policy, 'eu')).toBe(euPolicy);
  });

  it('pickPolicyForRegion falls back to default when the region has no override', () => {
    const policy: MultiRegionChannelRoutingPolicy = {
      default: defaultPolicy,
      byRegion: { eu: defaultPolicy },
    };
    expect(pickPolicyForRegion(policy, 'us')).toBe(defaultPolicy);
  });

  it('validateMultiRegionChannelRoutingPolicy reports default-policy errors with [default] prefix', () => {
    const { channel } = makeStubChannel('slack-global', 'info');
    const policy: MultiRegionChannelRoutingPolicy = {
      default: { critical: ['ghost'], high: ['slack-global'], medium: ['slack-global'], info: ['slack-global'] },
    };
    const result = validateMultiRegionChannelRoutingPolicy(policy, [channel]);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('[default]');
    expect(result.errors[0]).toContain('ghost');
  });

  it('validateMultiRegionChannelRoutingPolicy reports region-policy errors with [region] prefix', () => {
    const { channel } = makeStubChannel('slack-global', 'info');
    const policy: MultiRegionChannelRoutingPolicy = {
      default: defaultPolicy,
      byRegion: {
        eu: { critical: ['slack-eu-missing'], high: ['slack-global'], medium: ['slack-global'], info: ['slack-global'] },
      },
    };
    const result = validateMultiRegionChannelRoutingPolicy(policy, [channel]);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.startsWith('[eu]'))).toBe(true);
    expect(result.errors.some((e) => e.includes('slack-eu-missing'))).toBe(true);
  });

  it('dispatchCrossTenantAlertsWithMultiRegionPolicy routes through the regional policy', async () => {
    const { channel: global, sent: globalSent } = makeStubChannel('slack-global', 'info');
    const { channel: eu, sent: euSent } = makeStubChannel('slack-eu', 'info');
    const policy: MultiRegionChannelRoutingPolicy = {
      default: defaultPolicy,
      byRegion: {
        eu: { critical: ['slack-eu'], high: ['slack-eu'], medium: ['slack-eu'], info: ['slack-eu'] },
      },
    };
    await dispatchCrossTenantAlertsWithMultiRegionPolicy(
      [makePattern('critical')], [global, eu], policy, { region: 'eu' },
    );
    expect(euSent.length).toBe(1);
    expect(globalSent.length).toBe(0);
  });

  it('falls through to default when dispatching for a region with no override', async () => {
    const { channel: global, sent: globalSent } = makeStubChannel('slack-global', 'info');
    const policy: MultiRegionChannelRoutingPolicy = {
      default: defaultPolicy,
      byRegion: { eu: defaultPolicy },
    };
    await dispatchCrossTenantAlertsWithMultiRegionPolicy(
      [makePattern('critical')], [global], policy, { region: 'apac' },
    );
    expect(globalSent.length).toBe(1);
  });
});
