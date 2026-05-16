// Phase 9 batch 46 (2026-05-16): tests for Discord / Email / Datadog /
// Opsgenie alert channels.

import { describe, expect, it } from 'vitest';
import {
  createDiscordChannel,
  createEmailChannel,
  createDatadogChannel,
  createOpsgenieChannel,
  formatDiscordPayload,
  formatEmailPayload,
  formatDatadogPayload,
  formatOpsgeniePayload,
  type AlertHttpTransport,
  type EmailSender,
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
    totalCount: 12,
    tenantCount: 5,
    firstSeen: '2026-05-16T00:00:00Z',
    lastSeen: '2026-05-16T12:00:00Z',
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
    generatedAt: '2026-05-16T13:00:00Z',
  };
}

function recordingTransport(): {
  transport: AlertHttpTransport;
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const transport: AlertHttpTransport = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200, statusText: 'OK' };
  };
  return { transport, calls };
}

describe('Discord channel (Phase 9 batch 46)', () => {
  it('formats Discord webhook payload with severity-colored embed', () => {
    const formatted = formatDiscordPayload(buildPayload('critical'), 'Nexus Hub') as any;
    expect(formatted.username).toBe('Nexus Hub');
    expect(formatted.embeds).toHaveLength(1);
    expect(formatted.embeds[0].color).toBe(0xcc0000);
    expect(formatted.embeds[0].title).toMatch(/CRITICAL/);
  });

  it('maps colors: critical=red, high=orange, medium=yellow, info=blue', () => {
    expect((formatDiscordPayload(buildPayload('critical')) as any).embeds[0].color).toBe(0xcc0000);
    expect((formatDiscordPayload(buildPayload('high')) as any).embeds[0].color).toBe(0xe07b00);
    expect((formatDiscordPayload(buildPayload('medium')) as any).embeds[0].color).toBe(0xdfc100);
    expect((formatDiscordPayload(buildPayload('info')) as any).embeds[0].color).toBe(0x3aa3e3);
  });

  it('sends to the configured webhook URL', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createDiscordChannel({
      webhookUrl: 'https://discord.com/api/webhooks/X/Y',
      transport,
    });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://discord.com/api/webhooks/X/Y');
  });

  it('default minSeverity is medium', () => {
    const channel = createDiscordChannel({ webhookUrl: 'x', transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('medium');
  });
});

describe('Email channel (Phase 9 batch 46)', () => {
  it('formats email payload with text + HTML versions', () => {
    const formatted = formatEmailPayload(
      buildPayload('critical'),
      'alerts@nexushub.test',
      'felipe@example.com',
    );
    expect(formatted.from).toBe('alerts@nexushub.test');
    expect(formatted.to).toBe('felipe@example.com');
    expect(formatted.subject).toMatch(/CRITICAL/);
    expect(formatted.text).toMatch(/Severity: critical/);
    expect(formatted.html).toMatch(/<h2>/);
  });

  it('escapes HTML in payload title/description', () => {
    const payload: AlertPayload = {
      ...buildPayload('critical'),
      title: '<script>alert(1)</script>',
      description: 'A & B < C',
    };
    const formatted = formatEmailPayload(payload, 'from@x', 'to@x');
    expect(formatted.html).toMatch(/&lt;script&gt;/);
    expect(formatted.html).toMatch(/A &amp; B &lt; C/);
    expect(formatted.html).not.toMatch(/<script>/);
  });

  it('createEmailChannel calls the injected sender with the formatted payload', async () => {
    const received: Array<{ to: string; subject: string }> = [];
    const sender: EmailSender = async (input) => {
      received.push({ to: input.to, subject: input.subject });
    };
    const channel = createEmailChannel({
      from: 'alerts@nexushub.test',
      to: 'felipe@example.com',
      sender,
    });
    await channel.send(buildPayload('critical'));
    expect(received).toHaveLength(1);
    expect(received[0].to).toBe('felipe@example.com');
    expect(received[0].subject).toMatch(/CRITICAL/);
  });

  it('default minSeverity is high', () => {
    const channel = createEmailChannel({
      from: 'a@b',
      to: 'c@d',
      sender: () => {},
    });
    expect(channel.minSeverity).toBe('high');
  });

  it('surfaces sender errors', async () => {
    const sender: EmailSender = () => {
      throw new Error('SMTP unavailable');
    };
    const channel = createEmailChannel({ from: 'a@b', to: 'c@d', sender });
    await expect(channel.send(buildPayload('critical'))).rejects.toThrow(/SMTP unavailable/);
  });
});

describe('Datadog channel (Phase 9 batch 46)', () => {
  it('formats Events API v1 payload with severity-mapped alert_type', () => {
    const formatted = formatDatadogPayload(buildPayload('critical')) as any;
    expect(formatted.alert_type).toBe('error');
    expect(formatted.priority).toBe('normal');
    expect(formatted.source_type_name).toBe('nexus-hub-registry');
    expect(formatted.tags).toContain('severity:critical');
    expect(formatted.tags).toContain('skill:mail');
  });

  it('maps severity: critical/high → error, medium → warning, info → info', () => {
    expect((formatDatadogPayload(buildPayload('critical')) as any).alert_type).toBe('error');
    expect((formatDatadogPayload(buildPayload('high')) as any).alert_type).toBe('error');
    expect((formatDatadogPayload(buildPayload('medium')) as any).alert_type).toBe('warning');
    expect((formatDatadogPayload(buildPayload('info')) as any).alert_type).toBe('info');
  });

  it('sends to default datadoghq.com region with API key header', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createDatadogChannel({ apiKey: 'KEYABC', transport });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.datadoghq.com/api/v1/events');
    expect(calls[0].headers['DD-API-KEY']).toBe('KEYABC');
  });

  it('respects custom site (EU region)', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createDatadogChannel({ apiKey: 'k', site: 'datadoghq.eu', transport });
    await channel.send(buildPayload('critical'));
    expect(calls[0].url).toBe('https://api.datadoghq.eu/api/v1/events');
  });

  it('default minSeverity is medium', () => {
    const channel = createDatadogChannel({ apiKey: 'k', transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('medium');
  });
});

describe('Opsgenie channel (Phase 9 batch 46)', () => {
  it('formats Opsgenie alert payload with priority mapping', () => {
    const formatted = formatOpsgeniePayload(buildPayload('critical')) as any;
    expect(formatted.priority).toBe('P1');
    expect(formatted.source).toBe('nexus-hub-registry');
    expect(formatted.details.tenantCount).toBe('5');
  });

  it('maps severity: critical=P1, high=P2, medium=P3, info=P5', () => {
    expect((formatOpsgeniePayload(buildPayload('critical')) as any).priority).toBe('P1');
    expect((formatOpsgeniePayload(buildPayload('high')) as any).priority).toBe('P2');
    expect((formatOpsgeniePayload(buildPayload('medium')) as any).priority).toBe('P3');
    expect((formatOpsgeniePayload(buildPayload('info')) as any).priority).toBe('P5');
  });

  it('sends to default US region with GenieKey auth header', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createOpsgenieChannel({ apiKey: 'OPSKEY', transport });
    await channel.send(buildPayload('critical'));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.opsgenie.com/v2/alerts');
    expect(calls[0].headers['Authorization']).toBe('GenieKey OPSKEY');
  });

  it('respects EU region', async () => {
    const { transport, calls } = recordingTransport();
    const channel = createOpsgenieChannel({ apiKey: 'k', region: 'eu', transport });
    await channel.send(buildPayload('critical'));
    expect(calls[0].url).toBe('https://api.eu.opsgenie.com/v2/alerts');
  });

  it('default minSeverity is high', () => {
    const channel = createOpsgenieChannel({ apiKey: 'k', transport: recordingTransport().transport });
    expect(channel.minSeverity).toBe('high');
  });
});

describe('Multi-channel integration (Phase 9 batch 46)', () => {
  it('dispatcher can fan to all 7 channels simultaneously', async () => {
    const { transport: ddT, calls: ddCalls } = recordingTransport();
    const { transport: ogT, calls: ogCalls } = recordingTransport();
    const { transport: dcT, calls: dcCalls } = recordingTransport();
    const emailReceived: Array<string> = [];
    const channels = [
      createDatadogChannel({ apiKey: 'k', transport: ddT, minSeverity: 'medium' }),
      createOpsgenieChannel({ apiKey: 'k', transport: ogT, minSeverity: 'medium' }),
      createDiscordChannel({ webhookUrl: 'https://d/x', transport: dcT, minSeverity: 'medium' }),
      createEmailChannel({
        from: 'a@b',
        to: 'c@d',
        sender: (m) => { emailReceived.push(m.subject); },
        minSeverity: 'medium',
      }),
    ];
    const payload = buildPayload('critical');
    await Promise.all(channels.map((c) => c.send(payload)));
    expect(ddCalls).toHaveLength(1);
    expect(ogCalls).toHaveLength(1);
    expect(dcCalls).toHaveLength(1);
    expect(emailReceived).toHaveLength(1);
  });
});
