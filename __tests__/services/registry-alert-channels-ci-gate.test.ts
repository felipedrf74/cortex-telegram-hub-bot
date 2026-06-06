// Phase 9 batch 47 (2026-05-16): CI gate for alert channels.
//
// Validates that all alert channel implementations conform to the contract
// expected by the dispatcher:
//
//   • Channel has a non-empty `id` matching a documented channel type
//   • minSeverity is one of the four CrossTenantSeverity levels
//   • send() accepts an AlertPayload and either resolves OR throws
//   • Successful send leaves no side effects on payload (no mutation)
//   • Channel honors transport-level errors (HTTP non-2xx → throws)
//
// This file pins the per-channel contract; a regression in any channel
// implementation would fail one or more tests here.

import { describe, expect, it } from 'vitest';
import {
  dispatchCrossTenantAlerts,
} from '../../src/services/registry-cross-tenant-alert-hook';
import {
  createPagerDutyChannel,
  createSlackChannel,
  createTelegramChannel,
  createDiscordChannel,
  createDatadogChannel,
  createOpsgenieChannel,
  createEmailChannel,
  type AlertHttpTransport,
} from '../../src/services/registry-cross-tenant-alert-channels';
import type { AlertPayload } from '../../src/services/registry-cross-tenant-alert-hook';
import type {
  CrossTenantAdversarialPattern,
  CrossTenantSeverity,
} from '../../src/services/registry-adversarial-discovery';

function buildPattern(severity: CrossTenantSeverity): CrossTenantAdversarialPattern {
  return {
    skill: 'mail',
    action: 'send_email',
    failureReason: 'prompt_injection_marker_detected',
    outcome: null,
    totalCount: 10,
    tenantCount: 5,
    firstSeen: '2026-05-16T00:00:00Z',
    lastSeen: '2026-05-16T12:00:00Z',
    windowDays: 0.5,
    perTenantCounts: { '1': 2, '2': 2, '3': 2, '4': 2, '5': 2 },
    severity,
  };
}

function buildPayload(severity: CrossTenantSeverity = 'critical'): AlertPayload {
  return {
    severity,
    title: `[${severity.toUpperCase()}] CI-gate test`,
    description: 'CI gate test description',
    pattern: buildPattern(severity),
    generatedAt: '2026-05-16T13:00:00Z',
  };
}

const okTransport: AlertHttpTransport = async () => ({ ok: true, status: 200, statusText: 'OK' });
const failTransport: AlertHttpTransport = async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' });

const VALID_CHANNEL_IDS = new Set([
  'pagerduty', 'slack', 'telegram', 'discord', 'email', 'datadog', 'opsgenie',
]);
const VALID_SEVERITIES = new Set<CrossTenantSeverity>([
  'critical', 'high', 'medium', 'info',
]);

describe('alert channels — CI contract gate (Phase 9 batch 47)', () => {
  const channels = [
    createPagerDutyChannel({ routingKey: 'k', transport: okTransport }),
    createSlackChannel({ webhookUrl: 'https://slack/x', transport: okTransport }),
    createTelegramChannel({ botToken: 'k', chatId: 1, transport: okTransport }),
    createDiscordChannel({ webhookUrl: 'https://d/x', transport: okTransport }),
    createDatadogChannel({ apiKey: 'k', transport: okTransport }),
    createOpsgenieChannel({ apiKey: 'k', transport: okTransport }),
    createEmailChannel({ from: 'a@b', to: 'c@d', sender: () => {} }),
  ];

  for (const channel of channels) {
    describe(`${channel.id}`, () => {
      it('has a recognised id', () => {
        expect(VALID_CHANNEL_IDS.has(channel.id)).toBe(true);
      });

      it('has a valid minSeverity', () => {
        expect(VALID_SEVERITIES.has(channel.minSeverity)).toBe(true);
      });

      it('send(payload) does not mutate the payload', async () => {
        const payload = buildPayload('critical');
        const snapshot = JSON.parse(JSON.stringify(payload));
        await channel.send(payload);
        expect(payload).toEqual(snapshot);
      });

      it('handles all four severities without throwing', async () => {
        for (const severity of ['critical', 'high', 'medium', 'info'] as const) {
          await channel.send(buildPayload(severity));
        }
      });
    });
  }
});

describe('alert channels — error surfacing CI gate (Phase 9 batch 47)', () => {
  const httpBackedChannels = [
    () => createPagerDutyChannel({ routingKey: 'k', transport: failTransport }),
    () => createSlackChannel({ webhookUrl: 'https://slack/x', transport: failTransport }),
    () => createTelegramChannel({ botToken: 'k', chatId: 1, transport: failTransport }),
    () => createDiscordChannel({ webhookUrl: 'https://d/x', transport: failTransport }),
    () => createDatadogChannel({ apiKey: 'k', transport: failTransport }),
    () => createOpsgenieChannel({ apiKey: 'k', transport: failTransport }),
  ];

  for (const factory of httpBackedChannels) {
    const channel = factory();
    it(`${channel.id} surfaces HTTP 500 as thrown error`, async () => {
      await expect(channel.send(buildPayload('critical'))).rejects.toThrow();
    });
  }
});

describe('alert channels — dispatcher integration (Phase 9 batch 47)', () => {
  it('all 7 channels can be registered together and dispatched in parallel', async () => {
    const dispatched: string[] = [];
    const trackingTransport: AlertHttpTransport = async (url) => {
      dispatched.push(url);
      return { ok: true, status: 200, statusText: 'OK' };
    };
    const emailReceived: string[] = [];
    const channels = [
      createPagerDutyChannel({ routingKey: 'k', transport: trackingTransport, minSeverity: 'medium' }),
      createSlackChannel({ webhookUrl: 'https://slack/x', transport: trackingTransport, minSeverity: 'medium' }),
      createTelegramChannel({ botToken: 'k', chatId: 1, transport: trackingTransport, minSeverity: 'medium' }),
      createDiscordChannel({ webhookUrl: 'https://d/x', transport: trackingTransport, minSeverity: 'medium' }),
      createDatadogChannel({ apiKey: 'k', transport: trackingTransport, minSeverity: 'medium' }),
      createOpsgenieChannel({ apiKey: 'k', transport: trackingTransport, minSeverity: 'medium' }),
      createEmailChannel({ from: 'a@b', to: 'c@d', sender: (m) => { emailReceived.push(m.subject); }, minSeverity: 'medium' }),
    ];
    const result = await dispatchCrossTenantAlerts([buildPattern('critical')], channels);
    // 6 HTTP-backed channels + 1 email channel = 7 dispatches
    expect(result.alertsSent).toBe(7);
    expect(dispatched).toHaveLength(6);
    expect(emailReceived).toHaveLength(1);
  });

  it('shadow mode skips all channels (no actual dispatches)', async () => {
    const dispatched: string[] = [];
    const trackingTransport: AlertHttpTransport = async (url) => {
      dispatched.push(url);
      return { ok: true, status: 200, statusText: 'OK' };
    };
    const emailReceived: string[] = [];
    const channels = [
      createPagerDutyChannel({ routingKey: 'k', transport: trackingTransport, minSeverity: 'medium' }),
      createEmailChannel({ from: 'a@b', to: 'c@d', sender: (m) => { emailReceived.push(m.subject); }, minSeverity: 'medium' }),
    ];
    const result = await dispatchCrossTenantAlerts([buildPattern('critical')], channels, { shadowMode: true });
    expect(result.alertsSent).toBe(0);
    expect(result.alertsSkipped).toBe(2);
    expect(dispatched).toHaveLength(0);
    expect(emailReceived).toHaveLength(0);
  });
});
