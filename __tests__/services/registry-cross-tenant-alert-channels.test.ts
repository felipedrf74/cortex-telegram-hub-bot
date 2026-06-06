// Phase 8 batch 42 (2026-05-15): cross-tenant alert channel implementation tests.

import { describe, expect, it, vi } from 'vitest';
import {
  createPagerDutyChannel,
  createSlackChannel,
  createTelegramChannel,
  formatPagerDutyPayload,
  formatSlackPayload,
  formatTelegramPayload,
  type AlertHttpTransport,
} from '../../src/services/registry-cross-tenant-alert-channels';
import type {
  AlertPayload,
} from '../../src/services/registry-cross-tenant-alert-hook';
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
    totalCount: 12,
    tenantCount: 5,
    firstSeen: '2026-05-15T00:00:00Z',
    lastSeen: '2026-05-15T12:00:00Z',
    windowDays: 0.5,
    perTenantCounts: { '1': 3, '2': 2, '3': 3, '4': 2, '5': 2 },
    severity,
  };
}

function buildPayload(severity: CrossTenantSeverity = 'critical'): AlertPayload {
  return {
    severity,
    title: `[${severity.toUpperCase()}] Cross-tenant adversarial pattern on mail.send_email`,
    description: 'Test description',
    pattern: buildPattern(severity),
    generatedAt: '2026-05-15T13:00:00Z',
  };
}

function recordingTransport(): {
  transport: AlertHttpTransport;
  calls: Array<{ url: string; body: unknown }>;
} {
  const calls: Array<{ url: string; body: unknown }> = [];
  const transport: AlertHttpTransport = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, statusText: 'OK' };
  };
  return { transport, calls };
}

describe('PagerDuty channel (Phase 8 batch 42)', () => {
  it('formats Events API v2 payload with correct routing_key + severity mapping', () => {
    const payload = buildPayload('critical');
    const formatted = formatPagerDutyPayload(payload, 'TEST_KEY', 'test-source') as any;
    expect(formatted.routing_key).toBe('TEST_KEY');
    expect(formatted.event_action).toBe('trigger');
    expect(formatted.payload.severity).toBe('critical');
    expect(formatted.payload.source).toBe('test-source');
    expect(formatted.payload.custom_details.skill).toBe('mail');
    expect(formatted.payload.custom_details.tenantCount).toBe(5);
  });

  it('maps high → error in PagerDuty severity', () => {
    const formatted = formatPagerDutyPayload(buildPayload('high'), 'k', 's') as any;
    expect(formatted.payload.severity).toBe('error');
  });

  it('maps medium → warning, info → info', () => {
    expect((formatPagerDutyPayload(buildPayload('medium'), 'k', 's') as any).payload.severity).toBe('warning');
    expect((formatPagerDutyPayload(buildPayload('info'), 'k', 's') as any).payload.severity).toBe('info');
  });

  it('createPagerDutyChannel sends to /v2/enqueue by default', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createPagerDutyChannel({ routingKey: 'KEY123', transport });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://events.pagerduty.com/v2/enqueue');
    expect((calls[0].body as any).routing_key).toBe('KEY123');
  });

  it('createPagerDutyChannel respects minSeverity default high', () => {
    const channel = createPagerDutyChannel({ routingKey: 'k', transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('high');
  });

  it('createPagerDutyChannel surfaces transport errors', async () => {
    const failingTransport: AlertHttpTransport = async () => ({ ok: false, status: 503, statusText: 'Service Unavailable' });
    const channel = createPagerDutyChannel({ routingKey: 'k', transport: failingTransport });
    await expect(channel.send(buildPayload('critical'))).rejects.toThrow(/503/);
  });
});

describe('Slack channel (Phase 8 batch 42)', () => {
  it('formats Slack webhook payload with severity-colored attachment', () => {
    const payload = buildPayload('critical');
    const formatted = formatSlackPayload(payload) as any;
    expect(formatted.text).toMatch(/CRITICAL/);
    expect(formatted.attachments).toHaveLength(1);
    expect(formatted.attachments[0].color).toBe('#cc0000');
    expect(formatted.attachments[0].fields.find((f: any) => f.title === 'Tenants').value).toBe('5');
  });

  it('respects channelOverride when provided', () => {
    const formatted = formatSlackPayload(buildPayload(), '#security-alerts') as any;
    expect(formatted.channel).toBe('#security-alerts');
  });

  it('maps severity colors: critical=red, high=orange, medium=yellow, info=blue', () => {
    expect((formatSlackPayload(buildPayload('critical')) as any).attachments[0].color).toBe('#cc0000');
    expect((formatSlackPayload(buildPayload('high')) as any).attachments[0].color).toBe('#e07b00');
    expect((formatSlackPayload(buildPayload('medium')) as any).attachments[0].color).toBe('#dfc100');
    expect((formatSlackPayload(buildPayload('info')) as any).attachments[0].color).toBe('#3aa3e3');
  });

  it('createSlackChannel sends to the configured webhook URL', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createSlackChannel({
      webhookUrl: 'https://hooks.slack.com/services/T1/B1/X1',
      transport,
    });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://hooks.slack.com/services/T1/B1/X1');
  });

  it('createSlackChannel default minSeverity is medium', () => {
    const channel = createSlackChannel({ webhookUrl: 'https://example.com', transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('medium');
  });
});

describe('Telegram channel (Phase 8 batch 42)', () => {
  it('formats sendMessage payload with HTML and severity emoji', () => {
    const payload = buildPayload('critical');
    const formatted = formatTelegramPayload(payload, 123456) as any;
    expect(formatted.chat_id).toBe(123456);
    expect(formatted.parse_mode).toBe('HTML');
    expect(formatted.text).toMatch(/🚨/);
    expect(formatted.text).toMatch(/<b>/);
  });

  it('different severities get different emoji', () => {
    expect((formatTelegramPayload(buildPayload('critical'), 1) as any).text).toMatch(/🚨/);
    expect((formatTelegramPayload(buildPayload('high'), 1) as any).text).toMatch(/⚠️/);
    expect((formatTelegramPayload(buildPayload('medium'), 1) as any).text).toMatch(/🟡/);
    expect((formatTelegramPayload(buildPayload('info'), 1) as any).text).toMatch(/ℹ️/);
  });

  it('escapes HTML in payload title/description', () => {
    const payload: AlertPayload = {
      ...buildPayload('critical'),
      title: '<script>alert(1)</script>',
      description: 'A & B < C',
    };
    const formatted = formatTelegramPayload(payload, 1) as any;
    expect(formatted.text).toMatch(/&lt;script&gt;/);
    expect(formatted.text).toMatch(/A &amp; B &lt; C/);
    expect(formatted.text).not.toMatch(/<script>/);
  });

  it('createTelegramChannel sends to bot API URL', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createTelegramChannel({
      botToken: 'BOTTOKEN',
      chatId: 999,
      transport,
    });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.telegram.org/botBOTTOKEN/sendMessage');
    expect((calls[0].body as any).chat_id).toBe(999);
  });

  it('createTelegramChannel default minSeverity is high', () => {
    const channel = createTelegramChannel({ botToken: 't', chatId: 1, transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('high');
  });

  it('createTelegramChannel surfaces transport errors', async () => {
    const failingTransport: AlertHttpTransport = async () => ({ ok: false, status: 401, statusText: 'Unauthorized' });
    const channel = createTelegramChannel({ botToken: 'x', chatId: 1, transport: failingTransport });
    await expect(channel.send(buildPayload('critical'))).rejects.toThrow(/401/);
  });
});

describe('Multi-channel integration (Phase 8 batch 42)', () => {
  it('one payload can be sent through PagerDuty + Slack + Telegram simultaneously', async () => {
    const { transport: pdT, calls: pdCalls } = recordingTransport();
    const { transport: slT, calls: slCalls } = recordingTransport();
    const { transport: tgT, calls: tgCalls } = recordingTransport();
    const channels = [
      createPagerDutyChannel({ routingKey: 'k', transport: pdT, minSeverity: 'medium' }),
      createSlackChannel({ webhookUrl: 'https://slack/x', transport: slT, minSeverity: 'medium' }),
      createTelegramChannel({ botToken: 't', chatId: 1, transport: tgT, minSeverity: 'medium' }),
    ];
    const payload = buildPayload('critical');
    await Promise.all(channels.map((c) => c.send(payload)));
    expect(pdCalls).toHaveLength(1);
    expect(slCalls).toHaveLength(1);
    expect(tgCalls).toHaveLength(1);
  });
});
